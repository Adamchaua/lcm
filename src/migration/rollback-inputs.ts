import { join } from "node:path";
import { readDaemonConfigSnapshot, type ResolvedStorageConfig } from "../daemon/config.js";
import { requireMachineIdentity } from "../machine-identity.js";
import { readProjectMapSnapshot } from "../project-map.js";
import type { BackendMaintenanceRosterEntry, BackendPublicationCoordinator } from "../storage/backend-publication.js";
import { connectionSettings } from "../storage/postgresql/factory.js";
import { resolveStorageIdentityContext } from "../storage/identity-context.js";
import type { PortableProjectIdentity } from "../storage/portable-record-stream.js";
import { MigrationManifestStore } from "./manifest-store.js";
import type { MigrationManifest } from "./protocol.js";
import { inspectAuthenticatedSqliteMigrationSnapshot } from "./queue-evidence.js";
import {
  openRollbackFencedSession,
  type RollbackSessionDependencies,
  type RollbackSessionTarget,
} from "./rollback-session.js";
import type { RunMigrationRollbackDependencies, RunMigrationRollbackInput } from "./rollback.js";

/**
 * Derives a rollback's inputs from durable state (plan-v3.1 amendment A12),
 * so the CLI passes only a home directory and a generation id. Nothing
 * here is invented by a caller.
 *
 * Sources, all read from what the forward migration left behind:
 *
 *  - The manifest names the preserved source generation; its immutable
 *    #622 snapshot artifact (and the queue evidence sealed beside it) carry
 *    the project's physical id (the local project id), its live database
 *    path (the path rollback installs into -- not the project directory),
 *    and the values the forward capture bound into its maintenance journal.
 *  - The project map binds the local project to its PostgreSQL project id,
 *    which gives the shared project identity the export is built under.
 *    An unbound project refuses.
 *  - The daemon configuration supplies the PostgreSQL target; it must still
 *    select PostgreSQL, because rollback unwinds an activated backend.
 *
 * Rollback records sourceSelectionSha256, queueEvidenceSha256 and the roster
 * row as lineage evidence of the generation it unwinds, not as a fresh
 * cutoff, and it seals no queue evidence of its own. The values are only
 * format-checked by enterMaintenance and the quiescence check (which also
 * requires a single-machine roster); the one place a roster is read
 * semantically is the forward copy source (copy-source.ts), which rollback
 * never runs.
 */

export type RollbackInputResolutionReason =
  | "backend-not-postgresql"
  | "machine-mismatch"
  | "project-unbound";

export class RollbackInputResolutionError extends Error {
  constructor(readonly reason: RollbackInputResolutionReason, message: string) {
    super(message);
    this.name = "RollbackInputResolutionError";
  }
}

export type ResolvedMigrationRollbackContext = Readonly<{
  /** The input runMigrationRollback takes, minus the per-call scratchParent and signal. */
  input: Pick<
    RunMigrationRollbackInput,
    | "homeDir" | "generationId" | "canonicalPath" | "projectIdentity" | "localProjectId"
    | "sourceSelectionSha256" | "queueEvidenceSha256" | "roster"
  >;
  /** The fenced session's target (createMigrationRollbackDependencies consumes it). */
  target: RollbackSessionTarget;
}>;

/** The durable-state readers resolveMigrationRollbackContext uses; injectable for tests. */
export interface ResolveRollbackContextDependencies {
  readManifest(homeDir: string, generationId: string): MigrationManifest;
  inspectSnapshot: typeof inspectAuthenticatedSqliteMigrationSnapshot;
  requireMachineIdentity: typeof requireMachineIdentity;
  readStorageConfig(homeDir: string): ResolvedStorageConfig;
  readProjectMap: typeof readProjectMapSnapshot;
  resolveIdentity: typeof resolveStorageIdentityContext;
}

export const DEFAULT_RESOLVE_ROLLBACK_CONTEXT_DEPENDENCIES: ResolveRollbackContextDependencies = {
  readManifest: (homeDir, generationId) => new MigrationManifestStore({ homeDir }).read(generationId),
  inspectSnapshot: inspectAuthenticatedSqliteMigrationSnapshot,
  requireMachineIdentity,
  readStorageConfig: (homeDir) => readDaemonConfigSnapshot(join(homeDir, ".lcm", "config.json")).config.storage,
  readProjectMap: readProjectMapSnapshot,
  resolveIdentity: resolveStorageIdentityContext,
};

export async function resolveMigrationRollbackContext(
  request: Readonly<{ homeDir: string; generationId: string }>,
  dependencies: ResolveRollbackContextDependencies = DEFAULT_RESOLVE_ROLLBACK_CONTEXT_DEPENDENCIES,
): Promise<ResolvedMigrationRollbackContext> {
  const { homeDir, generationId } = request;
  const manifest = dependencies.readManifest(homeDir, generationId);
  const preservedSourceGenerationId = manifest.rollbackLineage.preservedSourceGenerationId;
  const evidence = await dependencies.inspectSnapshot(preservedSourceGenerationId, homeDir);
  const artifact = evidence.artifact;
  const authority = artifact.authority;

  const machine = dependencies.requireMachineIdentity(homeDir);
  if (authority.machineIdentity.machineId !== machine.machineId) {
    throw new RollbackInputResolutionError(
      "machine-mismatch",
      "the forward capture's participant machine is not this machine; rollback runs on the machine that migrated",
    );
  }
  const roster: readonly BackendMaintenanceRosterEntry[] = [{
    machineId: authority.machineIdentity.machineId,
    queueCutoff: evidence.receiptReference.queueCutoff,
    evidenceSha256: artifact.sourceByteWitnessSha256,
  }];

  const storage = dependencies.readStorageConfig(homeDir);
  if (storage.backend !== "postgresql") {
    throw new RollbackInputResolutionError(
      "backend-not-postgresql",
      "rollback unwinds an activated PostgreSQL backend, but the configuration selects another",
    );
  }
  const entry = dependencies.readProjectMap(homeDir)[authority.physicalProjectId];
  if (entry?.remoteProjectId === undefined) {
    throw new RollbackInputResolutionError(
      "project-unbound",
      "the project has no PostgreSQL binding in the project map; there is nothing to roll back from",
    );
  }
  const remoteProjectId = entry.remoteProjectId;
  const expectedIdentity = dependencies.resolveIdentity(
    storage,
    { id: authority.physicalProjectId, canonical: entry.canonical, remoteProjectId },
    homeDir,
    entry.canonical,
  );
  const projectIdentity: PortableProjectIdentity = { scope: "shared", projectId: remoteProjectId };

  return {
    input: {
      homeDir,
      generationId,
      canonicalPath: authority.projectDbPath,
      projectIdentity,
      localProjectId: authority.physicalProjectId,
      sourceSelectionSha256: artifact.sourceSelectionSha256,
      queueEvidenceSha256: artifact.queueEvidenceSha256,
      roster,
    },
    target: {
      settings: connectionSettings(storage),
      expectedOwner: storage.postgresql.migrationRole,
      expectedIdentity,
      localProjectId: authority.physicalProjectId,
      remoteProjectId,
      machineId: machine.machineId,
    },
  };
}

/**
 * The production dependencies of runMigrationRollback. Binding writers, the
 * binding and evidence readers and the context fetch are the orchestration's
 * own defaults; this supplies the fenced session. The coordinator stays
 * caller-supplied until a production driver exists.
 */
export function createMigrationRollbackDependencies(input: Readonly<{
  coordinator: BackendPublicationCoordinator;
  target: RollbackSessionTarget;
  sessionDependencies?: RollbackSessionDependencies;
}>): RunMigrationRollbackDependencies {
  return {
    coordinator: input.coordinator,
    openFencedSession: (request) => openRollbackFencedSession(request, input.target, input.sessionDependencies),
  };
}


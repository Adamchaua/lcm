import { basename } from "node:path";
import { configPath } from "../runtime-paths.js";
import { resolveProjectIdentity } from "../project-map.js";
import type { StorageIdentityContext } from "../storage/contracts.js";
import type { ResolvedPostgreSqlConfig } from "../daemon/config.js";
import { PostgreSqlRuntime } from "../storage/postgresql/runtime.js";
import { PostgreSqlIdentityRepository } from "../storage/postgresql/identity-repository.js";
import { requireMachineIdentity, MachineIdentityFileError } from "../machine-identity.js";
import { resolveMigrationTargetConfig } from "./target-config.js";
import { classifyMigrationDaemonPresence, type MigrationDaemonPresence } from "./daemon-presence.js";
import { verifyMigrationTargetReachability } from "./target-reachability.js";
import { resolveMigrationTargetProjectId } from "./target-identity.js";
import {
  computeMigrationGenerationBase,
  nonSecretPostgreSqlTargetCoordinates,
  MigrationIdentityError,
} from "./generation-identity.js";
import {
  resolveMigrationApplyCandidate,
  type MigrationApplyCandidateResolution,
} from "./candidate.js";

/**
 * The shared preflight both `plan` and `apply` compose identically (section
 * 3: `plan` "owns" preconditions, target reachability, roster, daemon
 * presence, and computing the candidate generation id -- exactly this
 * function's job). Built as one shared function specifically so the two
 * commands cannot silently diverge in composition order: `plan`'s preview
 * and `apply`'s real precondition check must reach the same generation id
 * from the same live state for the section 9 confirmation fence to guard
 * anything (see `candidate.ts`'s own agreement tests, which this function
 * calls the same `resolveMigrationApplyCandidate` those tests hold to that
 * standard).
 *
 * **Never collapses a three-valued primitive into a boolean at this call
 * site.** `classifyMigrationDaemonPresence`'s three outcomes are handled as
 * three distinct branches below, not `if (present) ... else refuse`. Only
 * `unresolvable` refuses (exit 5: evidence could not be established).
 * `present` and `authoritatively-absent` both proceed -- they are two
 * different positively-established facts, carried through to the caller
 * distinctly, but neither is a refusal.
 *
 * **Why a positively confirmed absence proceeds rather than refuses.**
 * Section 7 says `apply` "must positively establish daemon presence ...
 * and refuses exit 5 when it cannot" -- "cannot establish" means
 * `unresolvable`, not "established the answer is none". A confirmed
 * absence *is* establishing presence; the established answer happens to be
 * "no daemon". Refusing on absence would also be actively harmful: nothing
 * in this migration needs a daemon (the daemon is a *consumer* of storage,
 * not a participant in the copy), and section 7's policy already treats a
 * running daemon as merely *permitted*, not required -- refusing here would
 * force an operator to start a daemon purely to pass this check,
 * immediately before a maintenance hold that makes that very daemon's
 * passive-event sweeps fail for the whole capture-and-copy window. That is
 * precisely the condition this check exists to warn about, not require.
 * Section 6's restart-requirement precedent treats the identical
 * observation (no pid file, no live process) as authoritative absence
 * yielding exit 0 "no daemon to restart" -- this contract must not disagree
 * with itself between sections 6 and 7.
 *
 * **Section 4.10: the destination project identity is never derived from
 * the local project map.** `openMigrationCopySource` refuses unless the
 * capture authority's `projectIdentity.scope` is `"local"`
 * (`copy-source.ts:38-40`), and `authenticateSqliteMigrationSource` sets
 * that scope to `"shared"` the moment the local project-map entry carries
 * a `remoteProjectId` (`maintenance.ts:126-128`) -- so if this function
 * bound the map (the way `resolveStorageIdentityContext` does for every
 * *other* production caller), capture would refuse
 * `multi-machine-installation` on every migration, unconditionally. The
 * destination project id is instead resolved directly against PostgreSQL
 * (`resolveMigrationTargetProjectId`, `target-identity.ts`, which also
 * documents the exact input constraint this function must honour). The
 * local map stays unbound through capture, genesis and copy; #625's
 * activation publishes it for the first time, per the root's ruling. This
 * is why `unbound-postgresql-project` no longer exists as a refusal here:
 * the remedy it used to name (`lcm project create`/`lcm project link`,
 * both of which call `setRemoteProjectBinding`) would have told an
 * operator to write the exact field that must stay unset.
 */

export type MigrationPreflightResult =
  | Readonly<{
    status: "ready";
    targetConfig: ResolvedPostgreSqlConfig;
    presence: Extract<MigrationDaemonPresence, { status: "present" } | { status: "authoritatively-absent" }>;
    candidate: Extract<MigrationApplyCandidateResolution, { status: "candidate" }>;
    expectedIdentity: StorageIdentityContext;
    base: string;
  }>
  | Readonly<{ status: "refuse"; reason: string; evidence?: string }>;

export type MigrationPreflightOperations = Readonly<{
  resolveTargetConfig: typeof resolveMigrationTargetConfig;
  classifyPresence: typeof classifyMigrationDaemonPresence;
  verifyReachability: typeof verifyMigrationTargetReachability;
  requireMachine: typeof requireMachineIdentity;
  createIdentityRuntime: (settings: ResolvedPostgreSqlConfig["postgresql"]) => PostgreSqlRuntime;
  resolveTargetIdentity: typeof resolveMigrationTargetProjectId;
  resolveCandidate: typeof resolveMigrationApplyCandidate;
  resolveTargetCoordinates: typeof nonSecretPostgreSqlTargetCoordinates;
  computeBase: typeof computeMigrationGenerationBase;
}>;

export async function resolveMigrationPreflight(input: Readonly<{
  cwd: string;
  homeDir: string;
  /**
   * @internal Deterministic failure-injection seam for tests only, matching
   * the `_operationsForTesting` convention used elsewhere in
   * `src/migration/`. Each composed step can be overridden independently
   * so a test can prove this function refuses at exactly the step it
   * claims to, without needing a real PostgreSQL connection or a real
   * daemon for every branch.
   */
  _operationsForTesting?: Partial<MigrationPreflightOperations>;
}>): Promise<MigrationPreflightResult> {
  const resolveTargetConfig = input._operationsForTesting?.resolveTargetConfig ?? resolveMigrationTargetConfig;
  const classifyPresence = input._operationsForTesting?.classifyPresence ?? classifyMigrationDaemonPresence;
  const verifyReachability = input._operationsForTesting?.verifyReachability ?? verifyMigrationTargetReachability;
  const requireMachine = input._operationsForTesting?.requireMachine ?? requireMachineIdentity;
  const createIdentityRuntime = input._operationsForTesting?.createIdentityRuntime
    ?? ((settings) => new PostgreSqlRuntime(settings));
  const resolveTargetIdentity = input._operationsForTesting?.resolveTargetIdentity ?? resolveMigrationTargetProjectId;
  const resolveCandidate = input._operationsForTesting?.resolveCandidate ?? resolveMigrationApplyCandidate;
  const resolveTargetCoordinates = input._operationsForTesting?.resolveTargetCoordinates ?? nonSecretPostgreSqlTargetCoordinates;
  const computeBase = input._operationsForTesting?.computeBase ?? computeMigrationGenerationBase;

  // 1. Target config: storage.postgresql (plus LCM_POSTGRES_* fallbacks),
  // independent of the active backend, per the root's ruling.
  const targetResolution = resolveTargetConfig(configPath(input.homeDir));
  if (targetResolution.status === "refuse") {
    return { status: "refuse", reason: targetResolution.reason, evidence: targetResolution.evidence };
  }

  // 2. Daemon presence: three-valued, never collapsed.
  const presence = await classifyPresence({ homeDir: input.homeDir });
  if (presence.status === "unresolvable") {
    return { status: "refuse", reason: "daemon-presence-unresolvable", evidence: presence.evidence };
  }
  // `present` and `authoritatively-absent` both proceed from here: neither
  // is a refusal (see this module's own doc comment for why absence is not
  // treated as a precondition failure). `presence` is now typed as exactly
  // those two remaining variants and is carried through unchanged.

  // 3. Target reachability: a real connection, TLS and role verified.
  const verification = await verifyReachability({
    settings: targetResolution.config.postgresql,
    expectedOwner: targetResolution.config.postgresql.migrationRole,
  });
  if (verification.status === "refuse") {
    return { status: "refuse", reason: verification.reason, evidence: verification.evidence };
  }

  // 4a. This local project's own stable identity -- read-only, never
  // reconciled here (see this module's doc comment: reconciliation could
  // itself write the project map, which would make `plan` mutating on a
  // fresh or drifted worktree). `local.canonical` is also section 4.1's
  // base-identity input below and `target-identity.ts`'s required input
  // for the destination resolution in 4b -- one computation, reused
  // everywhere it is needed, never re-derived.
  const local = resolveProjectIdentity(input.cwd);

  // 4b. This machine's own registered identity, required before the
  // destination project id can be resolved or minted.
  let machineId: string;
  try {
    machineId = requireMachine(input.homeDir).machineId;
  } catch (error) {
    if (error instanceof MachineIdentityFileError) {
      return { status: "refuse", reason: "machine-identity-unregistered" };
    }
    throw error;
  }

  // 4c. The destination PostgreSQL project identity (section 4.10):
  // resolved directly against PostgreSQL through the identity repository,
  // never from the local project map, which must stay unbound through
  // capture, genesis and copy.
  const identityRuntime = createIdentityRuntime(targetResolution.config.postgresql);
  let projectId: string;
  try {
    const identityResolution = await resolveTargetIdentity({
      repository: new PostgreSqlIdentityRepository(identityRuntime),
      machineId,
      displayName: basename(local.canonical),
      authorityCanonicalPath: local.canonical,
    });
    if (identityResolution.status === "refuse") {
      return { status: "refuse", reason: identityResolution.reason, evidence: identityResolution.evidence };
    }
    projectId = identityResolution.projectId;
  } finally {
    try {
      await identityRuntime.close();
    } catch {
      // Preserve whichever outcome was already determined above; a close
      // failure after a successful or already-classified resolution is
      // not itself new evidence about the target.
    }
  }

  const expectedIdentity: StorageIdentityContext = {
    id: projectId,
    remoteProjectId: projectId,
    localProjectId: local.id,
    machineId,
    canonical: local.canonical,
    selectedPath: local.canonical,
  };

  // 5. The stable narrow base identity (section 4.1).
  const targetCoordinates = resolveTargetCoordinates(targetResolution.config.postgresql.url);
  let base: string;
  try {
    base = computeBase({
      physicalProjectId: local.id,
      canonicalPath: local.canonical,
      target: targetCoordinates,
    });
  } catch (error) {
    if (error instanceof MigrationIdentityError) {
      return { status: "refuse", reason: `generation-${error.reason}`, evidence: error.evidence ?? undefined };
    }
    throw error;
  }

  // 6. The candidate generation id preview (section 9's genesis repair).
  const candidate = await resolveCandidate({ cwd: input.cwd, homeDir: input.homeDir, base });
  if (candidate.status === "refuse") {
    return candidate;
  }

  return { status: "ready", targetConfig: targetResolution.config, presence, candidate, expectedIdentity, base };
}

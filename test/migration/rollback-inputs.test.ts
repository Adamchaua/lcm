import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StorageIdentityContext } from "../../src/storage/contracts.js";
import type { BackendPublicationCoordinator } from "../../src/storage/backend-publication.js";
import { MigrationManifestStore } from "../../src/migration/manifest-store.js";
import { createMigrationManifest, type MigrationManifest } from "../../src/migration/protocol.js";
import {
  DEFAULT_RESOLVE_ROLLBACK_CONTEXT_DEPENDENCIES,
  RollbackInputResolutionError,
  createMigrationRollbackDependencies,
  resolveMigrationRollbackContext,
  type ResolveRollbackContextDependencies,
} from "../../src/migration/rollback-inputs.js";
import type { RollbackSessionDependencies, RollbackSessionTarget } from "../../src/migration/rollback-session.js";

const HOME = "/home/user";
const GENERATION = "gen-1";
const PRESERVED = "preserved-gen";
const LOCAL = "local-project-1";
const REMOTE = "0197a000-0000-7000-8000-000000000001";
const MACHINE = "018f0b5d-1234-4abc-8def-1234567890ab";

const storage = {
  backend: "postgresql" as const,
  postgresql: {
    url: "postgresql://example/db", caFile: "/ca.pem", migrationRole: "lcm_owner",
    poolMax: 3, connectionTimeoutMs: 4, idleTimeoutMs: 5, statementTimeoutMs: 6, snapshotIdleTimeoutMs: 7,
  },
};

const snapshot = {
  artifact: {
    sourceSelectionSha256: "1".repeat(64),
    queueEvidenceSha256: "2".repeat(64),
    sourceByteWitnessSha256: "3".repeat(64),
    authority: {
      physicalProjectId: LOCAL,
      projectDbPath: "/home/user/.lcm/projects/" + LOCAL + "/db.sqlite",
      machineIdentity: { identityKey: "key", machineId: MACHINE },
    },
  },
  receiptReference: { queueCutoff: "0000000000000000042" },
};

function dependencies(overrides: Partial<ResolveRollbackContextDependencies> = {}): ResolveRollbackContextDependencies {
  return {
    readManifest: vi.fn(() => ({ rollbackLineage: { preservedSourceGenerationId: PRESERVED } }) as unknown as MigrationManifest),
    inspectSnapshot: vi.fn(async () => snapshot) as never,
    requireMachineIdentity: vi.fn(() => ({ machineId: MACHINE })) as never,
    readStorageConfig: vi.fn(() => storage),
    readProjectMap: vi.fn(() => ({ [LOCAL]: { canonical: "/work/project", aliases: [], remoteProjectId: REMOTE } })) as never,
    resolveIdentity: vi.fn((_config, local, _home, selectedPath) => ({
      id: local.remoteProjectId, canonical: local.canonical, remoteProjectId: local.remoteProjectId, machineId: MACHINE,
      selectedPath, localProjectId: local.id,
    })) as never,
    ...overrides,
  };
}

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("resolveMigrationRollbackContext", () => {
  it("derives every input from the forward snapshot, the project map and the configuration", async () => {
    const deps = dependencies();
    const { input, target } = await resolveMigrationRollbackContext({ homeDir: HOME, generationId: GENERATION }, deps);

    expect(deps.inspectSnapshot).toHaveBeenCalledWith(PRESERVED, HOME);
    expect(input).toEqual({
      homeDir: HOME,
      generationId: GENERATION,
      canonicalPath: snapshot.artifact.authority.projectDbPath,
      projectIdentity: { scope: "shared", projectId: REMOTE },
      localProjectId: LOCAL,
      sourceSelectionSha256: "1".repeat(64),
      queueEvidenceSha256: "2".repeat(64),
      roster: [{ machineId: MACHINE, queueCutoff: "0000000000000000042", evidenceSha256: "3".repeat(64) }],
    });
    expect(target).toEqual({
      settings: {
        url: "postgresql://example/db", caFile: "/ca.pem", poolMax: 3, connectionTimeoutMs: 4,
        idleTimeoutMs: 5, statementTimeoutMs: 6, snapshotIdleTimeoutMs: 7,
      },
      expectedOwner: "lcm_owner",
      expectedIdentity: expect.objectContaining({ id: REMOTE, remoteProjectId: REMOTE, selectedPath: "/work/project", machineId: MACHINE }),
      localProjectId: LOCAL,
      remoteProjectId: REMOTE,
      machineId: MACHINE,
    });
    expect(deps.resolveIdentity).toHaveBeenCalledWith(
      storage, { id: LOCAL, canonical: "/work/project", remoteProjectId: REMOTE }, HOME, "/work/project",
    );
  });

  it("keeps a null queue cutoff for a forward capture that had none", async () => {
    const deps = dependencies({
      inspectSnapshot: vi.fn(async () => ({ ...snapshot, receiptReference: { queueCutoff: null } })) as never,
    });
    const { input } = await resolveMigrationRollbackContext({ homeDir: HOME, generationId: GENERATION }, deps);
    expect(input.roster[0]!.queueCutoff).toBeNull();
  });

  it("refuses when the forward capture's participant is another machine", async () => {
    const deps = dependencies({ requireMachineIdentity: vi.fn(() => ({ machineId: "another-machine" })) as never });
    await expect(resolveMigrationRollbackContext({ homeDir: HOME, generationId: GENERATION }, deps))
      .rejects.toMatchObject({ name: "RollbackInputResolutionError", reason: "machine-mismatch" });
  });

  it("refuses when the configuration no longer selects PostgreSQL", async () => {
    const deps = dependencies({ readStorageConfig: vi.fn(() => ({ backend: "sqlite" as const })) });
    await expect(resolveMigrationRollbackContext({ homeDir: HOME, generationId: GENERATION }, deps))
      .rejects.toMatchObject({ reason: "backend-not-postgresql" });
  });

  it("refuses an unbound project, and a project missing from the map", async () => {
    const unbound = dependencies({
      readProjectMap: vi.fn(() => ({ [LOCAL]: { canonical: "/work/project", aliases: [] } })) as never,
    });
    await expect(resolveMigrationRollbackContext({ homeDir: HOME, generationId: GENERATION }, unbound))
      .rejects.toMatchObject({ reason: "project-unbound" });
    const missing = dependencies({ readProjectMap: vi.fn(() => ({})) as never });
    await expect(resolveMigrationRollbackContext({ homeDir: HOME, generationId: GENERATION }, missing))
      .rejects.toMatchObject({ reason: "project-unbound" });
  });

  it("reads the manifest and the configuration from the home directory by default", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "lcm-rollback-inputs-"));
    roots.push(homeDir);
    mkdirSync(join(homeDir, ".lcm"), { mode: 0o700 });
    writeFileSync(join(homeDir, ".lcm", "config.json"), JSON.stringify({ storage: { backend: "sqlite" } }), { mode: 0o600 });
    const witness = { version: 1 as const, backend: "sqlite" as const, identitySha256: "a".repeat(64), schemaSha256: "b".repeat(64), contentSha256: "c".repeat(64), capturedAt: "2026-09-06T00:00:00.000Z" };
    new MigrationManifestStore({ homeDir }).create(createMigrationManifest({
      generationId: GENERATION, source: witness, destination: { ...witness, backend: "postgresql" },
      parentGenerationId: null, preservedSourceGenerationId: PRESERVED, createdAt: "2026-09-06T00:00:00.000Z",
    }));
    const deps: ResolveRollbackContextDependencies = {
      ...DEFAULT_RESOLVE_ROLLBACK_CONTEXT_DEPENDENCIES,
      inspectSnapshot: vi.fn(async () => snapshot) as never,
      requireMachineIdentity: vi.fn(() => ({ machineId: MACHINE })) as never,
    };
    // The real manifest store and the real configuration reader are used: the manifest names the
    // preserved generation, and the (sqlite) configuration is read and refused.
    await expect(resolveMigrationRollbackContext({ homeDir, generationId: GENERATION }, deps))
      .rejects.toMatchObject({ reason: "backend-not-postgresql" });
    expect(deps.inspectSnapshot).toHaveBeenCalledWith(PRESERVED, homeDir);
  });
});

describe("createMigrationRollbackDependencies", () => {
  it("supplies the coordinator and a session opener bound to the resolved target", async () => {
    const coordinator = {} as unknown as BackendPublicationCoordinator;
    const target = {
      settings: storage.postgresql, expectedOwner: "lcm_owner", expectedIdentity: {} as StorageIdentityContext,
      localProjectId: LOCAL, remoteProjectId: REMOTE, machineId: MACHINE,
    } as unknown as RollbackSessionTarget;
    const createRuntime = vi.fn(() => { throw new Error("runtime construction reached"); });
    const deps = createMigrationRollbackDependencies({
      coordinator, target, sessionDependencies: { createRuntime } as unknown as RollbackSessionDependencies,
    });
    expect(deps.coordinator).toBe(coordinator);
    await expect(deps.openFencedSession({
      homeDir: HOME, manifest: { generationId: GENERATION } as MigrationManifest, lockToken: {} as never,
    })).rejects.toThrow("runtime construction reached");
    expect(createRuntime).toHaveBeenCalledWith(target.settings);
  });
});

describe("RollbackInputResolutionError", () => {
  it("names its reason", () => {
    expect(new RollbackInputResolutionError("project-unbound", "m")).toMatchObject({
      name: "RollbackInputResolutionError", reason: "project-unbound", message: "m",
    });
  });
});


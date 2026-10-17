import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { canonicalSha256, PORTABLE_RECORD_DOMAIN_ORDER, PORTABLE_RECORD_SCHEMA_SHA256 } from "../../src/storage/portable-record.js";
import type { StorageIdentityContext } from "../../src/storage/contracts.js";
import type { BackendPublicationLockToken } from "../../src/storage/backend-publication.js";
import type { PostgreSqlSnapshotSession } from "../../src/storage/postgresql/snapshot-session.js";
import {
  PostgreSqlBackendPublicationGuardError,
  type PostgreSqlBackendPublicationAcquireInput,
  type PostgreSqlBackendPublicationFence,
  type PostgreSqlBackendPublicationMutationInput,
} from "../../src/storage/postgresql/publication-guard.js";
import type { ActivationLeasePublicationGuard } from "../../src/migration/activation-lease.js";
import {
  createMigrationActivationWitness,
  migrationWitnessSha256,
} from "../../src/migration/activation-witness.js";
import type { MigrationManifest } from "../../src/migration/protocol.js";
import { deriveRollbackPublicationId, type RollbackFencedSession } from "../../src/migration/rollback.js";
import {
  DEFAULT_ROLLBACK_SESSION_DEPENDENCIES,
  ROLLBACK_LEASE_TTL_MS,
  RollbackSessionError,
  deriveRollbackProjectEvidenceSha256,
  openRollbackFencedSession,
  type RollbackProductionSession,
  type RollbackSessionDependencies,
  type RollbackSessionRuntime,
  type RollbackSessionTarget,
} from "../../src/migration/rollback-session.js";
import { buildMigrationCanonicalDelta, buildMigrationCensusVector } from "../../src/migration/verify-generation.js";
import {
  driftCanonicalDelta,
  fixtureActivationScenario,
  fixtureCanonicalDelta,
  fixtureCensusVector,
  fixtureDestinationIdentity,
  fixtureSchemaWitness,
  fixtureSha,
} from "../fixtures/migration-activation-records.js";

const GENERATION_ID = "gen-1";
const REMOTE = "0197a000-0000-7000-8000-000000000001";
const LOCAL = "local-project-1";
const MACHINE = "018f0b5d-1234-4abc-8def-1234567890ab";
const PUBLICATION_ID = deriveRollbackPublicationId(GENERATION_ID);
const EVIDENCE = deriveRollbackProjectEvidenceSha256({
  generationId: GENERATION_ID, publicationId: PUBLICATION_ID, localProjectId: LOCAL, remoteProjectId: REMOTE,
});

const target: RollbackSessionTarget = {
  settings: {
    url: "postgresql://example/db", caFile: "/ca.pem", poolMax: 1, connectionTimeoutMs: 1, idleTimeoutMs: 1,
    statementTimeoutMs: 1, snapshotIdleTimeoutMs: 1,
  },
  expectedOwner: "lcm_owner",
  expectedIdentity: {
    id: REMOTE, canonical: "/project", remoteProjectId: REMOTE, machineId: MACHINE, selectedPath: "/project",
  } as StorageIdentityContext,
  localProjectId: LOCAL,
  remoteProjectId: REMOTE,
  machineId: MACHINE,
};

const manifest = { generationId: GENERATION_ID } as unknown as MigrationManifest;
const lockToken = { token: "retained" } as unknown as BackendPublicationLockToken;
const openInput = { homeDir: "/home", manifest, lockToken, scratchParent: "/scratch" };

function fenceRow(overrides: Partial<PostgreSqlBackendPublicationFence> = {}): PostgreSqlBackendPublicationFence {
  return {
    projectId: REMOTE, machineId: MACHINE, publicationId: PUBLICATION_ID, targetBackend: "sqlite", evidenceSha256: EVIDENCE,
    fencingToken: 1n, acquiredAt: "t", renewedAt: "t", expiresAt: "t", releasedAt: null, databaseExpired: false,
    ...overrides,
  };
}

const guardError = (reason: PostgreSqlBackendPublicationGuardError["reason"]) =>
  new PostgreSqlBackendPublicationGuardError(REMOTE, "test", reason);

/** A stateful stand-in for the lcm.fenced_leases row with the guard's own acquire/renew/release preconditions. */
function statefulGuard(initial: PostgreSqlBackendPublicationFence | null = null) {
  const state: { row: PostgreSqlBackendPublicationFence | null } = { row: initial };
  const calls: string[] = [];
  const sameGeneration = (input: PostgreSqlBackendPublicationAcquireInput | PostgreSqlBackendPublicationMutationInput): boolean => (
    state.row !== null && state.row.publicationId === input.publicationId && state.row.machineId === input.machineId
    && state.row.targetBackend === input.targetBackend && state.row.evidenceSha256 === input.evidenceSha256
  );
  const active = (input: PostgreSqlBackendPublicationMutationInput): boolean => (
    sameGeneration(input) && state.row!.fencingToken === input.fencingToken
    && state.row!.releasedAt === null && !state.row!.databaseExpired
  );
  const guard: ActivationLeasePublicationGuard = {
    async acquire(input) {
      calls.push("acquire");
      if (state.row === null) return (state.row = fenceRow({ fencingToken: 1n }));
      if (!sameGeneration(input)) throw guardError("publication-conflict");
      if (!state.row.databaseExpired) return state.row;
      if (input.expectedFencingToken === undefined) throw guardError("fence-expired");
      if (input.expectedFencingToken !== state.row.fencingToken) throw guardError("fence-mismatch");
      return (state.row = fenceRow({ fencingToken: state.row.fencingToken + 1n }));
    },
    async renew(input) {
      calls.push("renew");
      if (!active(input)) throw guardError("fence-mismatch");
      return (state.row = { ...state.row!, renewedAt: "renewed" });
    },
    async release(input) {
      calls.push("release");
      if (!active(input)) throw guardError("fence-mismatch");
      return (state.row = { ...state.row!, releasedAt: "released" });
    },
    async read() {
      calls.push("read");
      return state.row;
    },
  };
  return { guard, state, calls };
}

function domainCensus(seed: string) {
  return PORTABLE_RECORD_DOMAIN_ORDER.map((domain, index) => ({
    domain, recordCount: index, prefixSha256: fixtureSha(seed + domain),
    terminalIdentitySha256: index === 0 ? null : fixtureSha(seed + domain + "terminal"),
  }));
}

function harness(options: Readonly<{
  guard?: ActivationLeasePublicationGuard;
  census?: ReturnType<typeof domainCensus>;
  overrides?: Partial<RollbackSessionDependencies>;
}> = {}) {
  const snapshots: Array<{ close: ReturnType<typeof vi.fn> }> = [];
  const runtime = {
    backendPublicationGuard: () => options.guard ?? statefulGuard().guard,
    openReadOnlySnapshot: vi.fn(async () => {
      const snapshot = { close: vi.fn(async () => undefined) };
      snapshots.push(snapshot);
      return snapshot as unknown as PostgreSqlSnapshotSession;
    }),
    close: vi.fn(async () => undefined),
  };
  const source = { close: vi.fn(async () => undefined) };
  const stream = { describe: vi.fn(), close: vi.fn(async () => undefined) };
  const census = options.census ?? domainCensus("session");
  const dependencies = {
    createRuntime: vi.fn(() => runtime as unknown as RollbackSessionRuntime),
    verifyRuntimeSchema: vi.fn(async () => undefined),
    assertReadOnlyGuard: vi.fn(async () => undefined),
    captureDestinationIdentity: vi.fn(async () => fixtureDestinationIdentity("dest")),
    captureDestinationSchemaWitness: vi.fn(async () => fixtureSchemaWitness("schema")),
    readFencedDestinationCensus: vi.fn(async () => ({
      census, dependencyEdges: new Map(), recordIdentities: new Map(), recordSha256s: new Map(),
    })),
    createPortableSource: vi.fn(async () => source),
    readDomainCensus: vi.fn((_source: unknown, domain: string) => census.find((entry) => entry.domain === domain)!),
    createStream: vi.fn(async () => stream),
    checkQuiescence: vi.fn(async () => ({
      status: "satisfied", reason: "quiescence-observed", detail: "held",
      quiescenceFence: { version: 1, kind: "lcm-activation-writer-quiescence-v1", payload: "{\"held\":true}", evidenceSha256: "a".repeat(64) },
    })),
    ...options.overrides,
  } as unknown as RollbackSessionDependencies & Record<string, ReturnType<typeof vi.fn>>;
  return { runtime, snapshots, source, stream, census, dependencies };
}

const open = (h: ReturnType<typeof harness>, input = openInput) =>
  openRollbackFencedSession(input, target, h.dependencies);

describe("deriveRollbackProjectEvidenceSha256", () => {
  it("is the canonical digest of the rollback-project-evidence record", () => {
    expect(EVIDENCE).toBe(canonicalSha256({
      version: 1, kind: "rollback-project-evidence", generationId: GENERATION_ID, publicationId: PUBLICATION_ID,
      localProjectId: LOCAL, remoteProjectId: REMOTE,
    }));
  });

  it("changes with every field it binds", () => {
    const base = { generationId: GENERATION_ID, publicationId: PUBLICATION_ID, localProjectId: LOCAL, remoteProjectId: REMOTE };
    for (const key of Object.keys(base) as Array<keyof typeof base>) {
      expect(deriveRollbackProjectEvidenceSha256({ ...base, [key]: "other" })).not.toBe(EVIDENCE);
    }
  });
});

describe("openRollbackFencedSession: opening", () => {
  it("acquires the coordinator's lease tuple under quiescence and mints the selection authority from the fence", async () => {
    const { guard, state, calls } = statefulGuard();
    const h = harness({ guard });
    const acquire = vi.spyOn(guard, "acquire");
    const session = await open(h);

    expect(acquire).toHaveBeenCalledWith({
      projectId: REMOTE, machineId: MACHINE, publicationId: PUBLICATION_ID, targetBackend: "sqlite",
      evidenceSha256: EVIDENCE, ttlMs: ROLLBACK_LEASE_TTL_MS, signal: undefined,
    });
    expect(state.row?.fencingToken).toBe(1n);
    expect(session.selectionAuthority).toEqual({
      version: 1, resourceType: "backend-publication", resourceKey: "selection", fencingToken: "1",
      ownerProcessId: PUBLICATION_ID,
    });
    expect(h.dependencies.checkQuiescence).toHaveBeenCalledWith({ homeDir: "/home", lockToken });
    expect(session.quiescenceFenceEvidenceSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(calls).toEqual(["acquire"]);
    await session.release();
  });

  it("takes over this rollback's own expired lease from a crashed earlier attempt", async () => {
    const { guard, state } = statefulGuard(fenceRow({ databaseExpired: true, fencingToken: 4n }));
    const h = harness({ guard });
    const session = await open(h);
    expect(state.row).toMatchObject({ fencingToken: 5n, databaseExpired: false });
    expect(session.selectionAuthority.fencingToken).toBe("5");
    await session.release();
  });

  it("refuses when a different publication holds the lease, closing the runtime", async () => {
    const { guard } = statefulGuard(fenceRow({ publicationId: "someone-else" }));
    const h = harness({ guard });
    await expect(open(h)).rejects.toMatchObject({ name: "RollbackSessionError", reason: "lease-unavailable" });
    expect(h.runtime.close).toHaveBeenCalledTimes(1);
    expect(h.dependencies.checkQuiescence).not.toHaveBeenCalled();
  });

  it("refuses when the expired lease cannot be read back for takeover", async () => {
    const { guard } = statefulGuard(fenceRow({ databaseExpired: true }));
    guard.read = async () => null;
    await expect(open(harness({ guard }))).rejects.toMatchObject({ reason: "lease-unavailable" });
  });

  it("refuses when the takeover loses its compare-and-swap", async () => {
    const { guard, state } = statefulGuard(fenceRow({ databaseExpired: true, fencingToken: 2n }));
    const realRead = guard.read.bind(guard);
    // The token moves between the read and the takeover.
    guard.read = async (input) => {
      const row = await realRead(input);
      state.row = { ...state.row!, fencingToken: 9n };
      return row;
    };
    await expect(open(harness({ guard }))).rejects.toMatchObject({ reason: "lease-unavailable" });
  });

  it("releases the lease it just acquired and closes the runtime when quiescence is not satisfied", async () => {
    const { guard, state } = statefulGuard();
    const h = harness({
      guard,
      overrides: {
        checkQuiescence: vi.fn(async () => ({
          status: "unsatisfied", reason: "maintenance-not-held", detail: "maintenance is not held", quiescenceFence: null,
        })),
      } as never,
    });
    await expect(open(h)).rejects.toMatchObject({ reason: "quiescence-unsatisfied", message: "maintenance is not held" });
    expect(state.row?.releasedAt).toBe("released");
    expect(h.runtime.close).toHaveBeenCalledTimes(1);
  });

  it("reports the original error even when releasing during cleanup also fails", async () => {
    const { guard } = statefulGuard();
    guard.release = async () => { throw new Error("release is down"); };
    const h = harness({
      guard,
      overrides: { checkQuiescence: vi.fn(async () => { throw new Error("quiescence probe crashed"); }) } as never,
    });
    await expect(open(h)).rejects.toThrow("quiescence probe crashed");
  });

  it("closes the runtime, and acquires nothing, when the schema admission fails", async () => {
    const { guard, calls } = statefulGuard();
    const h = harness({
      guard,
      overrides: { verifyRuntimeSchema: vi.fn(async () => { throw new Error("schema is not admitted"); }) } as never,
    });
    await expect(open(h)).rejects.toThrow("schema is not admitted");
    expect(calls).toEqual([]);
    expect(h.runtime.close).toHaveBeenCalledTimes(1);
  });

  it("swallows a failing runtime close during cleanup of a failed open", async () => {
    const h = harness({
      overrides: { verifyRuntimeSchema: vi.fn(async () => { throw new Error("schema is not admitted"); }) } as never,
    });
    h.runtime.close.mockRejectedValue(new Error("pool close failed"));
    await expect(open(h)).rejects.toThrow("schema is not admitted");
  });

  it("scratches under the OS temp directory when the caller names none", async () => {
    const h = harness();
    const session = await open(h, { homeDir: "/home", manifest, lockToken } as never);
    await session.captureReadback({ manifestDestinationWitnessSha256: "a".repeat(64), canonicalDeltaBaseline: fixtureCanonicalDelta("b") });
    const call = (h.dependencies.readFencedDestinationCensus as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(typeof (call[1] as { scratchParent: string }).scratchParent).toBe("string");
    expect((call[1] as { scratchParent: string }).scratchParent.length).toBeGreaterThan(0);
    await session.release();
  });

  it("builds a real PostgreSQL runtime by default, without connecting until used", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lcm-rollback-session-ca-"));
    try {
      const caFile = join(directory, "ca.pem");
      writeFileSync(caFile, "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n");
      const runtime = DEFAULT_ROLLBACK_SESSION_DEPENDENCIES.createRuntime({
        ...target.settings, url: "postgresql://user:secret@127.0.0.1:1/db", caFile,
      });
      expect(typeof runtime.backendPublicationGuard).toBe("function");
      await runtime.close();
    } finally {
      rmSync(directory, { recursive: true });
    }
  });

  it("uses the real collaborators by default", () => {
    expect(Object.keys(DEFAULT_ROLLBACK_SESSION_DEPENDENCIES).sort()).toEqual([
      "assertReadOnlyGuard", "captureDestinationIdentity", "captureDestinationSchemaWitness", "checkQuiescence",
      "createPortableSource", "createRuntime", "createStream", "readDomainCensus", "readFencedDestinationCensus",
      "verifyRuntimeSchema",
    ]);
  });
});

describe("renew", () => {
  it("renews the lease and then asserts the same identity", async () => {
    const { guard, calls } = statefulGuard();
    const session = await open(harness({ guard }));
    await session.renew();
    expect(calls).toEqual(["acquire", "renew", "read"]);
  });

  it("throws when the lease cannot be renewed (expired), never rotating the token silently", async () => {
    const { guard, state } = statefulGuard();
    const session = await open(harness({ guard }));
    state.row = { ...state.row!, databaseExpired: true };
    await expect(session.renew()).rejects.toMatchObject({ name: "RollbackSessionError", reason: "lease-lost" });
    expect(state.row.fencingToken).toBe(1n);
  });

  it("throws when the renewed lease no longer asserts as held", async () => {
    const { guard } = statefulGuard();
    const session = await open(harness({ guard }));
    guard.read = async () => fenceRow({ publicationId: "taken-over-by-another" });
    await expect(session.renew()).rejects.toMatchObject({ reason: "lease-lost" });
  });

  it("throws when the fence was released underneath the session", async () => {
    const { guard, state } = statefulGuard();
    const session = await open(harness({ guard }));
    state.row = { ...state.row!, releasedAt: "released-elsewhere" };
    await expect(session.renew()).rejects.toMatchObject({ reason: "lease-lost" });
  });
});

describe("captureReadback", () => {
  const witnessSha = "a".repeat(64);

  it("captures identity alone for an unactivated readback, scanning no census", async () => {
    const h = harness();
    const session = await open(h);
    const observation = await session.captureReadback({ manifestDestinationWitnessSha256: witnessSha, canonicalDeltaBaseline: null });
    expect(observation).toEqual({
      observedPortableRecordSchemaSha256: PORTABLE_RECORD_SCHEMA_SHA256,
      destinationIdentity: fixtureDestinationIdentity("dest"),
      postEpochDelta: null,
      postEpochCensus: null,
      manifestDestinationWitnessSha256: witnessSha,
    });
    expect(h.dependencies.readFencedDestinationCensus).not.toHaveBeenCalled();
    expect(h.snapshots).toHaveLength(1);
    expect(h.snapshots[0]!.close).toHaveBeenCalledTimes(1);
  });

  it("derives the delta and the census vector from ONE census scan, and captures the census only when the delta equals the baseline", async () => {
    const h = harness();
    const session = await open(h);
    const delta = buildMigrationCanonicalDelta(h.census);
    const equal = await session.captureReadback({ manifestDestinationWitnessSha256: witnessSha, canonicalDeltaBaseline: delta });
    expect(equal.postEpochDelta).toEqual(delta);
    expect(equal.postEpochCensus).toEqual(buildMigrationCensusVector(h.census));
    expect(h.dependencies.readFencedDestinationCensus).toHaveBeenCalledTimes(1);

    const changed = await session.captureReadback({
      manifestDestinationWitnessSha256: witnessSha, canonicalDeltaBaseline: driftCanonicalDelta(delta, 0),
    });
    expect(changed.postEpochDelta).toEqual(delta);
    expect(changed.postEpochCensus).toBeNull();
    // Each call used its own snapshot, and one scan each.
    expect(h.snapshots).toHaveLength(2);
    expect(h.dependencies.readFencedDestinationCensus).toHaveBeenCalledTimes(2);
  });

  it("captures the census for a changed delta when asked to", async () => {
    const h = harness();
    const session = await open(h);
    const delta = driftCanonicalDelta(buildMigrationCanonicalDelta(h.census), 2);
    const observation = await session.captureReadback({
      manifestDestinationWitnessSha256: witnessSha, canonicalDeltaBaseline: delta, requireCensus: true,
    });
    expect(observation.postEpochCensus).toEqual(buildMigrationCensusVector(h.census));
  });

  it("admits each snapshot (read-only guard, schema) and reads the census inside it", async () => {
    const h = harness();
    const session = await open(h);
    await session.captureReadback({ manifestDestinationWitnessSha256: witnessSha, canonicalDeltaBaseline: fixtureCanonicalDelta("x") });
    const snapshot = await (h.runtime.openReadOnlySnapshot as ReturnType<typeof vi.fn>).mock.results[0]!.value;
    expect(h.dependencies.assertReadOnlyGuard).toHaveBeenCalledWith(snapshot, undefined);
    expect(h.dependencies.verifyRuntimeSchema).toHaveBeenCalledWith(snapshot, { expectedOwner: "lcm_owner", signal: undefined });
    expect(h.dependencies.captureDestinationIdentity).toHaveBeenCalledWith(snapshot, REMOTE, undefined);
    expect(h.dependencies.readFencedDestinationCensus).toHaveBeenCalledWith(snapshot, {
      settings: target.settings, expectedOwner: "lcm_owner", expectedIdentity: target.expectedIdentity,
      scratchParent: "/scratch", signal: undefined,
    });
  });

  it("closes the snapshot when a capture fails", async () => {
    const h = harness({
      overrides: { captureDestinationIdentity: vi.fn(async () => { throw new Error("identity read failed"); }) } as never,
    });
    const session = await open(h);
    await expect(session.captureReadback({ manifestDestinationWitnessSha256: witnessSha, canonicalDeltaBaseline: null }))
      .rejects.toThrow("identity read failed");
    expect(h.snapshots[0]!.close).toHaveBeenCalledTimes(1);
  });

  it("refuses a destination outside the pinned schema contract", async () => {
    const h = harness({
      overrides: { captureDestinationSchemaWitness: vi.fn(async () => { throw new Error("schema outside contract"); }) } as never,
    });
    const session = await open(h);
    await expect(session.captureReadback({ manifestDestinationWitnessSha256: witnessSha, canonicalDeltaBaseline: fixtureCanonicalDelta("x") }))
      .rejects.toThrow("schema outside contract");
  });
});

describe("openPortableSource", () => {
  it("returns the stream with the delta and census of the very snapshot it reads, from the same domain census", async () => {
    const h = harness();
    const session = await open(h);
    const exported = await session.openPortableSource();
    // The stream delegates to the one createStream built (its close additionally closes the export snapshot).
    h.stream.describe.mockReturnValue("manifest");
    h.stream.readBatch = vi.fn(async () => "batch");
    h.stream.verify = vi.fn(async () => "verified");
    expect(exported.stream.describe()).toBe("manifest");
    await expect(exported.stream.readBatch({} as never)).resolves.toBe("batch");
    await expect(exported.stream.verify({} as never)).resolves.toBe("verified");
    expect(exported.canonicalDelta).toEqual(buildMigrationCanonicalDelta(h.census));
    expect(exported.censusVector).toEqual(buildMigrationCensusVector(h.census));
    const snapshot = await (h.runtime.openReadOnlySnapshot as ReturnType<typeof vi.fn>).mock.results[0]!.value;
    expect(h.dependencies.createPortableSource).toHaveBeenCalledWith({
      settings: target.settings, expectedOwner: "lcm_owner", expectedIdentity: target.expectedIdentity,
      scratchParent: "/scratch", signal: undefined, session: snapshot,
    });
    // The export snapshot stays open for the export; release() closes it.
    expect(h.snapshots[0]!.close).not.toHaveBeenCalled();
    await session.release();
    expect(h.snapshots[0]!.close).toHaveBeenCalledTimes(1);
  });

  it("F4: closing the stream closes the export snapshot, so a one-connection pool can renew and read back after it", async () => {
    let held = 0;
    const h = harness();
    h.runtime.openReadOnlySnapshot = vi.fn(async () => {
      if (held >= 1) throw new Error("pool exhausted: the export snapshot still holds the only connection");
      held += 1;
      const snapshot = { close: vi.fn(async () => { held -= 1; }) };
      h.snapshots.push(snapshot);
      return snapshot as unknown as PostgreSqlSnapshotSession;
    });
    const session = await open(h);
    const exported = await session.openPortableSource();
    await exported.stream.close();
    expect(held).toBe(0);
    await session.renew();
    await expect(session.captureReadback({ manifestDestinationWitnessSha256: "a".repeat(64), canonicalDeltaBaseline: fixtureCanonicalDelta("x") }))
      .resolves.toBeDefined();
    await session.release();
  });

  it("F4: the stream's close closes the snapshot once, whatever the stream's own close does, and release() does not close it again", async () => {
    const h = harness();
    const session = await open(h);
    const exported = await session.openPortableSource();
    await exported.stream.close();
    await exported.stream.close();
    expect(h.stream.close).toHaveBeenCalledTimes(1);
    expect(h.snapshots[0]!.close).toHaveBeenCalledTimes(1);
    await session.release();
    expect(h.snapshots[0]!.close).toHaveBeenCalledTimes(1);
  });

  it("F4: the snapshot is closed even when the stream's close fails, and the stream's failure is the one reported", async () => {
    const h = harness();
    h.stream.close.mockRejectedValue(new Error("stream close failed"));
    const session = await open(h);
    const exported = await session.openPortableSource();
    h.snapshots[0]!.close.mockRejectedValue(new Error("snapshot close failed"));
    await expect(exported.stream.close()).rejects.toThrow("stream close failed");
    expect(h.snapshots[0]!.close).toHaveBeenCalledTimes(1);
    await session.release();
  });

  it("F4: a failing snapshot close after a successful stream close is reported", async () => {
    const h = harness();
    const session = await open(h);
    const exported = await session.openPortableSource();
    h.snapshots[0]!.close.mockRejectedValue(new Error("snapshot close failed"));
    await expect(exported.stream.close()).rejects.toThrow("snapshot close failed");
    await session.release();
  });

  it("closes the source and the snapshot when the stream cannot be built", async () => {
    const h = harness({ overrides: { createStream: vi.fn(async () => { throw new Error("stream failed"); }) } as never });
    const session = await open(h);
    await expect(session.openPortableSource()).rejects.toThrow("stream failed");
    expect(h.source.close).toHaveBeenCalledTimes(1);
    expect(h.snapshots[0]!.close).toHaveBeenCalledTimes(1);
  });

  it("still reports the original error when closing the source and the snapshot also fail", async () => {
    const h = harness({ overrides: { createStream: vi.fn(async () => { throw new Error("stream failed"); }) } as never });
    h.source.close.mockRejectedValue(new Error("source close failed"));
    const session = await open(h);
    h.snapshots.length = 0;
    const pending = session.openPortableSource();
    await vi.waitFor(() => expect(h.snapshots).toHaveLength(1));
    h.snapshots[0]!.close.mockRejectedValue(new Error("snapshot close failed"));
    await expect(pending).rejects.toThrow("stream failed");
  });

  it("closes the snapshot when the source cannot be opened", async () => {
    const h = harness({ overrides: { createPortableSource: vi.fn(async () => { throw new Error("source failed"); }) } as never });
    const session = await open(h);
    await expect(session.openPortableSource()).rejects.toThrow("source failed");
    expect(h.snapshots[0]!.close).toHaveBeenCalledTimes(1);
  });

  it("closes the snapshot when the snapshot's own admission fails, even if that close also fails", async () => {
    const h = harness({ overrides: { assertReadOnlyGuard: vi.fn(async () => { throw new Error("not read-only"); }) } as never });
    const session = await open(h);
    const pending = session.openPortableSource();
    await vi.waitFor(() => expect(h.snapshots).toHaveLength(1));
    h.snapshots[0]!.close.mockRejectedValue(new Error("snapshot close failed"));
    await expect(pending).rejects.toThrow("not read-only");
    expect(h.snapshots[0]!.close).toHaveBeenCalled();
  });
});

describe("computeRollbackTerminalEvidenceSha256", () => {
  const observation = {
    observedPortableRecordSchemaSha256: PORTABLE_RECORD_SCHEMA_SHA256,
    destinationIdentity: fixtureDestinationIdentity("dest"),
    postEpochDelta: fixtureCanonicalDelta("terminal-delta"),
    postEpochCensus: null,
    manifestDestinationWitnessSha256: "a".repeat(64),
  };

  it("is the rollback witness checksum of the epoch and attempt it unwinds", async () => {
    const session = await open(harness());
    const scenario = fixtureActivationScenario({ canonicalDeltaBaseline: fixtureCanonicalDelta("baseline") });
    const delta = driftCanonicalDelta(scenario.attempt.canonicalDeltaBaseline, 0);
    const expected = createMigrationActivationWitness({
      kind: "rollback", epoch: scenario.epoch, attempt: scenario.attempt,
      postEpochDelta: delta, postEpochCensus: null, rollbackMode: "post-write",
    }).checksumSha256;
    expect(session.computeRollbackTerminalEvidenceSha256({
      epoch: scenario.epoch, attempt: scenario.attempt, observation: { ...observation, postEpochDelta: delta }, mode: "post-write",
    })).toBe(expected);
  });

  it("derives a deterministic unactivated digest from the mode and destination identity", async () => {
    const session = await open(harness());
    const digest = session.computeRollbackTerminalEvidenceSha256({ epoch: null, attempt: null, observation, mode: "pre-write" });
    expect(digest).toBe(migrationWitnessSha256([
      "lcm-rollback-unactivated-terminal-evidence-v1", "pre-write", fixtureDestinationIdentity("dest"),
    ]));
  });
});

describe("release", () => {
  it("releases the lease, closes the runtime, and is idempotent", async () => {
    const { guard, state, calls } = statefulGuard();
    const h = harness({ guard });
    const session = await open(h);
    await session.release();
    expect(state.row?.releasedAt).toBe("released");
    expect(h.runtime.close).toHaveBeenCalledTimes(1);
    await session.release();
    expect(calls.filter((call) => call === "release")).toHaveLength(1);
  });

  it("treats an already-released lease as released", async () => {
    const { guard, state } = statefulGuard();
    const session = await open(harness({ guard }));
    state.row = { ...state.row!, releasedAt: "earlier" };
    await expect(session.release()).resolves.toBeUndefined();
  });

  it("takes over its own expired lease, then releases the fresh fence", async () => {
    const { guard, state } = statefulGuard();
    const h = harness({ guard });
    const session = await open(h);
    state.row = { ...state.row!, databaseExpired: true };
    await session.release();
    expect(state.row).toMatchObject({ fencingToken: 2n, releasedAt: "released" });
    expect(h.runtime.close).toHaveBeenCalledTimes(1);
  });

  it("surfaces a failed takeover of an expired lease", async () => {
    const { guard, state } = statefulGuard();
    const session = await open(harness({ guard }));
    state.row = { ...state.row!, databaseExpired: true };
    const realAcquire = guard.acquire.bind(guard);
    guard.acquire = async (input) => { state.row = { ...state.row!, fencingToken: 7n }; return realAcquire(input); };
    await expect(session.release()).rejects.toMatchObject({ name: "RollbackSessionError", reason: "release-failed" });
  });

  it("surfaces a release that fails even after a successful takeover", async () => {
    const { guard, state } = statefulGuard();
    const session = await open(harness({ guard }));
    state.row = { ...state.row!, databaseExpired: true };
    const realRelease = guard.release.bind(guard);
    let calls = 0;
    guard.release = async (input) => {
      calls += 1;
      if (calls === 1) return realRelease(input);
      throw guardError("fence-mismatch");
    };
    state.row = { ...state.row!, databaseExpired: true };
    await expect(session.release()).rejects.toMatchObject({ reason: "release-failed" });
  });

  it("surfaces a release the guard refuses, still closing the runtime", async () => {
    const { guard, state } = statefulGuard();
    const h = harness({ guard });
    const session = await open(h);
    state.row = { ...state.row!, publicationId: "another-publication" };
    await expect(session.release()).rejects.toMatchObject({ name: "RollbackSessionError", reason: "release-failed" });
    expect(h.runtime.close).toHaveBeenCalledTimes(1);
  });

  it("surfaces a failing snapshot close and a failing runtime close, reporting the first failure", async () => {
    const h = harness();
    const session = await open(h);
    await session.openPortableSource();
    h.snapshots[0]!.close.mockRejectedValue(new Error("snapshot close failed"));
    h.runtime.close.mockRejectedValue(new Error("runtime close failed"));
    await expect(session.release()).rejects.toThrow("snapshot close failed");
    expect(h.runtime.close).toHaveBeenCalledTimes(1);
  });

  it("surfaces a failing runtime close on its own", async () => {
    const h = harness();
    const session = await open(h);
    h.runtime.close.mockRejectedValue(new Error("runtime close failed"));
    await expect(session.release()).rejects.toThrow("runtime close failed");
  });

  describe("after the coordinator acquired the lease", () => {
    it("never releases itself, and accepts a row the coordinator released", async () => {
      const { guard, state, calls } = statefulGuard();
      const h = harness({ guard });
      const session = await open(h) as RollbackProductionSession;
      session.markCoordinatorAcquired();
      state.row = { ...state.row!, releasedAt: "released-by-coordinator" };
      await session.release();
      expect(calls).not.toContain("release");
      expect(h.runtime.close).toHaveBeenCalledTimes(1);
    });

    it("refuses when the row is still held", async () => {
      const session = await open(harness()) as RollbackProductionSession;
      session.markCoordinatorAcquired();
      await expect(session.release()).rejects.toMatchObject({ reason: "release-failed" });
    });

    it("refuses when the row is gone", async () => {
      const { guard } = statefulGuard();
      const session = await open(harness({ guard })) as RollbackProductionSession;
      session.markCoordinatorAcquired();
      guard.read = async () => null;
      await expect(session.release()).rejects.toMatchObject({ reason: "release-failed" });
    });
  });
});

describe("RollbackSessionError", () => {
  it("carries its reason and is a named Error", () => {
    const error = new RollbackSessionError("lease-lost", "lost", { cause: "x" });
    expect(error).toMatchObject({ name: "RollbackSessionError", reason: "lease-lost", message: "lost", cause: "x" });
  });
});

// Type-level: the production session satisfies the orchestration's interface.
const _typeCheck: (session: RollbackProductionSession) => RollbackFencedSession = (session) => session;
void _typeCheck;


/**
 * #626 F11: a rollback whose maintenance selection was already attempted recovers through the REAL fenced-session
 * opener and the REAL recovery admission (no stand-in for either), over the real coordinator, journals and
 * stores. Only the PostgreSQL row (a stateful lease stand-in with the guard's own acquire semantics) and the
 * census reads are faked; the first-open quiescence is a stand-in only for the first attempt, which the strict
 * checkActivationWriterQuiescence legitimately handles elsewhere.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BackendPublicationCoordinator,
  backendPublicationCanonicalSha256,
  backendPublicationJournalPath,
  readBackendMaintenanceJournal,
  readBackendPublicationJournal,
  withBackendPublicationAppendBarrierAsync,
  type BackendPublicationLockToken,
  type BackendPublicationPhase,
} from "../../src/storage/backend-publication.js";
import { createPostgreSqlBackendPublicationRemoteGuard } from "../../src/storage/postgresql/publication-remote-guard.js";
import { PORTABLE_RECORD_DOMAIN_ORDER } from "../../src/storage/portable-record.js";
import type { ActivationLeasePublicationGuard } from "../../src/migration/activation-lease.js";
import { checkActivationWriterQuiescence } from "../../src/migration/activation-quiescence.js";
import { MigrationManifestStore } from "../../src/migration/manifest-store.js";
import {
  beginMigrationEffect,
  completeMigrationEffect,
  createMigrationManifest,
  type MigrationManifest,
} from "../../src/migration/protocol.js";
import {
  recordMigrationActivationAttempt,
  recordMigrationActivationEpoch,
  recordMigrationActivationWitness,
} from "../../src/migration/activation-evidence-store.js";
import {
  recordMigrationSelectionBinding,
  recordMigrationWitnessBinding,
  resolveMigrationWitnessBindings,
} from "../../src/migration/generation-binding-store.js";
import { assertMigrationReplayAdmission } from "../../src/migration/maintenance.js";
import {
  deriveRollbackPublicationId,
  readOwnPublicationSourceFromMaterial,
  runMigrationRollback,
  type RunMigrationRollbackDependencies,
  type RunMigrationRollbackInput,
} from "../../src/migration/rollback.js";
import {
  DEFAULT_ROLLBACK_SESSION_DEPENDENCIES,
  checkRollbackRecoveryAdmission,
  openRollbackFencedSession,
  type RollbackSessionDependencies,
  type RollbackSessionTarget,
} from "../../src/migration/rollback-session.js";
import { buildMigrationCanonicalDelta, buildMigrationCensusVector } from "../../src/migration/verify-generation.js";
import {
  FIXTURE_LOCAL_PROJECT_ID as LOCAL,
  FIXTURE_REMOTE_PROJECT_ID as REMOTE,
  activationPublicationMaterial,
  publicationMaterial,
  rollbackFixtureCoordinator,
  rollbackPublicationMaterial,
  workingPublicationDriver,
} from "../fixtures/backend-publication-driver.js";
import { fixtureActivationScenario, fixtureDestinationIdentity } from "../fixtures/migration-activation-records.js";

const GEN = "gen-recovery";
// UUIDv7: the production remote-guard provider (shared-lease tests below) normalizes the machine id as one.
const MACHINE = "018f0b5d-1234-7abc-8def-1234567890ab";
const OTHER_MACHINE = "018f0b5d-1234-7abc-8def-1234567890ff";
const capturedAt = "2026-09-06T00:00:00.000Z";
const PUBLICATION_ID = deriveRollbackPublicationId(GEN);

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "lcm-rollback-recovery-"));
  mkdirSync(join(dir, ".lcm"), { mode: 0o700 });
  dirs.push(dir);
  return dir;
}

type LeaseRow = {
  projectId: string; machineId: string; publicationId: string; targetBackend: "sqlite"; evidenceSha256: string;
  fencingToken: bigint; acquiredAt: string; renewedAt: string; expiresAt: string; releasedAt: string | null; databaseExpired: boolean;
};

/**
 * The lcm.fenced_leases row: acquire returns the live row of the same tuple and replaces a released one with a
 * fresh fencing token, as the real guard does (publication-guard.ts acquire).
 */
function leaseStandIn() {
  const state: { row: LeaseRow | null } = { row: null };
  const calls: string[] = [];
  let nextToken = 1n;
  const guard = {
    async acquire(input: Omit<LeaseRow, "fencingToken" | "acquiredAt" | "renewedAt" | "expiresAt" | "releasedAt" | "databaseExpired">) {
      calls.push("acquire");
      if (state.row !== null && state.row.releasedAt === null) return state.row;
      state.row = {
        projectId: input.projectId, machineId: input.machineId, publicationId: input.publicationId,
        targetBackend: input.targetBackend, evidenceSha256: input.evidenceSha256, fencingToken: nextToken++,
        acquiredAt: capturedAt, renewedAt: capturedAt, expiresAt: "2999-01-01T00:00:00.000Z", releasedAt: null, databaseExpired: false,
      };
      return state.row;
    },
    async renew() { calls.push("renew"); return state.row!; },
    async read() { calls.push("read"); return state.row; },
    async release() { calls.push("release"); state.row = { ...state.row!, releasedAt: capturedAt }; return state.row; },
  } as unknown as ActivationLeasePublicationGuard;
  return { guard, state, calls };
}

const destinationIdentity = fixtureDestinationIdentity("recovery");
const census = PORTABLE_RECORD_DOMAIN_ORDER.map((domain) => ({
  domain, recordCount: 0, prefixSha256: "a".repeat(64), terminalIdentitySha256: null,
}));
const baseline = buildMigrationCanonicalDelta(census);
const baselineCensus = buildMigrationCensusVector(census);

function setup() {
  const homeDir = tempHome();
  const lease = leaseStandIn();
  let observed = census;
  const target: RollbackSessionTarget = {
    settings: { poolMax: 5 } as never, expectedOwner: "owner",
    expectedIdentity: { id: REMOTE } as never, localProjectId: LOCAL, remoteProjectId: REMOTE, machineId: MACHINE,
  };
  // The first open stays a stand-in; the recovery open uses the default (real) admission.
  const sessionDependencies: RollbackSessionDependencies = {
    ...DEFAULT_ROLLBACK_SESSION_DEPENDENCIES,
    createRuntime: () => ({
      backendPublicationGuard: () => lease.guard,
      openReadOnlySnapshot: async () => ({ close: async () => undefined }),
      close: async () => undefined,
    }) as never,
    verifyRuntimeSchema: async () => undefined,
    assertReadOnlyGuard: async () => undefined,
    captureDestinationIdentity: async () => destinationIdentity,
    captureDestinationSchemaWitness: async () => undefined as never,
    readFencedDestinationCensus: async () => ({ census: observed }) as never,
    checkQuiescence: async () => ({
      status: "satisfied", reason: "quiescence-observed", detail: "test barrier",
      quiescenceFence: { version: 1, kind: "lcm-activation-writer-quiescence-v1", payload: "{}", evidenceSha256: "a".repeat(64) },
    }),
  };
  const store = new MigrationManifestStore({ homeDir });
  let manifest: MigrationManifest = store.create(createMigrationManifest({
    generationId: GEN,
    source: { version: 1, backend: "sqlite", identitySha256: "1".repeat(64), schemaSha256: "2".repeat(64), contentSha256: "3".repeat(64), capturedAt },
    destination: { version: 1, backend: "postgresql", identitySha256: "1".repeat(64), schemaSha256: "2".repeat(64), contentSha256: "3".repeat(64), capturedAt },
    parentGenerationId: null, preservedSourceGenerationId: GEN, createdAt: capturedAt,
  }));
  const step = (kind: string, extra: Record<string, unknown> = {}): void => {
    manifest = store.update(GEN, manifest.checksumSha256, (current) => beginMigrationEffect(current, {
      kind: kind as never, effectId: kind, inputSha256: "a".repeat(64), startedAt: capturedAt,
    }));
    manifest = store.update(GEN, manifest.checksumSha256, (current) => completeMigrationEffect(current, {
      effectId: kind, completedAt: capturedAt, ...extra,
    }));
  };
  step("verify-dry-run", { report: { kind: "dry-run", reportId: "r1", reportSha256: "b".repeat(64), createdAt: capturedAt } });
  step("copy-batch", { checkpoint: { domain: "conversations", ordinal: 1, recordCount: 1, sourceCheckpointSha256: "c".repeat(64), destinationCommitSha256: "d".repeat(64) } });
  step("complete-copy");
  step("verify-generation", {
    report: { kind: "verification", reportId: "r2", reportSha256: "b".repeat(64), createdAt: capturedAt },
    activationEligible: true,
  });
  const scenario = fixtureActivationScenario({
    generationId: GEN, destinationIdentity, censusVector: baselineCensus, canonicalDeltaBaseline: baseline,
  });
  recordMigrationActivationEpoch({ homeDir, epoch: scenario.epoch });
  recordMigrationActivationAttempt({ homeDir, generationId: GEN, attempt: scenario.attempt });
  recordMigrationActivationWitness({ homeDir, generationId: GEN, witness: scenario.witness });
  recordMigrationWitnessBinding({ homeDir, generationId: GEN, binding: scenario.witnessBinding });
  recordMigrationSelectionBinding({ homeDir, generationId: GEN, binding: scenario.selection });

  const input: RunMigrationRollbackInput = {
    homeDir, generationId: GEN, canonicalPath: join(homeDir, "live.sqlite"),
    projectIdentity: { scope: "shared", projectId: REMOTE } as never, localProjectId: LOCAL,
    sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64),
    roster: [{ machineId: MACHINE, queueCutoff: null, evidenceSha256: "7".repeat(64) }],
  };
  const opens: Array<{ recovery: boolean }> = [];
  /** The coordinator publishes through the in-memory driver; its completion releases the lease row, as the real remote guard does. */
  const coordinator = (): BackendPublicationCoordinator => {
    const real = rollbackFixtureCoordinator(homeDir);
    const resume = real.resume.bind(real);
    real.resume = async (...args) => {
      const journal = await resume(...args);
      if (lease.state.row !== null && lease.state.row.releasedAt === null) await lease.guard.release({} as never);
      return journal;
    };
    return real;
  };
  /**
   * The real coordinator over the in-memory publication driver and the PRODUCTION PostgreSQL remote-guard provider,
   * both bound to the very lease row the session acquires: the coordinator adopts, takes over and releases the
   * session's lease exactly as it does against PostgreSQL. crashAt throws once the journal is durably at that
   * phase (or right after the remote release, before the journal records it).
   */
  const sharedLeaseCoordinator = (
    crashAt?: BackendPublicationPhase | "after-release" | "before-material-seal" | "after-material-seal",
  ): BackendPublicationCoordinator => {
    let armed = crashAt !== undefined;
    return new BackendPublicationCoordinator({
      homeDir,
      driver: {
        ...workingPublicationDriver(rollbackPublicationMaterial()),
        ...createPostgreSqlBackendPublicationRemoteGuard({ guard: lease.guard as never, machineId: MACHINE, ttlMs: 15 * 60 * 1000 }),
      },
      observer: (event) => {
        if (!armed) return;
        const hit = crashAt === "after-release" || crashAt === "before-material-seal" || crashAt === "after-material-seal"
          ? event === crashAt
          : event === "after-journal-write" && readBackendPublicationJournal(homeDir)?.phase === crashAt;
        if (!hit) return;
        armed = false;
        throw new Error("crash at " + crashAt);
      },
    });
  };
  const dependencies = (coordinatorUsed: BackendPublicationCoordinator, extra: Partial<RunMigrationRollbackDependencies> = {},
    sessionOverrides: Partial<RollbackSessionDependencies> = {}): RunMigrationRollbackDependencies => ({
    coordinator: coordinatorUsed,
    openFencedSession: async (request) => {
      opens.push({ recovery: request.recovery === true });
      return openRollbackFencedSession(request, target, { ...sessionDependencies, ...sessionOverrides });
    },
    readProjectMap: () => ({ [LOCAL]: { canonical: "/covered", aliases: [], remoteProjectId: REMOTE } }),
    readRetainedMaterial: () => ({
      status: "present", journal: { publicationId: "publication-1", sourceBackend: "sqlite", targetBackend: "postgresql" },
      material: activationPublicationMaterial(),
    }) as never,
    composePublication: (request) => ({
      sourceBackend: "postgresql", targetBackend: "sqlite", material: rollbackPublicationMaterial(), projects: request.bindings,
    }) as never,
    ...extra,
  });
  return {
    homeDir, lease, input, store, opens, coordinator, sharedLeaseCoordinator, dependencies, target, sessionDependencies,
    setObserved(next: typeof census) { observed = next; },
    pending: () => store.read(GEN).pendingEffect,
  };
}

function crashBeforeCompleteSelection(coordinator: BackendPublicationCoordinator): BackendPublicationCoordinator {
  coordinator.completeMaintenanceSelection = async () => { throw new Error("crash before completeMaintenanceSelection"); };
  return coordinator;
}

const DRIFTED = census.map((entry, index) => (index === 0 ? { ...entry, recordCount: 7, prefixSha256: "e".repeat(64) } : entry));

describe("recovery of a rollback through the real session opener and recovery admission (F11)", () => {
  it("completes a prepared selection: the recovery open is admitted, revalidates and keeps one lease", async () => {
    const t = setup();
    await expect(runMigrationRollback(t.input, t.dependencies(crashBeforeCompleteSelection(t.coordinator()))))
      .rejects.toThrow("crash before completeMaintenanceSelection");
    expect(readBackendMaintenanceJournal(t.homeDir)?.phase).toBe("selection-prepared");
    expect(t.lease.state.row?.releasedAt).toBeNull();

    const outcome = await runMigrationRollback(t.input, t.dependencies(t.coordinator()));

    expect(outcome.manifest.phase).toBe("rolled-back");
    expect(t.opens).toEqual([{ recovery: false }, { recovery: true }]);
    expect(t.lease.calls.filter((call) => call === "release")).toHaveLength(1);
    expect(readBackendPublicationJournal(t.homeDir)).toMatchObject({ phase: "completed", publicationId: PUBLICATION_ID });
  });

  it("refuses a prepared selection whose destination changed meanwhile and keeps the lease held", async () => {
    const t = setup();
    await expect(runMigrationRollback(t.input, t.dependencies(crashBeforeCompleteSelection(t.coordinator()))))
      .rejects.toThrow("crash before completeMaintenanceSelection");
    t.setObserved(DRIFTED);
    const before = t.store.read(GEN).checksumSha256;

    await expect(runMigrationRollback(t.input, t.dependencies(t.coordinator()))).rejects.toThrow();

    expect(t.lease.state.row?.releasedAt).toBeNull();
    expect(t.lease.calls).not.toContain("release");
    expect(t.store.read(GEN).checksumSha256).toBe(before);
    expect(readBackendMaintenanceJournal(t.homeDir)?.phase).toBe("selection-prepared");
  });

  it("completes a completed selection (crash before the binding is written) under a recovery open", async () => {
    const t = setup();
    await expect(runMigrationRollback(t.input, t.dependencies(t.coordinator(), {
      recordSelectionBinding: () => { throw new Error("crash after selection-completed, before the binding"); },
    }))).rejects.toThrow("crash after selection-completed");
    expect(readBackendMaintenanceJournal(t.homeDir)?.phase).toBe("selection-completed");
    expect(t.lease.state.row?.releasedAt).toBeNull();

    const outcome = await runMigrationRollback(t.input, t.dependencies(t.coordinator()));

    expect(outcome.manifest.phase).toBe("rolled-back");
    expect(t.opens.map((open) => open.recovery)).toEqual([false, true]);
  });

  it("finishes the coordinator's own non-terminal publication under a recovery open", async () => {
    const t = setup();
    const crashing = t.coordinator();
    const prepare = crashing.prepare.bind(crashing);
    crashing.prepare = async (...args) => {
      await prepare(...args);
      throw new Error("crash right after prepare");
    };
    await expect(runMigrationRollback(t.input, t.dependencies(crashing))).rejects.toThrow("crash right after prepare");
    expect(readBackendMaintenanceJournal(t.homeDir)).toBeNull();
    expect(readBackendPublicationJournal(t.homeDir)).toMatchObject({ phase: "prepared", publicationId: PUBLICATION_ID });
    expect(t.lease.state.row?.releasedAt).toBeNull();

    const outcome = await runMigrationRollback(t.input, t.dependencies(t.coordinator()));

    expect(outcome.manifest.phase).toBe("rolled-back");
    expect(t.opens.map((open) => open.recovery)).toEqual([false, true]);
  });

  it("keeps the lease when the recovery open itself is refused", async () => {
    const t = setup();
    await expect(runMigrationRollback(t.input, t.dependencies(crashBeforeCompleteSelection(t.coordinator()))))
      .rejects.toThrow("crash before completeMaintenanceSelection");

    await expect(runMigrationRollback(t.input, t.dependencies(t.coordinator(), {}, {
      checkRecoveryAdmission: async () => ({ status: "unsatisfied", detail: "refused", quiescenceFence: null }),
    }))).rejects.toMatchObject({ reason: "quiescence-unsatisfied" });

    expect(t.lease.state.row?.releasedAt).toBeNull();
    expect(t.lease.calls).not.toContain("release");
  });

  it("the strict first-open quiescence still refuses every phase after maintenance-held", async () => {
    const t = setup();
    await expect(runMigrationRollback(t.input, t.dependencies(crashBeforeCompleteSelection(t.coordinator()))))
      .rejects.toThrow("crash before completeMaintenanceSelection");
    const result = await withBackendPublicationAppendBarrierAsync(t.homeDir, (token) => checkActivationWriterQuiescence({ homeDir: t.homeDir, lockToken: token }));
    expect(result).toMatchObject({ status: "unsatisfied", reason: "maintenance-not-held" });
  });
});

/**
 * #626 E1 (round-3 S3-1). The session and the coordinator drive ONE lease row. A recovery that meets the
 * coordinator's journal at released -- the coordinator released the fence and durably said so, and resumes by
 * finalizing without another release -- must not acquire a fence of its own: the real guard replaces a released
 * row with a fresh token that nothing would ever release, and guarded PostgreSQL writers refuse while any
 * unreleased row exists. Every earlier forward phase keeps its fence-driving recovery session (the coordinator
 * adopts or supersedes it and releases it); released and the abort phases finish through the coordinator alone.
 */
describe("recovery across the coordinator's lease handoff (E1): one lease row shared by the session and the coordinator", () => {
  const acquires = (t: ReturnType<typeof setup>) => t.lease.calls.filter((call) => call === "acquire").length;

  it("finishes a publication crashed at released without acquiring another fence, and settles with the one lease released", async () => {
    const t = setup();
    await expect(runMigrationRollback(t.input, t.dependencies(t.sharedLeaseCoordinator("released")))).rejects.toThrow("crash at released");
    expect(readBackendPublicationJournal(t.homeDir)).toMatchObject({ phase: "released", publicationId: PUBLICATION_ID });
    expect(t.pending()?.kind).toBe("publish-rollback");
    expect(t.lease.state.row).toMatchObject({ fencingToken: 1n, releasedAt: capturedAt });
    const acquiredBefore = acquires(t);

    const outcome = await runMigrationRollback(t.input, t.dependencies(t.sharedLeaseCoordinator()));

    expect(outcome.manifest.phase).toBe("rolled-back");
    expect(readBackendPublicationJournal(t.homeDir)).toMatchObject({ phase: "completed", publicationId: PUBLICATION_ID });
    // No recovery session was opened and no row was acquired: the released row of the first attempt is the only one.
    expect(t.opens).toEqual([{ recovery: false }]);
    expect(acquires(t)).toBe(acquiredBefore);
    expect(t.lease.state.row).toMatchObject({ fencingToken: 1n, releasedAt: capturedAt });

    // Settled: a further call reports the same outcome with the lease still released.
    const again = await runMigrationRollback(t.input, t.dependencies(t.sharedLeaseCoordinator()));
    expect(again.manifest.phase).toBe("rolled-back");
    expect(t.lease.state.row).toMatchObject({ fencingToken: 1n, releasedAt: capturedAt });
  });

  it.each([
    ["prepared", 1n],
    ["guarded", 1n],
    ["config-published", 1n],
    ["releasing", 1n],
    // The remote release landed but the journal still says releasing: the released row is superseded by the
    // recovery session's fresh token, which the coordinator's release phase then releases.
    ["after-release", 2n],
  ] as const)("finishes a publication crashed at %s under a recovery session whose fence the coordinator releases", async (crashAt, finalToken) => {
    const t = setup();
    await expect(runMigrationRollback(t.input, t.dependencies(t.sharedLeaseCoordinator(crashAt)))).rejects.toThrow("crash at " + crashAt);
    expect(readBackendPublicationJournal(t.homeDir)?.phase).toBe(crashAt === "after-release" ? "releasing" : crashAt);

    const outcome = await runMigrationRollback(t.input, t.dependencies(t.sharedLeaseCoordinator()));

    expect(outcome.manifest.phase).toBe("rolled-back");
    expect(t.opens).toEqual([{ recovery: false }, { recovery: true }]);
    expect(t.lease.state.row).toMatchObject({ fencingToken: finalToken, releasedAt: capturedAt });
  });

  it("resumes an abort of this rollback's publication through the coordinator alone, without a recovery session", async () => {
    const t = setup();
    await expect(runMigrationRollback(t.input, t.dependencies(t.sharedLeaseCoordinator("guarded")))).rejects.toThrow("crash at guarded");
    // Something else aborted the publication and died at abort-releasing, before the remote release.
    await expect(t.sharedLeaseCoordinator("abort-releasing").abort()).rejects.toThrow("crash at abort-releasing");
    expect(readBackendPublicationJournal(t.homeDir)?.phase).toBe("abort-releasing");
    expect(t.lease.state.row).toMatchObject({ fencingToken: 1n, releasedAt: null });
    const acquiredBefore = acquires(t);

    await expect(runMigrationRollback(t.input, t.dependencies(t.sharedLeaseCoordinator())))
      .rejects.toMatchObject({ reason: "unexpected-state", message: expect.stringContaining("aborted") });

    expect(readBackendPublicationJournal(t.homeDir)?.phase).toBe("aborted");
    expect(t.opens).toEqual([{ recovery: false }]);
    expect(acquires(t)).toBe(acquiredBefore);
    expect(t.lease.state.row).toMatchObject({ fencingToken: 1n, releasedAt: capturedAt });
    expect(t.pending()?.kind).toBe("publish-rollback");
  });

  it("refuses a released journal that does not record a released fence, instead of settling over it", async () => {
    const t = setup();
    await expect(runMigrationRollback(t.input, t.dependencies(t.sharedLeaseCoordinator("released")))).rejects.toThrow("crash at released");
    const journalPath = backendPublicationJournalPath(t.homeDir);
    const { checksumSha256: _checksum, ...body } = JSON.parse(readFileSync(journalPath, "utf8"));
    body.projects[0].fence.releasedAt = null;
    writeFileSync(journalPath, JSON.stringify({ ...body, checksumSha256: backendPublicationCanonicalSha256(body) }));
    const before = t.store.read(GEN).checksumSha256;

    await expect(runMigrationRollback(t.input, t.dependencies(t.sharedLeaseCoordinator())))
      .rejects.toMatchObject({ reason: "unexpected-state", message: expect.stringContaining("released fence") });

    expect(t.opens).toEqual([{ recovery: false }]);
    expect(t.store.read(GEN).checksumSha256).toBe(before);
    expect(readBackendPublicationJournal(t.homeDir)?.phase).toBe("released");
  });

  it("E4: refuses a journal under this rollback's id that is not its composition before resuming it", async () => {
    const t = setup();
    await expect(runMigrationRollback(t.input, t.dependencies(t.sharedLeaseCoordinator("prepared")))).rejects.toThrow("crash at prepared");
    const journalPath = backendPublicationJournalPath(t.homeDir);
    const { checksumSha256: _checksum, ...body } = JSON.parse(readFileSync(journalPath, "utf8"));
    // A forward-shaped (sqlite -> postgresql) publication planted under the rollback's publicationId.
    body.sourceBackend = "sqlite";
    body.targetBackend = "postgresql";
    writeFileSync(journalPath, JSON.stringify({ ...body, checksumSha256: backendPublicationCanonicalSha256(body) }));
    const before = t.store.read(GEN).checksumSha256;

    await expect(runMigrationRollback(t.input, t.dependencies(t.sharedLeaseCoordinator())))
      .rejects.toMatchObject({ reason: "unexpected-state", message: expect.stringContaining("not its composition") });

    // Nothing was resumed or settled; the recovery session kept the lease.
    expect(readBackendPublicationJournal(t.homeDir)).toMatchObject({ phase: "prepared", targetBackend: "postgresql" });
    expect(t.store.read(GEN).checksumSha256).toBe(before);
    expect(t.lease.state.row).toMatchObject({ fencingToken: 1n, releasedAt: null });
  });
});

/**
 * #626 E6 (escalation review AESC-01). The coordinator's prepare() writes the journal at preparing, seals the
 * material, then records prepared with the recovery reference. A crash in either window leaves this rollback's
 * own journal at preparing with recoveryReference null -- material absent or sealed. The authenticated material
 * reader refuses such a journal by design, so every input read must recognize it first and read the live files
 * (nothing was published yet), and the publication step must finish it through the coordinator: resume
 * authenticates sealed material; for absent material the coordinator's own preparing -> aborted exit is taken and
 * the publication is composed and prepared again, under the same retained barrier and the same recovery session,
 * whose original lease the coordinator adopts and releases exactly once.
 */
describe("recovery of a publication crashed while preparing (E6): unsealed journal, material absent or sealed", () => {
  const releases = (t: ReturnType<typeof setup>) => t.lease.calls.filter((call) => call === "release").length;
  const acquires = (t: ReturnType<typeof setup>) => t.lease.calls.filter((call) => call === "acquire").length;
  const counting = (coordinator: BackendPublicationCoordinator) => {
    const counts = { abort: 0, resume: 0, prepare: 0 };
    for (const method of ["abort", "resume", "prepare"] as const) {
      const real = (coordinator[method] as (...args: unknown[]) => Promise<unknown>).bind(coordinator);
      (coordinator as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => { counts[method]++; return real(...args); };
    }
    return { coordinator, counts };
  };
  const expectSettled = (t: ReturnType<typeof setup>) => {
    expect(readBackendPublicationJournal(t.homeDir)).toMatchObject({ phase: "completed", publicationId: PUBLICATION_ID });
    expect(t.pending()).toBeNull();
    expect(t.lease.state.row).toMatchObject({ fencingToken: 1n, releasedAt: capturedAt });
    // Every acquire adopted the one active row (the stand-in returns it, as the real guard does): token 1 throughout.
    expect(acquires(t)).toBe(t.opens.length);
    expect(releases(t)).toBe(1);
    const bindings = resolveMigrationWitnessBindings({ homeDir: t.homeDir, generationId: GEN });
    const rollback = bindings.state === "resolved" ? bindings.selections.find((selection) => selection.kind === "rollback") : undefined;
    expect(assertMigrationReplayAdmission({ homeDir: t.homeDir, generationId: GEN, evidenceSha256: rollback!.witnessChecksumSha256 }))
      .toEqual({ backend: "sqlite", disposition: "selected" });
  };

  it.each(["before-material-seal", "after-material-seal"] as const)("crash at %s: the retry resolves its inputs from the live files and settles under the original lease", async (crashAt) => {
    const t = setup();
    await expect(runMigrationRollback(t.input, t.dependencies(t.sharedLeaseCoordinator(crashAt)))).rejects.toThrow("crash at " + crashAt);
    expect(readBackendPublicationJournal(t.homeDir)).toMatchObject({ phase: "preparing", publicationId: PUBLICATION_ID, recoveryReference: null });
    expect(t.pending()?.kind).toBe("publish-rollback");
    expect(t.lease.state.row).toMatchObject({ fencingToken: 1n, releasedAt: null });
    // The production input resolver reads this journal too: it must not refuse, and it must read the live files.
    expect(readOwnPublicationSourceFromMaterial(t.homeDir, PUBLICATION_ID, LOCAL)).toBeNull();

    const { coordinator, counts } = counting(t.sharedLeaseCoordinator());
    const outcome = await runMigrationRollback(t.input, t.dependencies(coordinator));

    expect(outcome.manifest.phase).toBe("rolled-back");
    expect(t.opens).toEqual([{ recovery: false }, { recovery: true }]);
    // Sealed material is authenticated and driven forward by resume alone; absent material fails that resume, takes
    // the coordinator's preparing -> aborted exit once, and is composed, prepared and resumed again.
    expect(counts).toEqual(crashAt === "after-material-seal" ? { abort: 0, resume: 1, prepare: 0 } : { abort: 1, resume: 2, prepare: 1 });
    expectSettled(t);
  });

  it("crash between the missing-material abort and the second prepare: the aborted unsealed journal is admitted and prepared again", async () => {
    const t = setup();
    await expect(runMigrationRollback(t.input, t.dependencies(t.sharedLeaseCoordinator("before-material-seal")))).rejects.toThrow("crash at before-material-seal");
    await expect(runMigrationRollback(t.input, t.dependencies(t.sharedLeaseCoordinator("aborted")))).rejects.toThrow("crash at aborted");
    expect(readBackendPublicationJournal(t.homeDir)).toMatchObject({ phase: "aborted", publicationId: PUBLICATION_ID, recoveryReference: null });
    expect(t.pending()?.kind).toBe("publish-rollback");
    expect(t.lease.state.row).toMatchObject({ fencingToken: 1n, releasedAt: null });
    expect(readOwnPublicationSourceFromMaterial(t.homeDir, PUBLICATION_ID, LOCAL)).toBeNull();

    const { coordinator, counts } = counting(t.sharedLeaseCoordinator());
    const outcome = await runMigrationRollback(t.input, t.dependencies(coordinator));

    expect(outcome.manifest.phase).toBe("rolled-back");
    expect(t.opens).toEqual([{ recovery: false }, { recovery: true }, { recovery: true }]);
    expect(counts).toEqual({ abort: 0, resume: 1, prepare: 1 });
    expectSettled(t);
  });

  it("an aborted journal that had sealed its material (an external abort) is still refused, not prepared again", async () => {
    const t = setup();
    await expect(runMigrationRollback(t.input, t.dependencies(t.sharedLeaseCoordinator("prepared")))).rejects.toThrow("crash at prepared");
    await t.sharedLeaseCoordinator().abort();
    expect(readBackendPublicationJournal(t.homeDir)).toMatchObject({ phase: "aborted", recoveryReference: expect.objectContaining({ sealSha256: expect.any(String) }) });

    await expect(runMigrationRollback(t.input, t.dependencies(t.sharedLeaseCoordinator())))
      .rejects.toMatchObject({ reason: "unexpected-state", message: expect.stringContaining("aborted") });
    expect(t.opens).toEqual([{ recovery: false }]);
    expect(t.pending()?.kind).toBe("publish-rollback");
  });

  it("the input reader recognizes only this rollback's own unsealed composition and still refuses any other unreferenced journal", async () => {
    const t = setup();
    await expect(runMigrationRollback(t.input, t.dependencies(t.sharedLeaseCoordinator("after-material-seal")))).rejects.toThrow("crash at after-material-seal");
    expect(readOwnPublicationSourceFromMaterial(t.homeDir, PUBLICATION_ID, LOCAL)).toBeNull();
    // Same journal, another covered project: not this rollback's composition, so the authenticated reader decides.
    expect(() => readOwnPublicationSourceFromMaterial(t.homeDir, PUBLICATION_ID, "d".repeat(64)))
      .toThrow(expect.objectContaining({ reason: "publication-evidence-missing" }));
  });

  it("a resume failure other than missing material propagates untouched, with nothing aborted and the lease kept", async () => {
    const t = setup();
    await expect(runMigrationRollback(t.input, t.dependencies(t.sharedLeaseCoordinator("before-material-seal")))).rejects.toThrow("crash at before-material-seal");
    const { coordinator, counts } = counting(t.sharedLeaseCoordinator());
    coordinator.resume = async () => { throw new Error("EACCES-like failure reading the material"); };

    await expect(runMigrationRollback(t.input, t.dependencies(coordinator))).rejects.toThrow("EACCES-like failure reading the material");

    expect(counts.abort).toBe(0);
    expect(readBackendPublicationJournal(t.homeDir)).toMatchObject({ phase: "preparing", recoveryReference: null });
    expect(t.pending()?.kind).toBe("publish-rollback");
    expect(t.lease.state.row).toMatchObject({ fencingToken: 1n, releasedAt: null });
  });

  it("refuses to prepare again when the missing-material abort does not land on the unsealed aborted journal", async () => {
    const t = setup();
    await expect(runMigrationRollback(t.input, t.dependencies(t.sharedLeaseCoordinator("before-material-seal")))).rejects.toThrow("crash at before-material-seal");
    const { coordinator, counts } = counting(t.sharedLeaseCoordinator());
    const abort = coordinator.abort.bind(coordinator);
    coordinator.abort = async (...args) => {
      const journal = await abort(...args);
      return { ...journal, recoveryReference: { relativePath: PUBLICATION_ID + ".material", sealSha256: "f".repeat(64), byteLength: 1 } };
    };

    await expect(runMigrationRollback(t.input, t.dependencies(coordinator)))
      .rejects.toMatchObject({ reason: "unexpected-state", message: expect.stringContaining("did not abort as a missing-material publication") });

    expect(counts.prepare).toBe(0);
    expect(t.pending()?.kind).toBe("publish-rollback");
    expect(t.lease.state.row).toMatchObject({ fencingToken: 1n, releasedAt: null });
  });
});

describe("checkRollbackRecoveryAdmission", () => {
  const request = (homeDir: string, token: BackendPublicationLockToken, overrides: Partial<Parameters<typeof checkRollbackRecoveryAdmission>[0]> = {}) => ({
    homeDir, lockToken: token, generationId: GEN, publicationId: PUBLICATION_ID, machineId: MACHINE, ...overrides,
  });
  const check = (homeDir: string, overrides: Partial<Parameters<typeof checkRollbackRecoveryAdmission>[0]> = {}) =>
    withBackendPublicationAppendBarrierAsync(homeDir, (token) => checkRollbackRecoveryAdmission(request(homeDir, token, overrides)));

  /** A maintenance journal brought to the named phase by the real coordinator. */
  async function maintenanceAt(
    homeDir: string,
    phase: "maintenance-held" | "selection-prepared" | "selection-completed",
    options: { generationId?: string; publicationId?: string; roster?: Array<{ machineId: string; queueCutoff: null; evidenceSha256: string }>; target?: "sqlite" | "postgresql" } = {},
  ): Promise<void> {
    const coordinator = rollbackFixtureCoordinator(homeDir);
    const generationId = options.generationId ?? GEN;
    await withBackendPublicationAppendBarrierAsync(homeDir, async (token) => {
      const held = await coordinator.enterMaintenance({
        publicationId: options.publicationId ?? PUBLICATION_ID, generationId,
        sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64),
        roster: options.roster ?? [{ machineId: MACHINE, queueCutoff: null, evidenceSha256: "7".repeat(64) }],
      }, token);
      if (phase === "maintenance-held") return;
      const prepared = await coordinator.prepareMaintenanceSelection({
        expectedChecksumSha256: held.checksumSha256, generationId, targetBackend: options.target ?? "sqlite",
        terminalEvidenceSha256: "8".repeat(64),
      }, token);
      if (phase === "selection-prepared") return;
      await coordinator.completeMaintenanceSelection({
        expectedChecksumSha256: prepared.checksumSha256, generationId, terminalEvidenceSha256: "8".repeat(64),
      }, token);
    });
  }

  /** A publication journal in the live slot, at the named phase. */
  async function publicationAt(homeDir: string, publicationId: string, phase: "prepared" | "completed" | "aborted"): Promise<void> {
    const material = publicationMaterial();
    const coordinator = new BackendPublicationCoordinator({ homeDir, driver: workingPublicationDriver(material) });
    await coordinator.prepare({
      publicationId, sourceBackend: "sqlite", targetBackend: "postgresql", material,
      projects: [{ localProjectId: LOCAL, remoteProjectId: REMOTE, evidenceSha256: "a".repeat(64) }],
      now: new Date(capturedAt),
    });
    if (phase === "completed") await coordinator.resume();
    if (phase === "aborted") await coordinator.abort();
  }

  it.each(["selection-prepared", "selection-completed"] as const)("admits this rollback's own maintenance at %s", async (phase) => {
    const homeDir = tempHome();
    await maintenanceAt(homeDir, phase);
    const result = await check(homeDir);
    expect(result).toMatchObject({ status: "satisfied", quiescenceFence: { kind: "lcm-rollback-recovery-admission-v1" } });
    expect(JSON.parse(result.quiescenceFence!.payload)).toMatchObject({
      journal: "maintenance", phase, generationId: GEN, publicationId: PUBLICATION_ID, machineId: MACHINE,
    });
  });

  it("refuses a freshly held maintenance (that is the strict first-open path)", async () => {
    const homeDir = tempHome();
    await maintenanceAt(homeDir, "maintenance-held");
    expect(await check(homeDir)).toMatchObject({ status: "unsatisfied", quiescenceFence: null });
  });

  it("refuses a maintenance of another generation", async () => {
    const homeDir = tempHome();
    await maintenanceAt(homeDir, "selection-prepared", { generationId: "gen-other" });
    expect(await check(homeDir)).toMatchObject({ status: "unsatisfied" });
  });

  it("refuses a maintenance of another publication id", async () => {
    const homeDir = tempHome();
    await maintenanceAt(homeDir, "selection-prepared", { publicationId: "another-publication" });
    expect(await check(homeDir)).toMatchObject({ status: "unsatisfied" });
  });

  it("refuses a maintenance that selects another backend", async () => {
    const homeDir = tempHome();
    await maintenanceAt(homeDir, "selection-prepared", { target: "postgresql" });
    expect(await check(homeDir)).toMatchObject({ status: "unsatisfied" });
  });

  it("refuses a roster that is not this machine alone", async () => {
    const other = tempHome();
    await maintenanceAt(other, "selection-prepared", { roster: [{ machineId: OTHER_MACHINE, queueCutoff: null, evidenceSha256: "7".repeat(64) }] });
    expect(await check(other)).toMatchObject({ status: "unsatisfied", detail: expect.stringContaining("roster") });

    const several = tempHome();
    await maintenanceAt(several, "selection-prepared", { roster: [
      { machineId: MACHINE, queueCutoff: null, evidenceSha256: "7".repeat(64) },
      { machineId: OTHER_MACHINE, queueCutoff: null, evidenceSha256: "7".repeat(64) },
    ] });
    expect(await check(several)).toMatchObject({ status: "unsatisfied", detail: expect.stringContaining("roster") });
  });

  it("admits this rollback's own non-terminal publication once the maintenance was archived", async () => {
    const homeDir = tempHome();
    await publicationAt(homeDir, PUBLICATION_ID, "prepared");
    expect(existsSync(join(homeDir, ".lcm"))).toBe(true);
    const result = await check(homeDir);
    expect(result).toMatchObject({ status: "satisfied" });
    expect(JSON.parse(result.quiescenceFence!.payload)).toMatchObject({ journal: "publication", phase: "prepared" });
  });

  it("refuses a completed or aborted publication of this rollback, another publication, and an empty slot", async () => {
    for (const phase of ["completed", "aborted"] as const) {
      const homeDir = tempHome();
      await publicationAt(homeDir, PUBLICATION_ID, phase);
      expect(await check(homeDir)).toMatchObject({ status: "unsatisfied" });
    }
    const foreign = tempHome();
    await publicationAt(foreign, "another-publication", "prepared");
    expect(await check(foreign)).toMatchObject({ status: "unsatisfied" });
    expect(await check(tempHome())).toMatchObject({ status: "unsatisfied" });
  });

  it("E6: admits this rollback's own publication the coordinator aborted from preparing without ever sealing material", async () => {
    const homeDir = tempHome();
    const material = publicationMaterial();
    const crashing = new BackendPublicationCoordinator({
      homeDir, driver: workingPublicationDriver(material),
      observer: (event) => { if (event === "before-material-seal") throw new Error("crash before the seal"); },
    });
    await expect(crashing.prepare({
      publicationId: PUBLICATION_ID, sourceBackend: "postgresql", targetBackend: "sqlite", material,
      projects: [{ localProjectId: LOCAL, remoteProjectId: REMOTE, evidenceSha256: "a".repeat(64) }],
    })).rejects.toThrow("crash before the seal");
    expect(readBackendPublicationJournal(homeDir)).toMatchObject({ phase: "preparing", recoveryReference: null });
    expect(await check(homeDir)).toMatchObject({ status: "satisfied" });

    await new BackendPublicationCoordinator({ homeDir, driver: workingPublicationDriver(material) }).abort();
    expect(readBackendPublicationJournal(homeDir)).toMatchObject({ phase: "aborted", recoveryReference: null });
    const result = await check(homeDir);
    expect(result).toMatchObject({ status: "satisfied" });
    expect(JSON.parse(result.quiescenceFence!.payload)).toMatchObject({ journal: "publication", phase: "aborted" });
  });
});

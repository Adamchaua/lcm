/**
 * #626 F11: a rollback whose maintenance selection was already attempted recovers through the REAL fenced-session
 * opener and the REAL recovery admission (no stand-in for either), over the real coordinator, journals and
 * stores. Only the PostgreSQL row (a stateful lease stand-in with the guard's own acquire semantics) and the
 * census reads are faked; the first-open quiescence is a stand-in only for the first attempt, which the strict
 * checkActivationWriterQuiescence legitimately handles elsewhere.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BackendPublicationCoordinator,
  readBackendMaintenanceJournal,
  readBackendPublicationJournal,
  withBackendPublicationAppendBarrierAsync,
  type BackendPublicationLockToken,
} from "../../src/storage/backend-publication.js";
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
} from "../../src/migration/generation-binding-store.js";
import {
  deriveRollbackPublicationId,
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
const MACHINE = "018f0b5d-1234-4abc-8def-1234567890ab";
const OTHER_MACHINE = "018f0b5d-1234-4abc-8def-1234567890ff";
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

/** The lcm.fenced_leases row: acquire returns the live row of the same tuple, as the real guard does. */
function leaseStandIn() {
  const state: { row: LeaseRow | null } = { row: null };
  const calls: string[] = [];
  const guard = {
    async acquire(input: Omit<LeaseRow, "fencingToken" | "acquiredAt" | "renewedAt" | "expiresAt" | "releasedAt" | "databaseExpired">) {
      calls.push("acquire");
      if (state.row !== null && state.row.releasedAt === null) return state.row;
      state.row = {
        projectId: input.projectId, machineId: input.machineId, publicationId: input.publicationId,
        targetBackend: input.targetBackend, evidenceSha256: input.evidenceSha256, fencingToken: 1n,
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
    homeDir, lease, input, store, opens, coordinator, dependencies, target, sessionDependencies,
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
});

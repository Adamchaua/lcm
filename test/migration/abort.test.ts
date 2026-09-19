import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyMigrationAbortGate,
  performMigrationAbort,
} from "../../src/migration/abort.js";
import { MigrationManifestStore } from "../../src/migration/manifest-store.js";
import {
  beginMigrationEffect,
  completeMigrationEffect,
  createMigrationManifest,
  MigrationProtocolError,
  type MigrationManifest,
} from "../../src/migration/protocol.js";
import {
  BackendPublicationCoordinator,
  readBackendMaintenanceJournal,
  type BackendMaintenanceJournal,
  type BackendPublicationDriver,
} from "../../src/storage/backend-publication.js";

const roots: string[] = [];
const MACHINE_ID = "018f0b5d-1234-4abc-8def-1234567890ab";
const CREATED_AT = "2026-08-12T12:00:00.000Z";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "lcm-abort-"));
  roots.push(home);
  mkdirSync(join(home, ".lcm"), { mode: 0o700 });
  return home;
}

function coordinatorFor(home: string): BackendPublicationCoordinator {
  const unexpected: BackendPublicationDriver["observeLocalState"] = async () => {
    throw new Error("v2 driver must not run for maintenance");
  };
  const driver: BackendPublicationDriver = {
    observeLocalState: unexpected,
    publishProjectMap: async () => { throw new Error("v2 driver must not run for maintenance"); },
    publishConfig: async () => { throw new Error("v2 driver must not run for maintenance"); },
    restoreConfig: async () => { throw new Error("v2 driver must not run for maintenance"); },
    restoreProjectMap: async () => { throw new Error("v2 driver must not run for maintenance"); },
  };
  return new BackendPublicationCoordinator({ homeDir: home, driver });
}

async function heldJournal(home: string, generationId = "generation-1"): Promise<BackendMaintenanceJournal> {
  return coordinatorFor(home).enterMaintenance({
    publicationId: "maintenance-publication",
    generationId,
    sourceSelectionSha256: "a".repeat(64),
    queueEvidenceSha256: "b".repeat(64),
    roster: [{ machineId: MACHINE_ID, queueCutoff: null, evidenceSha256: "a".repeat(64) }],
  });
}

function manifest(generationId = "generation-1"): MigrationManifest {
  return createMigrationManifest({
    generationId,
    source: { version: 1, backend: "sqlite", identitySha256: "1".repeat(64), schemaSha256: "2".repeat(64), contentSha256: "3".repeat(64), capturedAt: CREATED_AT },
    destination: { version: 1, backend: "postgresql", identitySha256: "4".repeat(64), schemaSha256: "5".repeat(64), contentSha256: "6".repeat(64), capturedAt: CREATED_AT },
    parentGenerationId: null,
    preservedSourceGenerationId: generationId,
    createdAt: CREATED_AT,
  });
}

describe("classifyMigrationAbortGate (section 4.6)", () => {
  it("is ready when the journal is not terminal, regardless of manifest state", () => {
    const home = makeHome();
    const store = new MigrationManifestStore({ homeDir: home });
    expect(classifyMigrationAbortGate({ journalTerminal: false, generationId: "generation-1", manifestStore: store }))
      .toEqual({ status: "ready" });
  });

  it("is ready when the journal is terminal and the manifest is authoritatively absent (genesis never ran)", () => {
    const home = makeHome();
    const store = new MigrationManifestStore({ homeDir: home });
    expect(classifyMigrationAbortGate({ journalTerminal: true, generationId: "generation-1", manifestStore: store }))
      .toEqual({ status: "ready" });
  });

  it("refuses as an incomplete pair when the journal is terminal but the manifest is present and not settled (red: this is the exact disagreement section 4.6 exists to catch)", () => {
    const home = makeHome();
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(manifest());
    const result = classifyMigrationAbortGate({ journalTerminal: true, generationId: "generation-1", manifestStore: store });
    expect(result).toEqual({ status: "incomplete-pair", evidence: "manifest-ready" });
  });

  it("is ready when the journal is terminal and the manifest has independently reached a settled phase", () => {
    const home = makeHome();
    const store = new MigrationManifestStore({ homeDir: home });
    const planned = manifest();
    store.create(planned);
    const begun = beginMigrationEffect(planned, { effectId: "e".repeat(64), kind: "abort", inputSha256: "f".repeat(64), startedAt: CREATED_AT });
    store.update("generation-1", planned.checksumSha256, () => begun);
    const settled = completeMigrationEffect(begun, {
      effectId: "e".repeat(64),
      completedAt: CREATED_AT,
      report: { kind: "abort", reportId: "report-1", reportSha256: "9".repeat(64), createdAt: CREATED_AT },
    });
    store.update("generation-1", begun.checksumSha256, () => settled);
    expect(settled.phase).toBe("aborted");
    const result = classifyMigrationAbortGate({ journalTerminal: true, generationId: "generation-1", manifestStore: store });
    expect(result).toEqual({ status: "ready" });
  });

  it("is unresolvable, never ready, when the manifest presence probe itself cannot be established", () => {
    const home = makeHome();
    const store = new MigrationManifestStore({ homeDir: home });
    const migrations = join(home, ".lcm", "migrations");
    mkdirSync(migrations, { mode: 0o700 });
    chmodSync(migrations, 0o755);
    let result;
    try {
      result = classifyMigrationAbortGate({ journalTerminal: true, generationId: "generation-1", manifestStore: store });
    } finally {
      chmodSync(migrations, 0o700);
    }
    expect(result).toEqual({ status: "unresolvable", evidence: "manifest-internal-error" });
  });
});

describe("performMigrationAbort (section 4.6, completes whichever write is missing, idempotent)", () => {
  it("completes a held journal with no manifest ever created (genesis never ran)", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const coordinator = coordinatorFor(home);
    const result = await performMigrationAbort({
      homeDir: home, coordinator, journal: held, abortEvidenceSha256: "c".repeat(64),
    });
    expect(result).toEqual({ status: "completed" });
  });

  it("completes both writes when the journal is held and the manifest is present but not settled", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(manifest());
    const coordinator = coordinatorFor(home);

    const result = await performMigrationAbort({
      homeDir: home, coordinator, journal: held, abortEvidenceSha256: "c".repeat(64), manifestStore: store,
    });
    expect(result).toEqual({ status: "completed" });
    const settledManifest = store.read("generation-1");
    expect(settledManifest.phase).toBe("aborted");
    const settledJournal = readBackendMaintenanceJournal(home)!;
    expect(settledJournal.phase).toBe("maintenance-aborted");
  });

  it("is idempotent under repetition once re-invoked with the already-terminal journal read fresh from disk (red: proven by a real second and third call, not asserted)", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(manifest());
    const coordinator = coordinatorFor(home);

    const first = await performMigrationAbort({ homeDir: home, coordinator, journal: held, abortEvidenceSha256: "c".repeat(64), manifestStore: store });
    expect(first).toEqual({ status: "completed" });

    const aborted = readBackendMaintenanceJournal(home)!;
    expect(aborted.phase).toBe("maintenance-aborted");

    const second = await performMigrationAbort({ homeDir: home, coordinator, journal: aborted, abortEvidenceSha256: "c".repeat(64), manifestStore: store });
    expect(second).toEqual({ status: "completed" });
    const third = await performMigrationAbort({ homeDir: home, coordinator, journal: aborted, abortEvidenceSha256: "c".repeat(64), manifestStore: store });
    expect(third).toEqual({ status: "completed" });

    // Confirm repetition never re-touched either durable write: same journal
    // checksum, same manifest revision and checksum as after the first call.
    const stillAborted = readBackendMaintenanceJournal(home)!;
    expect(stillAborted.checksumSha256).toBe(aborted.checksumSha256);
    const stillSettled = store.read("generation-1");
    expect(stillSettled.revision).toBe(2);
  });

  it("refuses rather than silently succeeding when the caller's in-hand journal is stale (a genuinely different on-disk state, not the idempotent case above)", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(manifest());
    const coordinator = coordinatorFor(home);
    await performMigrationAbort({ homeDir: home, coordinator, journal: held, abortEvidenceSha256: "c".repeat(64), manifestStore: store });
    // held is now stale: the coordinator will refuse a second abortMaintenance
    // call built from it, because the real on-disk journal has moved on.
    const result = await performMigrationAbort({ homeDir: home, coordinator, journal: held, abortEvidenceSha256: "c".repeat(64), manifestStore: store });
    expect(result).toEqual({ status: "refuse", evidence: "journal-unexpected-state" });
  });

  it("refuses a selection-completed journal (a successful cutover is not an abort target)", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const coordinator = coordinatorFor(home);
    const prepared = await coordinator.prepareMaintenanceSelection({
      expectedChecksumSha256: held.checksumSha256, generationId: held.generationId,
      targetBackend: "postgresql", terminalEvidenceSha256: "c".repeat(64),
    });
    const completed = await coordinator.completeMaintenanceSelection({
      expectedChecksumSha256: prepared.checksumSha256, generationId: prepared.generationId,
      terminalEvidenceSha256: prepared.terminalEvidenceSha256!,
    });
    const result = await performMigrationAbort({ homeDir: home, coordinator, journal: completed, abortEvidenceSha256: "c".repeat(64) });
    expect(result).toEqual({ status: "refuse", evidence: "journal-selection-completed" });
  });

  it("refuses a selection-prepared journal (neither held/entering nor an abort target)", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const coordinator = coordinatorFor(home);
    const prepared = await coordinator.prepareMaintenanceSelection({
      expectedChecksumSha256: held.checksumSha256, generationId: held.generationId,
      targetBackend: "postgresql", terminalEvidenceSha256: "c".repeat(64),
    });
    const result = await performMigrationAbort({ homeDir: home, coordinator, journal: prepared, abortEvidenceSha256: "c".repeat(64) });
    expect(result).toEqual({ status: "refuse", evidence: "journal-selection-prepared" });
  });

  it("refuses when abortMaintenance itself fails (stale expectedChecksumSha256)", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const coordinator = coordinatorFor(home);
    const stale: BackendMaintenanceJournal = { ...held, checksumSha256: "f".repeat(64) };
    const result = await performMigrationAbort({ homeDir: home, coordinator, journal: stale, abortEvidenceSha256: "c".repeat(64) });
    expect(result).toEqual({ status: "refuse", evidence: "journal-unexpected-state" });
  });

  it("refuses when the manifest has a pending mid-flight effect rather than attempting to override resume's territory (copy-batch is authoritative-readback-required, classified as readback)", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const store = new MigrationManifestStore({ homeDir: home });
    const planned = manifest();
    store.create(planned);
    const dryRun = beginMigrationEffect(planned, { effectId: "e".repeat(64), kind: "verify-dry-run", inputSha256: "f".repeat(64), startedAt: CREATED_AT });
    store.update("generation-1", planned.checksumSha256, () => dryRun);
    const dryRunDone = completeMigrationEffect(dryRun, {
      effectId: "e".repeat(64),
      completedAt: CREATED_AT,
      report: { kind: "dry-run", reportId: "report-1", reportSha256: "9".repeat(64), createdAt: CREATED_AT },
    });
    store.update("generation-1", dryRun.checksumSha256, () => dryRunDone);
    const copying = beginMigrationEffect(dryRunDone, { effectId: "d".repeat(64), kind: "copy-batch", inputSha256: "f".repeat(64), startedAt: CREATED_AT });
    store.update("generation-1", dryRunDone.checksumSha256, () => copying);
    expect(copying.pendingEffect).not.toBeNull();

    const coordinator = coordinatorFor(home);
    const result = await performMigrationAbort({ homeDir: home, coordinator, journal: held, abortEvidenceSha256: "c".repeat(64), manifestStore: store });
    expect(result).toEqual({ status: "refuse", evidence: "manifest-readback" });
  });

  it("refuses when the manifest presence probe cannot be established", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const migrations = join(home, ".lcm", "migrations");
    mkdirSync(migrations, { mode: 0o700 });
    chmodSync(migrations, 0o755);
    const coordinator = coordinatorFor(home);
    let result;
    try {
      result = await performMigrationAbort({ homeDir: home, coordinator, journal: held, abortEvidenceSha256: "c".repeat(64) });
    } finally {
      chmodSync(migrations, 0o700);
    }
    expect(result).toEqual({ status: "refuse", evidence: "manifest-internal-error" });
  });
});

describe("abort.ts's non-protocol-error fallback branches (deterministic injection, per the sqlite-snapshot precedent: every real throw from these seams is provably a typed protocol error)", () => {
  it("classifyMigrationAbortGate: reports unresolvable when the manifest store's read throws an unrecognised error shape", () => {
    const home = makeHome();
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(manifest());
    const fakeStore = {
      probeManifestPresence: () => ({ status: "present" as const }),
      read: () => { throw new Error("unrecognised failure"); },
    } as unknown as MigrationManifestStore;
    const result = classifyMigrationAbortGate({ journalTerminal: true, generationId: "generation-1", manifestStore: fakeStore });
    expect(result).toEqual({ status: "unresolvable", evidence: "manifest-internal-error" });
  });

  it("performMigrationAbort: refuses with journal-internal-error when abortMaintenance throws an unrecognised error shape", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const fakeCoordinator = {
      abortMaintenance: async () => { throw new Error("unrecognised failure"); },
    } as unknown as BackendPublicationCoordinator;
    const result = await performMigrationAbort({ homeDir: home, coordinator: fakeCoordinator, journal: held, abortEvidenceSha256: "c".repeat(64) });
    expect(result).toEqual({ status: "refuse", evidence: "journal-internal-error" });
  });

  it("performMigrationAbort: refuses with manifest-internal-error when the manifest read throws an unrecognised error shape", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const coordinator = coordinatorFor(home);
    const fakeStore = {
      probeManifestPresence: () => ({ status: "present" as const }),
      read: () => { throw new Error("unrecognised failure"); },
    } as unknown as MigrationManifestStore;
    const result = await performMigrationAbort({ homeDir: home, coordinator, journal: held, abortEvidenceSha256: "c".repeat(64), manifestStore: fakeStore });
    expect(result).toEqual({ status: "refuse", evidence: "manifest-internal-error" });
  });

  it("performMigrationAbort: refuses with manifest-internal-error when beginEffect throws an unrecognised error shape", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(manifest());
    const coordinator = coordinatorFor(home);
    const result = await performMigrationAbort({
      homeDir: home, coordinator, journal: held, abortEvidenceSha256: "c".repeat(64), manifestStore: store,
      _operationsForTesting: { beginEffect: () => { throw new Error("unrecognised failure"); } },
    });
    expect(result).toEqual({ status: "refuse", evidence: "manifest-internal-error" });
  });

  it("performMigrationAbort: refuses with manifest-internal-error when the first (begin) store.update throws an unrecognised error shape", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const real = new MigrationManifestStore({ homeDir: home });
    real.create(manifest());
    const fakeStore = {
      probeManifestPresence: (id: string) => real.probeManifestPresence(id),
      read: (id: string) => real.read(id),
      update: () => { throw new Error("unrecognised failure"); },
    } as unknown as MigrationManifestStore;
    const coordinator = coordinatorFor(home);
    const result = await performMigrationAbort({ homeDir: home, coordinator, journal: held, abortEvidenceSha256: "c".repeat(64), manifestStore: fakeStore });
    expect(result).toEqual({ status: "refuse", evidence: "manifest-internal-error" });
  });

  it("performMigrationAbort: refuses with manifest-internal-error when completeEffect throws an unrecognised error shape", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(manifest());
    const coordinator = coordinatorFor(home);
    const result = await performMigrationAbort({
      homeDir: home, coordinator, journal: held, abortEvidenceSha256: "c".repeat(64), manifestStore: store,
      _operationsForTesting: { completeEffect: () => { throw new Error("unrecognised failure"); } },
    });
    expect(result).toEqual({ status: "refuse", evidence: "manifest-internal-error" });
  });

  it("performMigrationAbort: refuses with manifest-internal-error when the second (complete) store.update throws an unrecognised error shape", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const real = new MigrationManifestStore({ homeDir: home });
    real.create(manifest());
    let updateCalls = 0;
    const fakeStore = {
      probeManifestPresence: (id: string) => real.probeManifestPresence(id),
      read: (id: string) => real.read(id),
      update: (id: string, checksum: string, reduce: (m: MigrationManifest) => MigrationManifest) => {
        updateCalls += 1;
        if (updateCalls === 2) throw new Error("unrecognised failure");
        return real.update(id, checksum, reduce);
      },
    } as unknown as MigrationManifestStore;
    const coordinator = coordinatorFor(home);
    const result = await performMigrationAbort({ homeDir: home, coordinator, journal: held, abortEvidenceSha256: "c".repeat(64), manifestStore: fakeStore });
    expect(result).toEqual({ status: "refuse", evidence: "manifest-internal-error" });
    expect(updateCalls).toBe(2);
  });
});

describe("abort.ts's protocol-error-instance branch, for the same fallback ternaries (the TRUE side of the same instanceof check)", () => {
  it("classifyMigrationAbortGate: preserves the MigrationProtocolError reason when the manifest store's read throws one", () => {
    const home = makeHome();
    const fakeStore = {
      probeManifestPresence: () => ({ status: "present" as const }),
      read: () => { throw new MigrationProtocolError("recovery-required", "test"); },
    } as unknown as MigrationManifestStore;
    const result = classifyMigrationAbortGate({ journalTerminal: true, generationId: "generation-1", manifestStore: fakeStore });
    expect(result).toEqual({ status: "unresolvable", evidence: "manifest-recovery-required" });
  });

  it("performMigrationAbort: preserves the MigrationProtocolError reason when the manifest read throws one", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const coordinator = coordinatorFor(home);
    const fakeStore = {
      probeManifestPresence: () => ({ status: "present" as const }),
      read: () => { throw new MigrationProtocolError("recovery-required", "test"); },
    } as unknown as MigrationManifestStore;
    const result = await performMigrationAbort({ homeDir: home, coordinator, journal: held, abortEvidenceSha256: "c".repeat(64), manifestStore: fakeStore });
    expect(result).toEqual({ status: "refuse", evidence: "manifest-recovery-required" });
  });

  it("performMigrationAbort: preserves the MigrationProtocolError reason when beginEffect throws one", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(manifest());
    const coordinator = coordinatorFor(home);
    const result = await performMigrationAbort({
      homeDir: home, coordinator, journal: held, abortEvidenceSha256: "c".repeat(64), manifestStore: store,
      _operationsForTesting: { beginEffect: () => { throw new MigrationProtocolError("unexpected-state", "test"); } },
    });
    expect(result).toEqual({ status: "refuse", evidence: "manifest-unexpected-state" });
  });

  it("performMigrationAbort: preserves the MigrationProtocolError reason when the first (begin) store.update throws one", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const real = new MigrationManifestStore({ homeDir: home });
    real.create(manifest());
    const fakeStore = {
      probeManifestPresence: (id: string) => real.probeManifestPresence(id),
      read: (id: string) => real.read(id),
      update: () => { throw new MigrationProtocolError("unexpected-state", "test"); },
    } as unknown as MigrationManifestStore;
    const coordinator = coordinatorFor(home);
    const result = await performMigrationAbort({ homeDir: home, coordinator, journal: held, abortEvidenceSha256: "c".repeat(64), manifestStore: fakeStore });
    expect(result).toEqual({ status: "refuse", evidence: "manifest-unexpected-state" });
  });

  it("performMigrationAbort: preserves the MigrationProtocolError reason when completeEffect throws one", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(manifest());
    const coordinator = coordinatorFor(home);
    const result = await performMigrationAbort({
      homeDir: home, coordinator, journal: held, abortEvidenceSha256: "c".repeat(64), manifestStore: store,
      _operationsForTesting: { completeEffect: () => { throw new MigrationProtocolError("unexpected-state", "test"); } },
    });
    expect(result).toEqual({ status: "refuse", evidence: "manifest-unexpected-state" });
  });

  it("performMigrationAbort: preserves the MigrationProtocolError reason when the second (complete) store.update throws one", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const real = new MigrationManifestStore({ homeDir: home });
    real.create(manifest());
    let updateCalls = 0;
    const fakeStore = {
      probeManifestPresence: (id: string) => real.probeManifestPresence(id),
      read: (id: string) => real.read(id),
      update: (id: string, checksum: string, reduce: (m: MigrationManifest) => MigrationManifest) => {
        updateCalls += 1;
        if (updateCalls === 2) throw new MigrationProtocolError("unexpected-state", "test");
        return real.update(id, checksum, reduce);
      },
    } as unknown as MigrationManifestStore;
    const coordinator = coordinatorFor(home);
    const result = await performMigrationAbort({ homeDir: home, coordinator, journal: held, abortEvidenceSha256: "c".repeat(64), manifestStore: fakeStore });
    expect(result).toEqual({ status: "refuse", evidence: "manifest-unexpected-state" });
  });
});


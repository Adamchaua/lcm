import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { performMigrationAbortCommand } from "../../src/migration/cli-abort.js";
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
  backendPublicationJournalPath,
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
  const home = mkdtempSync(join(tmpdir(), "lcm-cli-abort-"));
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

describe("performMigrationAbortCommand: real end-to-end paths", () => {
  it("aborts a real held journal for real, manifestPhase null (genesis never ran) -- the exit-0 postcondition is a real readback, not a trusted return value", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const coordinator = coordinatorFor(home);
    const result = await performMigrationAbortCommand({ confirmGenerationId: "generation-1", homeDir: home, coordinator });
    expect(result).toEqual({ status: "ok", generationId: held.generationId, journalPhase: "maintenance-aborted", manifestPhase: null, applied: true });
    // Positive control: the real journal really is terminal on disk.
    expect(readBackendMaintenanceJournal(home)!.phase).toBe("maintenance-aborted");
  });

  it("aborts a real held journal with a real, settled (aborted) manifest, reading back the manifest phase from real durable state", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const store = new MigrationManifestStore({ homeDir: home });
    let m = store.create(manifest(held.generationId));
    m = store.update(held.generationId, m.checksumSha256, (current) =>
      beginMigrationEffect(current, { kind: "abort", effectId: "e1", inputSha256: "a".repeat(64), startedAt: CREATED_AT }));
    store.update(held.generationId, m.checksumSha256, (current) =>
      completeMigrationEffect(current, {
        effectId: "e1", completedAt: CREATED_AT,
        report: { kind: "abort", reportId: "r1", reportSha256: "b".repeat(64), createdAt: CREATED_AT },
      }));
    const coordinator = coordinatorFor(home);
    const result = await performMigrationAbortCommand({ confirmGenerationId: "generation-1", homeDir: home, coordinator, manifestStore: store });
    expect(result).toEqual({ status: "ok", generationId: held.generationId, journalPhase: "maintenance-aborted", manifestPhase: "aborted", applied: true });
  });

  it("is idempotent for real: aborting an already-aborted generation still reports ok with the same readback", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const coordinator = coordinatorFor(home);
    const first = await performMigrationAbortCommand({ confirmGenerationId: "generation-1", homeDir: home, coordinator });
    const second = await performMigrationAbortCommand({ confirmGenerationId: "generation-1", homeDir: home, coordinator });
    // Same readback, but a repeat finds both writes already made: nothing was applied.
    expect(second).toEqual({ ...first, applied: false });
    expect(first).toMatchObject({ applied: true });
  });
});

describe("performMigrationAbortCommand: the boundary catch (round-1 B-4)", () => {
  it("maps an unknown throw from the journal readback to unexpected-failure, reporting applied:true since a write may already have happened", async () => {
    const home = makeHome();
    await heldJournal(home);
    const result = await performMigrationAbortCommand({
      confirmGenerationId: "generation-1", homeDir: home, coordinator: coordinatorFor(home),
      _operationsForTesting: { readJournal: () => { throw new TypeError("boom with /a/path"); } },
    });
    expect(result).toEqual({ status: "refuse", reason: "unexpected-failure", evidence: "TypeError", applied: true });
    // The abort itself did complete; the boundary reported what it could not rule out.
    expect(readBackendMaintenanceJournal(home)!.phase).toBe("maintenance-aborted");
  });
});

describe("performMigrationAbortCommand: refusal paths", () => {
  it("refuses publication-occupies-slot when injected observation reports a v2 publication journal", async () => {
    const home = makeHome();
    const result = await performMigrationAbortCommand({
      confirmGenerationId: "generation-1",
      homeDir: home,
      _operationsForTesting: { observeJournal: () => ({ kind: "publication" }) },
    });
    expect(result).toEqual({ status: "refuse", reason: "publication-occupies-slot" });
  });

  it("refuses journal-unresolvable, carrying the observation's evidence", async () => {
    const home = makeHome();
    const result = await performMigrationAbortCommand({
      confirmGenerationId: "generation-1",
      homeDir: home,
      _operationsForTesting: { observeJournal: () => ({ kind: "unresolvable", evidence: "journal-checksum-mismatch" }) },
    });
    expect(result).toEqual({ status: "refuse", reason: "journal-unresolvable", evidence: "journal-checksum-mismatch" });
  });

  it("refuses abort-nothing-to-abort for a real absent journal (no injection: a genuinely fresh home with nothing to abort)", async () => {
    const home = makeHome();
    const result = await performMigrationAbortCommand({ confirmGenerationId: "generation-1", homeDir: home });
    expect(result).toEqual({ status: "refuse", reason: "abort-nothing-to-abort" });
  });

  it("classifies a refused performMigrationAbort result through classifyMigrationAbortRefusal, carrying the raw evidence alongside the classified reason", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const coordinator = coordinatorFor(home);
    const result = await performMigrationAbortCommand({
      confirmGenerationId: "generation-1",
      homeDir: home,
      coordinator,
      _operationsForTesting: {
        observeJournal: () => ({ kind: "hold", journal: held }),
        performAbort: async () => ({ status: "refuse", evidence: "journal-unexpected-state", mutated: false }),
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "abort-journal-moved", evidence: "journal-unexpected-state" });
  });

  it("refuses abort-readback-mismatch when performAbort reports completed but the real journal is not actually terminal (injected readJournal, proving the postcondition is a genuine re-read rather than trusting the return value)", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const coordinator = coordinatorFor(home);
    const result = await performMigrationAbortCommand({
      confirmGenerationId: "generation-1",
      homeDir: home,
      coordinator,
      _operationsForTesting: {
        observeJournal: () => ({ kind: "hold", journal: held }),
        performAbort: async () => ({ status: "completed", mutated: true }),
        readJournal: () => held, // still "maintenance-held", not terminal
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "abort-readback-mismatch", applied: true });
  });

  it("refuses abort-readback-mismatch when the readback journal is entirely absent despite performAbort reporting completed", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const coordinator = coordinatorFor(home);
    const result = await performMigrationAbortCommand({
      confirmGenerationId: "generation-1",
      homeDir: home,
      coordinator,
      _operationsForTesting: {
        observeJournal: () => ({ kind: "hold", journal: held }),
        performAbort: async () => ({ status: "completed", mutated: true }),
        readJournal: () => null,
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "abort-readback-mismatch", applied: true });
  });

  it("refuses abort-unresolvable when the manifest presence probe cannot be established on readback (a real terminal journal from a prior real abort, then an injected unresolvable manifestStore for the readback itself -- proving this is a distinct check from performMigrationAbort's own internal one, not merely unreachable code)", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const coordinator = coordinatorFor(home);
    // Real abort first, so the journal is genuinely terminal on disk.
    const real = await performMigrationAbortCommand({ confirmGenerationId: "generation-1", homeDir: home, coordinator });
    expect(real.status).toBe("ok");
    const unresolvableStore = {
      probeManifestPresence: () => ({ status: "unresolvable" as const, reason: "internal-error" }),
    } as unknown as MigrationManifestStore;
    const result = await performMigrationAbortCommand({
      confirmGenerationId: "generation-1",
      homeDir: home,
      coordinator,
      manifestStore: unresolvableStore,
      _operationsForTesting: {
        observeJournal: () => ({ kind: "hold", journal: held }),
        performAbort: async () => ({ status: "completed", mutated: true }),
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "abort-unresolvable", evidence: "manifest-internal-error", applied: true });
  });

  it("refuses abort-unresolvable when reading the present manifest throws on readback (a real terminal journal from a prior real abort, plus a real manifest present, then an injected read failure for the readback step specifically)", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(manifest(held.generationId));
    const coordinator = coordinatorFor(home);
    const real = await performMigrationAbortCommand({ confirmGenerationId: "generation-1", homeDir: home, coordinator, manifestStore: store });
    expect(real.status).toBe("ok");
    const throwingStore = {
      probeManifestPresence: () => store.probeManifestPresence(held.generationId),
      read: () => { throw new MigrationProtocolError("checksum-mismatch", "test"); },
    } as unknown as MigrationManifestStore;
    const result = await performMigrationAbortCommand({
      confirmGenerationId: "generation-1",
      homeDir: home,
      coordinator,
      manifestStore: throwingStore,
      _operationsForTesting: {
        observeJournal: () => ({ kind: "hold", journal: held }),
        performAbort: async () => ({ status: "completed", mutated: true }),
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "abort-unresolvable", evidence: "manifest-checksum-mismatch", applied: true });
  });

  it("refuses abort-readback-mismatch when the present manifest reads back as not settled, after a real terminal journal (an unexpected disagreement performMigrationAbort itself would not have produced, isolated from the journal-not-terminal case by first making the journal genuinely terminal for real)", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(manifest(held.generationId));
    const coordinator = coordinatorFor(home);
    // Real abort first (against a genesis-absent state), so the journal is
    // genuinely terminal on disk -- isolating this test to the manifest
    // disagreement specifically, not the journal-not-terminal case.
    await coordinator.abortMaintenance({
      expectedChecksumSha256: held.checksumSha256,
      sourceSelectionSha256: held.sourceSelectionSha256,
      abortEvidenceSha256: "c".repeat(64),
    });
    expect(readBackendMaintenanceJournal(home)!.phase).toBe("maintenance-aborted");
    const result = await performMigrationAbortCommand({
      confirmGenerationId: "generation-1",
      homeDir: home,
      coordinator,
      manifestStore: store,
      _operationsForTesting: {
        observeJournal: () => ({ kind: "hold", journal: held }),
        performAbort: async () => ({ status: "completed", mutated: true }),
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "abort-readback-mismatch", applied: true });
  });

  it("refuses abort-unresolvable with manifest-internal-error evidence when reading the present manifest throws a non-MigrationProtocolError on readback", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(manifest(held.generationId));
    const coordinator = coordinatorFor(home);
    const real = await performMigrationAbortCommand({ confirmGenerationId: "generation-1", homeDir: home, coordinator, manifestStore: store });
    expect(real.status).toBe("ok");
    const throwingStore = {
      probeManifestPresence: () => store.probeManifestPresence(held.generationId),
      read: () => { throw new Error("an unrelated internal failure"); },
    } as unknown as MigrationManifestStore;
    const result = await performMigrationAbortCommand({
      confirmGenerationId: "generation-1",
      homeDir: home,
      coordinator,
      manifestStore: throwingStore,
      _operationsForTesting: {
        observeJournal: () => ({ kind: "hold", journal: held }),
        performAbort: async () => ({ status: "completed", mutated: true }),
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "abort-unresolvable", evidence: "manifest-internal-error", applied: true });
  });
});
function pendingCopyBatchManifest(store: MigrationManifestStore): MigrationManifest {
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
  return copying;
}

describe("performMigrationAbortCommand: the confirmation fence (plan section 9, round-1 B-1/A-10)", () => {
  it("an omitted token refuses abort-confirmation-missing, names the live generation, and leaves journal and manifest bytes identical", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(manifest(held.generationId));
    const journalBefore = readFileSync(backendPublicationJournalPath(home));
    const manifestBefore = store.read(held.generationId).checksumSha256;

    const result = await performMigrationAbortCommand({ homeDir: home, coordinator: coordinatorFor(home), manifestStore: store });

    expect(result).toEqual({ status: "refuse", reason: "abort-confirmation-missing", generationId: held.generationId });
    expect(readFileSync(backendPublicationJournalPath(home)).equals(journalBefore)).toBe(true);
    expect(store.read(held.generationId).checksumSha256).toBe(manifestBefore);
    expect(readBackendMaintenanceJournal(home)!.phase).toBe("maintenance-held");
  });

  it("a mismatched token refuses abort-confirmation-moved and leaves journal and manifest bytes identical", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(manifest(held.generationId));
    const journalBefore = readFileSync(backendPublicationJournalPath(home));
    const manifestBefore = store.read(held.generationId).checksumSha256;

    const result = await performMigrationAbortCommand({
      confirmGenerationId: "some-other-generation", homeDir: home, coordinator: coordinatorFor(home), manifestStore: store,
    });

    expect(result).toEqual({ status: "refuse", reason: "abort-confirmation-moved", generationId: held.generationId });
    expect(readFileSync(backendPublicationJournalPath(home)).equals(journalBefore)).toBe(true);
    expect(store.read(held.generationId).checksumSha256).toBe(manifestBefore);
  });

  it("positive control: the matching token performs the same abort for real", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(manifest(held.generationId));

    const result = await performMigrationAbortCommand({
      confirmGenerationId: held.generationId, homeDir: home, coordinator: coordinatorFor(home), manifestStore: store,
    });

    expect(result).toEqual({ status: "ok", generationId: held.generationId, journalPhase: "maintenance-aborted", manifestPhase: "aborted", applied: true });
  });
});

describe("performMigrationAbortCommand: --dry-run (round-1 B-1/A-10)", () => {
  it("runs every read, reports applied:false, and leaves journal and manifest bytes identical; the real run afterwards does the work", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(manifest(held.generationId));
    const journalBefore = readFileSync(backendPublicationJournalPath(home));
    const manifestBefore = store.read(held.generationId).checksumSha256;
    const coordinator = coordinatorFor(home);

    const dry = await performMigrationAbortCommand({
      confirmGenerationId: held.generationId, dryRun: true, homeDir: home, coordinator, manifestStore: store,
    });
    expect(dry).toEqual({ status: "ok", generationId: held.generationId, journalPhase: "maintenance-held", manifestPhase: null, applied: false });
    expect(readFileSync(backendPublicationJournalPath(home)).equals(journalBefore)).toBe(true);
    expect(store.read(held.generationId).checksumSha256).toBe(manifestBefore);

    const real = await performMigrationAbortCommand({
      confirmGenerationId: held.generationId, homeDir: home, coordinator, manifestStore: store,
    });
    expect(real).toMatchObject({ status: "ok", applied: true, manifestPhase: "aborted" });
  });

  it("refuses with the class the real run would get when the manifest has a pending copy effect", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const store = new MigrationManifestStore({ homeDir: home });
    pendingCopyBatchManifest(store);

    const dry = await performMigrationAbortCommand({
      confirmGenerationId: held.generationId, dryRun: true, homeDir: home, coordinator: coordinatorFor(home), manifestStore: store,
    });
    expect(dry).toEqual({ status: "refuse", reason: "abort-manifest-needs-resume", evidence: "manifest-readback" });
  });

  it("still enforces the fence under --dry-run", async () => {
    const home = makeHome();
    await heldJournal(home);
    const dry = await performMigrationAbortCommand({ dryRun: true, homeDir: home, coordinator: coordinatorFor(home) });
    expect(dry).toMatchObject({ status: "refuse", reason: "abort-confirmation-missing" });
  });
});

describe("performMigrationAbortCommand: applied tracks whether a durable write preceded the refusal (round-1 A-2/B-6)", () => {
  it("a refusal after the journal was terminalized reports applied:true (the manifest write fails)", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const real = new MigrationManifestStore({ homeDir: home });
    real.create(manifest(held.generationId));
    const failingStore = {
      probeManifestPresence: (id: string) => real.probeManifestPresence(id),
      read: (id: string) => real.read(id),
      update: () => { throw new MigrationProtocolError("unexpected-state", "test"); },
    } as unknown as MigrationManifestStore;

    const result = await performMigrationAbortCommand({
      confirmGenerationId: held.generationId, homeDir: home, coordinator: coordinatorFor(home), manifestStore: failingStore,
    });

    expect(readBackendMaintenanceJournal(home)!.phase).toBe("maintenance-aborted");
    expect(result).toEqual({ status: "refuse", reason: "abort-unresolvable", evidence: "manifest-unexpected-state", applied: true });
  });

  it("a readback refusal after an idempotent repeat that wrote nothing reports no applied flag either", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const result = await performMigrationAbortCommand({
      confirmGenerationId: held.generationId, homeDir: home, coordinator: coordinatorFor(home),
      _operationsForTesting: {
        observeJournal: () => ({ kind: "hold", journal: held }),
        performAbort: async () => ({ status: "completed", mutated: false }),
        readJournal: () => held, // still "maintenance-held", not terminal
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "abort-readback-mismatch" });
  });

  it("a refusal before any write reports no applied flag (the pending-effect refusal leaves the journal held)", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const store = new MigrationManifestStore({ homeDir: home });
    pendingCopyBatchManifest(store);

    const result = await performMigrationAbortCommand({
      confirmGenerationId: held.generationId, homeDir: home, coordinator: coordinatorFor(home), manifestStore: store,
    });

    expect(result).toEqual({ status: "refuse", reason: "abort-manifest-needs-resume", evidence: "manifest-readback" });
    expect(readBackendMaintenanceJournal(home)!.phase).toBe("maintenance-held");
  });
});

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveMigrationHoldContinuation,
  type MigrationHoldCandidate,
} from "../../src/migration/hold-continuation.js";
import {
  BackendPublicationCoordinator,
  backendPublicationCanonicalSha256,
  backendPublicationJournalPath,
  readBackendMaintenanceJournal,
  withBackendPublicationAppendBarrierAsync,
  rebindBackendMaintenanceCutoff,
  type BackendMaintenanceJournal,
  type BackendPublicationDriver,
} from "../../src/storage/backend-publication.js";

const roots: string[] = [];
const MACHINE_ID = "018f0b5d-1234-4abc-8def-1234567890ab";
const OTHER_MACHINE_ID = "018f0b5d-9999-4abc-8def-1234567890ab";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "lcm-hold-continuation-"));
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

function rewriteJournal(home: string, mutate: (journal: Record<string, unknown>) => Record<string, unknown>): void {
  const path = backendPublicationJournalPath(home);
  const current = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const next = mutate(current);
  const { checksumSha256: _checksum, ...payload } = next;
  writeFileSync(path, `${JSON.stringify({ ...payload, checksumSha256: backendPublicationCanonicalSha256(payload) })}\n`, { mode: 0o600 });
}

async function heldJournal(home: string): Promise<BackendMaintenanceJournal> {
  return coordinatorFor(home).enterMaintenance({
    publicationId: "maintenance-publication",
    generationId: "maintenance-generation",
    sourceSelectionSha256: "a".repeat(64),
    queueEvidenceSha256: "b".repeat(64),
    roster: [{ machineId: MACHINE_ID, queueCutoff: null, evidenceSha256: "a".repeat(64) }],
  });
}

function candidateFor(journal: BackendMaintenanceJournal, overrides: Partial<MigrationHoldCandidate> = {}): MigrationHoldCandidate {
  return {
    publicationId: journal.publicationId,
    generationId: journal.generationId,
    sourceSelectionSha256: journal.sourceSelectionSha256,
    machineId: journal.roster[0]!.machineId,
    ...overrides,
  };
}

describe("resolveMigrationHoldContinuation (section 4.5 continuation)", () => {
  it("routes maintenance-entering to recover-entering regardless of candidate content (the full comparison belongs to enterMaintenance itself)", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    rewriteJournal(home, (journal) => ({ ...journal, phase: "maintenance-entering" }));
    const entering = readBackendMaintenanceJournal(home)!;
    expect(entering.phase).toBe("maintenance-entering");
    const result = resolveMigrationHoldContinuation({
      journal: entering,
      candidate: candidateFor(held, { sourceSelectionSha256: "totally-unrelated-value-should-not-matter" }),
    });
    expect(result).toEqual({ action: "recover-entering" });
  });

  it("continues a held journal after a real rebind moved queueEvidenceSha256, roster[0].queueCutoff and roster[0].evidenceSha256, because none of those are stable fields (red: comparing any of them would wrongly refuse a live, correct hold)", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const rebound = await withBackendPublicationAppendBarrierAsync(home, async (token) =>
      rebindBackendMaintenanceCutoff({
        homeDir: home,
        expectedChecksumSha256: held.checksumSha256,
        generationId: held.generationId,
        sourceSelectionSha256: held.sourceSelectionSha256,
        queueEvidenceSha256: "c".repeat(64),
        roster: [{ machineId: MACHINE_ID, queueCutoff: "0000000000000000123", evidenceSha256: "c".repeat(64) }],
      }, token));
    // Positive control: confirm the rebind actually moved the three fields
    // section 2.3 consequence 2 names, so this test cannot pass by accident.
    expect(rebound.queueEvidenceSha256).not.toBe(held.queueEvidenceSha256);
    expect(rebound.roster[0]!.queueCutoff).not.toBe(held.roster[0]!.queueCutoff);
    expect(rebound.roster[0]!.evidenceSha256).not.toBe(held.roster[0]!.evidenceSha256);
    expect(rebound.publicationId).toBe(held.publicationId);
    expect(rebound.generationId).toBe(held.generationId);
    expect(rebound.sourceSelectionSha256).toBe(held.sourceSelectionSha256);

    const result = resolveMigrationHoldContinuation({ journal: rebound, candidate: candidateFor(held) });
    expect(result).toEqual({ action: "continue-held" });
  });

  it("refuses a genuinely different selection against a real held journal (red: this must not be confused with the rebind-drift case above)", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const result = resolveMigrationHoldContinuation({
      journal: held,
      candidate: candidateFor(held, { sourceSelectionSha256: "f".repeat(64) }),
    });
    expect(result).toEqual({ action: "refuse", reason: "mismatched-hold" });
  });

  it("refuses a held journal held by a different machine", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const result = resolveMigrationHoldContinuation({
      journal: held,
      candidate: candidateFor(held, { machineId: OTHER_MACHINE_ID }),
    });
    expect(result).toEqual({ action: "refuse", reason: "mismatched-hold" });
  });

  it("refuses a held journal with a different publicationId", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const result = resolveMigrationHoldContinuation({
      journal: held,
      candidate: candidateFor(held, { publicationId: "a-different-publication" }),
    });
    expect(result).toEqual({ action: "refuse", reason: "mismatched-hold" });
  });

  it("refuses a held journal with a different generationId", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const result = resolveMigrationHoldContinuation({
      journal: held,
      candidate: candidateFor(held, { generationId: "a-different-generation" }),
    });
    expect(result).toEqual({ action: "refuse", reason: "mismatched-hold" });
  });

  it("refuses a held journal whose roster has grown past one entry", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const multiRoster: BackendMaintenanceJournal = {
      ...held,
      roster: [...held.roster, { machineId: OTHER_MACHINE_ID, queueCutoff: null, evidenceSha256: "a".repeat(64) }],
    };
    const result = resolveMigrationHoldContinuation({ journal: multiRoster, candidate: candidateFor(held) });
    expect(result).toEqual({ action: "refuse", reason: "mismatched-hold" });
  });

  it("continues a held journal whose candidate matches on every stable field", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const result = resolveMigrationHoldContinuation({ journal: held, candidate: candidateFor(held) });
    expect(result).toEqual({ action: "continue-held" });
  });

  it("routes selection-prepared to resume-required", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const prepared = await coordinatorFor(home).prepareMaintenanceSelection({
      expectedChecksumSha256: held.checksumSha256,
      generationId: held.generationId,
      targetBackend: "postgresql",
      terminalEvidenceSha256: "c".repeat(64),
    });
    expect(prepared.phase).toBe("selection-prepared");
    const result = resolveMigrationHoldContinuation({ journal: prepared, candidate: candidateFor(held) });
    expect(result).toEqual({ action: "refuse", reason: "resume-required" });
  });

  it("routes a terminal selection-completed journal to probe-fresh", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const prepared = await coordinatorFor(home).prepareMaintenanceSelection({
      expectedChecksumSha256: held.checksumSha256,
      generationId: held.generationId,
      targetBackend: "postgresql",
      terminalEvidenceSha256: "c".repeat(64),
    });
    const completed = await coordinatorFor(home).completeMaintenanceSelection({
      expectedChecksumSha256: prepared.checksumSha256,
      generationId: prepared.generationId,
      terminalEvidenceSha256: prepared.terminalEvidenceSha256!,
    });
    expect(completed.phase).toBe("selection-completed");
    const result = resolveMigrationHoldContinuation({ journal: completed, candidate: candidateFor(held) });
    expect(result).toEqual({ action: "probe-fresh" });
  });

  it("routes a terminal maintenance-aborted journal to probe-fresh", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const aborted = await coordinatorFor(home).abortMaintenance({
      expectedChecksumSha256: held.checksumSha256,
      sourceSelectionSha256: held.sourceSelectionSha256,
      abortEvidenceSha256: "c".repeat(64),
    });
    expect(aborted.phase).toBe("maintenance-aborted");
    const result = resolveMigrationHoldContinuation({ journal: aborted, candidate: candidateFor(held) });
    expect(result).toEqual({ action: "probe-fresh" });
  });
});


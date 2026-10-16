import { afterEach, describe, expect, it, vi } from "vitest";
import { performMigrationVerifyCommand } from "../../src/migration/cli-verify.js";
import { MigrationManifestStore } from "../../src/migration/manifest-store.js";
import { MigrationProtocolError } from "../../src/migration/protocol.js";
import { MigrationVerificationStoreError } from "../../src/migration/verification-store.js";
import { completePendingMigrationVerification, MigrationVerificationDriverError } from "../../src/migration/verify-generation.js";
import { admitExistingMigrationCommand } from "../../src/migration/cli-existing.js";
import {
  createFixtureManifest,
  FIXTURE_GENERATION,
  fixtureVerificationReport,
  heldFixtureJournal,
  makeFixtureHome,
  persistFixtureReport,
  removeFixtureHomes,
  snapshotHome,
} from "./existing-fixtures.js";

const roots: string[] = [];
afterEach(() => removeFixtureHomes(roots));

const complete = async () => ({ state: "complete" as const, witness: {} as never });
const resolution = { _operationsForTesting: { classifySnapshot: complete } };

/** A held journal plus a manifest pending verify-generation over a persisted, eligible report. */
async function pendingVerification(overrides: { destinationIdentitySha256?: string; destinationSystemIdentifier?: string | null; pendingEffectId?: string } = {}) {
  const home = makeFixtureHome(roots);
  await heldFixtureJournal(home);
  const report = fixtureVerificationReport();
  persistFixtureReport(home, report);
  createFixtureManifest(new MigrationManifestStore({ homeDir: home }), "copied", { pending: "verify-generation", report, ...overrides });
  return { home, report };
}

describe("verify row 23: completes the pending verify-generation effect from persisted evidence alone", () => {
  it("completes with no destination, project map, lease or identity at all, and reads the result back before exiting 0", async () => {
    const { home, report } = await pendingVerification();
    const result = await performMigrationVerifyCommand({
      homeDir: home, confirmGenerationId: FIXTURE_GENERATION, _resolution: resolution,
    });
    expect(result).toEqual({
      status: "ok", generationId: FIXTURE_GENERATION, manifestPhase: "verified", applied: true, next: "report",
      evidence: {
        reportId: report.reportId, reportSha256: report.reportSha256, activationEligible: true,
        cell: 23, coordinationEffects: "none",
      },
    });
    const manifest = new MigrationManifestStore({ homeDir: home }).read(FIXTURE_GENERATION);
    expect(manifest.phase).toBe("verified");
    expect(manifest.pendingEffect).toBeNull();
    expect(manifest.reports.find((entry) => entry.kind === "verification")?.reportSha256).toBe(report.reportSha256);
  });

  it("a second run lands on the verified cell and confirms from persisted evidence without writing", async () => {
    const { home, report } = await pendingVerification();
    await performMigrationVerifyCommand({ homeDir: home, confirmGenerationId: FIXTURE_GENERATION, _resolution: resolution });
    const before = snapshotHome(home);
    const second = await performMigrationVerifyCommand({ homeDir: home, confirmGenerationId: FIXTURE_GENERATION, _resolution: resolution });
    expect(second).toMatchObject({
      status: "ok", manifestPhase: "verified", applied: false,
      evidence: { reportSha256: report.reportSha256, activationEligible: true, cell: 24 },
    });
    expect(snapshotHome(home)).toEqual(before);
  });

  it("a corrupted pending effect id refuses report-identity-conflict (exit 5) and writes nothing", async () => {
    // The pending effect carries an id that does not name the persisted report.
    const { home } = await pendingVerification({ pendingEffectId: "verify-generation-" + "0".repeat(64) });
    const before = snapshotHome(home);
    const result = await performMigrationVerifyCommand({ homeDir: home, confirmGenerationId: FIXTURE_GENERATION, _resolution: resolution });
    expect(result).toEqual({ status: "refuse", reason: "verify-report-identity-conflict", generationId: FIXTURE_GENERATION });
    expect(snapshotHome(home)).toEqual(before);
  });

  it("a manifest whose sealed destination differs from the persisted report's refuses verify-destination-drift and writes nothing", async () => {
    const { home } = await pendingVerification({ destinationIdentitySha256: "9".repeat(64) });
    const before = snapshotHome(home);
    const result = await performMigrationVerifyCommand({ homeDir: home, confirmGenerationId: FIXTURE_GENERATION, _resolution: resolution });
    expect(result).toEqual({ status: "refuse", reason: "verify-destination-drift", generationId: FIXTURE_GENERATION });
    expect(snapshotHome(home)).toEqual(before);
  });

  it("a manifest that never recorded the destination system identifier refuses verify-destination-drift", async () => {
    const { home } = await pendingVerification({ destinationSystemIdentifier: null });
    const result = await performMigrationVerifyCommand({ homeDir: home, confirmGenerationId: FIXTURE_GENERATION, _resolution: resolution });
    expect(result).toEqual({ status: "refuse", reason: "verify-destination-drift", generationId: FIXTURE_GENERATION });
  });

  it("a persisted report that was never activation-eligible refuses report-identity-conflict", async () => {
    const home = makeFixtureHome(roots);
    await heldFixtureJournal(home);
    const dirty = fixtureVerificationReport(FIXTURE_GENERATION, {
      mismatches: [{ domain: "messages", class: "count", identitySha256: "a".repeat(64) }],
      mismatchTotals: [{ domain: "messages", class: "count", count: 1 }],
    });
    persistFixtureReport(home, dirty);
    createFixtureManifest(new MigrationManifestStore({ homeDir: home }), "copied", { pending: "verify-generation", report: dirty });
    const result = await performMigrationVerifyCommand({ homeDir: home, confirmGenerationId: FIXTURE_GENERATION, _resolution: resolution });
    expect(result).toEqual({ status: "refuse", reason: "verify-report-identity-conflict", generationId: FIXTURE_GENERATION });
  });

  it("a missing persisted report is unresolvable evidence (exit 5), never a recomputation", async () => {
    const home = makeFixtureHome(roots);
    await heldFixtureJournal(home);
    const report = fixtureVerificationReport();
    createFixtureManifest(new MigrationManifestStore({ homeDir: home }), "copied", { pending: "verify-generation", report });
    const result = await performMigrationVerifyCommand({ homeDir: home, confirmGenerationId: FIXTURE_GENERATION, _resolution: resolution });
    expect(result).toEqual({ status: "refuse", reason: "verify-report-unresolvable", evidence: "report-absent", generationId: FIXTURE_GENERATION });
  });

  it("--dry-run is route-only: it reports the pending effect, predicts nothing, and writes nothing", async () => {
    const { home } = await pendingVerification();
    const before = snapshotHome(home);
    const result = await performMigrationVerifyCommand({
      homeDir: home, confirmGenerationId: FIXTURE_GENERATION, dryRun: true, _resolution: resolution,
    });
    expect(result).toEqual({
      status: "ok", generationId: FIXTURE_GENERATION, manifestPhase: "copied", applied: false, next: "verify (drop --dry-run to complete)",
      evidence: { cell: 23, predictive: false, pendingEffect: "verify-generation", coordinationEffects: "none" },
    });
    expect(snapshotHome(home)).toEqual(before);
  });
});

describe("verify row 24: an idempotent confirmation from persisted evidence", () => {
  async function verified() {
    const home = makeFixtureHome(roots);
    await heldFixtureJournal(home);
    const report = fixtureVerificationReport();
    persistFixtureReport(home, report);
    createFixtureManifest(new MigrationManifestStore({ homeDir: home }), "verified", { report });
    return { home, report };
  }

  it("confirms the verified generation, writes nothing, and ignores --dry-run as the same read-only answer", async () => {
    const { home, report } = await verified();
    const before = snapshotHome(home);
    for (const dryRun of [false, true]) {
      const result = await performMigrationVerifyCommand({
        homeDir: home, confirmGenerationId: FIXTURE_GENERATION, dryRun, _resolution: resolution,
      });
      expect(result).toEqual({
        status: "ok", generationId: FIXTURE_GENERATION, manifestPhase: "verified", applied: false, next: "report",
        evidence: { reportId: report.reportId, reportSha256: report.reportSha256, activationEligible: true, cell: 24, coordinationEffects: "none" },
      });
    }
    expect(snapshotHome(home)).toEqual(before);
  });

  it("refuses verify-report-unresolvable when the persisted report the manifest names is gone", async () => {
    const home = makeFixtureHome(roots);
    await heldFixtureJournal(home);
    createFixtureManifest(new MigrationManifestStore({ homeDir: home }), "verified", { report: fixtureVerificationReport() });
    const result = await performMigrationVerifyCommand({ homeDir: home, confirmGenerationId: FIXTURE_GENERATION, _resolution: resolution });
    expect(result).toMatchObject({ status: "refuse", reason: "verify-report-unresolvable", evidence: "report-absent" });
  });

  it("refuses verify-readback-mismatch when the manifest names a report that is not activation-eligible", async () => {
    const home = makeFixtureHome(roots);
    await heldFixtureJournal(home);
    const dirty = fixtureVerificationReport(FIXTURE_GENERATION, {
      mismatches: [{ domain: "messages", class: "count", identitySha256: "a".repeat(64) }],
      mismatchTotals: [{ domain: "messages", class: "count", count: 1 }],
    });
    persistFixtureReport(home, dirty);
    createFixtureManifest(new MigrationManifestStore({ homeDir: home }), "verified", { report: dirty });
    const result = await performMigrationVerifyCommand({ homeDir: home, confirmGenerationId: FIXTURE_GENERATION, _resolution: resolution });
    expect(result).toEqual({ status: "refuse", reason: "verify-readback-mismatch", evidence: "report-not-eligible", generationId: FIXTURE_GENERATION });
  });
});

describe("verify row 22: the fresh path waits for #625", () => {
  it("refuses requires-625-project-map-witness (exit 7), including under --dry-run, and writes nothing", async () => {
    const home = makeFixtureHome(roots);
    await heldFixtureJournal(home);
    createFixtureManifest(new MigrationManifestStore({ homeDir: home }), "copied");
    const before = snapshotHome(home);
    for (const dryRun of [false, true]) {
      const result = await performMigrationVerifyCommand({
        homeDir: home, confirmGenerationId: FIXTURE_GENERATION, dryRun, _resolution: resolution,
      });
      expect(result).toEqual({ status: "refuse", reason: "requires-625-project-map-witness", generationId: FIXTURE_GENERATION });
    }
    expect(snapshotHome(home)).toEqual(before);
  });
});

describe("verify admission and the fence", () => {
  it("names the owner of a cell it does not own (exit 2) and writes nothing", async () => {
    const home = makeFixtureHome(roots);
    await heldFixtureJournal(home);
    createFixtureManifest(new MigrationManifestStore({ homeDir: home }), "planned");
    const before = snapshotHome(home);
    const result = await performMigrationVerifyCommand({ homeDir: home, confirmGenerationId: FIXTURE_GENERATION, _resolution: resolution });
    expect(result).toEqual({ status: "refuse", reason: "route-not-owner", generationId: FIXTURE_GENERATION, next: "resume" });
    expect(snapshotHome(home)).toEqual(before);
  });

  it.each([
    ["a missing token", undefined, "existing-confirmation-missing"],
    ["a mismatched token", "generation-2", "existing-confirmation-moved"],
  ])("%s refuses at the fence (exit 3), never reaches the completion, and leaves the home byte-identical", async (_name, token, reason) => {
    const { home } = await pendingVerification();
    const before = snapshotHome(home);
    const completePending = vi.fn();
    const result = await performMigrationVerifyCommand({
      homeDir: home, confirmGenerationId: token, _resolution: resolution, _operationsForTesting: { completePending },
    });
    expect(result).toEqual({ status: "refuse", reason, generationId: FIXTURE_GENERATION });
    expect(completePending).not.toHaveBeenCalled();
    expect(snapshotHome(home)).toEqual(before);
  });

  it("passes a resolver refusal through unchanged (no live hold and no --generation)", async () => {
    const home = makeFixtureHome(roots);
    const result = await performMigrationVerifyCommand({ homeDir: home, confirmGenerationId: FIXTURE_GENERATION });
    expect(result).toEqual({ status: "refuse", reason: "generation-required" });
  });

  it("resolves an explicit --generation", async () => {
    const { home } = await pendingVerification();
    const result = await performMigrationVerifyCommand({
      homeDir: home, generation: FIXTURE_GENERATION, confirmGenerationId: FIXTURE_GENERATION, dryRun: true, _resolution: resolution,
    });
    expect(result).toMatchObject({ status: "ok", applied: false });
  });

  it("fails loudly, never guessing, if the router ever admits verify at a cell it does not handle", async () => {
    const home = makeFixtureHome(roots);
    await heldFixtureJournal(home);
    createFixtureManifest(new MigrationManifestStore({ homeDir: home }), "planned");
    const result = await performMigrationVerifyCommand({
      homeDir: home, confirmGenerationId: FIXTURE_GENERATION,
      _operationsForTesting: {
        admit: async (input) => {
          const admitted = await admitExistingMigrationCommand({ ...input, command: "resume", resolution: { ...input.resolution, ...resolution } });
          return admitted;
        },
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "unexpected-failure", evidence: "Error", applied: true });
  });
});

describe("verify error mapping and the read-back", () => {
  async function ready() {
    return pendingVerification();
  }

  it("refuses verify-readback-mismatch (applied) when the call claims success but the manifest does not read back verified", async () => {
    const { home, report } = await ready();
    const result = await performMigrationVerifyCommand({
      homeDir: home, confirmGenerationId: FIXTURE_GENERATION, _resolution: resolution,
      _operationsForTesting: { completePending: () => ({ report, outcome: "clean", effectId: "e", inputSha256: report.reportSha256 }) },
    });
    expect(result).toEqual({ status: "refuse", reason: "verify-readback-mismatch", evidence: "manifest-copied", generationId: FIXTURE_GENERATION, applied: true });
  });

  it("refuses verify-readback-mismatch when the verified manifest names a different report than the call returned", async () => {
    const { home } = await ready();
    const other = fixtureVerificationReport(FIXTURE_GENERATION, { manifestRevision: 9 });
    const result = await performMigrationVerifyCommand({
      homeDir: home, confirmGenerationId: FIXTURE_GENERATION, _resolution: resolution,
      // Complete for real, then claim a different report was the result.
      _operationsForTesting: {
        completePending: (input) => ({ ...completePendingMigrationVerification(input)!, report: other }),
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "verify-readback-mismatch", evidence: "report-reference-mismatch", generationId: FIXTURE_GENERATION, applied: true });
  });

  it("refuses verify-readback-mismatch (pending-effect-moved, nothing applied) when the driver finds nothing pending", async () => {
    const { home } = await ready();
    const result = await performMigrationVerifyCommand({
      homeDir: home, confirmGenerationId: FIXTURE_GENERATION, _resolution: resolution,
      _operationsForTesting: { completePending: () => null },
    });
    expect(result).toEqual({ status: "refuse", reason: "verify-readback-mismatch", evidence: "pending-effect-moved", generationId: FIXTURE_GENERATION });
  });

  it.each([
    ["a protocol failure", new MigrationProtocolError("unexpected-state", "x"), "manifest-unresolvable", "manifest-unexpected-state"],
    ["a report-store failure", new MigrationVerificationStoreError("malformed-record", "x"), "verify-report-unresolvable", "report-malformed-record"],
  ])("maps %s to its closed refusal", async (_name, failure, reason, evidence) => {
    const { home } = await ready();
    const result = await performMigrationVerifyCommand({
      homeDir: home, confirmGenerationId: FIXTURE_GENERATION, _resolution: resolution,
      _operationsForTesting: { completePending: () => { throw failure; } },
    });
    expect(result).toEqual({ status: "refuse", reason, evidence, generationId: FIXTURE_GENERATION });
  });

  it.each(["report-identity-conflict", "destination-drift", "invalid-input"] as const)("maps the driver's %s to its closed verify refusal", async (driverReason) => {
    const { home } = await ready();
    const result = await performMigrationVerifyCommand({
      homeDir: home, confirmGenerationId: FIXTURE_GENERATION, _resolution: resolution,
      _operationsForTesting: { completePending: () => { throw new MigrationVerificationDriverError(driverReason, "x"); } },
    });
    expect(result).toEqual({ status: "refuse", reason: `verify-${driverReason}`, generationId: FIXTURE_GENERATION });
  });

  it("maps a driver reason this build cannot produce to the boundary's unexpected-failure rather than inventing a class", async () => {
    const { home } = await ready();
    const result = await performMigrationVerifyCommand({
      homeDir: home, confirmGenerationId: FIXTURE_GENERATION, _resolution: resolution,
      _operationsForTesting: { completePending: () => { throw new MigrationVerificationDriverError("lease-lost", "x"); } },
    });
    expect(result).toEqual({ status: "refuse", reason: "unexpected-failure", evidence: "MigrationVerificationDriverError", applied: true });
  });

  it("lets an unrecognised failure while reading the evidence back reach the boundary, reporting applied", async () => {
    const { home, report } = await ready();
    const result = await performMigrationVerifyCommand({
      homeDir: home, confirmGenerationId: FIXTURE_GENERATION, _resolution: resolution,
      reportStore: { read: () => { throw new TypeError("boom"); } } as never,
      _operationsForTesting: { completePending: (input) => completePendingMigrationVerification(input) ?? { report } as never },
    });
    expect(result).toEqual({ status: "refuse", reason: "unexpected-failure", evidence: "TypeError", applied: true });
  });

  it("maps a protocol or store failure while reading the evidence back to its closed refusal", async () => {
    const { home, report } = await ready();
    const result = await performMigrationVerifyCommand({
      homeDir: home, confirmGenerationId: FIXTURE_GENERATION, _resolution: resolution,
      // The resolver reads the manifest once; every later read (the read-back) fails.
      manifestStore: (() => {
        const real = new MigrationManifestStore({ homeDir: home });
        let reads = 0;
        return new Proxy(real, {
          get(target, property, receiver) {
            if (property === "read") {
              return (generationId: string) => {
                reads += 1;
                if (reads > 1) throw new MigrationProtocolError("malformed-manifest", "x");
                return target.read(generationId);
              };
            }
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
          },
        });
      })(),
      _operationsForTesting: { completePending: () => ({ report, outcome: "clean", effectId: "e", inputSha256: report.reportSha256 }) },
    });
    expect(result).toMatchObject({ status: "refuse", reason: "manifest-unresolvable", evidence: "manifest-malformed-manifest", applied: true });
  });
});


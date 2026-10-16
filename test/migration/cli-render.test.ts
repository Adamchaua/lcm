import { describe, expect, it } from "vitest";
import {
  renderMigrationPlanEnvelope,
  renderMigrationDryRunEnvelope,
  renderMigrationApplyEnvelope,
  renderMigrationAbortEnvelope,
  renderMigrationVerifyEnvelope,
  renderMigrationUnexpectedFailureEnvelope,
} from "../../src/migration/cli-render.js";
import { migrationExitClassForName } from "../../src/migration/exit-classes.js";
import type { SqliteSnapshotDryRun } from "../../src/migration/sqlite-snapshot.js";

const DRY_RUN_FIXTURE: SqliteSnapshotDryRun = {
  sourceSelectionSha256: "a".repeat(64),
  sourceByteWitnessSha256: "b".repeat(64),
  checksumSha256: "c".repeat(64),
  roles: [{ role: "project" } as never, { role: "passive-events" } as never],
  inspectedAt: "2026-01-01T00:00:00.000Z",
};

describe("renderMigrationPlanEnvelope", () => {
  it("builds an ok envelope for a fresh candidate with a present daemon, carrying its observed backend", () => {
    const envelope = renderMigrationPlanEnvelope({
      status: "ok", generationId: "gen-1", disposition: "fresh",
      daemonPresence: { status: "present", storageBackend: "postgresql", pid: 1, daemonInstanceId: "d1" },
    });
    expect(envelope.outcome).toBe("ok");
    expect(envelope.exitCode).toBe(0);
    expect(envelope.applied).toBe(false);
    expect(envelope.generation).toBe("gen-1");
    expect(envelope.next).toBe("apply");
    expect(envelope.evidence).toEqual({
      disposition: "fresh", daemonPresent: true, daemonStorageBackend: "postgresql",
    });
    expect(envelope.refusal).toBeNull();
  });

  it("builds an ok envelope for an authoritatively-absent daemon, carrying daemonPresent: false and no storageBackend field (red: a boolean-collapsed presence could not tell this apart from a real error)", () => {
    const envelope = renderMigrationPlanEnvelope({
      status: "ok", generationId: "gen-2", disposition: "continue-held",
      daemonPresence: { status: "authoritatively-absent" },
    });
    expect(envelope.evidence).toEqual({ disposition: "continue-held", daemonPresent: false });
    expect("daemonStorageBackend" in envelope.evidence).toBe(false);
  });

  it("builds a refusal envelope using the closed refusal-mapping table's exit class and remedy, sanitized evidence carrying the reason's own evidence detail", () => {
    const envelope = renderMigrationPlanEnvelope({
      status: "refuse", reason: "daemon-presence-unresolvable", evidence: "pidfile-live-no-answer",
    });
    expect(envelope.outcome).toBe("refused-evidence");
    expect(envelope.exitCode).toBe(migrationExitClassForName("refused-evidence").code);
    expect(envelope.applied).toBe(false);
    expect(envelope.refusal).toEqual({
      reason: "daemon-presence-unresolvable",
      remedy: "Daemon presence could not be positively established. Run `lcm daemon status`, resolve the failure, and retry.",
    });
    expect(envelope.evidence).toEqual({ detail: "pidfile-live-no-answer" });
  });

  it("builds a refusal envelope with empty evidence when the outcome carries no evidence detail", () => {
    const envelope = renderMigrationPlanEnvelope({ status: "refuse", reason: "machine-identity-unregistered" });
    expect(envelope.evidence).toEqual({});
  });

  it("throws for an unrecognised refusal reason rather than guessing a class (proves this layer never silently defaults)", () => {
    expect(() => renderMigrationPlanEnvelope({ status: "refuse", reason: "not-a-real-reason" }))
      .toThrow(/no exit-class mapping/u);
  });
});

describe("renderMigrationDryRunEnvelope", () => {
  it("builds an ok envelope with the flat dry-run evidence, never applied", () => {
    const envelope = renderMigrationDryRunEnvelope({ status: "ok", dryRun: DRY_RUN_FIXTURE });
    expect(envelope.outcome).toBe("ok");
    expect(envelope.applied).toBe(false);
    expect(envelope.evidence).toEqual({
      sourceSelectionSha256: "a".repeat(64),
      sourceByteWitnessSha256: "b".repeat(64),
      checksumSha256: "c".repeat(64),
      roleCount: 2,
      inspectedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("builds a refusal envelope for dry-run-failed", () => {
    const envelope = renderMigrationDryRunEnvelope({ status: "refuse", reason: "dry-run-failed", evidence: "unsupported-platform" });
    expect(envelope.refusal?.reason).toBe("dry-run-failed");
    expect(envelope.evidence).toEqual({ detail: "unsupported-platform" });
  });
});

describe("renderMigrationApplyEnvelope", () => {
  it("builds an ok envelope for a real copy, applied true, next null", () => {
    const envelope = renderMigrationApplyEnvelope({ status: "ok", generationId: "gen-1", applied: true, phase: "copied", daemonPresence: { status: "authoritatively-absent" } });
    expect(envelope.outcome).toBe("ok");
    expect(envelope.applied).toBe(true);
    expect(envelope.generation).toBe("gen-1");
    expect(envelope.manifestPhase).toBe("copied");
    expect(envelope.next).toBeNull();
  });

  it("builds an ok envelope for --dry-run, applied false, next suggests dropping --dry-run", () => {
    const envelope = renderMigrationApplyEnvelope({ status: "ok", generationId: "gen-1", applied: false, daemonPresence: { status: "authoritatively-absent" } });
    expect(envelope.applied).toBe(false);
    expect(envelope.manifestPhase).toBeNull();
    expect(envelope.next).toMatch(/--dry-run/u);
  });

  it("reports applied: true for a refusal after capture already durably mutated state (red: reporting false here would tell an operator nothing moved when it did)", () => {
    const envelope = renderMigrationApplyEnvelope({ status: "refuse", reason: "copy-failed", evidence: "PostgreSqlStorageOperationError" });
    expect(envelope.applied).toBe(true);
    expect(envelope.refusal?.reason).toBe("copy-failed");
  });

  it("reports applied: true for capture-failed specifically, the other durable-mutation producer", () => {
    const envelope = renderMigrationApplyEnvelope({ status: "refuse", reason: "capture-failed" });
    expect(envelope.applied).toBe(true);
  });

  it("reports applied: false for a preflight-stage refusal before any durable mutation in this invocation (red: reporting true here would falsely claim state moved)", () => {
    const envelope = renderMigrationApplyEnvelope({ status: "refuse", reason: "machine-identity-unregistered" });
    expect(envelope.applied).toBe(false);
  });

  it("reports applied: false for a confirmation-fence refusal", () => {
    const envelope = renderMigrationApplyEnvelope({ status: "refuse", reason: "confirmation-missing" });
    expect(envelope.applied).toBe(false);
  });
});

describe("renderMigrationApplyEnvelope, applied and presence evidence (round-1 A-2/B-6, A-8)", () => {
  it.each([
    "hold-entry-readback-mismatch", "capture-failed", "capture-contention", "capture-unresolvable",
    "snapshot-unresolvable", "capture-incomplete", "manifest-unresolvable",
    "genesis-inspection-failed", "genesis-create-failed", "genesis-dry-run-begin-failed",
    "genesis-dry-run-complete-failed", "copy-failed",
  ])("reports applied:true for %s, which follows a durable write in the same invocation", (reason) => {
    expect(renderMigrationApplyEnvelope({ status: "refuse", reason }).applied).toBe(true);
  });

  it.each([
    "confirmation-missing", "confirmation-generation-moved", "hold-entry-contention", "hold-entry-slot-occupied",
    "hold-entry-precondition", "hold-entry-evidence", "entering-recovery-contention", "continuation-mismatched-hold",
    "continuation-partial-snapshot", "journal-unresolvable", "publication-occupies-slot",
  ])("reports applied:false for %s, which is raised before this invocation writes anything", (reason) => {
    expect(renderMigrationApplyEnvelope({ status: "refuse", reason }).applied).toBe(false);
  });

  it("records a present daemon and its backend in the exit-0 evidence, as plan does", () => {
    const envelope = renderMigrationApplyEnvelope({
      status: "ok", generationId: "g", applied: true, phase: "copied",
      daemonPresence: { status: "present", storageBackend: "postgresql", pid: 7, daemonInstanceId: "d1" },
    });
    expect(envelope.evidence).toEqual({ daemonPresent: true, daemonStorageBackend: "postgresql" });
  });

  it("records an authoritative absence as daemonPresent:false with no backend field", () => {
    const envelope = renderMigrationApplyEnvelope({
      status: "ok", generationId: "g", applied: false, daemonPresence: { status: "authoritatively-absent" },
    });
    expect(envelope.evidence).toEqual({ daemonPresent: false });
  });
});

describe("renderMigrationUnexpectedFailureEnvelope (round-1 B-4)", () => {
  it.each([["plan", false], ["dry-run", false], ["apply", true], ["abort", true]] as const)(
    "builds the closed exit-5 envelope for %s, with applied:%s and only the error name as evidence",
    (command, applied) => {
      const envelope = renderMigrationUnexpectedFailureEnvelope(command, new RangeError("a message with /a/path"));
      expect(envelope).toMatchObject({ command, outcome: "refused-evidence", exitCode: 5, applied });
      expect(envelope.refusal?.reason).toBe("unexpected-failure");
      expect(envelope.evidence).toEqual({ detail: "RangeError" });
    },
  );
});

describe("renderMigrationAbortEnvelope", () => {
  it("builds an ok envelope whose applied flag is the operation's own report of whether it wrote", () => {
    const envelope = renderMigrationAbortEnvelope({
      status: "ok", generationId: "gen-1", journalPhase: "maintenance-aborted", manifestPhase: "aborted", applied: true,
    });
    expect(envelope.applied).toBe(true);
    expect(renderMigrationAbortEnvelope({
      status: "ok", generationId: "gen-1", journalPhase: "maintenance-held", manifestPhase: null, applied: false,
    }).applied).toBe(false);
    expect(envelope.generation).toBe("gen-1");
    expect(envelope.manifestPhase).toBe("aborted");
    expect(envelope.evidence).toEqual({ journalPhase: "maintenance-aborted" });
  });

  it("builds an ok envelope with a null manifestPhase when the manifest was genuinely never created", () => {
    const envelope = renderMigrationAbortEnvelope({
      status: "ok", generationId: "gen-1", journalPhase: "maintenance-aborted", manifestPhase: null, applied: true,
    });
    expect(envelope.manifestPhase).toBeNull();
  });

  it("reports applied:true on a refusal that followed a durable write, in each direction independently (A-2)", () => {
    const after = renderMigrationAbortEnvelope({ status: "refuse", reason: "abort-unresolvable", evidence: "manifest-unexpected-state", applied: true });
    const before = renderMigrationAbortEnvelope({ status: "refuse", reason: "abort-unresolvable", evidence: "manifest-unexpected-state" });
    expect(after.applied).toBe(true);
    expect(before.applied).toBe(false);
  });

  it("carries the live generation on a confirmation refusal so the operator learns what to confirm", () => {
    const envelope = renderMigrationAbortEnvelope({ status: "refuse", reason: "abort-confirmation-moved", generationId: "gen-live" });
    expect(envelope.generation).toBe("gen-live");
    expect(envelope.exitCode).toBe(3);
  });

  it("carries the router's next on a routed refusal", () => {
    const envelope = renderMigrationAbortEnvelope({ status: "refuse", reason: "route-resume-required", generationId: "gen-1", next: "resume" });
    expect(envelope).toMatchObject({ exitCode: 6, outcome: "incomplete-recoverable", next: "resume", generation: "gen-1" });
  });

  it("builds a refusal envelope for abort-nothing-to-abort, never applied", () => {
    const envelope = renderMigrationAbortEnvelope({ status: "refuse", reason: "abort-nothing-to-abort" });
    expect(envelope.applied).toBe(false);
    expect(envelope.refusal?.reason).toBe("abort-nothing-to-abort");
  });
});

describe("renderMigrationVerifyEnvelope", () => {
  it("builds an ok envelope carrying the cell's evidence, the generation, the phase and next", () => {
    const envelope = renderMigrationVerifyEnvelope({
      status: "ok", generationId: "gen-1", manifestPhase: "verified", applied: true, next: "report",
      evidence: { reportSha256: "a".repeat(64), activationEligible: true, cell: 23, coordinationEffects: "none" },
    });
    expect(envelope).toMatchObject({
      command: "verify", outcome: "ok", exitCode: 0, generation: "gen-1", manifestPhase: "verified", applied: true, next: "report",
      evidence: { activationEligible: true, cell: 23, coordinationEffects: "none", reportSha256: "a".repeat(64) },
      refusal: null,
    });
  });

  it("builds a not-applied ok envelope for a read-only answer", () => {
    expect(renderMigrationVerifyEnvelope({
      status: "ok", generationId: "gen-1", manifestPhase: "copied", applied: false, next: null, evidence: { predictive: false },
    })).toMatchObject({ applied: false, next: null, evidence: { predictive: false } });
  });

  it.each([
    ["requires-625-project-map-witness", 7, undefined],
    ["verify-destination-drift", 5, undefined],
    ["existing-confirmation-moved", 3, undefined],
    ["route-not-owner", 2, "resume"],
    ["route-resume-required", 6, "resume"],
  ])("maps the refusal %s to exit %i and carries the router's next (%s) and the generation", (reason, exit, next) => {
    const envelope = renderMigrationVerifyEnvelope({ status: "refuse", reason, generationId: "gen-1", ...(next === undefined ? {} : { next }) });
    expect(envelope.exitCode).toBe(exit);
    expect(envelope.generation).toBe("gen-1");
    expect(envelope.next).toBe(next ?? null);
    expect(envelope.applied).toBe(false);
  });

  it("reports applied:true on a refusal that followed a durable write", () => {
    expect(renderMigrationVerifyEnvelope({ status: "refuse", reason: "verify-readback-mismatch", applied: true }).applied).toBe(true);
  });
});

describe("every command's ok and refusal envelopes keep outcome/exitCode agreement (buildMigrationEnvelope's own construction-time assertion, exercised through every render function)", () => {
  it("agrees for every render function's ok path", () => {
    for (const envelope of [
      renderMigrationPlanEnvelope({ status: "ok", generationId: "g", disposition: "fresh", daemonPresence: { status: "authoritatively-absent" } }),
      renderMigrationDryRunEnvelope({ status: "ok", dryRun: DRY_RUN_FIXTURE }),
      renderMigrationApplyEnvelope({ status: "ok", generationId: "g", applied: true, phase: "copied", daemonPresence: { status: "authoritatively-absent" } }),
      renderMigrationAbortEnvelope({ status: "ok", generationId: "g", journalPhase: "maintenance-aborted", manifestPhase: null, applied: true }),
    ]) {
      expect(migrationExitClassForName(envelope.outcome).code).toBe(envelope.exitCode);
    }
  });
});


import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  exit: vi.fn((code) => {
    throw new Error("exit:" + (code ?? 0));
  }),
  plan: vi.fn(),
  dryRun: vi.fn(),
  apply: vi.fn(),
  abort: vi.fn(),
}));

vi.mock("node:process", async (importOriginal) => ({
  ...(await importOriginal()),
  exit: state.exit,
}));

vi.mock("../../src/runtime-paths.js", async (importOriginal) => ({
  ...(await importOriginal()),
  migrateLegacyHomeIfNeeded: vi.fn(),
}));

vi.mock("../../src/migration/cli-plan.js", () => ({
  performMigrationPlan: state.plan,
}));

vi.mock("../../src/migration/cli-dry-run.js", async (importOriginal) => ({
  ...(await importOriginal()),
  performMigrationDryRunCheck: state.dryRun,
}));

vi.mock("../../src/migration/cli-apply.js", async (importOriginal) => ({
  ...(await importOriginal()),
  performMigrationApply: state.apply,
}));

vi.mock("../../src/migration/cli-abort.js", () => ({
  performMigrationAbortCommand: state.abort,
}));

const { runCli } = await import("../../bin/lcm.js");

function stdoutText(spy) {
  return spy.mock.calls.map(([value]) => String(value)).join("");
}

function stderrText(spy) {
  return spy.mock.calls.map(([value]) => String(value)).join("");
}

async function invoke(...args) {
  await runCli(["node", "lcm", ...args]);
}

describe("lcm migration command group", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("plan: human mode prints a one-line ok summary and sets exitCode 0", async () => {
    state.plan.mockResolvedValueOnce({
      status: "ok", generationId: "gen-1", disposition: "fresh",
      daemonPresence: { status: "authoritatively-absent" },
    });
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await invoke("migration", "plan");
    expect(state.plan).toHaveBeenCalledWith({ cwd: process.cwd(), homeDir: expect.any(String) });
    expect(stdoutText(out)).toContain("plan: ok (exit 0)");
    expect(stdoutText(out)).toContain("generation=gen-1");
    expect(stdoutText(out)).toContain("applied=false");
    expect(stdoutText(out)).toContain("next=apply");
    expect(process.exitCode).toBe(0);
  });

  it("plan --json: stdout carries exactly the envelope document, nothing else", async () => {
    state.plan.mockResolvedValueOnce({
      status: "ok", generationId: "gen-1", disposition: "fresh",
      daemonPresence: { status: "present", storageBackend: "sqlite", pid: 1, daemonInstanceId: "d1" },
    });
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await invoke("migration", "plan", "--json");
    const envelope = JSON.parse(stdoutText(out));
    expect(envelope).toMatchObject({
      schemaVersion: 1, command: "plan", outcome: "ok", exitCode: 0,
      generation: "gen-1", applied: false, next: "apply",
    });
    expect(envelope.evidence).toEqual({ disposition: "fresh", daemonPresent: true, daemonStorageBackend: "sqlite" });
    expect(out.mock.calls).toHaveLength(1);
  });

  it("plan: a refusal maps through the closed refusal table to a non-zero exitCode and a human refusal line", async () => {
    state.plan.mockResolvedValueOnce({ status: "refuse", reason: "machine-identity-unregistered" });
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await invoke("migration", "plan");
    expect(stdoutText(out)).toContain("Refused (refused-precondition, exit 2): machine-identity-unregistered");
    expect(stdoutText(out)).toContain("lcm machine register");
    expect(process.exitCode).toBe(2);
  });

  it("plan: an unrecognised refusal reason from the orchestration layer propagates as an uncaught error rather than a guessed exit code", async () => {
    state.plan.mockResolvedValueOnce({ status: "refuse", reason: "not-a-real-reason" });
    await expect(invoke("migration", "plan")).rejects.toThrow(/no exit-class mapping/u);
  });

  it("dry-run: ok envelope carries the flat dry-run evidence", async () => {
    state.dryRun.mockResolvedValueOnce({
      status: "ok",
      dryRun: {
        sourceSelectionSha256: "a".repeat(64), sourceByteWitnessSha256: "b".repeat(64),
        checksumSha256: "c".repeat(64), roles: [{ role: "project" }], inspectedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await invoke("migration", "dry-run", "--json");
    const envelope = JSON.parse(stdoutText(out));
    expect(envelope.command).toBe("dry-run");
    expect(envelope.applied).toBe(false);
    expect(envelope.evidence.roleCount).toBe(1);
  });

  it("dry-run: human mode prints a one-line ok summary that omits generation= entirely (dry-run never resolves a generation, so migrationHumanSummary's generation !== null branch must be provably false here, not merely untested)", async () => {
    state.dryRun.mockResolvedValueOnce({
      status: "ok",
      dryRun: {
        sourceSelectionSha256: "a".repeat(64), sourceByteWitnessSha256: "b".repeat(64),
        checksumSha256: "c".repeat(64), roles: [{ role: "project" }], inspectedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await invoke("migration", "dry-run");
    const line = stdoutText(out);
    expect(line).toBe("dry-run: ok (exit 0) applied=false\n");
    expect(line).not.toContain("generation=");
    expect(line).not.toContain("phase=");
    expect(line).not.toContain("next=");
    expect(process.exitCode).toBe(0);
  });

  it("dry-run: a refusal reports exit 5 (refused-evidence) with the dry-run-failed remedy", async () => {
    state.dryRun.mockResolvedValueOnce({ status: "refuse", reason: "dry-run-failed", evidence: "unsupported-platform" });
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await invoke("migration", "dry-run");
    expect(process.exitCode).toBe(5);
    expect(stdoutText(out)).toContain("dry-run-failed");
  });

  it("apply: passes --confirm-generation, --max-records and --max-bytes through as parsed values, and succeeds", async () => {
    state.apply.mockResolvedValueOnce({ status: "ok", generationId: "gen-1", applied: true, phase: "copied" });
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await invoke("migration", "apply", "--confirm-generation", "gen-1", "--max-records", "250", "--max-bytes", "4096");
    expect(state.apply).toHaveBeenCalledWith(expect.objectContaining({
      confirmGenerationId: "gen-1", maxRecords: 250, maxBytes: 4096, dryRun: undefined,
    }));
    expect(stdoutText(out)).toContain("generation=gen-1");
    expect(stdoutText(out)).toContain("phase=copied");
    expect(process.exitCode).toBe(0);
  });

  it("apply: omitting --confirm-generation still reaches the orchestration layer (never a Commander-level usage error), which refuses confirmation-missing at exit 3", async () => {
    state.apply.mockResolvedValueOnce({ status: "refuse", reason: "confirmation-missing" });
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await invoke("migration", "apply");
    expect(state.apply).toHaveBeenCalledWith(expect.objectContaining({ confirmGenerationId: undefined }));
    expect(process.exitCode).toBe(3);
    expect(stdoutText(out)).toContain("confirmation-missing");
  });

  it("apply --dry-run: applied false, next names dropping --dry-run", async () => {
    state.apply.mockResolvedValueOnce({ status: "ok", generationId: "gen-1", applied: false });
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await invoke("migration", "apply", "--confirm-generation", "gen-1", "--dry-run");
    expect(state.apply).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
    expect(stdoutText(out)).toContain("applied=false");
    expect(stdoutText(out)).toContain("--dry-run");
  });

  it("apply: a non-numeric --max-records is a usage error (exit 1), never reaching the orchestration layer (red: if this reached performMigrationApply it would receive NaN rather than being refused at the boundary)", async () => {
    await expect(invoke("migration", "apply", "--confirm-generation", "gen-1", "--max-records", "not-a-number"))
      .rejects.toThrow("exit:1");
    expect(state.apply).not.toHaveBeenCalled();
  });

  it("apply: exit 7 for a mutation that already occurred (genesis/copy-stage failure), applied: true reported", async () => {
    state.apply.mockResolvedValueOnce({ status: "refuse", reason: "copy-failed", evidence: "PostgreSqlStorageOperationError" });
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await invoke("migration", "apply", "--confirm-generation", "gen-1");
    expect(process.exitCode).toBe(7);
    expect(stdoutText(out)).toContain("copy-failed");
  });

  it("apply: stdout is byte-identical whether stderr progress writes actually occur or are suppressed (section 10\u0027s stream-separation proof)", async () => {
    state.apply.mockResolvedValue({ status: "ok", generationId: "gen-1", applied: true, phase: "copied" });

    const outWithProgress = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const errWithProgress = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await invoke("migration", "apply", "--confirm-generation", "gen-1", "--json");
    const withProgress = stdoutText(outWithProgress);
    expect(stderrText(errWithProgress).length).toBeGreaterThan(0);
    vi.restoreAllMocks();

    const outSuppressed = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await invoke("migration", "apply", "--confirm-generation", "gen-1", "--json");
    const suppressed = stdoutText(outSuppressed);

    expect(suppressed).toBe(withProgress);
  });

  it("abort: ok envelope reports the operation's own applied flag", async () => {
    state.abort.mockResolvedValueOnce({
      status: "ok", generationId: "gen-1", journalPhase: "maintenance-aborted", manifestPhase: "aborted", applied: true,
    });
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await invoke("migration", "abort", "--json");
    const envelope = JSON.parse(stdoutText(out));
    expect(envelope).toMatchObject({ command: "abort", applied: true, generation: "gen-1", manifestPhase: "aborted" });
  });

  it("abort: nothing-to-abort refuses at exit 2", async () => {
    state.abort.mockResolvedValueOnce({ status: "refuse", reason: "abort-nothing-to-abort" });
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await invoke("migration", "abort");
    expect(process.exitCode).toBe(2);
    expect(stdoutText(out)).toContain("abort-nothing-to-abort");
  });

  it("bare lcm migration with no subcommand prints usage to stderr and exits 1, never calling any orchestration function", async () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect(invoke("migration")).rejects.toThrow("exit:1");
    expect(stderrText(err)).toContain("Usage: lcm migration");
    expect(state.plan).not.toHaveBeenCalled();
    expect(state.dryRun).not.toHaveBeenCalled();
    expect(state.apply).not.toHaveBeenCalled();
    expect(state.abort).not.toHaveBeenCalled();
  });

  it("lcm migration --help routes to the custom help page rather than any subcommand action", async () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await expect(invoke("migration", "--help")).rejects.toThrow("exit:0");
    expect(stdoutText(out)).toContain("lcm migration <plan|dry-run|apply|abort> [--json]");
    expect(state.plan).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from "vitest";
import { performMigrationApply, DEFAULT_MIGRATION_APPLY_MAX_RECORDS, DEFAULT_MIGRATION_APPLY_MAX_BYTES } from "../../src/migration/cli-apply.js";
import type { MigrationPreflightResult } from "../../src/migration/cli-preflight.js";

function readyPreflight(overrides: Partial<Extract<MigrationPreflightResult, { status: "ready" }>> = {}): MigrationPreflightResult {
  return {
    status: "ready",
    targetConfig: {
      backend: "postgresql",
      postgresql: {
        url: "postgresql://user:password@db.example.com:5432/lcm",
        caFile: "/unused",
        migrationRole: "lcm_migrator",
        poolMax: 4,
        connectionTimeoutMs: 1000,
        idleTimeoutMs: 1000,
        statementTimeoutMs: 1000,
      },
    },
    presence: { status: "present", storageBackend: "sqlite", pid: 1, daemonInstanceId: "gen-1" },
    candidate: { status: "candidate", disposition: "fresh", generationId: "generation-0" },
    expectedIdentity: {
      id: "remote-project-1",
      localProjectId: "local-1",
      canonical: "/tmp/project",
      remoteProjectId: "remote-project-1",
      machineId: "018f0b5d-1234-4abc-8def-1234567890ab",
      selectedPath: "/tmp/project",
    },
    base: "base-identity",
    ...overrides,
  };
}

describe("performMigrationApply: preflight and confirmation fence", () => {
  it("propagates a preflight refusal unchanged, never reaching the confirmation fence", async () => {
    const result = await performMigrationApply({
      cwd: "/tmp/project",
      homeDir: "/tmp/home",
      confirmGenerationId: "generation-0",
      _preflight: async () => ({ status: "refuse", reason: "migration-target-missing", evidence: "config-validation-error" }),
    });
    expect(result).toEqual({ status: "refuse", reason: "migration-target-missing", evidence: "config-validation-error" });
  });

  it("refuses confirmation-missing when no --confirm-generation was supplied, even though the candidate resolved fine", async () => {
    const result = await performMigrationApply({
      cwd: "/tmp/project",
      homeDir: "/tmp/home",
      _preflight: async () => readyPreflight(),
    });
    expect(result).toEqual({ status: "refuse", reason: "confirmation-missing" });
  });

  it("refuses confirmation-generation-moved when the confirmed id no longer matches the freshly re-run candidate (red: a fence that always accepts a stale token cannot be distinguished from this test failing to catch it -- the mismatch here is deliberately a real string inequality, not a mocked comparison)", async () => {
    const result = await performMigrationApply({
      cwd: "/tmp/project",
      homeDir: "/tmp/home",
      confirmGenerationId: "generation-stale",
      _preflight: async () => readyPreflight(),
    });
    expect(result).toEqual({ status: "refuse", reason: "confirmation-generation-moved" });
  });

  it("accepts a matching confirmation and proceeds (proven by --dry-run stopping cleanly right after, before any mutating call)", async () => {
    const result = await performMigrationApply({
      cwd: "/tmp/project",
      homeDir: "/tmp/home",
      confirmGenerationId: "generation-0",
      dryRun: true,
      _preflight: async () => readyPreflight(),
    });
    expect(result).toEqual({ status: "ok", generationId: "generation-0", applied: false });
  });
});

describe("performMigrationApply: --dry-run never reaches a mutating seam", () => {
  it("never calls performCapture or performGenesisAndCopy on the dry-run path", async () => {
    let captureCalled = false;
    let genesisCalled = false;
    const result = await performMigrationApply({
      cwd: "/tmp/project",
      homeDir: "/tmp/home",
      confirmGenerationId: "generation-0",
      dryRun: true,
      _preflight: async () => readyPreflight(),
      _operationsForTesting: {
        performCapture: async () => { captureCalled = true; return { status: "captured", generationId: "generation-0", maintenanceChecksumSha256: "a".repeat(64), snapshot: {} as never }; },
        performGenesisAndCopy: async () => { genesisCalled = true; return { status: "copied", result: {} as never }; },
      },
    });
    expect(result).toEqual({ status: "ok", generationId: "generation-0", applied: false });
    expect(captureCalled).toBe(false);
    expect(genesisCalled).toBe(false);
  });
});

describe("performMigrationApply: the mutating path", () => {
  it("propagates a capture refusal unchanged, never reaching genesis and copy", async () => {
    let genesisCalled = false;
    const result = await performMigrationApply({
      cwd: "/tmp/project",
      homeDir: "/tmp/home",
      confirmGenerationId: "generation-0",
      _preflight: async () => readyPreflight(),
      _operationsForTesting: {
        performCapture: async () => ({ status: "refuse", reason: "capture-failed", evidence: "Error" }),
        performGenesisAndCopy: async () => { genesisCalled = true; return { status: "copied", result: {} as never }; },
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "capture-failed", evidence: "Error" });
    expect(genesisCalled).toBe(false);
  });

  it("propagates a genesis-and-copy refusal unchanged", async () => {
    const result = await performMigrationApply({
      cwd: "/tmp/project",
      homeDir: "/tmp/home",
      confirmGenerationId: "generation-0",
      _preflight: async () => readyPreflight(),
      _operationsForTesting: {
        performCapture: async () => ({ status: "captured", generationId: "generation-0", maintenanceChecksumSha256: "a".repeat(64), snapshot: {} as never }),
        performGenesisAndCopy: async () => ({ status: "refuse", reason: "copy-failed", evidence: "PostgreSqlStorageOperationError" }),
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "copy-failed", evidence: "PostgreSqlStorageOperationError" });
  });

  it("succeeds end to end (mocked at the capture/genesis-copy boundary), carrying the copy result's own phase and a freshly minted, per-invocation ownerProcessId through to genesis-and-copy's input", async () => {
    let capturedOwnerProcessId: string | undefined;
    let capturedExpectedOwner: string | undefined;
    let capturedExpectedIdentityId: string | undefined;
    let capturedMaxRecords: number | undefined;
    let capturedMaxBytes: number | undefined;
    const result = await performMigrationApply({
      cwd: "/tmp/project",
      homeDir: "/tmp/home",
      confirmGenerationId: "generation-0",
      _preflight: async () => readyPreflight(),
      _operationsForTesting: {
        performCapture: async () => ({ status: "captured", generationId: "generation-0", maintenanceChecksumSha256: "a".repeat(64), snapshot: {} as never }),
        performGenesisAndCopy: async (genesisInput) => {
          capturedOwnerProcessId = genesisInput.ownerProcessId;
          capturedExpectedOwner = genesisInput.expectedOwner;
          capturedExpectedIdentityId = genesisInput.expectedIdentity.id;
          capturedMaxRecords = genesisInput.maxRecords;
          capturedMaxBytes = genesisInput.maxBytes;
          return { status: "copied", result: { phase: "copied" } as never };
        },
        mintOwnerProcessId: () => "minted-owner-id-1",
      },
    });
    expect(result).toEqual({ status: "ok", generationId: "generation-0", applied: true, phase: "copied" });
    expect(capturedOwnerProcessId).toBe("minted-owner-id-1");
    expect(capturedExpectedOwner).toBe("lcm_migrator");
    expect(capturedExpectedIdentityId).toBe("remote-project-1");
    expect(capturedMaxRecords).toBe(DEFAULT_MIGRATION_APPLY_MAX_RECORDS);
    expect(capturedMaxBytes).toBe(DEFAULT_MIGRATION_APPLY_MAX_BYTES);
  });

  it("honours explicit maxRecords/maxBytes overrides rather than always using the defaults", async () => {
    let capturedMaxRecords: number | undefined;
    let capturedMaxBytes: number | undefined;
    await performMigrationApply({
      cwd: "/tmp/project",
      homeDir: "/tmp/home",
      confirmGenerationId: "generation-0",
      maxRecords: 42,
      maxBytes: 4096,
      _preflight: async () => readyPreflight(),
      _operationsForTesting: {
        performCapture: async () => ({ status: "captured", generationId: "generation-0", maintenanceChecksumSha256: "a".repeat(64), snapshot: {} as never }),
        performGenesisAndCopy: async (genesisInput) => {
          capturedMaxRecords = genesisInput.maxRecords;
          capturedMaxBytes = genesisInput.maxBytes;
          return { status: "copied", result: { phase: "copied" } as never };
        },
      },
    });
    expect(capturedMaxRecords).toBe(42);
    expect(capturedMaxBytes).toBe(4096);
  });

  it("uses the real default randomUUID() mint (no injection) and never reuses the same ownerProcessId across two separate invocations", async () => {
    const seen: string[] = [];
    const runOnce = () => performMigrationApply({
      cwd: "/tmp/project",
      homeDir: "/tmp/home",
      confirmGenerationId: "generation-0",
      _preflight: async () => readyPreflight(),
      _operationsForTesting: {
        performCapture: async () => ({ status: "captured", generationId: "generation-0", maintenanceChecksumSha256: "a".repeat(64), snapshot: {} as never }),
        performGenesisAndCopy: async (genesisInput) => {
          seen.push(genesisInput.ownerProcessId);
          return { status: "copied", result: { phase: "copied" } as never };
        },
      },
    });
    await runOnce();
    await runOnce();
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen[0]).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("uses the real resolveMigrationPreflight default (no _preflight injection): a fresh home with no target configured really refuses at the preflight stage", async () => {
    const { mkdirSync, mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const home = mkdtempSync(join(tmpdir(), "lcm-cli-apply-real-preflight-"));
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
    const cwd = join(home, "project");
    mkdirSync(cwd, { mode: 0o700 });
    try {
      const result = await performMigrationApply({ cwd, homeDir: home, confirmGenerationId: "generation-0" });
      expect(result.status).toBe("refuse");
      expect((result as { reason: string }).reason).toMatch(/^migration-target-/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

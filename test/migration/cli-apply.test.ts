import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { performMigrationApply, DEFAULT_MIGRATION_APPLY_MAX_RECORDS, DEFAULT_MIGRATION_APPLY_MAX_BYTES } from "../../src/migration/cli-apply.js";
import type { MigrationPreflightResult } from "../../src/migration/cli-preflight.js";
import type { MigrationManifestStore } from "../../src/migration/manifest-store.js";
import { MigrationProtocolError } from "../../src/migration/protocol.js";

const PRESENT = { status: "present", storageBackend: "sqlite", pid: 1, daemonInstanceId: "gen-1" } as const;

/** A manifest store whose head reads at `phase`, for tests that mock the copy layer above it. */
function headStore(phase = "copied"): MigrationManifestStore {
  return { read: () => ({ phase }) } as unknown as MigrationManifestStore;
}

const IDENTITY = {
  id: "remote-project-1",
  localProjectId: "local-1",
  canonical: "/tmp/project",
  remoteProjectId: "remote-project-1",
  machineId: "018f0b5d-1234-4abc-8def-1234567890ab",
  selectedPath: "/tmp/project",
};
const resolveIdentity = async () => ({ status: "resolved" as const, expectedIdentity: IDENTITY });
const PREVIEW = { destinationProject: "will-be-created-at-apply", localProject: "persisted" } as const;

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
    presence: PRESENT,
    candidate: { status: "candidate", disposition: "fresh", generationId: "generation-0" },
    local: { id: "local-1", canonical: "/tmp/project", persisted: true },
    machineId: "018f0b5d-1234-4abc-8def-1234567890ab",
    destinationProjectId: null,
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
      manifestStore: headStore(),
      _preflight: async () => readyPreflight(),
    });
    expect(result).toEqual({ status: "refuse", reason: "confirmation-missing" });
  });

  it("refuses confirmation-generation-moved when the confirmed id no longer matches the freshly re-run candidate (red: a fence that always accepts a stale token cannot be distinguished from this test failing to catch it -- the mismatch here is deliberately a real string inequality, not a mocked comparison)", async () => {
    const result = await performMigrationApply({
      cwd: "/tmp/project",
      homeDir: "/tmp/home",
      confirmGenerationId: "generation-stale",
      manifestStore: headStore(),
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
      manifestStore: headStore(),
      _preflight: async () => readyPreflight(),
    });
    expect(result).toEqual({ status: "ok", generationId: "generation-0", applied: false, daemonPresence: PRESENT, identityPreview: PREVIEW });
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
      manifestStore: headStore(),
      _preflight: async () => readyPreflight(),
      _operationsForTesting: { resolveExpectedIdentity: resolveIdentity,
        performCapture: async () => { captureCalled = true; return { status: "captured", generationId: "generation-0", maintenanceChecksumSha256: "a".repeat(64), snapshot: {} as never }; },
        performGenesisAndCopy: async () => { genesisCalled = true; return { status: "copied", result: {} as never }; },
      },
    });
    expect(result).toEqual({ status: "ok", generationId: "generation-0", applied: false, daemonPresence: PRESENT, identityPreview: PREVIEW });
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
      manifestStore: headStore(),
      _preflight: async () => readyPreflight(),
      _operationsForTesting: { resolveExpectedIdentity: resolveIdentity,
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
      manifestStore: headStore(),
      _preflight: async () => readyPreflight(),
      _operationsForTesting: { resolveExpectedIdentity: resolveIdentity,
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
      manifestStore: headStore(),
      _preflight: async () => readyPreflight(),
      _operationsForTesting: { resolveExpectedIdentity: resolveIdentity,
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
    expect(result).toEqual({ status: "ok", generationId: "generation-0", applied: true, phase: "copied", daemonPresence: PRESENT });
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
      manifestStore: headStore(),
      _preflight: async () => readyPreflight(),
      _operationsForTesting: { resolveExpectedIdentity: resolveIdentity,
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
      manifestStore: headStore(),
      _preflight: async () => readyPreflight(),
      _operationsForTesting: { resolveExpectedIdentity: resolveIdentity,
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

describe("performMigrationApply: the boundary catch (round-1 B-4)", () => {
  it.each([
    ["the preflight", { _preflight: async () => { throw new TypeError("boom"); } }],
    ["capture", {
      _preflight: async () => readyPreflight(),
      _operationsForTesting: { resolveExpectedIdentity: resolveIdentity, performCapture: async () => { throw new TypeError("boom"); } },
    }],
  ])("maps an unknown throw from %s to unexpected-failure with only the error name", async (_name, overrides) => {
    const result = await performMigrationApply({
      cwd: "/tmp/project", homeDir: "/tmp/home", confirmGenerationId: "generation-0", ...overrides,
    });
    expect(result).toEqual({ status: "refuse", reason: "unexpected-failure", evidence: "TypeError" });
  });
});

describe("performMigrationApply: round-1 fixes", () => {
  const captured = async () => ({ status: "captured" as const, generationId: "generation-0", maintenanceChecksumSha256: "a".repeat(64), snapshot: {} as never });
  const copied = async () => ({ status: "copied" as const, result: { phase: "copied" } as never });

  it("A-3/B-2: carries the confirmed generation id into capture, so capture can compare it where it acts", async () => {
    let received: string | undefined;
    await performMigrationApply({
      cwd: "/tmp/project", homeDir: "/tmp/home", confirmGenerationId: "generation-0", manifestStore: headStore(),
      _preflight: async () => readyPreflight(),
      _operationsForTesting: { resolveExpectedIdentity: resolveIdentity,
        performCapture: async (captureInput) => { received = captureInput.confirmGenerationId; return captured(); },
        performGenesisAndCopy: copied,
      },
    });
    expect(received).toBe("generation-0");
  });

  it("A-8: carries a present daemon's evidence into the ok outcome and announces it before the fence and any write", async () => {
    const events: string[] = [];
    const result = await performMigrationApply({
      cwd: "/tmp/project", homeDir: "/tmp/home", confirmGenerationId: "generation-0", manifestStore: headStore(),
      onDaemonObserved: (presence) => { events.push("observed:" + String(presence.pid)); },
      _preflight: async () => readyPreflight(),
      _operationsForTesting: { resolveExpectedIdentity: resolveIdentity,
        performCapture: async () => { events.push("capture"); return captured(); },
        performGenesisAndCopy: copied,
      },
    });
    expect(result).toMatchObject({ status: "ok", daemonPresence: PRESENT });
    expect(events).toEqual(["observed:1", "capture"]);
  });

  it("A-8: announces a daemon even when the fence then refuses, since the operator should hear about it before retrying", async () => {
    const observed: number[] = [];
    await performMigrationApply({
      cwd: "/tmp/project", homeDir: "/tmp/home", confirmGenerationId: "generation-stale", manifestStore: headStore(),
      onDaemonObserved: (presence) => { observed.push(presence.pid); },
      _preflight: async () => readyPreflight(),
    });
    expect(observed).toEqual([1]);
  });

  it("A-8: records an authoritative absence as such and never announces a daemon", async () => {
    let announced = false;
    const result = await performMigrationApply({
      cwd: "/tmp/project", homeDir: "/tmp/home", confirmGenerationId: "generation-0", dryRun: true,
      onDaemonObserved: () => { announced = true; },
      _preflight: async () => readyPreflight({ presence: { status: "authoritatively-absent" } }),
    });
    expect(result).toEqual({ status: "ok", generationId: "generation-0", applied: false, daemonPresence: { status: "authoritatively-absent" }, identityPreview: PREVIEW });
    expect(announced).toBe(false);
  });

  it("A-16: reads the head through its own manifest store when none is injected, refusing manifest-unresolvable when the real store has no manifest", async () => {
    const { mkdirSync, mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const home = mkdtempSync(join(tmpdir(), "lcm-cli-apply-head-"));
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
    try {
      const result = await performMigrationApply({
        cwd: "/tmp/project", homeDir: home, confirmGenerationId: "generation-0",
        _preflight: async () => readyPreflight(),
        _operationsForTesting: { resolveExpectedIdentity: resolveIdentity, performCapture: captured, performGenesisAndCopy: copied },
      });
      expect(result).toMatchObject({ status: "refuse", reason: "manifest-unresolvable" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("A-16: reports the phase it read back from the manifest head", async () => {
    const result = await performMigrationApply({
      cwd: "/tmp/project", homeDir: "/tmp/home", confirmGenerationId: "generation-0", manifestStore: headStore("copied"),
      _preflight: async () => readyPreflight(),
      _operationsForTesting: { resolveExpectedIdentity: resolveIdentity, performCapture: captured, performGenesisAndCopy: copied },
    });
    expect(result).toMatchObject({ status: "ok", phase: "copied" });
  });

  it("A-16: refuses copy-failed with distinct evidence when the head reads at a phase other than the one the copy layer reported", async () => {
    const result = await performMigrationApply({
      cwd: "/tmp/project", homeDir: "/tmp/home", confirmGenerationId: "generation-0", manifestStore: headStore("copying"),
      _preflight: async () => readyPreflight(),
      _operationsForTesting: { resolveExpectedIdentity: resolveIdentity, performCapture: captured, performGenesisAndCopy: copied },
    });
    expect(result).toEqual({ status: "refuse", reason: "copy-failed", evidence: "manifest-readback-mismatch" });
  });

  it.each([
    ["a protocol error", new MigrationProtocolError("checksum-mismatch", "test"), "manifest-checksum-mismatch"],
    ["an unrecognised failure", new Error("boom"), "manifest-internal-error"],
  ])("A-16: refuses manifest-unresolvable when the head read fails with %s", async (_name, failure, evidence) => {
    const result = await performMigrationApply({
      cwd: "/tmp/project", homeDir: "/tmp/home", confirmGenerationId: "generation-0",
      manifestStore: { read: () => { throw failure; } } as unknown as MigrationManifestStore,
      _preflight: async () => readyPreflight(),
      _operationsForTesting: { resolveExpectedIdentity: resolveIdentity, performCapture: captured, performGenesisAndCopy: copied },
    });
    expect(result).toEqual({ status: "refuse", reason: "manifest-unresolvable", evidence });
  });
});

describe("performMigrationApply: identity is minted only after the fence (plan-v5 Part B (3); closes round-1 A-4)", () => {
  const captured = async () => ({ status: "captured" as const, generationId: "generation-0", maintenanceChecksumSha256: "a".repeat(64), snapshot: {} as never });
  const copied = async () => ({ status: "copied" as const, result: { phase: "copied" } as never });

  function snapshot(root: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) {
        const path = join(entry.parentPath, entry.name);
        out[path] = readFileSync(path, "base64");
      }
    }
    return out;
  }

  it.each([
    ["a missing token", undefined],
    ["a mismatched token", "generation-stale"],
  ])("%s leaves the home byte-identical and never reaches the identity resolver or any mutating seam", async (_name, token) => {
    const home = mkdtempSync(join(tmpdir(), "lcm-cli-apply-fence-"));
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
    writeFileSync(join(home, ".lcm", "marker"), "unchanged");
    const before = snapshot(home);
    const calls: string[] = [];
    try {
      const result = await performMigrationApply({
        cwd: "/tmp/project", homeDir: home, confirmGenerationId: token, manifestStore: headStore(),
        _preflight: async () => readyPreflight(),
        _operationsForTesting: {
          resolveExpectedIdentity: async () => { calls.push("identity"); return { status: "resolved", expectedIdentity: IDENTITY }; },
          performCapture: async () => { calls.push("capture"); return captured(); },
        },
      });
      expect(result.status).toBe("refuse");
      expect(calls).toEqual([]);
      expect(snapshot(home)).toEqual(before);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("--dry-run reports the identity preview and never mints", async () => {
    let minted = false;
    const result = await performMigrationApply({
      cwd: "/tmp/project", homeDir: "/tmp/home", confirmGenerationId: "generation-0", dryRun: true,
      _preflight: async () => readyPreflight({ destinationProjectId: "remote-project-1" }),
      _operationsForTesting: { resolveExpectedIdentity: async () => { minted = true; return { status: "resolved", expectedIdentity: IDENTITY }; } },
    });
    expect(result).toMatchObject({ status: "ok", applied: false, identityPreview: { destinationProject: "exists", localProject: "persisted" } });
    expect(minted).toBe(false);
  });

  it("a valid control mints exactly once, before capture, and hands that identity to genesis and copy", async () => {
    const events: string[] = [];
    let handed: unknown;
    const result = await performMigrationApply({
      cwd: "/tmp/project", homeDir: "/tmp/home", confirmGenerationId: "generation-0", manifestStore: headStore(),
      _preflight: async () => readyPreflight(),
      _operationsForTesting: {
        resolveExpectedIdentity: async (input) => {
          events.push("identity");
          expect(input.preflight.candidate.generationId).toBe("generation-0");
          return { status: "resolved", expectedIdentity: IDENTITY };
        },
        performCapture: async () => { events.push("capture"); return captured(); },
        performGenesisAndCopy: async (genesisInput) => { handed = genesisInput.expectedIdentity; events.push("genesis"); return copied(); },
      },
    });
    expect(result).toMatchObject({ status: "ok", applied: true });
    expect(events).toEqual(["identity", "capture", "genesis"]);
    expect(handed).toBe(IDENTITY);
  });

  it("an identity refusal is returned unchanged and nothing is captured", async () => {
    let capturing = false;
    const result = await performMigrationApply({
      cwd: "/tmp/project", homeDir: "/tmp/home", confirmGenerationId: "generation-0",
      _preflight: async () => readyPreflight(),
      _operationsForTesting: {
        resolveExpectedIdentity: async () => ({ status: "refuse", reason: "destination-project-absent" }),
        performCapture: async () => { capturing = true; return captured(); },
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "destination-project-absent" });
    expect(capturing).toBe(false);
  });

  it.each(["recover-entering", "continue-held"] as const)("a %s hold never mints: the real resolver refuses an unpersisted local identity before any runtime is built", async (disposition) => {
    const home = mkdtempSync(join(tmpdir(), "lcm-cli-apply-held-"));
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
    let capturing = false;
    try {
      const result = await performMigrationApply({
        cwd: join(home, "project"), homeDir: home, confirmGenerationId: "generation-0",
        _preflight: async () => readyPreflight({ candidate: { status: "candidate", disposition, generationId: "generation-0" } }),
        _operationsForTesting: { resolveExpectedIdentity: undefined, performCapture: async () => { capturing = true; return captured(); } },
      });
      expect(result).toEqual({ status: "refuse", reason: "local-identity-not-persisted" });
      expect(capturing).toBe(false);
      expect(existsSync(join(home, ".lcm", "project-map.json"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});


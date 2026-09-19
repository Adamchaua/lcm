import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveMigrationPreflight } from "../../src/migration/cli-preflight.js";
import {
  prepareSqliteMigrationEnrollment,
  type SqliteMigrationEnrollmentInput,
} from "../../src/migration/maintenance.js";
import { localProjectIdentity } from "../../src/daemon/project.js";
import * as identityApi from "../../src/machine-identity.js";
import { closeLcmConnection } from "../../src/db/connection.js";
import { clearProjectMapCache } from "../../src/project-map.js";
import type { IdentityRepository } from "../../src/identity-service.js";
import { MigrationIdentityError } from "../../src/migration/generation-identity.js";
import type { ResolvedPostgreSqlConfig } from "../../src/daemon/config.js";
import type { PostgreSqlRuntime } from "../../src/storage/postgresql/runtime.js";

const roots: string[] = [];
const REGISTERED_MACHINE = "018f0b5d-1234-7abc-8def-1234567890ab";

afterEach(() => {
  closeLcmConnection();
  vi.restoreAllMocks();
  clearProjectMapCache();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function home(): string {
  const value = mkdtempSync(join(tmpdir(), "lcm-preflight-"));
  mkdirSync(join(value, ".lcm"), { mode: 0o700 });
  roots.push(value);
  return value;
}

async function enrolled() {
  const homeDir = home();
  const cwd = join(homeDir, "project");
  mkdirSync(cwd, { mode: 0o700 });
  const local = localProjectIdentity(cwd, homeDir);
  const projectDir = join(homeDir, ".lcm", "projects", local.id);
  mkdirSync(projectDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(homeDir, ".lcm", "events"), { mode: 0o700 });
  writeFileSync(join(projectDir, "meta.json"), `${JSON.stringify({ cwd })}\n`, { mode: 0o600 });
  const request: SqliteMigrationEnrollmentInput = {
    cwd,
    homeDir,
    targetConfig: {
      backend: "postgresql",
      postgresql: {
        url: "postgresql://unused.invalid/lcm",
        caFile: "/unused",
        migrationRole: "unused",
        poolMax: 1,
        connectionTimeoutMs: 100,
        idleTimeoutMs: 100,
        statementTimeoutMs: 100,
      },
    },
  };
  const registered = () => {
    const pending = identityApi.readMachineIdentity(homeDir)!;
    return { machineId: REGISTERED_MACHINE, identityKey: pending.identityKey, displayName: pending.displayName };
  };
  const repository = {
    registerMachine: vi.fn(async () => registered()),
    recoverMachine: vi.fn(async () => registered()),
  };
  const close = vi.fn(async () => undefined);
  const openIdentitySession = vi.fn(async () => ({ repository: repository as unknown as IdentityRepository, close }));
  await prepareSqliteMigrationEnrollment(request, { openIdentitySession });
  return { homeDir, cwd, local };
}

const REAL_TARGET_CONFIG: ResolvedPostgreSqlConfig = {
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
};

function succeedingTargetConfig() {
  return { status: "resolved" as const, config: REAL_TARGET_CONFIG };
}

function presentPresence() {
  return { status: "present" as const, storageBackend: "sqlite", pid: 1, daemonInstanceId: "gen-1" };
}

function verifiedReachability() {
  return { status: "verified" as const };
}

/**
 * A stub identity runtime: never a real PostgreSQL connection. This unit
 * file tests step 4's composition, not resolveMigrationTargetProjectId's
 * own real-PostgreSQL correctness -- that is target-identity.test.ts's job
 * (mocked) and the real-PostgreSQL round-trip's job (assembled, for real).
 */
function stubIdentityRuntime(): PostgreSqlRuntime {
  return { close: vi.fn(async () => undefined) } as unknown as PostgreSqlRuntime;
}

function identitySeams(projectId = "remote-project-1") {
  return {
    requireMachine: vi.fn(() => ({ machineId: "018f0b5d-1234-4abc-8def-1234567890ab" }) as never),
    createIdentityRuntime: vi.fn(stubIdentityRuntime),
    resolveTargetIdentity: vi.fn(async () => ({ status: "resolved" as const, projectId })),
  };
}

describe("resolveMigrationPreflight: composes every step for real, never collapsing a three-valued primitive", () => {
  it("succeeds end to end using real base computation and candidate resolution against a real enrolled project, with target config/presence/reachability/machine-identity/destination-identity injected to succeed (each is independently, thoroughly tested elsewhere: machine identity for real below, destination identity in target-identity.test.ts and the real-PostgreSQL round trip)", async () => {
    const fixture = await enrolled();
    const seams = identitySeams();
    const result = await resolveMigrationPreflight({
      cwd: fixture.cwd,
      homeDir: fixture.homeDir,
      _operationsForTesting: {
        resolveTargetConfig: succeedingTargetConfig,
        classifyPresence: async () => presentPresence(),
        verifyReachability: async () => verifiedReachability(),
        ...seams,
      },
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("unreachable");
    expect(result.candidate.disposition).toBe("fresh");
    expect(result.presence.status).toBe("present");
    expect(result.expectedIdentity.localProjectId).toBe(fixture.local.id);
    expect(result.expectedIdentity.remoteProjectId).toBe("remote-project-1");
    expect(result.expectedIdentity.id).toBe("remote-project-1");
    expect(result.expectedIdentity.canonical).toBe(fixture.local.canonical);
    expect(result.expectedIdentity.selectedPath).toBe(fixture.local.canonical);
    expect(result.base.length).toBeGreaterThan(0);
    // The identity runtime is always constructed and always closed, even
    // when resolveTargetIdentity itself is injected -- it is passed a real
    // repository wrapping whatever runtime this seam returns.
    expect(seams.createIdentityRuntime).toHaveBeenCalledOnce();
  });

  it("refuses at step 1 (target config) with the target resolver's own reason, never proceeding to presence or reachability", async () => {
    const fixture = await enrolled();
    const classifyPresence = vi.fn();
    const verifyReachability = vi.fn();
    const result = await resolveMigrationPreflight({
      cwd: fixture.cwd,
      homeDir: fixture.homeDir,
      _operationsForTesting: {
        resolveTargetConfig: () => ({ status: "refuse", reason: "migration-target-missing", evidence: "config-validation-error" }),
        classifyPresence,
        verifyReachability,
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "migration-target-missing", evidence: "config-validation-error" });
    expect(classifyPresence).not.toHaveBeenCalled();
    expect(verifyReachability).not.toHaveBeenCalled();
  });

  it("refuses daemon-presence-unresolvable -- the only presence outcome that refuses (both present and authoritatively-absent proceed to ready, proven by the two tests below)", async () => {
    const fixture = await enrolled();
    const result = await resolveMigrationPreflight({
      cwd: fixture.cwd,
      homeDir: fixture.homeDir,
      _operationsForTesting: {
        resolveTargetConfig: succeedingTargetConfig,
        classifyPresence: async () => ({ status: "unresolvable" as const, evidence: "pidfile-live-no-answer" }),
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "daemon-presence-unresolvable", evidence: "pidfile-live-no-answer" });
  });

  it("proceeds to ready when presence is authoritatively-absent -- a positively confirmed absence is establishing presence, not a refusal (red: refusing here would force an operator to start a daemon purely to pass this check, immediately before a hold that makes that very daemon's sweeps fail)", async () => {
    const fixture = await enrolled();
    const result = await resolveMigrationPreflight({
      cwd: fixture.cwd,
      homeDir: fixture.homeDir,
      _operationsForTesting: {
        resolveTargetConfig: succeedingTargetConfig,
        classifyPresence: async () => ({ status: "authoritatively-absent" as const }),
        verifyReachability: async () => verifiedReachability(),
        ...identitySeams(),
      },
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("unreachable");
    expect(result.presence).toEqual({ status: "authoritatively-absent" });
  });

  it("refuses with the reachability verifier's own reason and evidence when target verification fails, never proceeding to machine or destination identity resolution", async () => {
    const fixture = await enrolled();
    const seams = identitySeams();
    const result = await resolveMigrationPreflight({
      cwd: fixture.cwd,
      homeDir: fixture.homeDir,
      _operationsForTesting: {
        resolveTargetConfig: succeedingTargetConfig,
        classifyPresence: async () => presentPresence(),
        verifyReachability: async () => ({ status: "refuse", reason: "migration-target-verification-failed", evidence: "readiness-runtime-role-policy" }),
        ...seams,
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "migration-target-verification-failed", evidence: "readiness-runtime-role-policy" });
    expect(seams.requireMachine).not.toHaveBeenCalled();
    expect(seams.resolveTargetIdentity).not.toHaveBeenCalled();
  });

  it("refuses machine-identity-unregistered for real: a fresh, never-enrolled home genuinely has no registered machine identity (the real, not injected, requireMachineIdentity default)", async () => {
    const homeDir = home();
    const cwd = join(homeDir, "project");
    mkdirSync(cwd, { mode: 0o700 });
    const result = await resolveMigrationPreflight({
      cwd,
      homeDir,
      _operationsForTesting: {
        resolveTargetConfig: succeedingTargetConfig,
        classifyPresence: async () => presentPresence(),
        verifyReachability: async () => verifiedReachability(),
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "machine-identity-unregistered" });
  });

  it("resolves machine identity for real (the real, not injected, requireMachineIdentity default) against a real enrolled project, proceeding to the injected destination-identity step with the real machineId", async () => {
    const fixture = await enrolled();
    const resolveTargetIdentity = vi.fn(async () => ({ status: "resolved" as const, projectId: "remote-project-2" }));
    const result = await resolveMigrationPreflight({
      cwd: fixture.cwd,
      homeDir: fixture.homeDir,
      _operationsForTesting: {
        resolveTargetConfig: succeedingTargetConfig,
        classifyPresence: async () => presentPresence(),
        verifyReachability: async () => verifiedReachability(),
        createIdentityRuntime: stubIdentityRuntime,
        resolveTargetIdentity,
      },
    });
    expect(result.status).toBe("ready");
    expect(resolveTargetIdentity).toHaveBeenCalledWith(expect.objectContaining({ machineId: REGISTERED_MACHINE }));
  });

  it("uses the real createIdentityRuntime default (no injection): constructs a real PostgreSqlRuntime for the target settings and closes it for real, with only destination-identity resolution itself injected", async () => {
    const fixture = await enrolled();
    const resolveTargetIdentity = vi.fn(async () => ({ status: "resolved" as const, projectId: "remote-project-3" }));
    // PostgreSqlRuntime's constructor synchronously reads and validates
    // caFile (client-config.ts) before this test's injected
    // resolveTargetIdentity ever runs, so the shared REAL_TARGET_CONFIG's
    // placeholder "/unused" path is not enough here -- a real, readable
    // (if not genuinely trusted) file is required to get past
    // construction.
    const caFile = join(fixture.homeDir, "dummy-ca.pem");
    writeFileSync(caFile, "-----BEGIN CERTIFICATE-----\ndummy\n-----END CERTIFICATE-----\n", { mode: 0o600 });
    const result = await resolveMigrationPreflight({
      cwd: fixture.cwd,
      homeDir: fixture.homeDir,
      _operationsForTesting: {
        resolveTargetConfig: () => ({
          status: "resolved" as const,
          config: { backend: "postgresql" as const, postgresql: { ...REAL_TARGET_CONFIG.postgresql, caFile } },
        }),
        classifyPresence: async () => presentPresence(),
        verifyReachability: async () => verifiedReachability(),
        resolveTargetIdentity,
      },
    });
    expect(result.status).toBe("ready");
    expect(resolveTargetIdentity).toHaveBeenCalledOnce();
    // The real runtime was constructed and handed a real
    // PostgreSqlIdentityRepository wrapping it -- resolveTargetIdentity's
    // own first argument is the repository, never asserted structurally
    // here since target-identity.test.ts already covers that shape; this
    // test's job is only proving the real construct-then-close path runs
    // without needing a live connection (no query is ever issued).
  });

  it("re-throws a non-MachineIdentityFileError from requireMachine rather than misclassifying it", async () => {
    const fixture = await enrolled();
    const outcome = resolveMigrationPreflight({
      cwd: fixture.cwd,
      homeDir: fixture.homeDir,
      _operationsForTesting: {
        resolveTargetConfig: succeedingTargetConfig,
        classifyPresence: async () => presentPresence(),
        verifyReachability: async () => verifiedReachability(),
        requireMachine: () => { throw new Error("an unrelated failure"); },
      },
    });
    await expect(outcome).rejects.toThrow("an unrelated failure");
  });

  it("propagates the destination-identity resolver's own refusal unchanged", async () => {
    const fixture = await enrolled();
    const result = await resolveMigrationPreflight({
      cwd: fixture.cwd,
      homeDir: fixture.homeDir,
      _operationsForTesting: {
        resolveTargetConfig: succeedingTargetConfig,
        classifyPresence: async () => presentPresence(),
        verifyReachability: async () => verifiedReachability(),
        requireMachine: identitySeams().requireMachine,
        createIdentityRuntime: stubIdentityRuntime,
        resolveTargetIdentity: async () => ({ status: "refuse", reason: "migration-target-identity-unresolvable", evidence: "post-conflict-reread-absent" }),
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "migration-target-identity-unresolvable", evidence: "post-conflict-reread-absent" });
  });

  it("closes the identity runtime even when resolveTargetIdentity itself throws, and still propagates the throw", async () => {
    const fixture = await enrolled();
    const close = vi.fn(async () => undefined);
    const outcome = resolveMigrationPreflight({
      cwd: fixture.cwd,
      homeDir: fixture.homeDir,
      _operationsForTesting: {
        resolveTargetConfig: succeedingTargetConfig,
        classifyPresence: async () => presentPresence(),
        verifyReachability: async () => verifiedReachability(),
        requireMachine: identitySeams().requireMachine,
        createIdentityRuntime: () => ({ close }) as unknown as PostgreSqlRuntime,
        resolveTargetIdentity: async () => { throw new Error("connection reset"); },
      },
    });
    await expect(outcome).rejects.toThrow("connection reset");
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes the identity runtime even when the runtime's own close() itself throws, without masking the real outcome (red: an unguarded close() rejection here would replace a clean ready result with an unrelated throw)", async () => {
    const fixture = await enrolled();
    const close = vi.fn(async () => { throw new Error("close failed"); });
    const result = await resolveMigrationPreflight({
      cwd: fixture.cwd,
      homeDir: fixture.homeDir,
      _operationsForTesting: {
        resolveTargetConfig: succeedingTargetConfig,
        classifyPresence: async () => presentPresence(),
        verifyReachability: async () => verifiedReachability(),
        requireMachine: identitySeams().requireMachine,
        createIdentityRuntime: () => ({ close }) as unknown as PostgreSqlRuntime,
        resolveTargetIdentity: async () => ({ status: "resolved" as const, projectId: "remote-project-1" }),
      },
    });
    expect(result.status).toBe("ready");
    expect(close).toHaveBeenCalledOnce();
  });

  it("converts a MigrationIdentityError from base computation into a generation-<reason> refusal", async () => {
    const fixture = await enrolled();
    const result = await resolveMigrationPreflight({
      cwd: fixture.cwd,
      homeDir: fixture.homeDir,
      _operationsForTesting: {
        resolveTargetConfig: succeedingTargetConfig,
        classifyPresence: async () => presentPresence(),
        verifyReachability: async () => verifiedReachability(),
        ...identitySeams(),
        computeBase: () => {
          throw new MigrationIdentityError("invalid-input", "test", null);
        },
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "generation-invalid-input", evidence: undefined });
  });

  it("re-throws a non-MigrationIdentityError from base computation rather than misclassifying it", async () => {
    const fixture = await enrolled();
    const outcome = resolveMigrationPreflight({
      cwd: fixture.cwd,
      homeDir: fixture.homeDir,
      _operationsForTesting: {
        resolveTargetConfig: succeedingTargetConfig,
        classifyPresence: async () => presentPresence(),
        verifyReachability: async () => verifiedReachability(),
        ...identitySeams(),
        computeBase: () => { throw new Error("an unrelated base computation failure"); },
      },
    });
    await expect(outcome).rejects.toThrow("an unrelated base computation failure");
  });

  it("propagates the candidate resolver's own refusal unchanged when candidate resolution refuses", async () => {
    const fixture = await enrolled();
    const result = await resolveMigrationPreflight({
      cwd: fixture.cwd,
      homeDir: fixture.homeDir,
      _operationsForTesting: {
        resolveTargetConfig: succeedingTargetConfig,
        classifyPresence: async () => presentPresence(),
        verifyReachability: async () => verifiedReachability(),
        ...identitySeams(),
        resolveCandidate: async () => ({ status: "refuse", reason: "continuation-mismatched-hold" }),
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "continuation-mismatched-hold" });
  });

  it("uses the real classifyMigrationDaemonPresence default (no injection): a fresh home with no daemon really is authoritatively-absent, and preflight proceeds past it rather than refusing -- landing on the next real step's own refusal (target reachability against an unreachable host) instead", async () => {
    const fixture = await enrolled();
    const result = await resolveMigrationPreflight({
      cwd: fixture.cwd,
      homeDir: fixture.homeDir,
      _operationsForTesting: {
        resolveTargetConfig: succeedingTargetConfig,
      },
    });
    expect(result.status).toBe("refuse");
    expect((result as { reason: string }).reason).toMatch(/^migration-target-verification-/);
  });

  it("uses the real verifyMigrationTargetReachability default (no injection): a genuinely unreachable target really fails verification, landing on a verification refusal", async () => {
    const fixture = await enrolled();
    const result = await resolveMigrationPreflight({
      cwd: fixture.cwd,
      homeDir: fixture.homeDir,
      _operationsForTesting: {
        resolveTargetConfig: succeedingTargetConfig,
        classifyPresence: async () => presentPresence(),
      },
    });
    expect(result.status).toBe("refuse");
    expect((result as { reason: string }).reason).toMatch(/^migration-target-verification-/);
  });

  it("uses the real resolveMigrationTargetConfig default (no injection): a fresh home with no config and no LCM_POSTGRES_* env vars really has no usable target, landing on migration-target-missing", async () => {
    const fixture = await enrolled();
    const result = await resolveMigrationPreflight({ cwd: fixture.cwd, homeDir: fixture.homeDir });
    expect(result.status).toBe("refuse");
    expect((result as { reason: string }).reason).toMatch(/^migration-target-/);
  });
});

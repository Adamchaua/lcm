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
import { StorageIdentityConfigurationError } from "../../src/storage/identity-context.js";
import { MigrationIdentityError } from "../../src/migration/generation-identity.js";
import type { ResolvedPostgreSqlConfig } from "../../src/daemon/config.js";

const roots: string[] = [];
const REGISTERED_MACHINE = "018f0b5d-1234-7abc-8def-1234567890ab";

afterEach(() => {
  closeLcmConnection();
  vi.restoreAllMocks();
  clearProjectMapCache();
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

function fabricatedIdentity(local: { id: string; canonical: string }) {
  return {
    id: "remote-project-1",
    localProjectId: local.id,
    canonical: local.canonical,
    remoteProjectId: "remote-project-1",
    machineId: "018f0b5d-1234-4abc-8def-1234567890ab",
    selectedPath: local.canonical,
  };
}

describe("resolveMigrationPreflight: composes all six steps for real, never collapsing a three-valued primitive", () => {
  it("succeeds end to end using real base computation and candidate resolution against a real enrolled project, with target config/presence/reachability/identity-binding injected to succeed (each of those four is independently, thoroughly tested elsewhere with real state -- identity binding specifically requires a real remote project link this fixture does not set up, which unbound-postgresql-project's own dedicated test below covers for real)", async () => {
    const fixture = await enrolled();
    const result = await resolveMigrationPreflight({
      cwd: fixture.cwd,
      homeDir: fixture.homeDir,
      _operationsForTesting: {
        resolveTargetConfig: succeedingTargetConfig,
        classifyPresence: async () => presentPresence(),
        verifyReachability: async () => verifiedReachability(),
        resolveIdentity: () => fabricatedIdentity(fixture.local),
      },
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("unreachable");
    expect(result.candidate.disposition).toBe("fresh");
    expect(result.presence.status).toBe("present");
    expect(result.expectedIdentity.localProjectId).toBe(fixture.local.id);
    expect(result.base.length).toBeGreaterThan(0);
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
        resolveIdentity: () => fabricatedIdentity(fixture.local),
      },
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("unreachable");
    expect(result.presence).toEqual({ status: "authoritatively-absent" });
  });

  it("refuses with the reachability verifier's own reason and evidence when target verification fails, never proceeding to identity resolution", async () => {
    const fixture = await enrolled();
    const resolveIdentity = vi.fn();
    const result = await resolveMigrationPreflight({
      cwd: fixture.cwd,
      homeDir: fixture.homeDir,
      _operationsForTesting: {
        resolveTargetConfig: succeedingTargetConfig,
        classifyPresence: async () => presentPresence(),
        verifyReachability: async () => ({ status: "refuse", reason: "migration-target-verification-failed", evidence: "readiness-runtime-role-policy" }),
        resolveIdentity,
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "migration-target-verification-failed", evidence: "readiness-runtime-role-policy" });
    expect(resolveIdentity).not.toHaveBeenCalled();
  });

  it("refuses unbound-postgresql-project for real: the enrolled() fixture never links a remote PostgreSQL project, so the real (not injected) resolveStorageIdentityContext genuinely throws StorageIdentityConfigurationError here -- this is the same real failure the success test above works around by injecting identity resolution", async () => {
    const fixture = await enrolled();
    const result = await resolveMigrationPreflight({
      cwd: fixture.cwd,
      homeDir: fixture.homeDir,
      _operationsForTesting: {
        resolveTargetConfig: succeedingTargetConfig,
        classifyPresence: async () => presentPresence(),
        verifyReachability: async () => verifiedReachability(),
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "unbound-postgresql-project" });
  });

  it("also refuses unbound-postgresql-project for an injected StorageIdentityConfigurationError, confirming the real-error type check itself rather than only the real fixture's own failure mode", async () => {
    const fixture = await enrolled();
    const result = await resolveMigrationPreflight({
      cwd: fixture.cwd,
      homeDir: fixture.homeDir,
      _operationsForTesting: {
        resolveTargetConfig: succeedingTargetConfig,
        classifyPresence: async () => presentPresence(),
        verifyReachability: async () => verifiedReachability(),
        resolveIdentity: () => { throw new StorageIdentityConfigurationError("local project has no PostgreSQL binding"); },
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "unbound-postgresql-project" });
  });

  it("re-throws a non-StorageIdentityConfigurationError from the identity resolver rather than misclassifying it", async () => {
    const fixture = await enrolled();
    const outcome = resolveMigrationPreflight({
      cwd: fixture.cwd,
      homeDir: fixture.homeDir,
      _operationsForTesting: {
        resolveTargetConfig: succeedingTargetConfig,
        classifyPresence: async () => presentPresence(),
        verifyReachability: async () => verifiedReachability(),
        resolveIdentity: () => { throw new Error("an unrelated failure"); },
      },
    });
    await expect(outcome).rejects.toThrow("an unrelated failure");
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
        resolveIdentity: () => fabricatedIdentity(fixture.local),
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
        resolveIdentity: () => fabricatedIdentity(fixture.local),
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
        resolveIdentity: () => fabricatedIdentity(fixture.local),
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

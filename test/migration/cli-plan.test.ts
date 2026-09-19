import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { performMigrationPlan } from "../../src/migration/cli-plan.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function home(): string {
  const value = mkdtempSync(join(tmpdir(), "lcm-cli-plan-"));
  mkdirSync(join(value, ".lcm"), { mode: 0o700 });
  roots.push(value);
  return value;
}

describe("performMigrationPlan: entirely non-mutating, reports the shared preflight's result", () => {
  it("maps a ready preflight into an ok outcome with the candidate id, disposition and daemon storage backend", async () => {
    const homeDir = home();
    const result = await performMigrationPlan({
      cwd: join(homeDir, "project"),
      homeDir,
      _preflight: async () => ({
        status: "ready",
        targetConfig: {} as never,
        presence: { status: "present", storageBackend: "postgresql", pid: 1, daemonInstanceId: "gen-1" },
        candidate: { status: "candidate", disposition: "fresh", generationId: "generation-0" },
        expectedIdentity: {} as never,
        base: "base-identity",
      }),
    });
    expect(result).toEqual({
      status: "ok",
      generationId: "generation-0",
      disposition: "fresh",
      daemonStorageBackend: "postgresql",
    });
  });

  it("propagates a preflight refusal unchanged, including its evidence", async () => {
    const homeDir = home();
    const result = await performMigrationPlan({
      cwd: join(homeDir, "project"),
      homeDir,
      _preflight: async () => ({ status: "refuse", reason: "migration-target-missing", evidence: "config-validation-error" }),
    });
    expect(result).toEqual({ status: "refuse", reason: "migration-target-missing", evidence: "config-validation-error" });
  });

  it("uses the real resolveMigrationPreflight default (no injection) end to end: a fresh home with no target configured really refuses migration-target-missing", async () => {
    const homeDir = home();
    const cwd = join(homeDir, "project");
    mkdirSync(cwd, { mode: 0o700 });
    const result = await performMigrationPlan({ cwd, homeDir });
    expect(result.status).toBe("refuse");
    expect((result as { reason: string }).reason).toMatch(/^migration-target-/);
  });
});

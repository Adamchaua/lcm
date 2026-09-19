import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveMigrationTargetProjectId } from "../../src/migration/target-identity.js";
import { PostgreSqlIdentityConflictError } from "../../src/storage/postgresql/identity-repository.js";
import { normalizeProjectPath, normalizeProjectIdentityPath } from "../../src/project-map.js";
import { localProjectIdentity } from "../../src/daemon/project.js";

const MACHINE_ID = "018f0b5d-1234-7abc-8def-1234567890ab";

function repositoryStub(overrides: { resolveProject?: unknown; createProject?: unknown } = {}) {
  return {
    resolveProject: overrides.resolveProject ?? vi.fn(),
    createProject: overrides.createProject ?? vi.fn(),
  } as never;
}

describe("resolveMigrationTargetProjectId", () => {
  it("resolves via the fast path when the (machineId, normalizedPath) key already has a bound project -- never calling createProject", async () => {
    const createProject = vi.fn();
    const resolveProject = vi.fn(async () => ({ projectId: "project-1", alias: {} as never }));
    const result = await resolveMigrationTargetProjectId({
      repository: repositoryStub({ resolveProject, createProject }),
      machineId: MACHINE_ID, displayName: "d", authorityCanonicalPath: "/tmp/project",
    });
    expect(result).toEqual({ status: "resolved", projectId: "project-1" });
    expect(createProject).not.toHaveBeenCalled();
  });

  it("mints a project when the key is genuinely absent", async () => {
    const resolveProject = vi.fn(async () => null);
    const createProject = vi.fn(async () => ({ projectId: "project-2", displayName: "d", createdAt: "x", updatedAt: "x", aliases: [] }));
    const result = await resolveMigrationTargetProjectId({
      repository: repositoryStub({ resolveProject, createProject }),
      machineId: MACHINE_ID, displayName: "d", authorityCanonicalPath: "/tmp/project",
    });
    expect(result).toEqual({ status: "resolved", projectId: "project-2" });
    expect(createProject).toHaveBeenCalledWith(expect.objectContaining({
      machineId: MACHINE_ID, path: "/tmp/project",
    }));
  });

  it("re-reads and resolves to the winner's id on a real PostgreSqlIdentityConflictError -- never refuses on a concurrent create (red: propagating this error as a refusal instead of re-reading would fail this test)", async () => {
    const resolveProject = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ projectId: "winner-project", alias: {} as never });
    const createProject = vi.fn(async () => {
      throw new PostgreSqlIdentityConflictError(MACHINE_ID, "/tmp/project", "winner-project", "loser-project");
    });
    const result = await resolveMigrationTargetProjectId({
      repository: repositoryStub({ resolveProject, createProject }),
      machineId: MACHINE_ID, displayName: "d", authorityCanonicalPath: "/tmp/project",
    });
    expect(result).toEqual({ status: "resolved", projectId: "winner-project" });
    expect(resolveProject).toHaveBeenCalledTimes(2);
  });

  it("refuses migration-target-identity-unresolvable when a conflict error's own re-read still finds nothing (should be unreachable in practice, but must not be guessed as a fresh retry)", async () => {
    const resolveProject = vi.fn(async () => null);
    const createProject = vi.fn(async () => {
      throw new PostgreSqlIdentityConflictError(MACHINE_ID, "/tmp/project", "winner-project", "loser-project");
    });
    const result = await resolveMigrationTargetProjectId({
      repository: repositoryStub({ resolveProject, createProject }),
      machineId: MACHINE_ID, displayName: "d", authorityCanonicalPath: "/tmp/project",
    });
    expect(result).toEqual({
      status: "refuse", reason: "migration-target-identity-unresolvable", evidence: "post-conflict-reread-absent",
    });
  });

  it("re-throws a non-conflict error from createProject rather than misclassifying it as a race", async () => {
    const resolveProject = vi.fn(async () => null);
    const createProject = vi.fn(async () => { throw new Error("connection reset"); });
    await expect(resolveMigrationTargetProjectId({
      repository: repositoryStub({ resolveProject, createProject }),
      machineId: MACHINE_ID, displayName: "d", authorityCanonicalPath: "/tmp/project",
    })).rejects.toThrow("connection reset");
  });
});

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

describe("the normalization hazard: authorityCanonicalPath converges with daemon/project.ts's own canonical for a real linked Git worktree", () => {
  it("normalizeProjectPath(authority.canonicalPath) equals normalizeProjectIdentityPath(worktreeCwd) for a real git worktree add fixture -- not a mocked path string, because the whole point is that the two normalizations genuinely differ for an unanchored input and only converge for an already-anchored one", () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-target-identity-worktree-"));
    try {
      const main = join(root, "main");
      const linked = join(root, "linked");
      mkdirSync(main, { recursive: true, mode: 0o700 });
      git(main, "init", "-q");
      git(main, "config", "user.email", "test@example.invalid");
      git(main, "config", "user.name", "LCM Test");
      writeFileSync(join(main, "README.md"), "test\n", { mode: 0o600 });
      git(main, "add", "README.md");
      git(main, "commit", "-qm", "initial");
      git(main, "worktree", "add", "-qb", "linked", linked);

      // What authenticateSqliteMigrationSource's canonicalPath actually is
      // for a fresh (not yet project-map-registered) linked worktree: the
      // real code path (localProjectIdentity's fallback) that computes it
      // via normalizeProjectIdentityPath -- anchoring to the repository,
      // not the worktree.
      const homeDir = mkdtempSync(join(tmpdir(), "lcm-target-identity-home-"));
      const local = localProjectIdentity(linked, homeDir);
      const authorityCanonicalPath = local.canonical;

      // This module's own internal computation.
      const thisModuleKey = normalizeProjectPath(authorityCanonicalPath);

      // What #625's own map-entry canonical would independently compute
      // for the *same worktree cwd*, via daemon/project.ts's real
      // production path (normalizeProjectIdentityPath, not
      // normalizeProjectPath).
      const mapEntryCanonical = normalizeProjectIdentityPath(linked);

      expect(thisModuleKey).toBe(mapEntryCanonical);
      // Positive control: the worktree and the repository really are
      // different real paths on disk, so this is not trivially true.
      expect(normalizeProjectPath(linked)).not.toBe(mapEntryCanonical);

      // Red-first: if this module's input were the raw worktree cwd
      // instead of the capture authority's already-anchored
      // canonicalPath, the two normalizations would disagree.
      const wrongInputKey = normalizeProjectPath(linked);
      expect(wrongInputKey).not.toBe(mapEntryCanonical);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});


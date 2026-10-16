import { describe, expect, it } from "vitest";
import { afterEach, beforeEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonClient } from "../src/daemon/client.js";
import { cwdToProjectHash, importSessions } from "../src/import.js";
import {
  addProjectAlias,
  clearProjectMapCache,
  hashProjectPath,
  normalizeProjectPath,
  projectMapPath,
  resolveProjectIdentity,
} from "../src/project-map.js";
import {
  STORAGE_IDENTITY_REQUIRED_ERROR_CODE,
  STORAGE_IDENTITY_REQUIRED_UNBOUND_REASON,
  UNBOUND_POSTGRESQL_PROJECT_MESSAGE,
} from "../src/storage/identity-context.js";
import * as configModule from "../src/daemon/config.js";
import * as publicationModule from "../src/storage/backend-publication.js";
import { clearGitProjectAnchorCache } from "../src/git-project.js";
import { clearWorktreeReconciliationCache } from "../src/worktree-reconciliation.js";
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function cloneRepository(root: string, name: string, remote: string): string {
  const path = join(root, name);
  mkdirSync(path);
  git(path, "init", "-q");
  git(path, "config", "user.email", "test@example.invalid");
  git(path, "config", "user.name", "LCM Test");
  git(path, "remote", "add", "origin", remote);
  writeFileSync(join(path, "README.md"), name + "\n");
  git(path, "add", "README.md");
  git(path, "commit", "-qm", "initial");
  return path;
}

describe("import names the unbound-project remedy", () => {
  let home: string;
  let claudeProjectsDir: string;
  let server: Server | undefined;
  const dirs: string[] = [];

  function makeTmpDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "lcm-import-remedy-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    mkdirSync(join(home, ".lcm"), { mode: PRIVATE_DIRECTORY_MODE });
    chmodSync(join(home, ".lcm"), PRIVATE_DIRECTORY_MODE);
    writeFileSync(join(home, ".lcm", "machine.json"), JSON.stringify({
      version: 1,
      identityKey: "machine:" + "a".repeat(64),
      machineId: "01940000-0000-7000-8000-0000000000aa",
      displayName: "test",
    }), { mode: PRIVATE_FILE_MODE });
    clearProjectMapCache();
    clearGitProjectAnchorCache();
    clearWorktreeReconciliationCache();
    claudeProjectsDir = makeTmpDir("lcm-import-remedy-claude-");
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server?.close(() => resolve()) ?? resolve());
    server = undefined;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    clearProjectMapCache();
    clearGitProjectAnchorCache();
    clearWorktreeReconciliationCache();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
    rmSync(home, { recursive: true, force: true });
  });

  function selectPostgresqlBackend(): void {
    const config = configModule.loadDaemonConfig(join(home, ".lcm", "config.json"));
    vi.spyOn(configModule, "loadDaemonConfig").mockReturnValue({
      ...config,
      storage: { ...config.storage, backend: "postgresql" },
    });
    vi.spyOn(publicationModule, "assertBackendPublicationConsumerAccess").mockReturnValue(undefined);
  }

  function plantUnboundProjectWithSessions(name: string, sessionCount: number): string {
    const cwd = join(home, name);
    mkdirSync(cwd, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    chmodSync(cwd, PRIVATE_DIRECTORY_MODE);
    const canonical = normalizeProjectPath(cwd);
    writeFileSync(
      projectMapPath(),
      JSON.stringify({ [hashProjectPath(canonical)]: { canonical, aliases: [] } }) + "\n",
      { mode: PRIVATE_FILE_MODE },
    );
    clearProjectMapCache();
    const projectDir = join(claudeProjectsDir, cwdToProjectHash(canonical));
    mkdirSync(projectDir, { recursive: true });
    for (let index = 0; index < sessionCount; index += 1) {
      writeFileSync(join(projectDir, "session-" + index + ".jsonl"), "");
    }
    return canonical;
  }

  async function startUnboundDaemon(): Promise<{ client: DaemonClient; posts: string[]; cwds: string[] }> {
    const posts: string[] = [];
    const cwds: string[] = [];
    const daemon = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        posts.push("ingest");
        cwds.push((JSON.parse(Buffer.concat(chunks).toString("utf8")) as { cwd: string }).cwd);
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          code: STORAGE_IDENTITY_REQUIRED_ERROR_CODE,
          reason: STORAGE_IDENTITY_REQUIRED_UNBOUND_REASON,
          error: UNBOUND_POSTGRESQL_PROJECT_MESSAGE,
          storageBackend: "postgresql",
        }));
      });
    });
    server = daemon;
    await new Promise<void>(resolve => daemon.listen(0, "127.0.0.1", resolve));
    const address = daemon.address();
    if (address === null || typeof address === "string") throw new Error("daemon server did not bind");
    return { client: new DaemonClient("http://127.0.0.1:" + address.port), posts, cwds };
  }

  function plantAliasCloneProject(): { main: string; aliasClone: string; codexDir: string } {
    const remote = "https://example.invalid/import-remedy-alias.git";
    const main = cloneRepository(home, "alias-main", remote);
    const aliasClone = cloneRepository(home, "alias-clone", remote);
    resolveProjectIdentity(main);
    addProjectAlias(aliasClone, { canonical: main });
    clearProjectMapCache();
    const projectDir = join(claudeProjectsDir, cwdToProjectHash(main));
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "claude-0.jsonl"), "");
    const codexDir = makeTmpDir("lcm-import-remedy-codex-");
    const archived = join(codexDir, "archived_sessions");
    mkdirSync(archived, { recursive: true });
    writeFileSync(join(archived, "codex-alias.jsonl"), JSON.stringify({
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "codex-alias",
        cwd: aliasClone,
        cli_version: "0.100.0",
        model_provider: "openai",
        git: { repository_url: remote, commit_hash: "abc123", branch: "feature" },
      },
    }));
    return { main, aliasClone, codexDir };
  }

  it("prints one remedy line naming the unbound PostgreSQL project on a real run", async () => {
    const unbound = plantUnboundProjectWithSessions("unbound", 2);
    selectPostgresqlBackend();
    const daemon = await startUnboundDaemon();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await importSessions(daemon.client, {
      all: true,
      provider: "claude",
      dryRun: false,
      verbose: true,
      _claudeProjectsDir: claudeProjectsDir,
    });

    expect(daemon.posts).toHaveLength(2);
    expect(result).toMatchObject({ imported: 0, failed: 2 });
    const lines = error.mock.calls.map(call => String(call[0]));
    expect(lines.filter(line => line === ("  " + unbound + ": " + UNBOUND_POSTGRESQL_PROJECT_MESSAGE))).toHaveLength(1);
    expect(lines.filter(line => line === ("  \u274c session-0: " + UNBOUND_POSTGRESQL_PROJECT_MESSAGE))).toHaveLength(1);
    expect(lines.filter(line => line === ("  \u274c session-1: " + UNBOUND_POSTGRESQL_PROJECT_MESSAGE))).toHaveLength(1);
  });

  it("prints the project remedy without per-session detail when not verbose", async () => {
    const unbound = plantUnboundProjectWithSessions("quiet-unbound", 2);
    selectPostgresqlBackend();
    const daemon = await startUnboundDaemon();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await importSessions(daemon.client, {
      all: true,
      provider: "claude",
      _claudeProjectsDir: claudeProjectsDir,
    });

    expect(result).toMatchObject({ imported: 0, failed: 2 });
    expect(error).toHaveBeenCalledExactlyOnceWith("  " + unbound + ": " + UNBOUND_POSTGRESQL_PROJECT_MESSAGE);
  });

  it("contacts no project storage on a dry run", async () => {
    plantUnboundProjectWithSessions("unbound-dry", 2);
    selectPostgresqlBackend();
    const daemon = await startUnboundDaemon();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await importSessions(daemon.client, {
      all: true,
      provider: "claude",
      dryRun: true,
      _claudeProjectsDir: claudeProjectsDir,
    });

    expect(daemon.posts).toEqual([]);
    expect(result).toMatchObject({ imported: 2, failed: 0 });
    expect(error).not.toHaveBeenCalled();
  });

  it("keeps the generic diagnostic for other real-run ingest failures", async () => {
    const cwd = "/failing/project";
    const projectDir = join(claudeProjectsDir, cwdToProjectHash(cwd));
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "session.jsonl"), "");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const client = { post: vi.fn(async () => { throw new Error("ingest boom"); }) };
    const result = await importSessions(client as unknown as DaemonClient, {
      cwd,
      verbose: true,
      _claudeProjectsDir: claudeProjectsDir,
    });
    expect(result).toMatchObject({ imported: 0, failed: 1 });
    const lines = error.mock.calls.map(call => String(call[0]));
    expect(lines).toContain("  \u274c session: ingest failed");
    expect(lines.some(line => line.includes(cwd))).toBe(false);
    expect(lines.join("\n")).not.toContain("ingest boom");
  });

  it("prints one remedy line per project across Claude and Codex batches", async () => {
    const unbound = plantUnboundProjectWithSessions("unbound-all", 2);
    const codexDir = makeTmpDir("lcm-import-remedy-codex-");
    const archived = join(codexDir, "archived_sessions");
    mkdirSync(archived, { recursive: true });
    writeFileSync(join(archived, "codex-0.jsonl"), JSON.stringify({
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "session_meta",
      payload: { id: "codex-0", cwd: unbound, cli_version: "0.100.0", model_provider: "openai" },
    }));
    selectPostgresqlBackend();
    const daemon = await startUnboundDaemon();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await importSessions(daemon.client, {
      all: true,
      provider: "all",
      cwd: unbound,
      _claudeProjectsDir: claudeProjectsDir,
      _codexDir: codexDir,
    });

    expect(daemon.posts).toHaveLength(3);
    expect(result).toMatchObject({ imported: 0, failed: 3 });
    expect(error).toHaveBeenCalledExactlyOnceWith("  " + unbound + ": " + UNBOUND_POSTGRESQL_PROJECT_MESSAGE);
  });

  it("prints one remedy for a project whose Claude and Codex sessions use a canonical and a cloned alias", async () => {
    const { main, aliasClone, codexDir } = plantAliasCloneProject();
    const other = join(home, "other-unbound");
    mkdirSync(other, { mode: PRIVATE_DIRECTORY_MODE });
    const otherCanonical = normalizeProjectPath(other);
    resolveProjectIdentity(otherCanonical);
    clearProjectMapCache();
    const otherDir = join(claudeProjectsDir, cwdToProjectHash(otherCanonical));
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(join(otherDir, "other-0.jsonl"), "");
    selectPostgresqlBackend();
    const daemon = await startUnboundDaemon();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await importSessions(daemon.client, {
      all: true,
      provider: "all",
      cwd: main,
      _claudeProjectsDir: claudeProjectsDir,
      _codexDir: codexDir,
    });

    expect(result).toMatchObject({ imported: 0, failed: 3 });
    expect(new Set(daemon.cwds)).toEqual(new Set([normalizeProjectPath(main), normalizeProjectPath(aliasClone), otherCanonical]));
    const lines = error.mock.calls.map(call => String(call[0]));
    const remedyLines = lines.filter(line => line.endsWith(": " + UNBOUND_POSTGRESQL_PROJECT_MESSAGE));
    expect(remedyLines).toHaveLength(2);
    expect(remedyLines.filter(line => line.includes(otherCanonical))).toHaveLength(1);
  });

  it("prints one remedy for the current project when its Claude and Codex sessions use different cwds", async () => {
    const { main, aliasClone, codexDir } = plantAliasCloneProject();
    selectPostgresqlBackend();
    const daemon = await startUnboundDaemon();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await importSessions(daemon.client, {
      provider: "all",
      cwd: main,
      _claudeProjectsDir: claudeProjectsDir,
      _codexDir: codexDir,
    });

    expect(result).toMatchObject({ imported: 0, failed: 2 });
    expect(new Set(daemon.cwds)).toEqual(new Set([main, normalizeProjectPath(aliasClone)]));
    const lines = error.mock.calls.map(call => String(call[0]));
    expect(lines.filter(line => line.endsWith(": " + UNBOUND_POSTGRESQL_PROJECT_MESSAGE))).toHaveLength(1);
  });
});

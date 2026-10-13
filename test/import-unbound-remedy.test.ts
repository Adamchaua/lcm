import { describe, expect, it } from "vitest";
import { afterEach, beforeEach, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonClient } from "../src/daemon/client.js";
import { cwdToProjectHash, importSessions } from "../src/import.js";
import { clearProjectMapCache, hashProjectPath, normalizeProjectPath, projectMapPath } from "../src/project-map.js";
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

  async function startUnboundDaemon(): Promise<{ client: DaemonClient; posts: string[] }> {
    const posts: string[] = [];
    const daemon = createServer((_req, res) => {
      posts.push("ingest");
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        code: STORAGE_IDENTITY_REQUIRED_ERROR_CODE,
        reason: STORAGE_IDENTITY_REQUIRED_UNBOUND_REASON,
        error: UNBOUND_POSTGRESQL_PROJECT_MESSAGE,
        storageBackend: "postgresql",
      }));
    });
    server = daemon;
    await new Promise<void>(resolve => daemon.listen(0, "127.0.0.1", resolve));
    const address = daemon.address();
    if (address === null || typeof address === "string") throw new Error("daemon server did not bind");
    return { client: new DaemonClient("http://127.0.0.1:" + address.port), posts };
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
});

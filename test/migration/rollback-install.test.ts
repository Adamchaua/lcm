/**
 * Tests for src/migration/rollback-install.ts.
 *
 * Per the epic's standing rule (plan-v2 section 0): every check names the
 * two independent observations it compares, and is proven breakable. The
 * order-matters checks here (pool release before rename, checkpoint
 * before move, witness before AND after the move) are each proven with a
 * real live connection, a real WAL database with real -wal/-shm siblings,
 * and a real content comparison -- not fixtures that assume the property
 * they are meant to prove.
 */

import {
  chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  renameSync as realRenameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import * as fsModule from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runLcmMigrations } from "../../src/db/migration.js";
import {
  getExistingLcmConnection,
  getLcmConnection,
  isLcmConnectionOpen,
  closeLcmConnection,
} from "../../src/db/connection.js";
import {
  installRollbackGeneration,
  RollbackInstallError,
  checkCanonicalLiveExists,
  streamSha256,
  checkpointAndConvertToDelete,
} from "../../src/migration/rollback-install.js";
import { rollbackGenerationPath, rollbackGenerationsRoot } from "../../src/migration/rollback-generation.js";

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
}));
const renameSpy = vi.spyOn(fsModule, "renameSync");

const dirs: string[] = [];
afterEach(() => {
  closeLcmConnection();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "lcm-rollback-install-home-"));
  dirs.push(dir);
  return dir;
}

function makeGenerationDir(homeDir: string, generationId: string): string {
  mkdirSync(rollbackGenerationsRoot(homeDir), { recursive: true, mode: 0o700 });
  const dir = rollbackGenerationPath(homeDir, generationId);
  mkdirSync(dir, { mode: 0o700 });
  return dir;
}

/** A canonical-shaped live LCM database, real WAL mode, real content. */
function liveCanonicalDatabase(homeDir: string, content: string): string {
  const dir = join(homeDir, ".lcm", "projects", "proj-1");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "db.sqlite");
  const db = new DatabaseSync(path);
  try {
    runLcmMigrations(db, { fts5Available: false });
    db.exec(`INSERT INTO conversations(conversation_id,session_id,title,created_at,updated_at)
      VALUES (1,'rollback-install-test','${content}','2026-09-06 00:00:00','2026-09-06 00:00:00')`);
  } finally { db.close(); }
  chmodSync(path, 0o600);
  return path;
}

/** A minimal "verified generation" db.sqlite standing in for buildRollbackGeneration's output. */
function verifiedGenerationDatabase(dir: string, marker: string): string {
  const path = join(dir, "db.sqlite");
  const db = new DatabaseSync(path);
  try {
    runLcmMigrations(db, { fts5Available: false });
    db.exec(`INSERT INTO conversations(conversation_id,session_id,title,created_at,updated_at)
      VALUES (1,'verified-generation','${marker}','2026-09-06 00:00:00','2026-09-06 00:00:00')`);
  } finally { db.close(); }
  chmodSync(path, 0o600);
  return path;
}

function conversationTitles(path: string): readonly string[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (db.prepare("SELECT title FROM conversations ORDER BY conversation_id").all() as { title: string }[])
      .map((row) => row.title);
  } finally { db.close(); }
}

describe("installRollbackGeneration", () => {
  it("releases the pool, checkpoints WAL away, witnesses, moves the live database aside, and installs the verified one", async () => {
    const homeDir = tempHome();
    const canonicalPath = liveCanonicalDatabase(homeDir, "pre-rollback-live-data");
    // Prove there really is WAL state to convert: open via the pool (as
    // the runtime does), write through it so a real -wal file exists,
    // and leave the pooled connection open -- exactly the state this
    // function must release before touching the file.
    const pooled = getLcmConnection(canonicalPath);
    pooled.exec("PRAGMA journal_mode=WAL");
    pooled.exec(`INSERT INTO conversations(conversation_id,session_id,title,created_at,updated_at)
      VALUES (2,'wal-write','through-pool','2026-09-06 00:00:00','2026-09-06 00:00:00')`);
    expect(isLcmConnectionOpen(canonicalPath)).toBe(true);
    expect(existsSync(`${canonicalPath}-wal`) || existsSync(`${canonicalPath}-shm`)).toBe(true);

    const generationDir = makeGenerationDir(homeDir, "gen-install-happy");
    const verifiedPath = verifiedGenerationDatabase(generationDir, "post-rollback-verified-data");

    const outcome = installRollbackGeneration({
      homeDir, generationId: "gen-install-happy", canonicalPath, verifiedDatabasePath: verifiedPath,
    });

    // Breakable independently: pool released (not merely "connection
    // still works because SQLite tolerates a stale handle").
    expect(isLcmConnectionOpen(canonicalPath)).toBe(false);
    // The canonical path now serves the VERIFIED generation's content,
    // not the pre-rollback live content.
    expect(conversationTitles(canonicalPath)).toEqual(["post-rollback-verified-data"]);
    // No stray WAL siblings at the canonical name.
    expect(existsSync(`${canonicalPath}-wal`)).toBe(false);
    expect(existsSync(`${canonicalPath}-shm`)).toBe(false);
    // The preempted (pre-rollback) content is preserved, not discarded,
    // and is immutable evidence (0400) at a path beside the generation.
    expect(outcome.preempted).not.toBeNull();
    const preempted = outcome.preempted!;
    expect(preempted.path).toBe(join(generationDir, "preempted-canonical.sqlite"));
    expect(conversationTitles(preempted.path)).toEqual(["pre-rollback-live-data", "through-pool"]);
    expect(statSync(preempted.path).mode & 0o777).toBe(0o400);
    // Move-aside integrity: the two witnesses (taken before and after the
    // rename) agree on content, proving the rename preserved bytes.
    expect(preempted.before.sha256).toBe(preempted.after.sha256);
    expect(preempted.before.size).toBe(preempted.after.size);
  });

  it("installs directly with no preemption when nothing is live at the canonical path yet", async () => {
    const homeDir = tempHome();
    const canonicalPath = join(homeDir, ".lcm", "projects", "proj-2", "db.sqlite");
    mkdirSync(join(homeDir, ".lcm", "projects", "proj-2"), { recursive: true, mode: 0o700 });
    const generationDir = makeGenerationDir(homeDir, "gen-install-first-time");
    const verifiedPath = verifiedGenerationDatabase(generationDir, "first-install");
    const outcome = installRollbackGeneration({
      homeDir, generationId: "gen-install-first-time", canonicalPath, verifiedDatabasePath: verifiedPath,
    });
    expect(outcome.preempted).toBeNull();
    expect(conversationTitles(canonicalPath)).toEqual(["first-install"]);
  });

  it("is idempotent across a simulated crash between move-aside and install: retrying after the canonical path is already absent skips straight to install", async () => {
    const homeDir = tempHome();
    const canonicalPath = liveCanonicalDatabase(homeDir, "pre-crash-live-data");
    const generationDir = makeGenerationDir(homeDir, "gen-crash-retry");
    // Simulate the crash: move the canonical file aside by hand, exactly
    // as this function's own first phase would, then never install.
    const preemptedPath = join(generationDir, "preempted-canonical.sqlite");
    realRenameSync(canonicalPath, preemptedPath);
    chmodSync(preemptedPath, 0o400);
    expect(existsSync(canonicalPath)).toBe(false);

    const verifiedPath = verifiedGenerationDatabase(generationDir, "post-crash-retry-install");
    const outcome = installRollbackGeneration({
      homeDir, generationId: "gen-crash-retry", canonicalPath, verifiedDatabasePath: verifiedPath,
    });
    // No new preemption on the retry -- the canonical path was already
    // absent, so this call skipped straight to install.
    expect(outcome.preempted).toBeNull();
    expect(conversationTitles(canonicalPath)).toEqual(["post-crash-retry-install"]);
    // The FIRST attempt's preserved evidence is still there, untouched.
    expect(conversationTitles(preemptedPath)).toEqual(["pre-crash-live-data"]);
  });

  it("refuses when the canonical path is a symlink rather than a plain regular file", async () => {
    const homeDir = tempHome();
    const realPath = liveCanonicalDatabase(homeDir, "real-target");
    const linkDir = join(homeDir, ".lcm", "projects", "proj-symlink");
    mkdirSync(linkDir, { recursive: true, mode: 0o700 });
    const canonicalPath = join(linkDir, "db.sqlite");
    fsModule.symlinkSync(realPath, canonicalPath);
    const generationDir = makeGenerationDir(homeDir, "gen-symlink-refused");
    const verifiedPath = verifiedGenerationDatabase(generationDir, "should-not-install");
    expect(() => installRollbackGeneration({
      homeDir, generationId: "gen-symlink-refused", canonicalPath, verifiedDatabasePath: verifiedPath,
    })).toThrow(RollbackInstallError);
  });

  it("discovers a real, honest fact: SQLite's own checkpoint-then-DELETE step already removes a stray -wal file, so assertNoWalSiblings has nothing left to catch by the time it runs through this real code path", async () => {
    // Verified directly (not assumed): writing a stray -wal file, running
    // the exact PRAGMA wal_checkpoint(TRUNCATE) + journal_mode=DELETE
    // sequence this module runs, and observing the file is gone
    // afterward -- SQLite deletes any file at the -wal name for a
    // database it is switching to DELETE mode, real WAL frames or not.
    // This means a genuine post-checkpoint stray-WAL refusal has no known
    // real trigger through this exact code path; the guard's own wiring
    // is proven correct below instead, with a controlled fake, following
    // the same disciplined pattern (and the same reasoning for keeping a
    // defence-in-depth check that a different layer already happens to
    // close) as rollback-generation.ts's content-mismatch test.
    const homeDir = tempHome();
    const canonicalPath = liveCanonicalDatabase(homeDir, "clean-delete-mode-data");
    writeFileSync(`${canonicalPath}-wal`, "stray leftover, not a real WAL frame");
    expect(existsSync(`${canonicalPath}-wal`)).toBe(true);
    const generationDir = makeGenerationDir(homeDir, "gen-stray-wal");
    const verifiedPath = verifiedGenerationDatabase(generationDir, "should-not-install");
    const outcome = installRollbackGeneration({
      homeDir, generationId: "gen-stray-wal", canonicalPath, verifiedDatabasePath: verifiedPath,
    });
    // Real, observed outcome: the stray file is gone and the install
    // proceeds normally, not a refusal.
    expect(outcome.preempted).not.toBeNull();
  });

  it("proves assertNoWalSiblings's own refusal is wired correctly via a controlled fake existsSync, since no real post-checkpoint trigger was found (see the test above)", async () => {
    const homeDir = tempHome();
    const canonicalPath = liveCanonicalDatabase(homeDir, "clean-delete-mode-data-2");
    const generationDir = makeGenerationDir(homeDir, "gen-stray-wal-mocked");
    const verifiedPath = verifiedGenerationDatabase(generationDir, "should-not-install");
    const existsSpy = vi.spyOn(fsModule, "existsSync");
    // assertNoWalSiblings short-circuits on the first existsSync call
    // (the -wal check) via ||, so a single mocked "true" here is
    // sufficient and never reaches the -shm check at all.
    existsSpy.mockImplementationOnce(() => true);
    expect(() => installRollbackGeneration({
      homeDir, generationId: "gen-stray-wal-mocked", canonicalPath, verifiedDatabasePath: verifiedPath,
    })).toThrow(RollbackInstallError);
    existsSpy.mockRestore();
  });

  it("RED-PROOF: refuses when the move-aside rename does not preserve bytes -- proven with a real content mutation immediately after a real rename, not a fixture that assumes agreement", async () => {
    const homeDir = tempHome();
    const canonicalPath = liveCanonicalDatabase(homeDir, "pre-mutation-data");
    const generationDir = makeGenerationDir(homeDir, "gen-move-corrupted");
    const verifiedPath = verifiedGenerationDatabase(generationDir, "should-not-install");
    const preemptedPath = join(generationDir, "preempted-canonical.sqlite");
    renameSpy.mockImplementationOnce((from, to) => {
      // Let the real rename happen (this is the exact call this module
      // makes to move the canonical file aside), then simulate a race
      // that corrupts a byte immediately afterward, before this
      // function's own "after" witness ever reads the file.
      realRenameSync(from as string, to as string);
      const bytes = readFileSync(preemptedPath);
      bytes[bytes.length - 1] = (bytes[bytes.length - 1]! + 1) % 256;
      writeFileSync(preemptedPath, bytes);
    });
    expect(() => installRollbackGeneration({
      homeDir, generationId: "gen-move-corrupted", canonicalPath, verifiedDatabasePath: verifiedPath,
    })).toThrow(RollbackInstallError);
    renameSpy.mockRestore();
  });

  it("positive control for the red-proof above: an unmocked rename (identical code path, no corruption) installs cleanly", async () => {
    const homeDir = tempHome();
    const canonicalPath = liveCanonicalDatabase(homeDir, "pre-mutation-data-control");
    const generationDir = makeGenerationDir(homeDir, "gen-move-control");
    const verifiedPath = verifiedGenerationDatabase(generationDir, "installs-cleanly");
    const outcome = installRollbackGeneration({
      homeDir, generationId: "gen-move-control", canonicalPath, verifiedDatabasePath: verifiedPath,
    });
    expect(outcome.preempted).not.toBeNull();
    expect(conversationTitles(canonicalPath)).toEqual(["installs-cleanly"]);
  });

  it("refuses to witness a hardlinked canonical file -- a second path can still reference the same inode after the rename", async () => {
    const homeDir = tempHome();
    const canonicalPath = liveCanonicalDatabase(homeDir, "hardlinked-data");
    const secondLinkPath = join(homeDir, ".lcm", "projects", "proj-1", "db-hardlink.sqlite");
    linkSync(canonicalPath, secondLinkPath);
    expect(lstatSync(canonicalPath).nlink).toBe(2);
    const generationDir = makeGenerationDir(homeDir, "gen-hardlinked");
    const verifiedPath = verifiedGenerationDatabase(generationDir, "should-not-install");
    expect(() => installRollbackGeneration({
      homeDir, generationId: "gen-hardlinked", canonicalPath, verifiedDatabasePath: verifiedPath,
    })).toThrow(RollbackInstallError);
  });

  it("refuses when the canonical path exists but is not a regular file -- a directory, distinct from the symlink case above", async () => {
    const homeDir = tempHome();
    const canonicalPath = join(homeDir, ".lcm", "projects", "proj-dir", "db.sqlite");
    mkdirSync(canonicalPath, { recursive: true, mode: 0o700 });
    const generationDir = makeGenerationDir(homeDir, "gen-directory-refused");
    const verifiedPath = verifiedGenerationDatabase(generationDir, "should-not-install");
    expect(() => installRollbackGeneration({
      homeDir, generationId: "gen-directory-refused", canonicalPath, verifiedDatabasePath: verifiedPath,
    })).toThrow(RollbackInstallError);
  });

});

describe("checkCanonicalLiveExists", () => {
  // installRollbackGeneration's own precondition call, and also
  // getExistingLcmConnection's, both call the real node:fs lstatSync for
  // the same path in the same invocation, so mocking lstatSync through
  // the full installRollbackGeneration pipeline cannot deterministically
  // target "this function's own call" without depending on connection.ts's
  // internal call count. Testing the extracted, named function directly
  // avoids that fragility entirely.
  it("returns false for a positively observed ENOENT", () => {
    expect(checkCanonicalLiveExists("/nonexistent/path/that/should/not/exist/db.sqlite")).toBe(false);
  });

  it("re-throws a precondition-check failure that is not itself a missing-file case", () => {
    const homeDir = tempHome();
    const canonicalPath = liveCanonicalDatabase(homeDir, "eacces-data");
    const lstatSpy = vi.spyOn(fsModule, "lstatSync");
    lstatSpy.mockImplementationOnce(() => {
      throw Object.assign(new Error("simulated EACCES"), { code: "EACCES" });
    });
    expect(() => checkCanonicalLiveExists(canonicalPath)).toThrow("simulated EACCES");
    lstatSpy.mockRestore();
  });

  it("refuses a path that exists, is not a symlink, but is also not a regular file", () => {
    const homeDir = tempHome();
    const canonicalPath = join(homeDir, "a-directory");
    mkdirSync(canonicalPath, { mode: 0o700 });
    expect(() => checkCanonicalLiveExists(canonicalPath)).toThrow(RollbackInstallError);
  });
});

describe("streamSha256", () => {
  it("hashes a real file's real bytes, matching an independently computed digest", () => {
    const homeDir = tempHome();
    const path = join(homeDir, "hash-me.bin");
    const content = Buffer.from("deterministic content for a hash comparison");
    writeFileSync(path, content);
    const expected = createHash("sha256").update(content).digest("hex");
    expect(streamSha256(path, content.byteLength)).toBe(expected);
  });

  it("refuses when the file has fewer bytes than the size it was witnessed at -- a real truncation, not a fixture", () => {
    const homeDir = tempHome();
    const path = join(homeDir, "shrinks.bin");
    writeFileSync(path, Buffer.from("twenty bytes exactly"));
    // Ask for more bytes than the file actually has.
    expect(() => streamSha256(path, 1000)).toThrow(RollbackInstallError);
  });

  it("refuses when the file has grown past the size it was witnessed at -- distinct from the truncation case above", () => {
    const homeDir = tempHome();
    const path = join(homeDir, "grows.bin");
    const content = Buffer.from("this file is longer than the size argument");
    writeFileSync(path, content);
    // Ask for fewer bytes than the file actually has: the final
    // extra-byte probe finds more data than expected.
    expect(() => streamSha256(path, 4)).toThrow(RollbackInstallError);
  });
});

describe("checkpointAndConvertToDelete", () => {
  it("refuses when the journal mode does not report delete after the conversion -- proven with a controlled fake PRAGMA result, since SQLite's own conversion has no known real failure trigger through this code path", () => {
    // Why a mock, stated rather than hidden: PRAGMA journal_mode=DELETE
    // reliably succeeds for any database this function is given (proven
    // by every other test in this file, which all rely on it succeeding
    // for real). No real trigger for a post-PRAGMA "still not delete"
    // state was found. This guard is kept as defence in depth against a
    // future SQLite/driver change that could silently fail the
    // conversion, and is proven wired correctly with a fake result
    // rather than left uncovered or given a misleading "real"
    // reproduction it does not have.
    const homeDir = tempHome();
    const path = liveCanonicalDatabase(homeDir, "checkpoint-mock-data");
    const realPrepare = DatabaseSync.prototype.prepare;
    const prepareSpy = vi.spyOn(DatabaseSync.prototype, "prepare");
    prepareSpy.mockImplementation(function (this: InstanceType<typeof DatabaseSync>, sql: string) {
      const statement = realPrepare.call(this, sql);
      if (sql === "PRAGMA journal_mode") {
        return { ...statement, get: () => ({ journal_mode: "wal" }) } as unknown as ReturnType<typeof realPrepare>;
      }
      return statement;
    });
    expect(() => checkpointAndConvertToDelete(path)).toThrow(RollbackInstallError);
    prepareSpy.mockRestore();
  });
});

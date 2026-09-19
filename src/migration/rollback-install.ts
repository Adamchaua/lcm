/**
 * Moves the live canonical SQLite database aside and installs a verified
 * rollback generation in its place, for item #626, per plan-v2 section 4
 * ("Moving it aside correctly") and section 5 step 11 ("Install
 * precedes publication").
 *
 * ORDER IS THE CONTRACT, not an implementation detail. Each step exists
 * because skipping it produces intermittent, hard-to-reproduce corruption
 * rather than a clean failure:
 *
 *  1. Release the pooled connection for the canonical path FIRST. Pooled
 *     handles are keyed by path and track inode (db/connection.ts:249-272
 *     `getPooledLcmConnection` / the `_connections` map), so a
 *     handle left open follows the renamed inode and keeps writing the
 *     file this function is about to preserve as evidence.
 *  2. Checkpoint and convert to `journal_mode = DELETE`. Live
 *     LCM connections run WAL (db/connection.ts:307), so the sibling set
 *     matters: renaming the main file alone would neither preserve a
 *     complete committed image nor stop a stale -wal poisoning a newly
 *     installed file at the same name. #622 already solved exactly this
 *     problem (sqlite-snapshot.ts's `inspectDatabase`,
 *     `normalize: true` branch) and this reuses that same two-PRAGMA
 *     idiom rather than inventing a second one.
 *  3. Witness the file, move it aside to a lineage path, and witness it
 *     again -- proving the move preserved the exact bytes rather than
 *     merely trusting `renameSync`'s success.
 *  4. Install the verified generation at the canonical path by a single
 *     rename, so a reader never observes a partially-written file at that
 *     name.
 *
 * WHAT THIS MODULE DOES NOT OWN. It performs no PostgreSQL-side fencing,
 * no BackendPublicationCoordinator calls, and no maintenance-journal
 * transitions -- those belong to rollback.ts's orchestration, which calls
 * this function while the retained local token and the durable
 * PostgreSQL lease are already held. The window this function's own
 * crash-recovery leaves open (canonical path briefly absent, between
 * moving the old file aside and installing the new one) is closed by
 * that durable maintenance-journal state, not by anything in this file:
 * `assertBackendPublicationConsumerAccessUnlocked`
 * (backend-publication.ts:1616-1632) refuses `unresolved-publication`
 * for any caller going through backend selection while maintenance
 * remains non-terminal, and it reads that fact from the durable journal
 * file, not from an in-memory lock that would die with a crashed
 * process. This function's own idempotence (skipping preemption when the
 * canonical path is already absent) is what makes a retry after such a
 * crash safe to call again.
 */

import { chmodSync, lstatSync, openSync, closeSync, readSync, renameSync, statSync } from "node:fs";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import {
  getExistingLcmConnection,
  invalidateLcmConnection,
} from "../db/connection.js";
import { rollbackGenerationPath } from "./rollback-generation.js";

export type RollbackInstallErrorReason =
  | "unsafe-storage"
  | "move-aside-content-changed";

export class RollbackInstallError extends Error {
  constructor(readonly reason: RollbackInstallErrorReason, message: string = reason, options?: ErrorOptions) {
    super(message, options);
    this.name = "RollbackInstallError";
  }
}

/** Mirrors sqlite-snapshot.ts's SqliteSnapshotFileIdentity field set -- the established witness shape, not a new one. */
export type RollbackFileWitness = Readonly<{
  dev: string;
  ino: string;
  mode: number;
  size: string;
  sha256: string;
}>;

export type RollbackInstallOutcome = Readonly<{
  canonicalPath: string;
  preempted: Readonly<{
    path: string;
    before: RollbackFileWitness;
    after: RollbackFileWitness;
  }> | null;
}>;

export interface InstallRollbackGenerationInput {
  readonly homeDir: string;
  /** The generation being installed; the preempted file is recorded beside it. */
  readonly generationId: string;
  readonly canonicalPath: string;
  /** BuildRollbackGenerationOutcome's databasePath when state is "verified". */
  readonly verifiedDatabasePath: string;
}

const COPY_CHUNK = 1024 * 1024;
const OWNER_FILE_MODES = new Set([0o400, 0o500, 0o600, 0o700]);

function releasePooledCanonicalConnection(canonicalPath: string): void {
  const db = getExistingLcmConnection(canonicalPath);
  if (db === null) return;
  invalidateLcmConnection(canonicalPath, db);
}

/** @internal Exported for direct unit testing only; not part of the module's public surface. */
export function streamSha256(path: string, size: number): string {
  const fd = openSync(path, "r");
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(COPY_CHUNK);
    let position = 0;
    while (position < size) {
      const wanted = Math.min(buffer.byteLength, size - position);
      const read = readSync(fd, buffer, 0, wanted, position);
      if (read <= 0) throw new RollbackInstallError("unsafe-storage", "canonical database changed while being witnessed");
      hash.update(buffer.subarray(0, read));
      position += read;
    }
    const extra = readSync(fd, buffer, 0, 1, position);
    if (extra !== 0) throw new RollbackInstallError("unsafe-storage", "canonical database grew while being witnessed");
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}

function witnessFile(path: string): RollbackFileWitness {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile() || stat.nlink !== 1n || !OWNER_FILE_MODES.has(Number(stat.mode) & 0o777)) {
    throw new RollbackInstallError("unsafe-storage", "canonical database is not a plain owner-only regular file");
  }
  return {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    mode: Number(stat.mode) & 0o777,
    size: stat.size.toString(),
    sha256: streamSha256(path, Number(stat.size)),
  };
}

/** Reuses sqlite-snapshot.ts's checkpoint-then-DELETE idiom exactly (its `inspectDatabase`, normalize branch). */
/** @internal Exported for direct unit testing only; not part of the module's public surface. */
export function checkpointAndConvertToDelete(path: string): void {
  // mode=rw opens an existing file read/write and atomically refuses to
  // create a replacement main file, matching db/connection.ts:282-292's
  // own idiom for the same reason: this must never create.
  const url = pathToFileURL(path);
  url.searchParams.set("mode", "rw");
  const db = new DatabaseSync(url);
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.exec("PRAGMA journal_mode = DELETE");
    const mode = db.prepare("PRAGMA journal_mode").get()!.journal_mode;
    if (mode !== "delete") throw new RollbackInstallError("unsafe-storage", "canonical database did not convert to journal_mode=DELETE");
  } finally {
    db.close();
  }
}

function assertNoWalSiblings(path: string): void {
  if (existsSync(`${path}-wal`) || existsSync(`${path}-shm`)) {
    throw new RollbackInstallError("unsafe-storage", "canonical database still has WAL siblings after journal_mode=DELETE");
  }
}

/**
 * Three-valued in effect, named rather than collapsed into a boolean per
 * this Epic's standing rule against collapsing absence with failure:
 * `false` means a positively observed ENOENT (nothing lives here yet, a
 * normal first-install or a post-crash retry), `true` means a live plain
 * regular file was found, and any other stat failure (permission denied,
 * an unreadable parent, ...) is a distinct precondition failure that must
 * not be silently treated as either of the other two.
 */
/** @internal Exported for direct unit testing only; not part of the module's public surface. */
export function checkCanonicalLiveExists(canonicalPath: string): boolean {
  try {
    const stat = lstatSync(canonicalPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new RollbackInstallError("unsafe-storage", "canonical database path is not a plain regular file");
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Moves the live canonical database aside (if one exists) and installs
 * the verified generation in its place. Idempotent across a crash: if the
 * canonical path is already absent (a prior attempt already moved it
 * aside but crashed before installing), this skips straight to install.
 */
export function installRollbackGeneration(
  input: InstallRollbackGenerationInput,
): RollbackInstallOutcome {
  const canonicalPath = resolve(input.canonicalPath);
  try {
    releasePooledCanonicalConnection(canonicalPath);
  } catch (error) {
    throw new RollbackInstallError("unsafe-storage", "canonical database pool could not be released", { cause: error });
  }

  let preempted: RollbackInstallOutcome["preempted"] = null;
  const liveExists = checkCanonicalLiveExists(canonicalPath);

  if (liveExists) {
    checkpointAndConvertToDelete(canonicalPath);
    assertNoWalSiblings(canonicalPath);
    const before = witnessFile(canonicalPath);
    const preemptedPath = join(rollbackGenerationPath(input.homeDir, input.generationId), "preempted-canonical.sqlite");
    renameSync(canonicalPath, preemptedPath);
    const after = witnessFile(preemptedPath);
    if (before.sha256 !== after.sha256 || before.size !== after.size) {
      throw new RollbackInstallError("move-aside-content-changed", "canonical database bytes changed across the move-aside rename");
    }
    chmodSync(preemptedPath, 0o400);
    preempted = { path: preemptedPath, before, after };
  }

  renameSync(input.verifiedDatabasePath, canonicalPath);
  return { canonicalPath, preempted };
}

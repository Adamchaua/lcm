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
 *
 * PR #1556 thread 4308518705. The move-aside is recorded durably BEFORE
 * its rename, in a record keyed by the rollback's own generation id
 * (.lcm/migration-rollback-preemptions/<rollbackGenerationId>.json), and
 * completed in that record once the preserved file is read-only, flushed
 * and witnessed again. A retry whose build lands in a different generation
 * directory (every attempt's does) therefore still finds the preserved
 * file of a crashed attempt and finishes it: a crash between the rename
 * and the chmod no longer leaves the pre-rollback database writable,
 * unflushed and unverified. A record that is complete leaves nothing to
 * finish; a live canonical file beside an unfinished preserved file is a
 * state no path here produces and refuses.
 */

import { chmodSync, lstatSync, openSync, closeSync, readSync, renameSync } from "node:fs";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import {
  getExistingLcmConnection,
  invalidateLcmConnection,
} from "../db/connection.js";
import {
  atomicWritePrivateFileDurable,
  ensurePrivateDirectory,
  readBoundedRegularFileWithStat,
  syncPrivateDirectory,
} from "../security-files.js";
import { assertRollbackGenerationId, rollbackGenerationPath } from "./rollback-generation.js";

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
  /** The rollback's own generation id, stable across its attempts; the move-aside record is keyed by it. */
  readonly rollbackGenerationId: string;
  readonly canonicalPath: string;
  /** BuildRollbackGenerationOutcome's databasePath when state is "verified". */
  readonly verifiedDatabasePath: string;
  /**
   * Flushes a directory so a rename's directory entries are durable. Defaults to syncPrivateDirectory
   * (src/security-files.ts). Injectable so a test can fail it.
   */
  readonly syncDirectory?: (path: string) => void;
}

const COPY_CHUNK = 1024 * 1024;
const OWNER_FILE_MODES = new Set([0o400, 0o500, 0o600, 0o700]);
const MAX_ROLLBACK_PREEMPTION_RECORD_BYTES = 8192;

/** The durable move-aside record: its intent (`after` null) before the rename, its completion after the witness. */
export type RollbackPreemptionRecord = Readonly<{
  version: 1;
  rollbackGenerationId: string;
  canonicalPath: string;
  preemptedPath: string;
  before: RollbackFileWitness;
  after: RollbackFileWitness | null;
}>;

function rollbackPreemptionDirectory(homeDir: string): string {
  return join(resolve(homeDir), ".lcm", "migration-rollback-preemptions");
}

/** .lcm/migration-rollback-preemptions/<rollbackGenerationId>.json. */
export function rollbackPreemptionRecordPath(homeDir: string, rollbackGenerationId: string): string {
  assertRollbackGenerationId(rollbackGenerationId);
  return join(rollbackPreemptionDirectory(homeDir), rollbackGenerationId + ".json");
}

function isFileWitness(value: unknown): value is RollbackFileWitness {
  if (typeof value !== "object" || value === null) return false;
  const witness = value as Record<string, unknown>;
  return typeof witness.dev === "string" && typeof witness.ino === "string" && typeof witness.mode === "number"
    && typeof witness.size === "string" && typeof witness.sha256 === "string";
}

function writePreemptionRecord(homeDir: string, record: RollbackPreemptionRecord): void {
  ensurePrivateDirectory(rollbackPreemptionDirectory(homeDir));
  atomicWritePrivateFileDurable(rollbackPreemptionRecordPath(homeDir, record.rollbackGenerationId), JSON.stringify(record), {
    maxExistingBytes: MAX_ROLLBACK_PREEMPTION_RECORD_BYTES,
  });
}

/** @internal Exported for direct unit testing only; not part of the module's public surface. */
export function readRollbackPreemptionRecord(homeDir: string, rollbackGenerationId: string): RollbackPreemptionRecord | null {
  const path = rollbackPreemptionRecordPath(homeDir, rollbackGenerationId);
  let content: string;
  try {
    content = Buffer.from(readBoundedRegularFileWithStat(path, {
      allowedRoot: rollbackPreemptionDirectory(homeDir),
      maxBytes: MAX_ROLLBACK_PREEMPTION_RECORD_BYTES,
      allowedModes: [0o600],
      requireSingleLink: true,
    }).content).toString("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new RollbackInstallError("unsafe-storage", "the move-aside record could not be read", { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new RollbackInstallError("unsafe-storage", "the move-aside record is malformed", { cause: error });
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof parsed !== "object" || parsed === null
    || record.version !== 1
    || record.rollbackGenerationId !== rollbackGenerationId
    || typeof record.canonicalPath !== "string"
    || typeof record.preemptedPath !== "string"
    || !isFileWitness(record.before)
    || !(record.after === null || isFileWitness(record.after))
  ) {
    throw new RollbackInstallError("unsafe-storage", "the move-aside record is malformed");
  }
  return parsed as RollbackPreemptionRecord;
}

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

/** Flushes the source and destination directories of a rename; a failure of either propagates. */
function syncRenamedDirectories(sync: (path: string) => void, fromDir: string, toDir: string): void {
  try {
    sync(fromDir);
    if (toDir !== fromDir) sync(toDir);
  } catch (error) {
    throw new RollbackInstallError("unsafe-storage", "a directory could not be flushed after a rename", { cause: error });
  }
}

/**
 * Moves the live canonical database aside (if one exists) and installs
 * the verified generation in its place. Idempotent across a crash: if the
 * canonical path is already absent (a prior attempt already moved it
 * aside but crashed before installing), this first finishes that attempt's
 * move-aside from its durable record when it is unfinished, then skips
 * straight to install.
 */
export function installRollbackGeneration(
  input: InstallRollbackGenerationInput,
): RollbackInstallOutcome {
  const canonicalPath = resolve(input.canonicalPath);
  const syncDirectory = input.syncDirectory ?? ((path: string) => syncPrivateDirectory(path));
  /** Makes the preserved file read-only, flushes both directories, witnesses it again and completes the record. */
  const finishPreemption = (record: RollbackPreemptionRecord): NonNullable<RollbackInstallOutcome["preempted"]> => {
    // The preserved file is made read-only before the directories are flushed, so the flush covers its mode too (F14).
    chmodSync(record.preemptedPath, 0o400);
    // Both directories changed (the entry left one and entered the other): flush them before anything else.
    syncRenamedDirectories(syncDirectory, dirname(record.canonicalPath), dirname(record.preemptedPath));
    const after = witnessFile(record.preemptedPath);
    if (record.before.sha256 !== after.sha256 || record.before.size !== after.size) {
      throw new RollbackInstallError("move-aside-content-changed", "canonical database bytes changed across the move-aside rename");
    }
    writePreemptionRecord(input.homeDir, { ...record, after });
    return { path: record.preemptedPath, before: record.before, after };
  };
  try {
    releasePooledCanonicalConnection(canonicalPath);
  } catch (error) {
    throw new RollbackInstallError("unsafe-storage", "canonical database pool could not be released", { cause: error });
  }

  let preempted: RollbackInstallOutcome["preempted"] = null;
  const liveExists = checkCanonicalLiveExists(canonicalPath);
  const record = readRollbackPreemptionRecord(input.homeDir, input.rollbackGenerationId);

  if (liveExists) {
    if (record !== null && record.after === null && existsSync(record.preemptedPath)) {
      throw new RollbackInstallError("unsafe-storage", "a live canonical database and an unfinished preserved database both exist");
    }
    checkpointAndConvertToDelete(canonicalPath);
    assertNoWalSiblings(canonicalPath);
    const before = witnessFile(canonicalPath);
    const preemptedPath = join(rollbackGenerationPath(input.homeDir, input.generationId), "preempted-canonical.sqlite");
    const intent: RollbackPreemptionRecord = {
      version: 1, rollbackGenerationId: input.rollbackGenerationId, canonicalPath, preemptedPath, before, after: null,
    };
    // The intent is durable before the rename, so a crash anywhere after it is finished by the retry below.
    writePreemptionRecord(input.homeDir, intent);
    renameSync(canonicalPath, preemptedPath);
    preempted = finishPreemption(intent);
  } else if (record !== null && record.after === null) {
    // A prior attempt crashed between its rename and its completion: the canonical file is gone and the record is
    // its only account. The preserved file must be where the record says; its absence as well means the rename
    // never became durable and something else removed the canonical file, which nothing here can repair.
    if (record.canonicalPath !== canonicalPath || !existsSync(record.preemptedPath)) {
      throw new RollbackInstallError("unsafe-storage", "the canonical database is absent and its unfinished move-aside record does not account for it");
    }
    preempted = finishPreemption(record);
  } else if (record !== null && record.after !== null) {
    preempted = { path: record.preemptedPath, before: record.before, after: record.after };
  }

  renameSync(input.verifiedDatabasePath, canonicalPath);
  // The selection must not become durable before the installed database's directory entries are (A-03 / F3).
  syncRenamedDirectories(syncDirectory, dirname(input.verifiedDatabasePath), dirname(canonicalPath));
  return { canonicalPath, preempted };
}

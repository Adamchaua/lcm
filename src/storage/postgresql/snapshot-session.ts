import { randomUUID } from "node:crypto";
import type { QueryConfig, QueryResult, QueryResultRow } from "pg";
import { StorageOperationError } from "../errors.js";
import type { PostgreSqlQueryExecutor, PostgreSqlQueryOptions } from "./contracts.js";
import {
  isPostgreSqlConnectionError, isPostgreSqlSnapshotTerminationError, normalizePostgreSqlError,
} from "./errors.js";

/**
 * Fallback applied at the snapshot-open seam when a caller's
 * {@link PostgreSqlConnectionSettings.snapshotIdleTimeoutMs} is omitted.
 * Longer than any expected gap between source reads in a healthy local
 * transfer, five times the statement-timeout default so the two knobs
 * cannot be mistaken for each other, and short enough that a genuinely
 * abandoned snapshot is reclaimed before autovacuum is badly stuck.
 */
export const DEFAULT_SNAPSHOT_IDLE_TIMEOUT_MS = 300_000;
const SNAPSHOT_IDLE_TIMEOUT_MIN_MS = 1;
const SNAPSHOT_IDLE_TIMEOUT_MAX_MS = 3_600_000;
const SNAPSHOT_IDLE_TIMEOUT_SQL = [
  "SELECT pg_catalog.set_config(",
  "  'idle_in_transaction_session_timeout',",
  "  $1::pg_catalog.text,",
  "  true",
  ")",
].join("\n");

/**
 * The snapshot-open seam is reachable through the public
 * {@link PostgreSqlRuntime} API without daemon config validation, so the
 * value is integer-validated here too. Zero is rejected: zero disables the
 * PostgreSQL bound, and the whole point of this seam is that a bound must
 * exist. A non-integer, zero, negative or out-of-range value fails closed
 * instead of silently proceeding with the connection-level statement-scale
 * bound still in force.
 */
function resolveSnapshotIdleTimeoutMs(value: number | undefined, projectId: string): number {
  const candidate = value ?? DEFAULT_SNAPSHOT_IDLE_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(candidate)
    || candidate < SNAPSHOT_IDLE_TIMEOUT_MIN_MS
    || candidate > SNAPSHOT_IDLE_TIMEOUT_MAX_MS
  ) {
    throw new StorageOperationError(
      "STORAGE_INITIALIZATION_FAILED", "postgresql", projectId, "transaction", "snapshot",
    );
  }
  return candidate;
}

export interface PostgreSqlSnapshotOptions {
  readonly projectId: string;
  readonly signal?: AbortSignal;
  /**
   * Runtime-resolved; per-call callers of {@link PostgreSqlRuntime.openReadOnlySnapshot}
   * do not set this. {@link PostgreSqlRuntime} derives it once from its own
   * {@link PostgreSqlConnectionSettings.snapshotIdleTimeoutMs} (or the
   * {@link DEFAULT_SNAPSHOT_IDLE_TIMEOUT_MS} fallback) and supplies the
   * definite value here before opening the transaction.
   */
  readonly snapshotIdleTimeoutMs?: number;
}

export interface PostgreSqlSnapshotIdentity {
  /** A process-local lifetime identifier; it cannot reopen a source snapshot. */
  readonly sessionId: string;
  readonly backendPid: number;
  readonly projectId: string;
}

/** Internal connection transport supplied by the admitted PostgreSQL runtime. */
export interface PostgreSqlSnapshotTransport extends PostgreSqlQueryExecutor {
  rollback(): Promise<void>;
  release(destroy: boolean): void;
}

/** A single checked-out backend, retained until terminal rollback or disconnect. */
export class PostgreSqlSnapshotSession implements PostgreSqlQueryExecutor {
  private readonly cancellation = new AbortController();
  private readonly context: PostgreSqlQueryOptions;
  private queue = Promise.resolve();
  private closed = false;
  private destroy = false;
  private closePromise: Promise<void> | undefined;
  private snapshotIdentity!: PostgreSqlSnapshotIdentity;
  private readonly onAbort = (): void => {
    void this.close().catch(() => undefined);
  };

  private constructor(
    private readonly transport: PostgreSqlSnapshotTransport,
    private readonly options: PostgreSqlSnapshotOptions,
  ) {
    this.context = { domain: "transaction", operation: "snapshot", projectId: options.projectId };
    options.signal?.addEventListener("abort", this.onAbort, { once: true });
    if (options.signal?.aborted) this.onAbort();
  }

  static async open(
    transport: PostgreSqlSnapshotTransport,
    options: PostgreSqlSnapshotOptions,
  ): Promise<PostgreSqlSnapshotSession> {
    const session = new PostgreSqlSnapshotSession(transport, options);
    try {
      const snapshotIdleTimeoutMs = resolveSnapshotIdleTimeoutMs(
        options.snapshotIdleTimeoutMs, options.projectId,
      );
      await session.query({ text: "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" }, session.context);
      // SET LOCAL revert semantics via set_config(..., true): the relaxed
      // idle bound applies only to this snapshot transaction and reverts on
      // COMMIT/ROLLBACK, so the pooled client is never left with it. The
      // ::pg_catalog.text cast matches the house set_config idiom (see
      // coordination.ts, lexical-search-repository.ts) and is load-bearing;
      // without it node-pg may send a non-text-typed parameter. Values are
      // parameterized, not interpolated, and the digits-only ms guard above
      // keeps the rendered "<n>ms" text injection-proof.
      await session.query({
        text: SNAPSHOT_IDLE_TIMEOUT_SQL,
        values: [snapshotIdleTimeoutMs + "ms"],
      }, session.context);
      const result = await session.query<{ pid: number }>({
        text: "SELECT pg_catalog.pg_backend_pid() AS pid",
      }, session.context);
      const pid = result.rows[0]?.pid;
      if (!Number.isSafeInteger(pid) || pid <= 0) {
        throw new Error("invalid snapshot backend identity");
      }
      session.snapshotIdentity = Object.freeze({
        sessionId: randomUUID(), backendPid: pid, projectId: options.projectId,
      });
      session.assertOpen();
      return session;
    } catch (error) {
      await session.close().catch(() => undefined);
      throw normalizePostgreSqlError(error, session.context);
    }
  }

  get identity(): PostgreSqlSnapshotIdentity {
    return this.snapshotIdentity;
  }

  async query<R extends QueryResultRow = QueryResultRow, I extends unknown[] = unknown[]>(
    config: QueryConfig<I>,
    options: PostgreSqlQueryOptions,
  ): Promise<QueryResult<R>> {
    this.assertOpen();
    const effectiveOptions = {
      ...options,
      signal: options.signal
        ? AbortSignal.any([options.signal, this.cancellation.signal])
        : this.cancellation.signal,
    };
    const execute = this.queue.then(async () => {
      this.assertOpen();
      try {
        return await this.transport.query<R, I>(config, effectiveOptions);
      } catch (error) {
        // A 25P03 idle-in-transaction kill (or any connection-termination
        // failure) marks the backend dead immediately, so finishClose skips
        // ROLLBACK on the FATAL-dead session and releases with destroy=true
        // instead of attempting a doomed rollback.
        this.destroy ||= effectiveOptions.signal.aborted
          || isPostgreSqlConnectionError(error)
          || isPostgreSqlSnapshotTerminationError(error);
        // Do not await close inside the queue it must drain.
        void this.close().catch(() => undefined);
        throw normalizePostgreSqlError(error, { ...options, projectId: this.options.projectId });
      }
    });
    this.queue = execute.then(() => undefined, () => undefined);
    return execute;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.options.signal?.removeEventListener("abort", this.onAbort);
    this.cancellation.abort();
    this.closePromise = this.finishClose();
    return this.closePromise;
  }

  private async finishClose(): Promise<void> {
    await this.queue;
    try {
      // Aborted or broken connections must never return to the pool. Disconnect
      // rolls back even when cancellation failed and a query is still pending.
      if (!this.destroy) await this.transport.rollback();
    } catch (error) {
      this.destroy = true;
      throw normalizePostgreSqlError(error, this.context);
    } finally {
      try {
        this.transport.release(this.destroy);
      } catch (error) {
        throw normalizePostgreSqlError(error, this.context);
      }
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new StorageOperationError(
        "STORAGE_CLOSED", "postgresql", this.options.projectId, "transaction", "snapshot",
      );
    }
  }
}

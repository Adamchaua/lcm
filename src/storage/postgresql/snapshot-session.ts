import { randomUUID } from "node:crypto";
import type { QueryConfig, QueryResult, QueryResultRow } from "pg";
import { StorageOperationError } from "../errors.js";
import type { PostgreSqlQueryExecutor, PostgreSqlQueryOptions } from "./contracts.js";
import {
  isPostgreSqlConnectionError, isPostgreSqlSnapshotTerminationError, normalizePostgreSqlError,
  isPostgreSqlSnapshotTerminationSqlState, PostgreSqlStorageOperationError,
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
  /**
   * Optional. When present, the session registers exactly one handler here
   * at construction time, and the transport must invoke it whenever the
   * driver reports an asynchronous failure that arrives outside any
   * query's promise chain: most notably a FATAL delivered to an idle
   * checked-out client, such as an idle_in_transaction_session_timeout
   * kill (PostgreSQL only ever checks that timeout between statements, so
   * the FATAL ordinarily has no in-flight query to reject). The transport
   * must swallow the underlying driver event itself so it never becomes an
   * unhandled process-level error, and must invoke the handler with the
   * failure's sanitized five-character SQLSTATE when the driver supplied
   * one, or null otherwise.
   */
  onAsyncFailure?(handler: (sqlState: string | null) => void): void;
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
  /**
   * Set only by the transport's {@link PostgreSqlSnapshotTransport.onAsyncFailure}
   * callback: the sanitized SQLSTATE of an out-of-band driver failure
   * (idle-in-transaction FATAL, most often), captured because it never
   * arrives on the promise a later query or close rejects with. Reattached
   * by {@link normalize} so that later rejection still carries the real
   * diagnostic instead of a generic, code-free "not queryable" message.
   */
  private capturedSqlState: string | null = null;
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
    // The listener can fire at any time once the transport's client is
    // checked out, including before BEGIN completes and after close() has
    // already started; it only ever marks this session destroyed and
    // records a diagnostic, so it is safe regardless of session phase.
    transport.onAsyncFailure?.((sqlState) => {
      this.destroy = true;
      this.capturedSqlState ??= sqlState;
    });
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
      throw session.normalize(error, session.context);
    }
  }

  get identity(): PostgreSqlSnapshotIdentity {
    return this.snapshotIdentity;
  }

  /**
   * Normalizes a driver failure, then reattaches {@link capturedSqlState}
   * when normalization left sqlState null. A captured async failure is by
   * definition a connection-level event (an out-of-band driver 'error'),
   * never an ordinary query-level SQL error, so the reattached error is
   * always marked retryable regardless of what the code-free rejection it
   * replaces would otherwise have computed.
   */
  private normalize(error: unknown, context: PostgreSqlQueryOptions): StorageOperationError {
    const normalized = normalizePostgreSqlError(error, context);
    if (
      this.capturedSqlState !== null
      && isPostgreSqlSnapshotTerminationSqlState(this.capturedSqlState)
      && normalized instanceof PostgreSqlStorageOperationError
      && normalized.sqlState === null
    ) {
      return new PostgreSqlStorageOperationError(
        normalized.code as "STORAGE_INITIALIZATION_FAILED" | "STORAGE_OPERATION_FAILED",
        context,
        this.capturedSqlState,
        true,
      );
    }
    return normalized;
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
        // Normalize first so a captured async diagnostic (see
        // capturedSqlState / normalize) can participate in the destroy
        // decision: a raw post-kill rejection can be a generic, code-free
        // "not queryable" message that isPostgreSqlSnapshotTerminationError
        // would not recognize on its own, even though the reattached,
        // normalized error correctly carries the real captured sqlState.
        // isPostgreSqlConnectionError still reads the raw error: it is a
        // raw-driver-shape check (transport codes, connection-loss
        // messages) that a normalized StorageOperationError can never
        // match, so normalizing first would only ever make it return false.
        const normalized = this.normalize(error, { ...options, projectId: this.options.projectId });
        // A 25P03 idle-in-transaction kill (or any connection-termination
        // failure) marks the backend dead immediately, so finishClose skips
        // ROLLBACK on the FATAL-dead session and releases with destroy=true
        // instead of attempting a doomed rollback.
        this.destroy ||= effectiveOptions.signal.aborted
          || isPostgreSqlConnectionError(error)
          || isPostgreSqlSnapshotTerminationError(normalized);
        // Do not await close inside the queue it must drain.
        void this.close().catch(() => undefined);
        throw normalized;
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
      throw this.normalize(error, this.context);
    } finally {
      try {
        this.transport.release(this.destroy);
      } catch (error) {
        throw this.normalize(error, this.context);
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

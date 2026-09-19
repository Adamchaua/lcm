import { StorageOperationError } from "../errors.js";
import type { PostgreSqlOperationContext } from "./contracts.js";

const RETRYABLE_SQLSTATES = new Set([
  "40001",
  "40P01",
  "53300",
]);

const CONNECTION_TERMINATION_SQLSTATES = new Set([
  "57P01",
  "57P02",
  "57P03",
]);

/**
 * Sessions killed by idle_in_transaction_session_timeout (25P03) are FATAL
 * and dead, exactly like a transport-level connection loss, but 25P03 is
 * class 25 ("Invalid Transaction State"), not 08 ("Connection Exception"),
 * so it is deliberately kept out of {@link CONNECTION_TERMINATION_SQLSTATES}.
 * Folding it in there would widen {@link isRetryablePostgreSqlError} and the
 * runtime's destroy decisions across the whole PostgreSQL layer, retrying a
 * FATAL idle-kill as if it were transient like ECONNRESET. That is the
 * wrong blast radius. It is used only by the narrower snapshot-local
 * predicate below.
 */
const SNAPSHOT_TERMINATION_SQLSTATES = new Set([
  "25P03",
  ...CONNECTION_TERMINATION_SQLSTATES,
]);

const RETRYABLE_TRANSPORT_CODES = new Set([
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTDOWN",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETRESET",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
]);

const RETRYABLE_DRIVER_MESSAGES = new Set([
  "Connection terminated due to connection timeout",
  "Connection terminated unexpectedly",
  "timeout exceeded when trying to connect",
  "timeout expired",
]);

type PostgreSqlDriverError = Error & { code?: unknown };

export class PostgreSqlStorageOperationError extends StorageOperationError {
  readonly machineId: string | undefined;

  constructor(
    code: "STORAGE_INITIALIZATION_FAILED" | "STORAGE_OPERATION_FAILED",
    context: PostgreSqlOperationContext,
    readonly sqlState: string | null,
    retryable: boolean,
  ) {
    super(code, "postgresql", context.projectId, context.domain, context.operation, { retryable });
    this.machineId = context.machineId;
  }

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      sqlState: this.sqlState,
      ...(this.machineId === undefined
        ? {}
        : { machineId: this.machineId }),
    };
  }
}

/**
 * A transport failure observed after COMMIT was sent. The server may have
 * committed successfully, so callers must reconcile through an authoritative
 * read before retrying a non-idempotent operation.
 */
export class PostgreSqlCommitOutcomeUnknownError extends StorageOperationError {
  readonly machineId: string | undefined;

  constructor(context: PostgreSqlOperationContext) {
    super(
      "STORAGE_OPERATION_FAILED",
      "postgresql",
      context.projectId,
      context.domain,
      context.operation,
    );
    this.name = "PostgreSqlCommitOutcomeUnknownError";
    this.machineId = context.machineId;
  }

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      ...(this.machineId === undefined
        ? {}
        : { machineId: this.machineId }),
    };
  }
}

function sanitizeSqlState(error: unknown): string | null {
  const code = (error as PostgreSqlDriverError | undefined)?.code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/u.test(code) ? code : null;
}

export function isPostgreSqlConnectionError(error: unknown): boolean {
  const candidate = error as PostgreSqlDriverError | undefined;
  const code = candidate?.code;
  if (typeof code === "string" && (
    (code.length === 5 && code.startsWith("08"))
    || CONNECTION_TERMINATION_SQLSTATES.has(code)
    || RETRYABLE_TRANSPORT_CODES.has(code)
  )) {
    return true;
  }
  return error instanceof Error && RETRYABLE_DRIVER_MESSAGES.has(error.message);
}

/**
 * A narrower, snapshot-local predicate for the read-only snapshot session
 * only. Matches 25P03 (idle-in-transaction session kill), 08xxx (connection
 * exception), 57P01/57P02/57P03 (admin/crash shutdown) and the existing
 * transport codes/messages, reading either the raw pre-normalize driver
 * error or the sqlState already carried by a normalized
 * {@link PostgreSqlStorageOperationError}. Deliberately NOT the same set as
 * {@link isPostgreSqlConnectionError}: use this only at the two seams that
 * need it (snapshot session destroy-on-error, and the session arm of
 * portable-source close() tolerance), never for the general retry/destroy
 * decisions the wider helper feeds.
 */
export function isPostgreSqlSnapshotTerminationError(error: unknown): boolean {
  if (error instanceof PostgreSqlStorageOperationError) {
    const sqlState = error.sqlState;
    return sqlState !== null && (
      sqlState === "25P03"
      || (sqlState.length === 5 && sqlState.startsWith("08"))
      || CONNECTION_TERMINATION_SQLSTATES.has(sqlState)
    );
  }
  const candidate = error as PostgreSqlDriverError | undefined;
  const code = candidate?.code;
  if (typeof code === "string" && (
    (code.length === 5 && code.startsWith("08"))
    || SNAPSHOT_TERMINATION_SQLSTATES.has(code)
    || RETRYABLE_TRANSPORT_CODES.has(code)
  )) {
    return true;
  }
  return error instanceof Error && RETRYABLE_DRIVER_MESSAGES.has(error.message);
}

export function isRetryablePostgreSqlError(error: unknown): boolean {
  const code = (error as PostgreSqlDriverError | undefined)?.code;
  return isPostgreSqlConnectionError(error)
    || (typeof code === "string" && RETRYABLE_SQLSTATES.has(code));
}

export function normalizePostgreSqlError(
  error: unknown,
  context: PostgreSqlOperationContext,
  code: "STORAGE_INITIALIZATION_FAILED" | "STORAGE_OPERATION_FAILED" = "STORAGE_OPERATION_FAILED",
): StorageOperationError {
  if (error instanceof StorageOperationError) return error;
  return new PostgreSqlStorageOperationError(
    code,
    context,
    sanitizeSqlState(error),
    isRetryablePostgreSqlError(error),
  );
}

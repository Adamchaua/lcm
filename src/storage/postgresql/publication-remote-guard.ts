import { normalizeUuidV7 } from "../../machine-identity.js";
import type { BackendPublicationRemoteGuardProvider } from "../backend-publication-driver.js";
import type {
  BackendPublicationFenceRecord,
  BackendPublicationRemoteContext,
} from "../backend-publication.js";
import {
  PostgreSqlBackendPublicationGuardError,
  type PostgreSqlBackendPublicationFence,
  type PostgreSqlBackendPublicationGuard,
} from "./publication-guard.js";

// Mirrors publication-guard.ts's MAX_PUBLICATION_TTL_MS. The guard does not
// export its validators; a parity test pins both bounds against the real
// guard so they cannot drift apart.
const MAX_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The slice of {@link PostgreSqlBackendPublicationGuard} this provider calls.
 * A real guard (for example `PostgreSqlRuntime#backendPublicationGuard()`)
 * satisfies it directly.
 */
export type PostgreSqlBackendPublicationRemoteGuardPort = Pick<
  PostgreSqlBackendPublicationGuard,
  "acquire" | "read" | "release"
>;

export type CreatePostgreSqlBackendPublicationRemoteGuardOptions = Readonly<{
  guard: PostgreSqlBackendPublicationRemoteGuardPort;
  /** This machine's PostgreSQL machine id (a UUIDv7). */
  machineId: string;
  /** Lease lifetime for an acquisition or takeover, in milliseconds. */
  ttlMs: number;
}>;

function assertOptions(options: CreatePostgreSqlBackendPublicationRemoteGuardOptions): string {
  const guard: unknown = options?.guard;
  if (guard === null || typeof guard !== "object") {
    throw new TypeError("backend publication remote guard requires a guard object");
  }
  for (const method of ["acquire", "read", "release"] as const) {
    if (typeof (guard as Record<string, unknown>)[method] !== "function") {
      throw new TypeError(
        `backend publication remote guard guard is missing required method: ${method}`,
      );
    }
  }
  const machineId = typeof options.machineId === "string"
    ? normalizeUuidV7(options.machineId)
    : null;
  if (machineId === null) {
    throw new TypeError("backend publication remote guard machineId must be a UUIDv7");
  }
  const ttlMs: unknown = options.ttlMs;
  if (
    typeof ttlMs !== "number"
    || !Number.isSafeInteger(ttlMs)
    || ttlMs <= 0
    || ttlMs > MAX_TTL_MS
  ) {
    throw new TypeError(
      `backend publication remote guard ttlMs must be an integer from 1 to ${MAX_TTL_MS}`,
    );
  }
  return machineId;
}

function toFenceRecord(fence: PostgreSqlBackendPublicationFence): BackendPublicationFenceRecord {
  return { ...fence, fencingToken: fence.fencingToken.toString() };
}

function identityOf(context: BackendPublicationRemoteContext) {
  return {
    projectId: context.project.remoteProjectId,
    targetBackend: context.journal.targetBackend,
    evidenceSha256: context.project.evidenceSha256,
  };
}

/**
 * Production {@link BackendPublicationRemoteGuardProvider} over the
 * PostgreSQL fenced publication lease.
 *
 * The consumer (migration activation or rollback) acquires and renews the
 * lease for each project before it drives the coordinator, so the
 * coordinator normally finds an active fence already and only adopts it.
 * This provider never renews. It acquires only when the coordinator asks
 * for it:
 *
 * - no row, or a released row: the guard inserts or replaces it;
 * - an unexpired row of this exact generation (machine, publication, target
 *   backend and evidence): the guard returns it unchanged, which adopts the
 *   caller's lease;
 * - an expired, unreleased row of this exact generation: the provider reads
 *   the row and passes that row's own token as the guard's
 *   `expectedFencingToken`, taking over our own lapsed generation. The token
 *   in the journal is never used, because the authoritative row decides
 *   whether a takeover is allowed and which token it must name;
 * - an unreleased row of any other generation: the guard refuses with
 *   `publication-conflict` and the error propagates, so the coordinator
 *   fails closed.
 *
 * A row held by a different machine under this publication id is refused by
 * this provider, so a foreign fence is never journalled as ours.
 */
export function createPostgreSqlBackendPublicationRemoteGuard(
  options: CreatePostgreSqlBackendPublicationRemoteGuardOptions,
): BackendPublicationRemoteGuardProvider {
  const machineId = assertOptions(options);
  const { guard, ttlMs } = options;

  const refuseForeignMachine = (
    fence: PostgreSqlBackendPublicationFence,
    context: BackendPublicationRemoteContext,
  ): void => {
    if (
      fence.publicationId === context.journal.publicationId
      && fence.machineId !== machineId
    ) {
      throw new PostgreSqlBackendPublicationGuardError(
        fence.projectId,
        "backendPublicationRemoteGuard",
        "publication-conflict",
      );
    }
  };

  const isOwnGeneration = (
    fence: PostgreSqlBackendPublicationFence,
    context: BackendPublicationRemoteContext,
  ): boolean => fence.machineId === machineId
    && fence.publicationId === context.journal.publicationId
    && fence.targetBackend === context.journal.targetBackend
    && fence.evidenceSha256 === context.project.evidenceSha256;

  return {
    async readRemoteGuard(context) {
      const fence = await guard.read(identityOf(context));
      if (fence === null) return null;
      refuseForeignMachine(fence, context);
      return toFenceRecord(fence);
    },

    async acquireRemoteGuard(context) {
      const identity = identityOf(context);
      const row = await guard.read(identity);
      if (row !== null) refuseForeignMachine(row, context);
      const takeover = row !== null
        && row.releasedAt === null
        && row.databaseExpired
        && isOwnGeneration(row, context);
      const fence = await guard.acquire({
        ...identity,
        machineId,
        publicationId: context.journal.publicationId,
        ttlMs,
        ...(takeover ? { expectedFencingToken: row.fencingToken } : {}),
      });
      refuseForeignMachine(fence, context);
      return toFenceRecord(fence);
    },

    async releaseRemoteGuard(context) {
      await guard.release({
        ...identityOf(context),
        machineId,
        publicationId: context.journal.publicationId,
        fencingToken: BigInt(context.fence.fencingToken),
      });
    },
  };
}

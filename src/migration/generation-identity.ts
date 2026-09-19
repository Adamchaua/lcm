import {
  backendPublicationCanonicalSha256,
} from "../storage/backend-publication.js";
import {
  classifySqliteSnapshotArtifact,
  SqliteSnapshotError,
  type SqliteSnapshotClassification,
} from "./sqlite-snapshot.js";
import {
  MigrationManifestStore,
  type MigrationManifestPresence,
} from "./manifest-store.js";

/**
 * Section 4.1's stable narrow base, plus the section 4.3 two-tree occupancy
 * probe used to mint a fresh generation id. Neither reimplements a migration
 * decision: both call the exact existing classifiers (#622's snapshot
 * classification, this item's own manifest presence probe) and refuse rather
 * than guess when either cannot be established.
 */

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_IDENTIFIER_LENGTH = 128;
const SEPARATOR = "-";
const BASE_LABEL = "sqlite-postgresql-migration";

/**
 * The bound on how many candidate ordinals `apply` will probe before
 * refusing rather than looping. Documented in `docs/migration-operations.md`.
 * Overridable only for deterministic tests; production callers must use the
 * default.
 */
export const DEFAULT_MAX_PROBE_ORDINAL = 9999;

export type MigrationIdentityReason =
  | "invalid-input"
  | "identifier-bound-exceeded"
  | "probe-bound-exceeded"
  | "occupancy-refused";

export class MigrationIdentityError extends Error {
  readonly reason: MigrationIdentityReason;
  /** Closed, non-path, non-secret evidence string; never a raw message or cause. */
  readonly evidence: string | null;

  constructor(reason: MigrationIdentityReason, message: string, evidence: string | null = null) {
    super(message);
    this.name = "MigrationIdentityError";
    this.reason = reason;
    this.evidence = evidence;
  }
}

function invalid(message: string): never {
  throw new MigrationIdentityError("invalid-input", message);
}

export type NonSecretPostgreSqlTarget = Readonly<{
  host: string;
  port: number;
  database: string;
}>;

/**
 * Extracts only the target's non-secret coordinates from a PostgreSQL
 * connection URL: host, port, database. Never the URL itself, which may
 * carry a credential (section 4.1). `URL#username`/`#password` are never
 * read.
 */
export function nonSecretPostgreSqlTargetCoordinates(url: string): NonSecretPostgreSqlTarget {
  if (typeof url !== "string" || url.length === 0) {
    invalid("PostgreSQL target URL is missing");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (error) {
    throw new MigrationIdentityError("invalid-input", "PostgreSQL target URL is malformed", null);
  }
  const host = parsed.hostname;
  const database = decodeURIComponent(parsed.pathname.replace(/^\//u, ""));
  if (host.length === 0 || database.length === 0) {
    invalid("PostgreSQL target URL is missing a host or database name");
  }
  const port = parsed.port === "" ? 5432 : Number(parsed.port);
  // WHATWG URL parsing already rejects a port outside 0-65535 and anything
  // non-numeric, so the only invalid case reachable here is the syntactically
  // legal but semantically unusable port 0.
  if (port === 0) {
    invalid("PostgreSQL target URL has an invalid port");
  }
  return Object.freeze({ host, port, database });
}

export type MigrationGenerationBaseInput = Readonly<{
  physicalProjectId: string;
  canonicalPath: string;
  target: NonSecretPostgreSqlTarget;
}>;

/**
 * The stable, attempt-invariant base identity (section 4.1): local physical
 * project id, canonical path, and the target's non-secret coordinates only.
 * Excludes `sourceSelectionSha256` and every clock, random value, fencing
 * token and live capture (section 2.10). A configuration property alone, so
 * it cannot distinguish a second cutover from the first — {@link
 * resolveMigrationGenerationId} appends the probe ordinal that does.
 */
export function computeMigrationGenerationBase(input: MigrationGenerationBaseInput): string {
  if (typeof input?.physicalProjectId !== "string" || input.physicalProjectId.length === 0) {
    invalid("migration base identity requires a physical project id");
  }
  if (typeof input.canonicalPath !== "string" || input.canonicalPath.length === 0) {
    invalid("migration base identity requires a canonical path");
  }
  const { host, port, database } = input.target ?? invalid("migration base identity requires a target");
  if (typeof host !== "string" || host.length === 0 || typeof database !== "string" || database.length === 0
    || !Number.isInteger(port) || port <= 0 || port > 65535) {
    invalid("migration base identity target coordinates are invalid");
  }
  const digest = backendPublicationCanonicalSha256({
    version: 1,
    kind: "migration-generation-base-identity",
    physicalProjectId: input.physicalProjectId,
    canonicalPath: input.canonicalPath,
    target: { host, port, database },
  });
  return `${BASE_LABEL}${SEPARATOR}${digest}`;
}

export type MigrationCandidateOccupancy =
  | Readonly<{ status: "free" }>
  | Readonly<{ status: "occupied" }>
  | Readonly<{ status: "refuse"; evidence: string }>;

export type MigrationCandidateOccupancyOperations = Readonly<{
  classifySnapshot: typeof classifySqliteSnapshotArtifact;
}>;

/**
 * Section 4.3's two-tree occupancy check for one candidate generation id.
 * Never deletes or advances anything itself; the caller decides what a
 * `refuse` or `occupied` result means for the probe loop.
 */
export async function classifyMigrationCandidateOccupancy(input: Readonly<{
  generationId: string;
  homeDir: string;
  manifestStore?: MigrationManifestStore;
  /**
   * @internal Deterministic failure-injection seam for tests only, matching
   * the `_operationsForTesting` convention used elsewhere in
   * `src/migration/` (see `sqlite-snapshot.ts`, `maintenance.ts`). Every
   * documented throw from `classifySqliteSnapshotArtifact` is a typed
   * `SqliteSnapshotError` (`invalid-input`, `unsupported-platform`,
   * `snapshot-io`); this default is never overridden in production.
   */
  _operationsForTesting?: Partial<MigrationCandidateOccupancyOperations>;
}>): Promise<MigrationCandidateOccupancy> {
  const classify = input._operationsForTesting?.classifySnapshot ?? classifySqliteSnapshotArtifact;
  let snapshot: SqliteSnapshotClassification;
  try {
    snapshot = await classify(input.generationId, { homeDir: input.homeDir });
  } catch (error) {
    // The real seam never throws anything else (verified at source: every
    // throw path in classifySqliteSnapshotArtifact wraps into
    // SqliteSnapshotError). An unrecognised throw shape is not converted
    // into fabricated evidence — it propagates, because guessing at its
    // meaning would be exactly the unattributable-absence defect this item
    // exists to avoid.
    if (!(error instanceof SqliteSnapshotError)) throw error;
    return { status: "refuse", evidence: `snapshot-${error.reason}` };
  }
  if (snapshot.state === "replaced" || snapshot.state === "tampered") {
    return { status: "refuse", evidence: `snapshot-${snapshot.state}` };
  }
  if (snapshot.state === "complete" || snapshot.state === "partial") {
    return { status: "occupied" };
  }
  // snapshot.state === "absent": the manifest tree still needs its own answer.
  const store = input.manifestStore ?? new MigrationManifestStore({ homeDir: input.homeDir });
  const presence: MigrationManifestPresence = store.probeManifestPresence(input.generationId);
  if (presence.status === "present") return { status: "occupied" };
  if (presence.status === "absent") return { status: "free" };
  return { status: "refuse", evidence: `manifest-${presence.reason}` };
}

export type MigrationGenerationIdResolution = Readonly<{
  generationId: string;
  probedOrdinals: number;
}>;

/**
 * Advances the probe ordinal (section 4.1) until both trees agree a
 * candidate is free (section 4.3), refusing rather than looping when the
 * identifier bound or the probe bound would be exceeded, or either tree
 * cannot be classified.
 */
export async function resolveMigrationGenerationId(input: Readonly<{
  base: string;
  homeDir: string;
  manifestStore?: MigrationManifestStore;
  maxProbeOrdinal?: number;
}>): Promise<MigrationGenerationIdResolution> {
  if (typeof input?.base !== "string" || input.base.length === 0) {
    invalid("migration generation base identity is missing");
  }
  const maxProbeOrdinal = input.maxProbeOrdinal ?? DEFAULT_MAX_PROBE_ORDINAL;
  if (!Number.isInteger(maxProbeOrdinal) || maxProbeOrdinal < 0) {
    invalid("migration generation probe bound is invalid");
  }
  const store = input.manifestStore ?? new MigrationManifestStore({ homeDir: input.homeDir });
  for (let ordinal = 0; ordinal <= maxProbeOrdinal; ordinal += 1) {
    const candidate = `${input.base}${SEPARATOR}${ordinal}`;
    if (candidate.length > MAX_IDENTIFIER_LENGTH || !IDENTIFIER_PATTERN.test(candidate)) {
      throw new MigrationIdentityError(
        "identifier-bound-exceeded",
        "migration candidate generation id exceeds the identifier bound",
        `ordinal-${ordinal}`,
      );
    }
    const occupancy = await classifyMigrationCandidateOccupancy({
      generationId: candidate,
      homeDir: input.homeDir,
      manifestStore: store,
    });
    if (occupancy.status === "free") {
      return { generationId: candidate, probedOrdinals: ordinal + 1 };
    }
    if (occupancy.status === "refuse") {
      throw new MigrationIdentityError(
        "occupancy-refused",
        "migration candidate generation could not be classified",
        occupancy.evidence,
      );
    }
  }
  throw new MigrationIdentityError(
    "probe-bound-exceeded",
    "migration generation probe ordinal bound was exceeded before a free candidate was found",
    `max-${maxProbeOrdinal}`,
  );
}

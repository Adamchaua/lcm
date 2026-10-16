import { tmpdir } from "node:os";
import { canonicalSha256, PORTABLE_RECORD_DOMAIN_ORDER, PORTABLE_RECORD_SCHEMA_SHA256 } from "../storage/portable-record.js";
import { createPortableRecordStream } from "../storage/portable-record-stream.js";
import type { StorageIdentityContext } from "../storage/contracts.js";
import type { PostgreSqlConnectionSettings, PostgreSqlQueryExecutor } from "../storage/postgresql/contracts.js";
import { createPostgreSqlPortableSource, readPostgreSqlPortableSourceDomainCensus } from "../storage/postgresql/portable-source.js";
import { PostgreSqlRuntime } from "../storage/postgresql/runtime.js";
import { verifyPostgreSqlRuntimeSchema } from "../storage/postgresql/runtime-readiness.js";
import type { PostgreSqlSnapshotSession } from "../storage/postgresql/snapshot-session.js";
import {
  acquireActivationLease,
  assertActivationLeaseFence,
  releaseActivationLease,
  renewActivationLease,
  resolveActivationLeaseFence,
  takeoverActivationLease,
  type ActivationLeaseFence,
  type ActivationLeasePublicationGuard,
} from "./activation-lease.js";
import { checkActivationWriterQuiescence } from "./activation-quiescence.js";
import {
  createMigrationActivationWitness,
  createMigrationQuiescenceFence,
  migrationCanonicalDeltaChanged,
  migrationWitnessSha256,
  type MigrationSelectionAuthority,
} from "./activation-witness.js";
import { deriveRollbackPublicationId } from "./rollback.js";
import type {
  ComputeRollbackTerminalEvidenceInput,
  OpenRollbackFencedSession,
  RollbackExportSource,
  RollbackFencedSession,
} from "./rollback.js";
import type { RollbackEligibilityObservation } from "./rollback-eligibility.js";
import {
  assertPermanentReadOnlyGuard,
  buildMigrationCanonicalDelta,
  buildMigrationCensusVector,
  captureDestinationIdentity,
  captureDestinationSchemaWitness,
  readFencedDestinationCensus,
} from "./verify-generation.js";

/**
 * The production fenced PostgreSQL session of a rollback (Boundary F,
 * plan-v3 section 4), composed from the modules main already has: the
 * publication lease (activation-lease.ts), writer quiescence
 * (activation-quiescence.ts), the verification driver's destination
 * captures and fenced census, and the PostgreSQL portable source. Nothing
 * here derives a new digest.
 *
 * Fence. One lease on the covered project's backend-publication row, with
 * exactly the identity the coordinator will adopt for the rollback
 * publication (plan-v3.1 amendment A7, seam section 19): the project's
 * remote id, this machine's id, the rollback publicationId, target backend
 * "sqlite", and rollback-project evidence derived by
 * {@link deriveRollbackProjectEvidenceSha256}. renew() renews and then
 * asserts the same identity; anything but a satisfied assertion throws. An
 * expired lease refuses: there is no silent token rotation under an open
 * snapshot.
 *
 * Admission. Rollback runs after activation, under the runtime role the
 * activated configuration names, so the schema is admitted with the runtime
 * privilege profile (not the transfer profile the copy and verification
 * drivers use).
 *
 * Snapshots. Every readback opens its own read-only snapshot, so steps 4
 * and 10 never share one. Each captures the destination identity and the
 * schema witness (which refuses a destination outside the pinned schema
 * contract), then reads the census ONCE and derives both the canonical delta
 * and the census vector from that one result (amendment A11). The export
 * source reads inside its own snapshot and reports the same two values
 * for that snapshot, so step 10 can compare them (amendment A6).
 *
 * Release. Before the coordinator has acquired the lease the session
 * releases it, first taking over its own expired lease (seam section 19).
 * After the coordinator has acquired it the session never releases and
 * only verifies the row is present and released
 * ({@link RollbackProductionSession.markCoordinatorAcquired}). Failures
 * surface; the runtime is closed either way.
 */

/** How long one acquisition or renewal keeps the lease. Fixed, not caller-supplied. */
export const ROLLBACK_LEASE_TTL_MS = 15 * 60 * 1000;

export type RollbackSessionErrorReason =
  | "lease-unavailable"
  | "lease-lost"
  | "quiescence-unsatisfied"
  | "release-failed";

export class RollbackSessionError extends Error {
  constructor(readonly reason: RollbackSessionErrorReason, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RollbackSessionError";
  }
}

/** The covered project and the PostgreSQL target a rollback runs against. */
export type RollbackSessionTarget = Readonly<{
  settings: PostgreSqlConnectionSettings;
  expectedOwner: string;
  /** id and remoteProjectId are the PostgreSQL project id; selectedPath is the project's canonical path. */
  expectedIdentity: StorageIdentityContext;
  localProjectId: string;
  remoteProjectId: string;
  machineId: string;
}>;

/**
 * The rollback project evidence both this session's lease and the
 * coordinator's compose step (S4) must carry, so the coordinator adopts the
 * session's lease instead of conflicting with it. One derivation.
 */
export function deriveRollbackProjectEvidenceSha256(input: Readonly<{
  generationId: string;
  publicationId: string;
  localProjectId: string;
  remoteProjectId: string;
}>): string {
  return canonicalSha256({
    version: 1,
    kind: "rollback-project-evidence",
    generationId: input.generationId,
    publicationId: input.publicationId,
    localProjectId: input.localProjectId,
    remoteProjectId: input.remoteProjectId,
  });
}

export interface RollbackSessionRuntime extends PostgreSqlQueryExecutor {
  backendPublicationGuard(): ActivationLeasePublicationGuard;
  openReadOnlySnapshot(options: { projectId: string; signal?: AbortSignal }): Promise<PostgreSqlSnapshotSession>;
  close(): Promise<void>;
}

export interface RollbackSessionDependencies {
  createRuntime(settings: PostgreSqlConnectionSettings): RollbackSessionRuntime;
  verifyRuntimeSchema: typeof verifyPostgreSqlRuntimeSchema;
  assertReadOnlyGuard: typeof assertPermanentReadOnlyGuard;
  captureDestinationIdentity: typeof captureDestinationIdentity;
  captureDestinationSchemaWitness: typeof captureDestinationSchemaWitness;
  readFencedDestinationCensus: typeof readFencedDestinationCensus;
  createPortableSource: typeof createPostgreSqlPortableSource;
  readDomainCensus: typeof readPostgreSqlPortableSourceDomainCensus;
  createStream: typeof createPortableRecordStream;
  checkQuiescence: typeof checkActivationWriterQuiescence;
}

export const DEFAULT_ROLLBACK_SESSION_DEPENDENCIES: RollbackSessionDependencies = {
  createRuntime: (settings) => new PostgreSqlRuntime(settings),
  verifyRuntimeSchema: verifyPostgreSqlRuntimeSchema,
  assertReadOnlyGuard: assertPermanentReadOnlyGuard,
  captureDestinationIdentity,
  captureDestinationSchemaWitness,
  readFencedDestinationCensus,
  createPortableSource: createPostgreSqlPortableSource,
  readDomainCensus: readPostgreSqlPortableSourceDomainCensus,
  createStream: createPortableRecordStream,
  checkQuiescence: checkActivationWriterQuiescence,
};

/** The session a rollback receives, plus the one hook the coordinator wiring (S4) needs. */
export interface RollbackProductionSession extends RollbackFencedSession {
  /**
   * Call once the coordinator has acquired the lease for the rollback
   * publication. From then on release() only verifies that the row is
   * present and released; it never releases it itself.
   */
  markCoordinatorAcquired(): void;
}

type LeaseTuple = Readonly<{
  projectId: string;
  machineId: string;
  publicationId: string;
  targetBackend: "sqlite";
  evidenceSha256: string;
}>;

async function acquireRollbackLease(
  guard: ActivationLeasePublicationGuard,
  tuple: LeaseTuple,
  signal: AbortSignal | undefined,
): Promise<ActivationLeaseFence> {
  const acquired = await acquireActivationLease(guard, { ...tuple, ttlMs: ROLLBACK_LEASE_TTL_MS, signal });
  if (acquired.status === "acquired") return acquired.fence;
  if (acquired.status !== "expired-needs-takeover") {
    throw new RollbackSessionError("lease-unavailable", acquired.detail);
  }
  // A crashed earlier attempt of this same rollback left its lease expired and unreleased: the
  // same generation may take it over, compare-and-swap on the token it read.
  const stored = await resolveActivationLeaseFence(guard, { ...tuple, signal });
  if (stored.kind !== "present") {
    throw new RollbackSessionError("lease-unavailable", "the expired lease could not be read back for takeover");
  }
  const took = await takeoverActivationLease(guard, {
    ...tuple, ttlMs: ROLLBACK_LEASE_TTL_MS, expectedFencingToken: stored.fence.fencingToken, signal,
  });
  if (took.status !== "took-over") throw new RollbackSessionError("lease-unavailable", took.detail);
  return took.fence;
}

class FencedRollbackSession implements RollbackProductionSession {
  readonly selectionAuthority: MigrationSelectionAuthority;
  /** Sealed once quiescence is observed, before the session is handed out. */
  quiescenceFenceEvidenceSha256 = "";
  private fence: ActivationLeaseFence;
  private coordinatorAcquired = false;
  private released = false;
  private readonly snapshots = new Set<PostgreSqlSnapshotSession>();

  constructor(
    private readonly runtime: RollbackSessionRuntime,
    private readonly guard: ActivationLeasePublicationGuard,
    private readonly tuple: LeaseTuple,
    fence: ActivationLeaseFence,
    private readonly target: RollbackSessionTarget,
    private readonly scratchParent: string,
    private readonly signal: AbortSignal | undefined,
    private readonly dependencies: RollbackSessionDependencies,
  ) {
    this.fence = fence;
    this.selectionAuthority = {
      version: 1,
      resourceType: "backend-publication",
      resourceKey: tuple.projectId,
      fencingToken: fence.fencingToken.toString(),
      ownerProcessId: "rollback-" + process.pid.toString(),
    };
  }

  markCoordinatorAcquired(): void {
    this.coordinatorAcquired = true;
  }

  async renew(): Promise<void> {
    const renewed = await renewActivationLease(this.guard, {
      ...this.tuple, fencingToken: this.fence.fencingToken, ttlMs: ROLLBACK_LEASE_TTL_MS, signal: this.signal,
    });
    if (renewed.status !== "renewed") throw new RollbackSessionError("lease-lost", renewed.detail);
    this.fence = renewed.fence;
    const asserted = await assertActivationLeaseFence(this.guard, { ...this.tuple, signal: this.signal });
    if (asserted.status !== "satisfied") throw new RollbackSessionError("lease-lost", asserted.detail);
  }

  private async admittedSnapshot(): Promise<PostgreSqlSnapshotSession> {
    const snapshot = await this.runtime.openReadOnlySnapshot({
      projectId: this.target.remoteProjectId, signal: this.signal,
    });
    this.snapshots.add(snapshot);
    try {
      await this.dependencies.assertReadOnlyGuard(snapshot, this.signal);
      await this.dependencies.verifyRuntimeSchema(snapshot, {
        expectedOwner: this.target.expectedOwner, signal: this.signal,
      });
    } catch (error) {
      await this.closeSnapshot(snapshot).catch(() => undefined);
      throw error;
    }
    return snapshot;
  }

  private async closeSnapshot(snapshot: PostgreSqlSnapshotSession): Promise<void> {
    this.snapshots.delete(snapshot);
    await snapshot.close();
  }

  async captureReadback(input: Parameters<RollbackFencedSession["captureReadback"]>[0]): Promise<RollbackEligibilityObservation> {
    const snapshot = await this.admittedSnapshot();
    try {
      const destinationIdentity = await this.dependencies.captureDestinationIdentity(
        snapshot, this.target.remoteProjectId, this.signal,
      );
      // Refuses a destination outside the pinned schema contract, whose census would not be comparable.
      await this.dependencies.captureDestinationSchemaWitness(snapshot, this.signal);
      const base = {
        observedPortableRecordSchemaSha256: PORTABLE_RECORD_SCHEMA_SHA256,
        destinationIdentity,
        manifestDestinationWitnessSha256: input.manifestDestinationWitnessSha256,
      };
      if (input.canonicalDeltaBaseline === null) {
        return { ...base, postEpochDelta: null, postEpochCensus: null };
      }
      // ONE census scan: the delta and the vector both come from this result.
      const read = await this.dependencies.readFencedDestinationCensus(snapshot, {
        settings: this.target.settings,
        expectedOwner: this.target.expectedOwner,
        expectedIdentity: this.target.expectedIdentity,
        scratchParent: this.scratchParent,
        signal: this.signal,
      });
      const postEpochDelta = buildMigrationCanonicalDelta(read.census);
      const deltaEqual = !migrationCanonicalDeltaChanged(postEpochDelta, input.canonicalDeltaBaseline);
      return {
        ...base,
        postEpochDelta,
        postEpochCensus: deltaEqual || input.requireCensus === true ? buildMigrationCensusVector(read.census) : null,
      };
    } finally {
      await this.closeSnapshot(snapshot);
    }
  }

  async openPortableSource(): Promise<RollbackExportSource> {
    // The snapshot stays open for the whole export; release() closes it. The borrowed-session source
    // never closes it itself.
    const snapshot = await this.admittedSnapshot();
    try {
      const source = await this.dependencies.createPortableSource({
        settings: this.target.settings,
        expectedOwner: this.target.expectedOwner,
        expectedIdentity: this.target.expectedIdentity,
        scratchParent: this.scratchParent,
        signal: this.signal,
        session: snapshot,
      });
      try {
        const census = PORTABLE_RECORD_DOMAIN_ORDER.map((domain) => this.dependencies.readDomainCensus(source, domain));
        return {
          stream: await this.dependencies.createStream(source),
          canonicalDelta: buildMigrationCanonicalDelta(census),
          censusVector: buildMigrationCensusVector(census),
        };
      } catch (error) {
        await source.close().catch(() => undefined);
        throw error;
      }
    } catch (error) {
      await this.closeSnapshot(snapshot).catch(() => undefined);
      throw error;
    }
  }

  computeRollbackTerminalEvidenceSha256(input: ComputeRollbackTerminalEvidenceInput): string {
    if (input.epoch === null || input.attempt === null) {
      // Never activated: there is no epoch, hence no witness to mint.
      return migrationWitnessSha256([
        "lcm-rollback-unactivated-terminal-evidence-v1", input.mode, input.observation.destinationIdentity,
      ]);
    }
    return createMigrationActivationWitness({
      kind: "rollback",
      epoch: input.epoch,
      attempt: input.attempt,
      postEpochDelta: input.observation.postEpochDelta!,
      postEpochCensus: input.observation.postEpochCensus,
      rollbackMode: input.mode,
    }).checksumSha256;
  }

  private async releaseLease(): Promise<void> {
    const request = { ...this.tuple, fencingToken: this.fence.fencingToken, signal: this.signal };
    const released = await releaseActivationLease(this.guard, request);
    if (released.status === "released" || released.status === "already-released") return;
    if (released.status !== "expired") throw new RollbackSessionError("release-failed", released.detail);
    // Expiry is not release: take over our own expired lease, then release the fresh fence.
    const took = await takeoverActivationLease(this.guard, {
      ...this.tuple, ttlMs: ROLLBACK_LEASE_TTL_MS, expectedFencingToken: released.fence.fencingToken, signal: this.signal,
    });
    if (took.status !== "took-over") throw new RollbackSessionError("release-failed", took.detail);
    const again = await releaseActivationLease(this.guard, { ...request, fencingToken: took.fence.fencingToken });
    if (again.status !== "released" && again.status !== "already-released") {
      throw new RollbackSessionError("release-failed", again.detail);
    }
  }

  private async verifyReleased(): Promise<void> {
    const stored = await resolveActivationLeaseFence(this.guard, { ...this.tuple, signal: this.signal });
    if (stored.kind !== "present" || stored.fence.releasedAt === null) {
      throw new RollbackSessionError(
        "release-failed",
        "the coordinator was expected to have released the rollback lease, but it is not recorded as released",
      );
    }
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    const failures: unknown[] = [];
    const attempt = async (step: () => Promise<void>): Promise<void> => {
      try { await step(); } catch (error) { failures.push(error); }
    };
    for (const snapshot of [...this.snapshots]) await attempt(() => this.closeSnapshot(snapshot));
    await attempt(() => (this.coordinatorAcquired ? this.verifyReleased() : this.releaseLease()));
    await attempt(() => this.runtime.close());
    if (failures.length > 0) throw failures[0];
  }
}

/**
 * Open the rollback's fenced session: lease, then quiescence under the
 * retained token. A failure after the lease was acquired releases it (best
 * effort; the original error is the one reported) and closes the runtime.
 */
export async function openRollbackFencedSession(
  input: Parameters<OpenRollbackFencedSession>[0],
  target: RollbackSessionTarget,
  dependencies: RollbackSessionDependencies = DEFAULT_ROLLBACK_SESSION_DEPENDENCIES,
): Promise<RollbackProductionSession> {
  const publicationId = deriveRollbackPublicationId(input.manifest.generationId);
  const tuple: LeaseTuple = {
    projectId: target.remoteProjectId,
    machineId: target.machineId,
    publicationId,
    targetBackend: "sqlite",
    evidenceSha256: deriveRollbackProjectEvidenceSha256({
      generationId: input.manifest.generationId,
      publicationId,
      localProjectId: target.localProjectId,
      remoteProjectId: target.remoteProjectId,
    }),
  };
  const runtime = dependencies.createRuntime(target.settings);
  let session: FencedRollbackSession | undefined;
  try {
    await dependencies.verifyRuntimeSchema(runtime, { expectedOwner: target.expectedOwner, signal: input.signal });
    const guard = runtime.backendPublicationGuard();
    const fence = await acquireRollbackLease(guard, tuple, input.signal);
    // From here the lease exists: a failure must release it through the same path release() uses.
    const opened = new FencedRollbackSession(
      runtime, guard, tuple, fence, target, input.scratchParent ?? tmpdir(), input.signal, dependencies,
    );
    session = opened;
    const quiescence = await dependencies.checkQuiescence({ homeDir: input.homeDir, lockToken: input.lockToken });
    if (quiescence.status !== "satisfied") {
      throw new RollbackSessionError("quiescence-unsatisfied", quiescence.detail);
    }
    const sealed = createMigrationQuiescenceFence({
      kind: quiescence.quiescenceFence!.kind, payload: quiescence.quiescenceFence!.payload,
    });
    opened.quiescenceFenceEvidenceSha256 = sealed.evidenceSha256;
    return opened;
  } catch (error) {
    if (session === undefined) await runtime.close().catch(() => undefined);
    else await session.release().catch(() => undefined);
    throw error;
  }
}


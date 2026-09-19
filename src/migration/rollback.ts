/**
 * Orchestration for item #626: rollback into a new SQLite generation.
 * Fencing, the journal and report lifecycle, publication, recovery and
 * abandonment, per plan-v2 section 5's twelve-step sequence (normative;
 * this file implements it and does not re-derive it) and
 * coordinator-seam-FROZEN.md v7.
 *
 * BOUNDARIES THIS FILE DOES NOT IMPLEMENT, read before extending.
 * Exactly like rollback-eligibility.ts's own boundary note, every one of
 * these is a required dependency-injected parameter with no default and
 * no production fallback anywhere in this file, so a caller that forgets
 * to wire one gets a type error, never silently-wrong behavior:
 *
 *  - Boundary A: {@link MigrationWitnessResolver} (resolveMigrationWitnessBindings),
 *    owned by #625 (coordinator-seam-FROZEN.md v6 sections 13-14).
 *  - Boundary B: {@link RollbackModeClassifier} (classifyRollbackMode),
 *    owned by #624 (witness-schema-FROZEN-v2.md section 9).
 *  - Boundary C: {@link OperabilityFactResolver}. UNLIKE A and B, #626 owns
 *    this reader's production implementation -- see
 *    {@link readBackendPublicationOperabilityFact} below, which is real,
 *    not injected as an unimplemented boundary. It is still passed
 *    through the same injection seam rollback-eligibility.ts expects,
 *    because that module's resolveActivationAuthority takes an
 *    already-resolved value (its own no-I/O invariant), never performs
 *    the read itself.
 *  - Boundary D: {@link MigrationSelectionBindingRecorder}
 *    (recordMigrationSelectionBinding), owned by #625
 *    (coordinator-seam-FROZEN.md v7 section 17, added specifically
 *    because this item's implementer found the write side of the
 *    selection-binding store undefined and asked rather than inventing a
 *    durable format -- see section 17's own account of that exchange).
 *  - Boundary E: {@link RollbackAuthoritativeContextResolver}, fetching
 *    the MigrationActivationEpochShape/MigrationActivationAttemptShape
 *    pair named by an authoritative selection's epochId/attemptId.
 *    rollback-eligibility.ts's own doc comment on
 *    RollbackAuthoritativeContext states explicitly that "fetching
 *    these by epochId/attemptId from whatever artifact store #624/#625
 *    end up providing is the caller's job (rollback.ts)" -- this is that
 *    job, modeled as an injected boundary for the same reason A/B/D are:
 *    the artifact store's shape is owned by #624/#625's witness-schema
 *    module, which does not exist on this branch.
 *  - Boundary F: {@link OpenRollbackFencedSession}. Everything that
 *    requires (a) a live PostgreSQL connection under the durable
 *    lcm.fenced_leases fence (coordinator-seam-FROZEN.md section 5) and
 *    (b) #624's witness-schema canonicalization of a live snapshot into
 *    MigrationDestinationIdentityShape / MigrationCanonicalDeltaShape /
 *    MigrationCensusVectorShape / MigrationSchemaWitnessShape. #626
 *    owns opening and fencing the PostgreSQL session for real (the
 *    lease-acquisition and repeatable-read machinery lives in
 *    src/storage/postgresql/publication-guard.ts and
 *    snapshot-session.ts), but the CANONICALIZATION of what it reads
 *    into the witness-schema shapes above is #624's algorithm, which does
 *    not exist in this branch (no activation-witness.ts anywhere on
 *    main or this branch). Building the PostgreSQL plumbing here and
 *    then hand-rolling a second, locally-invented canonicalization would
 *    be exactly the "production wrapper to bridge the gap" plan-v2
 *    section 7 forbids, one level further down than rollback-eligibility.ts's
 *    own three boundaries. This is flagged to the root coordinator per
 *    plan-v2 section 7's own instruction to ask rather than guess; see
 *    this item's status report for the exact question.
 *
 * WHAT THIS FILE DOES OWN AND IMPLEMENT FOR REAL: the local fencing
 * sequence (enterMaintenance retention across the whole window), the
 * migration-protocol effect lifecycle (begin/complete/abandon via
 * MigrationManifestStore), calling rollback-generation.ts /
 * rollback-install.ts / rollback-sidecars.ts in the order plan-v2 section
 * 5 mandates, the maintenance-selection-to-report-persistence sequence,
 * crash recovery classification (step 1), and every deterministic-identity
 * derivation this item mints (inputSha256, publicationId, report
 * reportId), per section 8's convergence rule.
 */

import { join, resolve } from "node:path";
import {
  atomicWritePrivateFileDurable,
  ensurePrivateDirectory,
  readBoundedRegularFileWithStat,
} from "../security-files.js";
import { canonicalJson, canonicalSha256, sha256 } from "../storage/portable-record.js";
import type { PortableRecordStream } from "../storage/portable-record-stream.js";
import {
  BackendPublicationJournalError,
  backendPublicationCanonicalSha256,
  captureBackendPublicationState,
  readBackendMaintenanceJournal,
  readBackendPublicationJournal,
  withBackendPublicationConsumerLockAsync,
  type BackendPublicationLockToken,
} from "../storage/backend-publication.js";
import {
  MigrationProtocolError,
  type MigrationManifest,
} from "./protocol.js";
import {
  type MigrationSelectionBinding,
  type OperabilityFactResolution,
  type RollbackAuthoritativeContext,
  type RollbackEligibilityObservation,
} from "./rollback-eligibility.js";

const MAX_REPORT_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------
// Boundary C. #626 owns this production implementation. See
// coordinator-seam-FROZEN.md v6 section 16: read the live
// BackendPublicationJournal (never delegate to
// assertBackendPublicationConsumerAccess or
// PostgreSqlStorageBackendFactory.capturePublicationWitness, both of which
// throw identically for "wrong backend" and "the read itself failed"),
// three-valued, and MUST be called during eligibility, strictly before
// this item's own enterMaintenance -- not merely before the coordinator's
// prepare() call. enterMaintenance archives the terminal journal out of
// the live slot exactly like prepare() does (both call
// archiveTerminalJournal on an existing terminal journal), so calling this
// reader after step 2 would observe an emptied slot on every single
// rollback attempt and never report "present", which is why
// runMigrationRollback below calls it before step 2, not between steps 2
// and 11 where section 16's prose alone might suggest.
// ---------------------------------------------------------------------------

function describeUnresolvable(error: unknown): string {
  if (error instanceof BackendPublicationJournalError) {
    return `${error.reason}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

export async function readBackendPublicationOperabilityFact(
  input: Readonly<{ homeDir?: string; lockToken?: BackendPublicationLockToken }>,
): Promise<OperabilityFactResolution> {
  try {
    return await withBackendPublicationConsumerLockAsync(
      input.homeDir,
      async () => {
        // The maintenance and publication journals share one live file
        // slot (coordinator-seam-FROZEN.md section 3). Any maintenance
        // journal here -- terminal or not -- means the slot does not hold
        // a publication journal at all right now, so the operability fact
        // cannot be read positively. That is a failed read, not a
        // successful one finding nothing: "authoritatively-absent" would
        // wrongly license a pre-write reversal if the destination was in
        // fact operable before maintenance began and archived it out of
        // view.
        const maintenance = readBackendMaintenanceJournal(input.homeDir);
        if (maintenance !== null) {
          return {
            state: "unresolvable" as const,
            reason: "backend maintenance holds the live publication slot; no publication journal is readable",
          };
        }
        let journal;
        try {
          journal = readBackendPublicationJournal(input.homeDir);
        } catch (error) {
          return { state: "unresolvable" as const, reason: describeUnresolvable(error) };
        }
        if (journal === null || journal.phase !== "completed" || journal.targetBackend !== "postgresql") {
          return { state: "authoritatively-absent" as const };
        }
        let stateSha256: string;
        try {
          stateSha256 = backendPublicationCanonicalSha256(captureBackendPublicationState(input.homeDir));
        } catch (error) {
          return { state: "unresolvable" as const, reason: describeUnresolvable(error) };
        }
        // Exactly the four-field shape PostgreSqlStorageBackendFactory's
        // capturePublicationWitness computes and its caller
        // backendPublicationCanonicalSha256-compares
        // (factory.ts:518-540, :466, :489-495), so both consumers of this
        // fact compare identical bytes, per section 16.
        const valueSha256 = backendPublicationCanonicalSha256({
          journalChecksum: journal.checksumSha256,
          journalPhase: journal.phase,
          targetBackend: journal.targetBackend,
          stateSha256,
        });
        return { state: "present" as const, valueSha256 };
      },
      { allowUnresolved: true, lockToken: input.lockToken },
    );
  } catch (error) {
    return { state: "unresolvable", reason: describeUnresolvable(error) };
  }
}

// ---------------------------------------------------------------------------
// Deterministic identity derivations. Section 8's rule applies to every
// one of these: no attempt-time observation (clock, fencing token, owner
// process id, census/delta digest, watermark) may participate, because
// each of these values must converge across a crash-then-retry rather
// than rotate and cause a permanent refusal.
// ---------------------------------------------------------------------------

/**
 * The maintenance journal's publicationId, and by extension the
 * publicationId field #626 later writes into its own
 * {@link MigrationSelectionBinding} (coordinator-seam-FROZEN.md v7 section
 * 17: "it is the value #626 supplies at enterMaintenance and reads back
 * from the maintenance journal... derive it without any attempt-time
 * observation"). A pure function of the generation id alone: stable
 * across every retry of a rollback on this generation, so
 * enterMaintenance's own recovery-resume comparison
 * (maintenance.publicationId !== input.publicationId) never spuriously
 * refuses a retry, and the later selection-binding write is idempotent
 * because this value never rotates.
 */
export function deriveRollbackPublicationId(generationId: string): string {
  return sha256(canonicalJson(["rollback-publication-v1", generationId]));
}

/**
 * plan-v2 section 5 step 7's inputSha256 for prepare-rollback: epoch
 * identity, manifest revision and checksum, generation, and the fenced
 * lease's resource coordinates (constant, never attempt-time). Excludes
 * the fencing token, owner process id, census and delta digests,
 * watermarks and clocks: prepare-rollback is retry-idempotent
 * (protocol.ts's legalEffect) and can never be abandoned, so any rotating
 * input here would make a resume refuse a retry permanently -- exactly
 * the failure plan-v1's inputSha256 produced (plan-v2 section 0) and
 * section 8 forbids generally.
 */
export function deriveRollbackPrepareInputSha256(input: Readonly<{
  generationId: string;
  manifestRevision: number;
  manifestChecksumSha256: string;
  epochId: string | null;
  resourceType: string;
  resourceKey: string;
}>): string {
  return canonicalSha256([
    "rollback-prepare-input-v1",
    input.generationId,
    input.manifestRevision,
    input.manifestChecksumSha256,
    input.epochId,
    input.resourceType,
    input.resourceKey,
  ]);
}

/**
 * The rollback report's reportId. Excludes attempt-time values on the
 * same grounds as {@link deriveRollbackPrepareInputSha256}: a crash after
 * the report file is durably written but before completeMigrationEffect
 * observes it must regenerate byte-identical content on retry, or the
 * idempotent report write in {@link writeRollbackReport} becomes a
 * permanent refusal. Distinct kind values ("rollback" vs "abandonment")
 * are included so the two reports for one publish-rollback attempt
 * (an authoritative rollback report and, on a later abandonment, an
 * abandonment report) never collide.
 */
export function deriveRollbackReportId(input: Readonly<{
  generationId: string;
  effectId: string;
  kind: "rollback" | "abandonment";
}>): string {
  return sha256(canonicalJson(["rollback-report-v1", input.generationId, input.effectId, input.kind]));
}

// ---------------------------------------------------------------------------
// Boundary D. coordinator-seam-FROZEN.md v7 section 17. Owned by #625,
// consumed here injected, no production fallback -- #626 persists nothing
// itself, per section 17's explicit "two independent writers" prohibition.
// Synchronous, per section 17: an async writer inside the retained fenced
// window invites the suspend-across-await hazard the lock seam itself was
// just fixed to avoid.
// ---------------------------------------------------------------------------

export type MigrationSelectionBindingRecorder = (
  input: Readonly<{ homeDir: string; generationId: string; binding: MigrationSelectionBinding }>,
) => void;

// ---------------------------------------------------------------------------
// Boundary E. Fetches the epoch/attempt pair an authoritative selection
// names. See this file's module doc comment.
// ---------------------------------------------------------------------------

export type RollbackAuthoritativeContextResolver = (
  input: Readonly<{ homeDir: string; epochId: string; attemptId: string }>,
) => Promise<RollbackAuthoritativeContext | null>;

// ---------------------------------------------------------------------------
// Boundary F. See this file's module doc comment for why this is one
// injected capability rather than PostgreSQL plumbing #626 builds here.
// ---------------------------------------------------------------------------

/** One fenced PostgreSQL session, retained across steps 3 through 10. */
export interface RollbackFencedSession {
  /** witness-schema-FROZEN-v2.md section 2 shape, minted at lease acquisition (step 3). */
  readonly selectionAuthority: Readonly<{
    version: 1;
    resourceType: string;
    resourceKey: string;
    fencingToken: string;
    ownerProcessId: string;
  }>;
  readonly quiescenceFenceEvidenceSha256: string;
  /** Re-asserts the same fencingToken before a durable step, per contract section 5. */
  renew(): Promise<void>;
  /**
   * One dedicated-snapshot readback (plan-v2 section 5 steps 4 and 10).
   * canonicalDeltaBaseline: null is the unactivated case: only
   * destinationIdentity is meaningful and no delta/census is captured.
   * Otherwise the implementation captures the delta and, only if it is
   * found equal to the baseline within this same snapshot, the census --
   * plan-v2 section 4's "the census when the delta is equal", read from
   * the identical transaction rather than a second one.
   */
  captureReadback(input: Readonly<{
    manifestDestinationWitnessSha256: string;
    canonicalDeltaBaseline: Readonly<{ version: 1; domains: readonly unknown[] }> | null;
  }>): Promise<RollbackEligibilityObservation>;
  /** Opens the source #626 exports from for post-write generation build. */
  openPortableSource(): Promise<PortableRecordStream>;
  release(): Promise<void>;
}

export type OpenRollbackFencedSession = (
  input: Readonly<{ homeDir: string; manifest: MigrationManifest }>,
) => Promise<RollbackFencedSession>;

// ---------------------------------------------------------------------------
// Report persistence. #624's D1 convention (plan-v1 section 4, carried
// into plan-v2 section 5's closing paragraph): immutable 0400 private
// JSON at <homeDir>/.lcm/migration-reports/<generationId>/<reportId>.json,
// canonical ASCII with a trailing checksumSha256, createdAt kept OUT of
// the hashed body (it lives only in the MigrationReportReference the
// manifest carries), so a crash-then-retry regenerates byte-identical
// content and the write below is genuinely idempotent rather than merely
// retried.
// ---------------------------------------------------------------------------

export type RollbackReportBody = Readonly<{
  version: 1;
  reportId: string;
  generationId: string;
  effectId: string;
  kind: "rollback" | "abandonment";
  /** Recorded separately from the protocol mode, per plan-v2 section 5's
   * closing paragraph: "unactivated and proven pre-write are never
   * conflated by a later reader." */
  eligibility: "unactivated" | "pre-write" | "post-write" | null;
  mode: "pre-write" | "post-write" | null;
  epochId: string | null;
  attemptId: string | null;
  /** backend-publication.ts:3765-3780's sealed material digest, binding
   * which publication material this report's rollback prepared -- so a
   * later abandonment can prove exactly what was prepared. Null for an
   * abandonment report itself (there is no sealed material once
   * abandoned). */
  sealedPublicationMaterialDigestSha256: string | null;
  /** Present only for kind "abandonment". */
  reason: string | null;
  checksumSha256: string;
}>;

function reportPath(homeDir: string, generationId: string, reportId: string): string {
  return join(resolve(homeDir), ".lcm", "migration-reports", generationId, reportId + ".json");
}

function reportChecksum(body: Omit<RollbackReportBody, "checksumSha256">): string {
  return sha256(canonicalJson(body as unknown as Record<string, unknown>));
}

/**
 * Writes the report, idempotently: a retry after a crash between the
 * write and completeMigrationEffect observing it regenerates
 * byte-identical content (every field here is deterministic, per this
 * file's derivation functions above) and this function treats an
 * existing file with matching bytes as success rather than an error. A
 * mismatch -- which can only mean two DIFFERENT reports collided on one
 * reportId, a derivation bug -- throws rather than silently overwriting
 * immutable evidence.
 */
export function writeRollbackReport(
  homeDir: string,
  body: Omit<RollbackReportBody, "checksumSha256">,
): RollbackReportBody {
  const report: RollbackReportBody = { ...body, checksumSha256: reportChecksum(body) };
  const path = reportPath(homeDir, body.generationId, body.reportId);
  ensurePrivateDirectory(join(resolve(homeDir), ".lcm", "migration-reports", body.generationId));
  try {
    atomicWritePrivateFileDurable(path, canonicalJson(report), {
      finalMode: 0o400,
      requireAbsent: true,
      maxExistingBytes: MAX_REPORT_BYTES,
    });
    return report;
  } catch (error) {
    const existing = readRollbackReport(homeDir, body.generationId, body.reportId);
    if (existing !== null && existing.checksumSha256 === report.checksumSha256) return existing;
    throw error;
  }
}

export function readRollbackReport(
  homeDir: string,
  generationId: string,
  reportId: string,
): RollbackReportBody | null {
  const path = reportPath(homeDir, generationId, reportId);
  let content: string;
  try {
    content = Buffer.from(
      readBoundedRegularFileWithStat(path, {
        allowedRoot: join(resolve(homeDir), ".lcm", "migration-reports", generationId),
        maxBytes: MAX_REPORT_BYTES,
        allowedModes: [0o400],
        requireSingleLink: true,
      }).content,
    ).toString("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const parsed = JSON.parse(content) as RollbackReportBody;
  const { checksumSha256, ...rest } = parsed;
  if (reportChecksum(rest) !== checksumSha256) {
    throw new MigrationProtocolError("checksum-mismatch", "rollback report checksum does not match");
  }
  return parsed;
}

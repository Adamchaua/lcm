/**
 * Orchestration for item #626: rollback into a new SQLite generation.
 * Fencing, the journal and report lifecycle, publication, recovery and
 * abandonment, per plan-v2 section 5's twelve-step sequence (normative;
 * this file implements it and does not re-derive it) and
 * coordinator-seam-FROZEN.md v7.
 *
 * WHAT IS INJECTED, AND WHAT IT DEFAULTS TO. Every dependency below that has
 * a production implementation on this branch defaults to it, so a caller
 * (and a test) that supplies nothing exercises the real stores; each stays
 * overridable as a seam for failure injection:
 *
 *  - Boundary A: {@link MigrationWitnessResolver}, defaulting to
 *    generation-binding-store.ts's resolveMigrationWitnessBindings.
 *  - Activation evidence: {@link ActivationEvidenceResolver}, defaulting to
 *    activation-evidence-store.ts's readMigrationActivationEvidence. With A
 *    and Boundary C it feeds resolveActivationAuthority's three-observation
 *    truth table (plan-v3.1 amendment A1).
 *  - Boundary B has no seam: classifyMigrationRollbackMode is pure, and
 *    rollback-eligibility.ts adapts it directly.
 *  - Boundary C: {@link readBackendPublicationOperabilityFact}, below.
 *  - Boundaries D and D2: {@link MigrationSelectionBindingRecorder} and
 *    {@link MigrationWitnessBindingRecorder}, defaulting to
 *    recordMigrationSelectionBinding and recordMigrationWitnessBinding.
 *  - Boundary E: {@link RollbackAuthoritativeContextResolver}, defaulting
 *    to resolveRollbackAuthoritativeContext, which returns the full parsed
 *    epoch and attempt (and the selected witness) of the selection.
 *
 * STILL REQUIRED, NO DEFAULT:
 *
 *  - Boundary F: {@link OpenRollbackFencedSession}. The fenced PostgreSQL
 *    session (lease, quiescence, dedicated snapshot readback) is composed
 *    by a later slice of #626; until then a caller supplies it.
 *  - The BackendPublicationCoordinator. No production driver exists on this
 *    branch (see the KNOWN GAP note above runMigrationRollback).
 *
 * * WHAT THIS FILE DOES OWN AND IMPLEMENT FOR REAL: the local fencing
 * sequence (enterMaintenance retention across the whole window), the
 * migration-protocol effect lifecycle (begin/complete/abandon via
 * MigrationManifestStore), calling rollback-generation.ts /
 * rollback-install.ts / rollback-sidecars.ts in the order plan-v2 section
 * 5 mandates, the maintenance-selection-to-report-persistence sequence,
 * crash recovery classification (step 1), and every deterministic-identity
 * derivation this item mints (inputSha256, publicationId, report
 * reportId), per section 8's convergence rule.
 */

import { opendirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  atomicWritePrivateFileDurable,
  ensurePrivateDirectory,
  openPrivateDirectoryIfExists,
  readBoundedRegularFileWithStat,
} from "../security-files.js";
import { canonicalJson, canonicalSha256, sha256 } from "../storage/portable-record.js";
import type { PortableRecordStream } from "../storage/portable-record-stream.js";
import type { PortableProjectIdentity } from "../storage/portable-record-stream.js";
import {
  BackendPublicationJournalError,
  backendPublicationCanonicalSha256,
  captureBackendPublicationState,
  readBackendMaintenanceJournal,
  readBackendPublicationJournal,
  withBackendPublicationConsumerLockAsync,
  withBackendPublicationAppendBarrierAsync,
  BackendPublicationCoordinator,
  type BackendPublicationLockToken,
  type BackendMaintenanceRosterEntry,
  type BackendMaintenanceJournal,
} from "../storage/backend-publication.js";
import {
  MigrationProtocolError,
  abandonMigrationEffect,
  beginMigrationEffect,
  classifyMigrationRecovery,
  completeMigrationEffect,
  type MigrationManifest,
  type MigrationReportReference,
} from "./protocol.js";
import { MigrationManifestStore } from "./manifest-store.js";
import type { MigrationCanonicalDelta, MigrationSelectionAuthority } from "./activation-witness.js";
import {
  readMigrationActivationEvidence,
  resolveRollbackAuthoritativeContext,
} from "./activation-evidence-store.js";
import {
  recordMigrationSelectionBinding,
  recordMigrationWitnessBinding,
  resolveMigrationWitnessBindings,
} from "./generation-binding-store.js";
import {
  evaluateRollbackEligibility,
  resolveActivationAuthority,
  type ActivationAuthority,
  type MigrationSelectionBinding,
  type MigrationWitnessBinding,
  type ActivationEvidenceResolver,
  type MigrationWitnessResolver,
  type OperabilityFactResolution,
  type RollbackAuthoritativeContext,
  type RollbackEligibilityDecision,
  type RollbackEligibilityObservation,
} from "./rollback-eligibility.js";
import { buildRollbackGeneration, type RollbackGenerationOutcome } from "./rollback-generation.js";
import { installRollbackGeneration } from "./rollback-install.js";
import { materializeRollbackSidecars } from "./rollback-sidecars.js";

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

/**
 * donadiosolutions/lcm#1432. The exact, distinguishable reason
 * readBackendPublicationOperabilityFact reports when a maintenance
 * journal (terminal or not) holds the live slot -- the ONE unresolvable
 * cause that is expected and recoverable from the durable rollback-
 * authority artifact (see resolveRollbackOperabilityFact below). Named
 * here, as a single source of truth, so the two sites (the producer
 * below and the recovery fallback) cannot silently drift apart.
 */
const MAINTENANCE_HOLDS_LIVE_SLOT_REASON =
  "backend maintenance holds the live publication slot; no publication journal is readable";

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
            reason: MAINTENANCE_HOLDS_LIVE_SLOT_REASON,
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
// The durable rollback-authority artifact. donadiosolutions/lcm#1432.
//
// NOT a MigrationReportReference-bound report, deliberately: a report
// inherits the protocol's createdAt-within-[pending.startedAt,completedAt]
// bound (protocol.ts:748-751), which only exists once an effect is
// pending. This artifact must be written BEFORE enterMaintenance (step
// 2) -- before prepare-rollback (step 7) ever begins -- so it can never
// be bound to one. Binding it to prepare-rollback would only have
// closed the window between step 7 and step 8, trading a large hole (any
// crash from step 2 onward) for a smaller one (a crash between step 2
// and step 7, where maintenance is held, no artifact yet exists, and the
// not-yet-completed prepare-rollback effect cannot be abandoned once
// begun) -- that trade is what this design corrects.
//
// Immutable, 0400, private, canonical ASCII with a trailing
// checksumSha256 -- the same D1 discipline every other artifact this
// file writes uses. Deterministic identity keyed on generationId ALONE:
// no clock, fencing token, owner pid, census or delta digest, per
// contract section 8, so a retry rewrites byte-identical content and the
// write is idempotent for free. generationId alone is a sufficient key
// because exactly one artifact is ever legitimate per generationId
// across its entire lifetime: it is written once, before the ONE
// prepare-rollback effect protocol.ts's legalEffect table permits for a
// generationId ever exists (phase "rolling-back" is reachable from
// "verified"/"active" through prepare-rollback only, and "rolled-back",
// the only phase reachable from "rolling-back", is terminal with no
// outbound transition), and every retry before that effect completes is
// retrying that SAME resolution, never a different one.
// ---------------------------------------------------------------------------

const MAX_ROLLBACK_AUTHORITY_ARTIFACT_BYTES = 4 * 1024;

export type RollbackAuthorityArtifactBody = Readonly<{
  version: 1;
  generationId: string;
  /**
   * The OperabilityFactResolution this generation's rollback resolved at
   * step 1, before enterMaintenance archived it out of the live slot.
   * Never "unresolvable": an unresolvable operability fact refuses
   * before this artifact is ever written (resolveActivationAuthority's
   * row 4), so nothing reaches the write with that state.
   */
  operabilityFactState: "present" | "authoritatively-absent";
  /** Present only when operabilityFactState is "present". */
  operabilityFactValueSha256: string | null;
  authorityStatus: "unactivated" | "authoritative";
  /** Present only when authorityStatus is "authoritative". */
  epochId: string | null;
  attemptId: string | null;
  checksumSha256: string;
}>;

/**
 * donadiosolutions/lcm#1432. Deliberately DIFFERENT in shape from
 * {@link deriveRollbackReportId} above: this derives from generationId
 * ALONE, matching the artifact's own "exactly one, ever" identity rule
 * stated in this section's header comment.
 */
export function deriveRollbackAuthorityArtifactId(generationId: string): string {
  return sha256(canonicalJson(["rollback-authority-artifact-v1", generationId]));
}

function rollbackAuthorityArtifactDirectory(homeDir: string): string {
  return join(resolve(homeDir), ".lcm", "migration-rollback-authority");
}

function rollbackAuthorityArtifactPath(homeDir: string, generationId: string): string {
  return join(rollbackAuthorityArtifactDirectory(homeDir), deriveRollbackAuthorityArtifactId(generationId) + ".json");
}

function rollbackAuthorityArtifactChecksum(body: Omit<RollbackAuthorityArtifactBody, "checksumSha256">): string {
  return sha256(canonicalJson(body as unknown as Record<string, unknown>));
}

/**
 * Writes the artifact, idempotently: a retry regenerates byte-identical
 * content (every field is deterministic given the SAME resolved fact and
 * authority) and this function treats an existing file with matching
 * bytes as success. A mismatch -- two DIFFERENT resolutions colliding on
 * one generationId, which can only mean the live fact or authority
 * genuinely changed between writes -- throws rather than silently
 * overwriting immutable evidence.
 */
export function writeRollbackAuthorityArtifact(
  homeDir: string,
  body: Omit<RollbackAuthorityArtifactBody, "checksumSha256">,
): RollbackAuthorityArtifactBody {
  const artifact: RollbackAuthorityArtifactBody = { ...body, checksumSha256: rollbackAuthorityArtifactChecksum(body) };
  const path = rollbackAuthorityArtifactPath(homeDir, body.generationId);
  ensurePrivateDirectory(rollbackAuthorityArtifactDirectory(homeDir));
  try {
    atomicWritePrivateFileDurable(path, canonicalJson(artifact), {
      finalMode: 0o400,
      requireAbsent: true,
      maxExistingBytes: MAX_ROLLBACK_AUTHORITY_ARTIFACT_BYTES,
    });
    return artifact;
  } catch (error) {
    const existing = readRollbackAuthorityArtifact(homeDir, body.generationId);
    if (existing !== null && existing.checksumSha256 === artifact.checksumSha256) return existing;
    throw error;
  }
}

export function readRollbackAuthorityArtifact(
  homeDir: string,
  generationId: string,
): RollbackAuthorityArtifactBody | null {
  const path = rollbackAuthorityArtifactPath(homeDir, generationId);
  let content: string;
  try {
    content = Buffer.from(
      readBoundedRegularFileWithStat(path, {
        allowedRoot: rollbackAuthorityArtifactDirectory(homeDir),
        maxBytes: MAX_ROLLBACK_AUTHORITY_ARTIFACT_BYTES,
        allowedModes: [0o400],
        requireSingleLink: true,
      }).content,
    ).toString("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const parsed = JSON.parse(content) as RollbackAuthorityArtifactBody;
  const { checksumSha256, ...rest } = parsed;
  if (rollbackAuthorityArtifactChecksum(rest) !== checksumSha256) {
    throw new MigrationProtocolError("checksum-mismatch", "rollback authority artifact checksum does not match");
  }
  return parsed;
}

function sameOperabilityFactValue(
  live: Readonly<{ state: "present" | "authoritatively-absent"; valueSha256?: string }>,
  artifact: RollbackAuthorityArtifactBody,
): boolean {
  if (live.state !== artifact.operabilityFactState) return false;
  if (live.state === "present") return live.valueSha256 === artifact.operabilityFactValueSha256;
  return true;
}

/**
 * donadiosolutions/lcm#1432. The single reader every rollback code path
 * uses to resolve the operability fact, so the fallback-and-cross-check
 * rule is implemented exactly once rather than once per call site:
 *
 * 1. A resolvable live read (present/authoritatively-absent) is used,
 *    and cross-checked against the durable artifact when one already
 *    exists -- disagreement refuses rather than preferring either side,
 *    per section 15's "compared as a value, never inferred from
 *    ordering or timing" discipline.
 * 2. An unresolvable live read falls back to the durable artifact ONLY
 *    when the reason is EXACTLY MAINTENANCE_HOLDS_LIVE_SLOT_REASON --
 *    the expected, structural cause once this rollback's own
 *    enterMaintenance has run -- never any other unresolvable cause
 *    (lock contention, malformed journal, ...), which stays a refusal.
 * 3. No artifact and an unresolvable live read for that expected reason
 *    refuses: structurally this should not happen for THIS generation's
 *    own maintenance (the artifact is always written before its
 *    enterMaintenance call), so it can only mean the live slot is held
 *    by something unrelated to this rollback, and there is nothing to
 *    recover from.
 */
async function resolveRollbackOperabilityFact(
  input: Readonly<{ homeDir: string; generationId: string }>,
): Promise<Readonly<{ fact: OperabilityFactResolution; artifact: RollbackAuthorityArtifactBody | null }>> {
  const live = await readBackendPublicationOperabilityFact({ homeDir: input.homeDir });
  const artifact = readRollbackAuthorityArtifact(input.homeDir, input.generationId);
  if (live.state !== "unresolvable") {
    if (artifact !== null && !sameOperabilityFactValue(live, artifact)) {
      return {
        fact: {
          state: "unresolvable",
          reason: "the live operability fact disagrees with the durable rollback-authority artifact",
        },
        artifact,
      };
    }
    return { fact: live, artifact };
  }
  if (live.reason !== MAINTENANCE_HOLDS_LIVE_SLOT_REASON) {
    return { fact: live, artifact };
  }
  if (artifact === null) {
    return {
      fact: {
        state: "unresolvable",
        reason: "backend maintenance holds the live publication slot and no durable "
          + "rollback-authority artifact exists to recover the fact from",
      },
      artifact: null,
    };
  }
  return {
    fact: artifact.operabilityFactState === "present"
      ? { state: "present", valueSha256: artifact.operabilityFactValueSha256 ?? "" }
      : { state: "authoritatively-absent" },
    artifact,
  };
}

/**
 * donadiosolutions/lcm#1432. The artifact is immutable and every reader
 * only reads it, never rewrites it -- but it is not blindly trusted
 * either: this cross-checks the authority recomputed from a FRESH
 * Boundary A read (independent of the archived-publication-slot problem
 * resolveRollbackOperabilityFact exists to recover from) against the
 * epoch/attempt the artifact recorded, and refuses rather than
 * preferring either side when they disagree. A null artifact (the first
 * time this generationId's rollback ever reaches this point) has nothing
 * to check against and is not an error.
 */
function assertAuthorityAgreesWithArtifact(
  authority: Exclude<ActivationAuthority, Readonly<{ status: "refused"; reason: string }>>,
  artifact: RollbackAuthorityArtifactBody | null,
): void {
  if (artifact === null) return;
  if (authority.status === "unactivated") {
    if (artifact.authorityStatus !== "unactivated") {
      throw new RollbackOrchestrationError(
        "unexpected-state",
        "freshly resolved authority is unactivated but the durable rollback-authority "
          + "artifact recorded an authoritative epoch/attempt",
      );
    }
    return;
  }
  // authority.status === "authoritative"
  if (
    artifact.authorityStatus !== "authoritative"
    || authority.selection.epochId !== artifact.epochId
    || authority.selection.attemptId !== artifact.attemptId
  ) {
    throw new RollbackOrchestrationError(
      "unexpected-state",
      "freshly resolved authority disagrees with the durable rollback-authority artifact's "
        + "recorded epoch/attempt",
    );
  }
}

// ---------------------------------------------------------------------------
// Boundary D. coordinator-seam-FROZEN.md v7 section 17. The writer is
// generation-binding-store.ts's recordMigrationSelectionBinding (the default
// below); #626 persists nothing through any other path, per section 17's
// explicit "two independent writers" prohibition.
// Synchronous, per section 17: an async writer inside the retained fenced
// window invites the suspend-across-await hazard the lock seam itself was
// just fixed to avoid.
// ---------------------------------------------------------------------------

export type MigrationSelectionBindingRecorder = (
  input: Readonly<{ homeDir: string; generationId: string; binding: MigrationSelectionBinding }>,
) => void;

// ---------------------------------------------------------------------------
// Boundary E. Fetches the full epoch and attempt records an authoritative
// selection names (plan-v3.1 amendment A4), plus the witness it names. Null
// only for a store lacking the pair; an unreadable store throws.
// ---------------------------------------------------------------------------

export type RollbackAuthoritativeContextResolver = (
  input: Readonly<{
    homeDir: string;
    generationId: string;
    epochId: string;
    attemptId: string;
    witnessChecksumSha256?: string;
  }>,
) => Promise<RollbackAuthoritativeContext | null>;

// ---------------------------------------------------------------------------
// Boundary F. See this file's module doc comment for why this is one
// injected capability rather than PostgreSQL plumbing #626 builds here.
// ---------------------------------------------------------------------------

/** One fenced PostgreSQL session, retained across steps 3 through 10. */
export interface RollbackFencedSession {
  /** witness-schema-FROZEN-v2.md section 2 shape, minted at lease acquisition (step 3). */
  readonly selectionAuthority: MigrationSelectionAuthority;
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
    canonicalDeltaBaseline: MigrationCanonicalDelta | null;
  }>): Promise<RollbackEligibilityObservation>;
  /** Opens the source #626 exports from for post-write generation build. */
  openPortableSource(): Promise<PortableRecordStream>;
  /**
   * EXTENSION added by this item's continuation (see the standalone doc
   * comment above ComputeRollbackTerminalEvidenceInput for why). Not part
   * of the originally committed interface.
   */
  computeRollbackTerminalEvidenceSha256(input: ComputeRollbackTerminalEvidenceInput): string;
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


// ---------------------------------------------------------------------------
// Boundary D2 (coordinator-seam-FROZEN.md v9 section 18, added since
// Boundary D above was written). recordMigrationSelectionBinding's twin
// for the WITNESS binding. Same ownership rule as Boundary D: #625
// implements it, #626 consumes it injected, #626 persists nothing itself.
// Ordering differs from Boundary D's -- a witness binding is written
// BEFORE its selection is prepared (it is evidence an attempt happened),
// never after (section 18: "ordering differs from section 17's, and the
// difference is the whole point of the witness/selection split"). See
// runMigrationRollback below for exactly where this item calls it.
//
// NOTE (v9 amendment): witnessChecksumSha256 is not recomputable by this
// writer, so this file must not assume the store re-derives or
// authenticates that digest -- #626 computes it (see
// RollbackFencedSession.computeRollbackTerminalEvidenceSha256 below) and
// the writer is trusted to store exactly what it is given.
// ---------------------------------------------------------------------------

export type MigrationWitnessBindingRecorder = (
  input: Readonly<{ homeDir: string; generationId: string; binding: MigrationWitnessBinding }>,
) => void;

// ---------------------------------------------------------------------------
// EXTENSION TO BOUNDARY F. coordinator-seam-FROZEN.md section 4's
// terminalEvidenceSha256 is "the checksumSha256 of the
// MigrationActivationWitness of frozen witness schema v3 section 8", which
// only the code that holds the live capture can mint with
// createMigrationActivationWitness. So the injected session computes it from
// values this orchestration legitimately has (epoch/attempt identity, the
// fresh observation, and this item's own eligibility decision) rather than
// this file hand-deriving a digest that activation-witness.ts owns.
// ---------------------------------------------------------------------------

export type ComputeRollbackTerminalEvidenceInput = Readonly<{
  epochId: string | null;
  attemptId: string | null;
  observation: RollbackEligibilityObservation;
  mode: "pre-write" | "post-write";
}>;

/** @internal Exported for direct unit testing only; not part of the module's public surface. */
export type RollbackTerminalEvidenceComputer = (
  input: ComputeRollbackTerminalEvidenceInput,
) => string;



// ---------------------------------------------------------------------------
// Orchestration. plan-v2 section 5's twelve steps. The retained local
// token spans steps 2 through 12, which this function implements as one
// call to withBackendPublicationAppendBarrierAsync wrapping steps 2-12's
// entire body -- the token this file's own coordinator methods accept is
// only valid inside that callback (see backend-publication.ts's
// activeAppendBarrierTokens lifecycle), so "retained across the window"
// means "the window's code runs inside the one callback", not that the
// token is threaded out and reused across separate acquisitions.
//
// KNOWN GAP, flagged rather than guessed (see this item's status report):
// coordinator-seam-FROZEN.md section 1 states the seven token-gated
// coordinator methods have "zero production callers under src/ today".
// This orchestration is the first one. Constructing a real
// BackendPublicationCoordinator requires a real BackendPublicationDriver
// (observeLocalState / publishProjectMap / publishConfig / ... --
// backend-publication.ts's own interface), and no implementation of that
// interface exists anywhere in src/ on this branch -- only test doubles
// under test/. This item does not invent one: plan-v2 section 7 forbids a
// production wrapper bridging an undefined coupling, and a driver
// implementation is exactly the PostgreSQL-specific plumbing #625's own
// activation orchestration needs identically, so it is a joint gap, not
// this item's alone to close silently. runMigrationRollback therefore
// takes an already-constructed BackendPublicationCoordinator as a
// caller-supplied dependency, exactly like MigrationManifestStore and
// every other already-open resource this codebase's orchestrators accept
// (see rollback-generation.ts's already-open PortableRecordStream for the
// same discipline). Wiring a real driver in is out of this item's scope
// until the coupling is resolved.
// ---------------------------------------------------------------------------

export interface RunMigrationRollbackDependencies {
  /** Caller-constructed; see the KNOWN GAP note above on why this item does not construct one itself. */
  readonly coordinator: BackendPublicationCoordinator;
  /** Boundary F. */
  readonly openFencedSession: OpenRollbackFencedSession;
  /** Boundary A. Defaults to resolveMigrationWitnessBindings. */
  readonly resolveWitnessBindings?: MigrationWitnessResolver;
  /** Activation evidence store read. Defaults to readMigrationActivationEvidence. */
  readonly resolveActivationEvidence?: ActivationEvidenceResolver;
  /** Boundary D. Defaults to recordMigrationSelectionBinding. */
  readonly recordSelectionBinding?: MigrationSelectionBindingRecorder;
  /** Boundary D2. Defaults to recordMigrationWitnessBinding. */
  readonly recordWitnessBinding?: MigrationWitnessBindingRecorder;
  /** Boundary E. Defaults to resolveRollbackAuthoritativeContext. */
  readonly resolveAuthoritativeContext?: RollbackAuthoritativeContextResolver;
}

type ResolvedRollbackDependencies = Required<RunMigrationRollbackDependencies>;

function withDefaultDependencies(
  deps: Readonly<RunMigrationRollbackDependencies>,
): Readonly<ResolvedRollbackDependencies> {
  return {
    coordinator: deps.coordinator,
    openFencedSession: deps.openFencedSession,
    resolveWitnessBindings: deps.resolveWitnessBindings ?? resolveMigrationWitnessBindings,
    resolveActivationEvidence: deps.resolveActivationEvidence ?? readMigrationActivationEvidence,
    recordSelectionBinding: deps.recordSelectionBinding ?? recordMigrationSelectionBinding,
    recordWitnessBinding: deps.recordWitnessBinding ?? recordMigrationWitnessBinding,
    resolveAuthoritativeContext: deps.resolveAuthoritativeContext ?? resolveRollbackAuthoritativeContext,
  };
}

export interface RunMigrationRollbackInput {
  readonly homeDir: string;
  readonly generationId: string;
  /** The live canonical SQLite database path this rollback installs into. */
  readonly canonicalPath: string;
  readonly projectIdentity: PortableProjectIdentity;
  /** StorageIdentityContext.localProjectId -- see rollback-sidecars.ts's module doc on why this is separate from projectIdentity. */
  readonly localProjectId: string;
  readonly sourceSelectionSha256: string;
  readonly queueEvidenceSha256: string;
  readonly roster: readonly BackendMaintenanceRosterEntry[];
  readonly scratchParent?: string;
  readonly signal?: AbortSignal;
  /** @internal Clock seam for tests. */
  readonly _now?: () => Date;
}

export type RollbackOrchestrationErrorReason =
  | "not-eligible"
  | "unexpected-state"
  | "not-implemented";

export class RollbackOrchestrationError extends Error {
  constructor(
    readonly reason: RollbackOrchestrationErrorReason,
    message: string = reason,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RollbackOrchestrationError";
  }
}

export type RunMigrationRollbackOutcome = Readonly<{
  manifest: MigrationManifest;
  report: RollbackReportBody | null;
}>;

function sameSuccessorManifest(a: MigrationManifest, b: MigrationManifest): boolean {
  const strip = (value: MigrationManifest) => ({
    ...value,
    checksumSha256: null,
    updatedAt: null,
    pendingEffect: value.pendingEffect === null ? null : { ...value.pendingEffect, startedAt: null },
  });
  return canonicalJson(strip(a) as unknown as Record<string, unknown>)
    === canonicalJson(strip(b) as unknown as Record<string, unknown>);
}

/**
 * Publishes a computed successor manifest, tolerating a retry that already
 * landed the identical successor (compared modulo timestamps/checksum, per
 * batch-copy.ts's own sameSuccessor discipline for the identical reason:
 * this orchestration's retry paths recompute deterministic inputs and must
 * not refuse when their own prior attempt already published the result).
 */
function publishManifest(
  store: MigrationManifestStore,
  generationId: string,
  current: MigrationManifest,
  next: MigrationManifest,
): MigrationManifest {
  try {
    return store.update(generationId, current.checksumSha256, () => next);
  } catch (error) {
    const observed = store.read(generationId);
    if (!sameSuccessorManifest(observed, next)) throw error;
    return observed;
  }
}



/**
 * Orchestrates one rollback attempt for a manifest at its generationId,
 * per plan-v2 section 5's twelve steps.
 *
 * SCOPE OF THIS IMPLEMENTATION, stated honestly rather than silently
 * narrowed (see this item's status report for the full account):
 *
 *  - Fully implemented: step 1's recovery classification and its three
 *    branches (fresh start, resume a pending prepare-rollback, continue a
 *    completed prepare-rollback with no pending effect); steps 2-8 for
 *    every eligibility outcome; step 9/11's post-write generation
 *    build+install+materialize path; step 9/11's pre-write and
 *    unactivated selection-reversal path -- no build, no install, no
 *    sidecar materialization, no generation directory, per plan-v2
 *    section 1's "Data movement: none" for both eligibilities and issue
 *    #626's acceptance ("an exact selection reversal with no data
 *    copy") -- corrected in this continuation from a predecessor's
 *    blanket "not-implemented" refusal for every non-post-write mode,
 *    which this file's own module doc's Boundary section had wrongly
 *    reasoned required resolving the #622-preserved source generation's
 *    on-disk path; step 12's report persistence and effect completion
 *    for both the post-write and pre-write/unactivated paths.
 *  - NOT implemented: nothing at step 9 or step 11 remains unimplemented
 *    for any eligibility. The maintenance-selection flip
 *    (prepareMaintenanceSelection / completeMaintenanceSelection) is
 *    unconditional across every eligibility, which is what makes
 *    pre-write and unactivated a real "selection reversal" rather than a
 *    no-op.
*  - Best-effort, flagged as needing review rather than presented as
*    settled: step 12's abandonment path's explicit backend-selection
*    reconciliation (see recoverPendingPublishRollback below).
*/

/**
 * donadiosolutions/lcm#1432. True only when "existing" is a durable,
 * non-terminal maintenance journal that matches every field THIS
 * generationId's rollback would itself supply to enterMaintenance --
 * meaning it can only be OUR OWN maintenance, held by a crashed prior
 * attempt of this SAME rollback, never a different or unrelated one.
 * Deliberately conservative: any mismatch (including roster order,
 * compared order-invariantly below) falls through to calling
 * enterMaintenance normally, which refuses loudly rather than this
 * function silently adopting a maintenance it cannot prove is ours.
 */
function maintenanceAlreadyHeldForThisAttempt(
  existing: BackendMaintenanceJournal | null,
  attempt: Readonly<{
    publicationId: string;
    generationId: string;
    sourceSelectionSha256: string;
    queueEvidenceSha256: string;
    roster: readonly BackendMaintenanceRosterEntry[];
  }>,
): boolean {
  if (existing === null || existing.phase !== "maintenance-held") return false;
  return existing.publicationId === attempt.publicationId
    && existing.generationId === attempt.generationId
    && existing.sourceSelectionSha256 === attempt.sourceSelectionSha256
    && existing.queueEvidenceSha256 === attempt.queueEvidenceSha256
    && sameMaintenanceRoster(existing.roster, attempt.roster);
}

function sortedMaintenanceRoster(
  roster: readonly BackendMaintenanceRosterEntry[],
): readonly BackendMaintenanceRosterEntry[] {
  return [...roster].sort((a, b) => (a.machineId < b.machineId ? -1 : a.machineId > b.machineId ? 1 : 0));
}

function sameMaintenanceRoster(
  left: readonly BackendMaintenanceRosterEntry[],
  right: readonly BackendMaintenanceRosterEntry[],
): boolean {
  return canonicalJson(sortedMaintenanceRoster(left) as unknown as readonly Record<string, unknown>[])
    === canonicalJson(sortedMaintenanceRoster(right) as unknown as readonly Record<string, unknown>[]);
}

export async function runMigrationRollback(
  input: Readonly<RunMigrationRollbackInput>,
  suppliedDeps: Readonly<RunMigrationRollbackDependencies>,
): Promise<RunMigrationRollbackOutcome> {
  const deps = withDefaultDependencies(suppliedDeps);
  const now = input._now ?? ((): Date => new Date());
  const store = new MigrationManifestStore({ homeDir: input.homeDir });
  const current = store.read(input.generationId);
  const recovery = classifyMigrationRecovery(current);

  // Step 1: classify recovery.
  if (recovery.action === "readback") {
    return recoverPendingPublishRollback(input, deps, store, current, now);
  }
  if (recovery.action === "settled") {
    if (recovery.phase !== "active") {
      throw new RollbackOrchestrationError(
        "unexpected-state",
        `generation ${input.generationId} is settled at phase ${recovery.phase}; no rollback is available on this manifest`,
      );
    }
    // Fresh start from an activated manifest with no pending effect --
    // falls through to the full step 2-12 sequence below, same as a fresh
    // start from "verified".
  } else if (recovery.action === "ready" && current.phase === "rolling-back") {
    // prepare-rollback already completed on a prior attempt and sealed
    // rollbackLineage.returnPhase; classifyMigrationRecovery returns
    // "ready" here (not "resume") because there is no pending effect.
    // Re-beginning prepare-rollback would be illegal (legalEffect only
    // accepts it from "verified"/"active"). Continue from step 9.
    return continueAfterPrepareRollback(input, deps, store, current, now);
  }
  // recovery.action === "ready" (phase "verified") or "resume" (a pending
  // prepare-rollback, retry-idempotent) both fall through: "resume"
  // re-derives the identical deterministic inputSha256 below and the
  // begin-effect call becomes a no-op comparison rather than a fresh
  // begin, per section 8's convergence rule.

  // Boundary C's operability fact MUST be read before enterMaintenance
  // (step 2 below), never after -- see readBackendPublicationOperabilityFact's
  // own doc comment on why. Boundary A's witness resolution is read
  // alongside it so both observations describe the same instant.
  // donadiosolutions/lcm#1432: resolveRollbackOperabilityFact (rather
  // than the bare live reader) so a RETRY of this same fresh/resume path
  // -- reached after a crash anywhere from here through step 8, where
  // enterMaintenance has already run and archived the live slot -- falls
  // back to the durable rollback-authority artifact instead of observing
  // "unresolvable" and refusing permanently.
  const { fact: operabilityFact, artifact: priorAuthorityArtifact } = await resolveRollbackOperabilityFact({
    homeDir: input.homeDir,
    generationId: input.generationId,
  });
  const witnessResolution = deps.resolveWitnessBindings({
    homeDir: input.homeDir,
    generationId: input.generationId,
  });
  const evidence = deps.resolveActivationEvidence({
    homeDir: input.homeDir,
    generationId: input.generationId,
  });
  const authority = resolveActivationAuthority({ resolution: witnessResolution, evidence, operabilityFact });
  if (authority.status === "refused") {
    throw new RollbackOrchestrationError("not-eligible", authority.reason);
  }
  assertAuthorityAgreesWithArtifact(authority, priorAuthorityArtifact);
  if (operabilityFact.state === "unresolvable") {
    // Unreachable: resolveActivationAuthority's row 4 refuses (and
    // returns above) whenever operabilityFact.state is "unresolvable".
    // Stated as a runtime assertion, not just a comment, because the
    // artifact write two lines below must never persist that state.
    throw new RollbackOrchestrationError(
      "unexpected-state",
      "internal: authority resolved non-refused with an unresolvable operability fact",
    );
  }

  let authoritativeContext: RollbackAuthoritativeContext | null = null;
  if (authority.status === "authoritative") {
    authoritativeContext = await deps.resolveAuthoritativeContext({
      homeDir: input.homeDir,
      generationId: input.generationId,
      epochId: authority.selection.epochId,
      attemptId: authority.selection.attemptId,
      witnessChecksumSha256: authority.selection.witnessChecksumSha256,
    });
    if (authoritativeContext === null) {
      throw new RollbackOrchestrationError(
        "unexpected-state",
        "authoritative selection resolved but its epoch/attempt record could not be fetched",
      );
    }
  }

  // donadiosolutions/lcm#1432: persist the durable rollback-authority
  // artifact BEFORE entering maintenance (step 2) -- see this artifact's
  // own module doc comment for why it must live here rather than between
  // steps 7 and 8. Idempotent: a retry regenerates byte-identical
  // content (operabilityFact/authority above are unchanged from any
  // prior write for this generationId, per the cross-check just above).
  writeRollbackAuthorityArtifact(input.homeDir, {
    version: 1,
    generationId: input.generationId,
    operabilityFactState: operabilityFact.state,
    operabilityFactValueSha256: operabilityFact.state === "present" ? operabilityFact.valueSha256 : null,
    authorityStatus: authority.status,
    epochId: authority.status === "authoritative" ? authority.selection.epochId : null,
    attemptId: authority.status === "authoritative" ? authority.selection.attemptId : null,
  });

  return withBackendPublicationAppendBarrierAsync(input.homeDir, async (token) => {
    let working = current;

    // Step 2: enterMaintenance under the retained token.
    //
    // donadiosolutions/lcm#1432 (closing the same window from the other
    // side). enterMaintenance refuses ("unresolved-publication") when a
    // non-terminal maintenance journal already exists -- it only
    // idempotently resumes its OWN "maintenance-entering" sub-phase, per
    // its own doc comment and coordinator-seam-FROZEN.md section 3. A
    // crash anywhere from here through step 8 leaves maintenance durably
    // "maintenance-held", so a fresh retry that always calls
    // enterMaintenance again -- as this line did before -- fails on
    // exactly the crash window the durable rollback-authority artifact
    // above was introduced to recover, for a DIFFERENT reason than the
    // operability-fact one: not an unresolvable fact, but a coordinator
    // refusal to re-enter a maintenance it (correctly) does not know is
    // this SAME attempt's own. This file does not own backend-publication.ts
    // and cannot teach enterMaintenance a new idempotent-resume branch,
    // so the check is made here instead: if a held maintenance journal
    // already matches every field THIS call would have supplied, it is
    // adopted as-is rather than re-entered. A mismatch on any field (a
    // genuinely different or unrelated maintenance) is deliberately left
    // to enterMaintenance's own call below, which refuses loudly rather
    // than this function guessing whose maintenance it is.
    const publicationId = deriveRollbackPublicationId(input.generationId);
    const existingMaintenance = readBackendMaintenanceJournal(input.homeDir);
    const maintenanceJournal = maintenanceAlreadyHeldForThisAttempt(existingMaintenance, {
      publicationId,
      generationId: input.generationId,
      sourceSelectionSha256: input.sourceSelectionSha256,
      queueEvidenceSha256: input.queueEvidenceSha256,
      roster: input.roster,
    })
      ? existingMaintenance!
      : await deps.coordinator.enterMaintenance({
        publicationId,
        generationId: input.generationId,
        sourceSelectionSha256: input.sourceSelectionSha256,
        queueEvidenceSha256: input.queueEvidenceSha256,
        roster: input.roster,
        now: now(),
      }, token);

    // Step 3: acquire the fenced PostgreSQL session (Boundary F).
    const session = await deps.openFencedSession({ homeDir: input.homeDir, manifest: working });
    try {
      // Step 4: authoritative readback in the dedicated snapshot.
      const observation = await session.captureReadback({
        manifestDestinationWitnessSha256: working.destination.identitySha256,
        canonicalDeltaBaseline: authoritativeContext?.attempt.canonicalDeltaBaseline ?? null,
      });

      // Steps 5+6 combined: identity gate, schema-bound census
      // comparability, and classification, in that order -- exactly the
      // order evaluateRollbackEligibility already implements.
      const decision = evaluateRollbackEligibility({
        authority,
        authoritativeContext,
        observation,
      });
      if (decision.eligibility === "refused") {
        await deps.coordinator.abortMaintenance({
          expectedChecksumSha256: maintenanceJournal.checksumSha256,
          sourceSelectionSha256: input.sourceSelectionSha256,
          abortEvidenceSha256: sha256(canonicalJson(["rollback-abort-v1", input.generationId, decision.reason])),
        }, token);
        throw new RollbackOrchestrationError("not-eligible", decision.reason);
      }

     // Step 7: begin prepare-rollback with a deterministic inputSha256.
     const epochIdForInput = authority.status === "authoritative" ? authority.selection.epochId : null;
      // donadiosolutions/lcm#1432, a third independent defect found while
      // building the resume tests this fix requires: on a "resume"
      // (classifyMigrationRecovery's retry-idempotent action, reached
      // when a crashed prior attempt's begin already landed durably),
      // "working" here is the manifest AFTER that begin -- one revision
      // past the "verified"/"active" state the crashed attempt actually
      // computed prepareInputSha256 from. Recomputing from working.revision
      // /working.checksumSha256 unconditionally therefore used the WRONG
      // baseline on every resume and could never match the stored
      // pendingEffect.inputSha256, making every resume of a pending
      // prepare-rollback refuse permanently below -- unreachable via any
      // committed test before this continuation added one. The correct
      // baseline is one revision back, which working.previousManifestSha256
      // already names exactly (it is the checksum of the immediate
      // predecessor manifest, i.e. the pre-begin state) whenever a pending
      // effect exists.
      const prepareInputBaselineRevision = working.pendingEffect === null ? working.revision : working.revision - 1;
      const prepareInputBaselineChecksumSha256 = working.pendingEffect === null
        ? working.checksumSha256
        : working.previousManifestSha256!;
      const prepareInputSha256 = deriveRollbackPrepareInputSha256({
        generationId: input.generationId,
        manifestRevision: prepareInputBaselineRevision,
        manifestChecksumSha256: prepareInputBaselineChecksumSha256,
        epochId: epochIdForInput,
        resourceType: session.selectionAuthority.resourceType,
        resourceKey: session.selectionAuthority.resourceKey,
      });
      const prepareEffectId = "rollback-prepare-" + prepareInputSha256;
      if (working.pendingEffect === null) {
        working = publishManifest(store, input.generationId, working, beginMigrationEffect(working, {
          effectId: prepareEffectId,
          kind: "prepare-rollback",
          inputSha256: prepareInputSha256,
          startedAt: now().toISOString(),
        }));
      } else if (
        working.pendingEffect.kind !== "prepare-rollback"
        || working.pendingEffect.inputSha256 !== prepareInputSha256
      ) {
        throw new RollbackOrchestrationError(
          "unexpected-state",
          "a pending effect exists that does not match this rollback attempt's deterministic input",
        );
      }

      // Step 8: complete prepare-rollback; returnPhase seals.
      working = publishManifest(store, input.generationId, working, completeMigrationEffect(working, {
        effectId: working.pendingEffect!.effectId,
        completedAt: now().toISOString(),
      }));

      return await runPostPrepareSequence(
        input, deps, store, working, session, authority, authoritativeContext, decision, token, now,
      );
    } finally {
      await session.release();
    }
  });
}



function requireMaintenanceChecksum(homeDir: string): string {
  const journal = readBackendMaintenanceJournal(homeDir);
  if (journal === null) {
    throw new RollbackOrchestrationError("unexpected-state", "backend maintenance journal is unexpectedly absent");
  }
  return journal.checksumSha256;
}

function rollbackGenerationBuildRoot(homeDir: string): string {
  return join(resolve(homeDir), ".lcm", "migration-rollback-generations");
}

const ROLLBACK_GENERATION_BUILD_ATTEMPT_ORDINAL_PATTERN = /^[1-9][0-9]*$/u;
const MAX_ROLLBACK_GENERATION_BUILD_ATTEMPT_ENTRIES = 100_000;

/**
 * donadiosolutions/lcm#626 (post-write build retry). Three-valued, like
 * every other resolver in this file: the private root directory not
 * existing yet is a legitimate, positively-determined "no attempt has
 * EVER built here" -- it is created lazily by buildRollbackGeneration's
 * own first call, for any generationId -- not a read failure. Any OTHER
 * failure to open, authenticate or list it REFUSES rather than
 * defaulting to "none found", because a silent default here could mint
 * a build target that collides with an existing quarantined failed
 * generation, the one artifact this item treats as immutable evidence.
 *
 * The match against baseGenerationId/revision is EXACT, never startsWith:
 * the prefix carries its own trailing "-" separator, and the remainder
 * after stripping it must be a bare positive integer with nothing else,
 * so a differently-shaped generationId that happens to share a textual
 * prefix (including one containing "-rb" itself) can never be mistaken
 * for one of THIS generationId/revision pair's own attempts.
 */
function highestRollbackGenerationBuildAttempt(
  homeDir: string,
  baseGenerationId: string,
  revision: number,
): number {
  const root = rollbackGenerationBuildRoot(homeDir);
  try {
    // The whole body -- including opening the directory -- is inside
    // this one try/catch, deliberately: an EACCES (or any other) failure
    // opening the private directory must be wrapped in the SAME
    // distinguishable message as a failure listing it, so a caller (and
    // a test) can tell this guard fired rather than some other nearby
    // code throwing an incidental, differently-shaped error.
    const handle = openPrivateDirectoryIfExists(root);
    if (handle === undefined) return 0;
    try {
      const prefix = baseGenerationId + "-rb" + revision.toString(10) + "-";
      const directory = opendirSync(root, { bufferSize: 1 });
      let highest = 0;
      try {
        let seen = 0;
        for (;;) {
          const entry = directory.readSync();
          if (entry === null) break;
          seen += 1;
          if (seen > MAX_ROLLBACK_GENERATION_BUILD_ATTEMPT_ENTRIES) {
            throw new RollbackOrchestrationError(
              "unexpected-state",
              "rollback generation build root has more entries than this enumeration will scan; refusing rather than risk an undercounted ordinal",
            );
          }
          if (!entry.name.startsWith(prefix)) continue;
          const remainder = entry.name.slice(prefix.length);
          if (!ROLLBACK_GENERATION_BUILD_ATTEMPT_ORDINAL_PATTERN.test(remainder)) continue;
          const ordinal = Number(remainder);
          if (Number.isSafeInteger(ordinal) && ordinal > highest) highest = ordinal;
        }
      } finally {
        directory.closeSync();
      }
      return highest;
    } finally {
      handle.close();
    }
  } catch (error) {
    if (error instanceof RollbackOrchestrationError) throw error;
    throw new RollbackOrchestrationError(
      "unexpected-state",
      "could not enumerate existing rollback generation build attempts: " + describeUnresolvable(error),
    );
  }
}

/**
 * Steps 9-12, shared by the fresh path (called from runMigrationRollback
 * right after step 8 completes, inside the same retained token and the
 * same fenced session opened at step 3) and the resumed path (called from
 * continueAfterPrepareRollback under a freshly acquired token and a
 * freshly opened session, when a prior attempt completed prepare-rollback
 * and then crashed before step 9). `decision` is step 9's own input in
 * the fresh path; in the resumed path the caller has no valid step-4
 * observation to reuse (it lived in a dead process) and passes a decision
 * derived from a readback taken at resume time instead. Either way, this
 * function performs its OWN fresh step-10 revalidation before installing,
 * so a resumed run is never less safe than a fresh one -- it is simply
 * the case where steps "9's decision" and "10's decision" are taken from

 * two readbacks that are closer together in time than the fresh path's.
 */
async function runPostPrepareSequence(
  input: Readonly<RunMigrationRollbackInput>,
  deps: Readonly<ResolvedRollbackDependencies>,
  store: MigrationManifestStore,
  working: MigrationManifest,
  session: RollbackFencedSession,
  authority: ActivationAuthority,
  authoritativeContext: RollbackAuthoritativeContext | null,
  decision: RollbackEligibilityDecision,
  token: BackendPublicationLockToken,
  now: () => Date,
): Promise<RunMigrationRollbackOutcome> {
  if (decision.eligibility === "refused") {
    throw new RollbackOrchestrationError(
      "unexpected-state",
      "internal: runPostPrepareSequence received a refused decision",
    );
  }
  const mode = decision.mode;

  // Step 9: build, verify -- post-write only. Corrected by this item's
  // continuation: plan-v2 section 1's eligibility table records "Data
  // movement: none" for BOTH "unactivated" and "pre-write", because in
  // neither eligibility was anything ever durably written past
  // activation -- the live SQLite database at input.canonicalPath is
  // still the correct, current image. Building a reconstruction and
  // installing it over that live database would replace a correct
  // database with a reconstruction, which issue #626's acceptance
  // ("an exact selection reversal with no data copy") and this table
  // both forbid; the predecessor's blanket "not-implemented" refusal for
  // every non-post-write mode was itself the defect this continuation
  // corrects, not a conservative placeholder to keep. Sidecars
  // materialize only after install, once a generation's canonical bytes
  // are final, so they are skipped identically for pre-write: whatever
  // sidecars already sit beside the live database are untouched by this
  // rollback, exactly like the database itself.
  let built: RollbackGenerationOutcome | null = null;
  if (mode === "post-write") {
    const source = await session.openPortableSource();
    // The build target must be a FRESH physical generation per attempt,
    // never reused: plan-v2 section 4's "Resumability, stated honestly"
    // requires "crash recovery creates a new generation under the
    // already-sealed prepare-rollback", with the incomplete one
    // "quarantined read-only at 0400, never deleted" -- and
    // rollback-generation.ts's own SCOPE NOTE refuses ("generation-
    // exists") rather than accept a second build at one path, pushing
    // the mint-or-retry decision up to this orchestration explicitly.
    // The ordinal is derived by enumerating the durable filesystem
    // state rather than threaded through in-memory or manifest state,
    // for the same reason every other identity in this file is: it is
    // compared/derived as a value, attributable evidence rather than an
    // unattributable nonce, and ordered so an operator inspecting
    // quarantined generations reads them in attempt sequence. This does
    // NOT engage contract section 8 (no attempt-time observation in a
    // DETERMINISTIC identity that must converge across retries):
    // section 8 governs identities that must produce the SAME bytes on
    // every retry; this identity must do the opposite, differing per
    // attempt BY CONSTRUCTION, so there is nothing for section 8 to
    // forbid here. buildRollbackGeneration's own "generation-exists"
    // refusal stays as the final guard regardless: even a wrong ordinal
    // fails closed rather than overwriting evidence.
    const buildAttemptOrdinal = highestRollbackGenerationBuildAttempt(
      input.homeDir, input.generationId, working.revision,
    ) + 1;
    built = await buildRollbackGeneration({
      homeDir: input.homeDir,
      generationId: input.generationId + "-rb" + working.revision + "-" + buildAttemptOrdinal,
      projectIdentity: input.projectIdentity,
      source,
      scratchParent: input.scratchParent,
      signal: input.signal,
    });
    if (built.state === "quarantined") {
      throw new RollbackOrchestrationError(
        "unexpected-state",
        "rollback generation build failed and was quarantined: " + built.reason,
      );
    }
  }

  // Step 10: revalidate under a NEW snapshot, never step 4's/9's own.
  await session.renew();
  const revalidated = await session.captureReadback({
    manifestDestinationWitnessSha256: working.destination.identitySha256,
    canonicalDeltaBaseline: authoritativeContext?.attempt.canonicalDeltaBaseline ?? null,
  });
  const revalidatedDecision = evaluateRollbackEligibility({
    authority,
    authoritativeContext,
    observation: revalidated,
  });
  if (revalidatedDecision.eligibility === "refused" || revalidatedDecision.mode !== decision.mode) {
    // A racing post-activation write (or any other change) inside the
    // fenced window. working is left at phase "rolling-back" with no
    // pending effect -- a legitimate state a future attempt resumes from
    // via continueAfterPrepareRollback. The generation this attempt built
    // is left in place, verified but unreferenced, never deleted.
    throw new RollbackOrchestrationError(
      "not-eligible",
      revalidatedDecision.eligibility === "refused"
        ? revalidatedDecision.reason
        : 'revalidation observed mode "' + revalidatedDecision.mode + '" where step 9 acted on "' + decision.mode + '"',
    );
  }

  const epochId = authority.status === "authoritative" ? authority.selection.epochId : null;
  const attemptId = authority.status === "authoritative" ? authority.selection.attemptId : null;
  const terminalEvidenceSha256 = session.computeRollbackTerminalEvidenceSha256({
    epochId,
    attemptId,
    observation: revalidated,
    mode: revalidatedDecision.mode,
  });

  // Section 18: written BEFORE the selection is prepared. Gated on
  // authority.status === "authoritative" rather than on mode, because the
  // binding names the ACTIVATION epoch/attempt this rollback reverses
  // (epochId/attemptId above), and "unactivated" authority carries
  // neither -- rollback-eligibility.ts's ActivationAuthority "unactivated"
  // variant is exactly `{ status: "unactivated" }`, no fields, so there
  // is genuinely nothing to name.
  //
  // OPEN QUESTION flagged to the owner rather than guessed (see this
  // item's status report). This continuation's instruction was "write
  // the rollback witness binding" even for "unactivated", reasoning that
  // "an unactivated rollback is still an attempt that happened" (section
  // 18). That is correct in the witnessed-but-unpublished sub-case -- an
  // activation attempt WAS witnessed (fixtureWitnessedButUnpublished
  // proves this state is reachable) but never selected, and "unactivated"
  // is exactly that sub-case's outcome -- but resolveActivationAuthority's
  // current, already-tested return shape discards that witness and
  // returns the bare unactivated status with no epochId/attemptId to
  // bind. Widening it to carry the witness would also break
  // rollback-eligibility.test.ts's existing exact
  // `.toEqual({ status: "unactivated" })` assertions against that same
  // fixture, which read as an intentional decision to keep "unactivated"
  // dataless. This item does not silently pick a side: no witness
  // binding is written for "unactivated" here, and the tension is
  // reported rather than resolved by guessing.
  if (authority.status === "authoritative") {
    deps.recordWitnessBinding({
      homeDir: input.homeDir,
      generationId: input.generationId,
      binding: {
        kind: "rollback",
        epochId: epochId!,
        attemptId: attemptId!,
        manifestRevision: working.revision,
        witnessChecksumSha256: terminalEvidenceSha256,
      },
    });
  }

  // Step 11: install precedes publication -- while PostgreSQL is still
  // the durably selected backend -- then flip maintenance selection to
  // sqlite. Post-write only: pre-write and unactivated install nothing
  // and materialize no sidecars, because the live database at
  // input.canonicalPath already IS the correct generation and its
  // existing sidecars are untouched -- see step 9's comment above. The
  // maintenance selection flip immediately below is unconditional: it is
  // the actual "selection reversal" issue #626 asks pre-write and
  // unactivated to perform, for every eligibility.
  if (mode === "post-write") {
    if (built === null || built.state !== "verified") {
      throw new RollbackOrchestrationError(
        "unexpected-state",
        "internal: post-write mode reached step 11 without a verified built generation",
      );
    }
    const installOutcome = installRollbackGeneration({
      homeDir: input.homeDir,
      generationId: built.generationId,
      canonicalPath: input.canonicalPath,
      verifiedDatabasePath: built.databasePath,
    });
    materializeRollbackSidecars({
      homeDir: input.homeDir,
      databasePath: installOutcome.canonicalPath,
      localProjectId: input.localProjectId,
    });
  }

  const heldChecksum = requireMaintenanceChecksum(input.homeDir);
  const prepared = await deps.coordinator.prepareMaintenanceSelection({
    expectedChecksumSha256: heldChecksum,
    generationId: input.generationId,
    targetBackend: "sqlite",
    terminalEvidenceSha256,
  }, token);
  await deps.coordinator.completeMaintenanceSelection({
    expectedChecksumSha256: prepared.checksumSha256,
    generationId: input.generationId,
    terminalEvidenceSha256,
  }, token);

  // "then the coordinator publication of project map and config" is NOT
  // implemented here -- see this item's status report. coordinator.prepare()
  // needs a BackendPublicationRecoveryMaterial and a projects list this
  // item has no source for; that shape belongs to whichever item defines
  // config/project-map publication content (#625's activation side, or a
  // shared module neither item has authored yet), and inventing one here
  // would be an undefined coupling guessed rather than asked about. The
  // maintenance journal is already durably terminal at
  // "selection-completed" above, which is what assertMigrationReplayAdmission
  // and assertBackendPublicationConsumerAccessUnlocked key on (section 6),
  // so replay admission and backend selection already route to sqlite
  // correctly even though this step is incomplete.

  // Step 12: persist the report, then complete with the report and the
  // exact mode. Order is begin, persist, complete (plan-v2 section 5's
  // closing paragraph), so the report's createdAt falls inside
  // [pending.startedAt, completedAt].
  const publishInputSha256 = terminalEvidenceSha256;
  const publishEffectId = "rollback-publish-" + publishInputSha256;
  working = publishManifest(store, input.generationId, working, beginMigrationEffect(working, {
    effectId: publishEffectId,
    kind: "publish-rollback",
    inputSha256: publishInputSha256,
    startedAt: now().toISOString(),
  }));

  const reportId = deriveRollbackReportId({
    generationId: input.generationId,
    effectId: working.pendingEffect!.effectId,
    kind: "rollback",
  });
  const reportCreatedAt = now().toISOString();
  const report = writeRollbackReport(input.homeDir, {
    version: 1,
    reportId,
    generationId: input.generationId,
    effectId: working.pendingEffect!.effectId,
    kind: "rollback",
    eligibility: revalidatedDecision.eligibility,
    mode: revalidatedDecision.mode,
    epochId,
    attemptId,
    sealedPublicationMaterialDigestSha256: null,
    reason: null,
  });

  working = publishManifest(store, input.generationId, working, completeMigrationEffect(working, {
    effectId: working.pendingEffect!.effectId,
    completedAt: now().toISOString(),
    report: { kind: "rollback", reportId: report.reportId, reportSha256: report.checksumSha256, createdAt: reportCreatedAt },
    rollbackMode: revalidatedDecision.mode,
  }));

  // Written only after the selection completes, and before this
  // function returns (the retained token is released by the caller's
  // `finally` immediately after, which is inside this same window).
  if (authority.status === "authoritative") {
    deps.recordSelectionBinding({
      homeDir: input.homeDir,
      generationId: input.generationId,
      binding: {
        kind: "rollback",
        epochId: epochId!,
        attemptId: attemptId!,
        manifestRevision: working.revision,
        witnessChecksumSha256: terminalEvidenceSha256,
        publicationId: deriveRollbackPublicationId(input.generationId),
      },
    });
  }

  return { manifest: working, report };
}



/**
 * Resumes a rollback whose prepare-rollback effect already completed
 * (manifest phase "rolling-back", no pending effect) -- classifyMigrationRecovery
 * returns "ready" here, per plan-v2 section 5 step 1: "rolling-back with
 * no pending effect continues to export and publish". This is a fresh
 * process (the original one may have crashed or simply exited after
 * step 8), so it acquires a fresh retained token and a fresh fenced
 * session rather than reusing anything from a prior attempt.
 *
 * donadiosolutions/lcm#1432. This function MUST NOT call
 * readBackendPublicationOperabilityFact directly: the original attempt's
 * own enterMaintenance (step 2) already archived the live publication
 * slot out of view by the time this phase is ever reached, so a live
 * re-read here always observes the still-held maintenance journal and
 * answers "unresolvable". resolveRollbackOperabilityFact recognizes
 * exactly that expected cause and falls back to the durable rollback-
 * authority artifact written before enterMaintenance ever ran; any OTHER
 * unresolvable cause, or a disagreement between a resolvable live read
 * and the artifact, still refuses. Boundary A is read fresh regardless
 * (it is independent of the archived-slot problem) and its resulting
 * authority is required to AGREE with the artifact's recorded
 * epoch/attempt rather than being trusted on its own.
 */
async function continueAfterPrepareRollback(
  input: Readonly<RunMigrationRollbackInput>,
  deps: Readonly<ResolvedRollbackDependencies>,
  store: MigrationManifestStore,
  current: MigrationManifest,
  now: () => Date,
): Promise<RunMigrationRollbackOutcome> {
  const { fact: operabilityFact, artifact: priorAuthorityArtifact } = await resolveRollbackOperabilityFact({
    homeDir: input.homeDir,
    generationId: input.generationId,
  });
  const witnessResolution = deps.resolveWitnessBindings({
    homeDir: input.homeDir,
    generationId: input.generationId,
  });
  const evidence = deps.resolveActivationEvidence({
    homeDir: input.homeDir,
    generationId: input.generationId,
  });
  const authority = resolveActivationAuthority({ resolution: witnessResolution, evidence, operabilityFact });
  if (authority.status === "refused") {
    throw new RollbackOrchestrationError(
      "unexpected-state",
      "continuing a prepared rollback: authority resolution now refuses: " + authority.reason,
    );
  }
  assertAuthorityAgreesWithArtifact(authority, priorAuthorityArtifact);
  let authoritativeContext: RollbackAuthoritativeContext | null = null;
  if (authority.status === "authoritative") {
    authoritativeContext = await deps.resolveAuthoritativeContext({
      homeDir: input.homeDir,
      generationId: input.generationId,
      epochId: authority.selection.epochId,
      attemptId: authority.selection.attemptId,
      witnessChecksumSha256: authority.selection.witnessChecksumSha256,
    });
    if (authoritativeContext === null) {
      throw new RollbackOrchestrationError(
        "unexpected-state",
        "authoritative selection resolved but its epoch/attempt record could not be fetched",
      );
    }
  }

  return withBackendPublicationAppendBarrierAsync(input.homeDir, async (token) => {
    // No enterMaintenance call here: the durable maintenance journal is
    // already held from the original attempt's step 2, and enterMaintenance
    // refuses (unresolved-publication) when a non-terminal maintenance
    // journal already exists. A freshly acquired token still authorizes
    // the coordinator's token branch (coordinator-seam-FROZEN.md section 3:
    // "a consumer-lock token is accepted... does NOT require
    // activeAppendBarrierTokens membership [pre-dating this call]").
    const session = await deps.openFencedSession({ homeDir: input.homeDir, manifest: current });
    try {
      const observation = await session.captureReadback({
        manifestDestinationWitnessSha256: current.destination.identitySha256,
        canonicalDeltaBaseline: authoritativeContext?.attempt.canonicalDeltaBaseline ?? null,
      });
      const decision = evaluateRollbackEligibility({
        authority,
        authoritativeContext,
        observation,
      });
      if (decision.eligibility === "refused") {
        throw new RollbackOrchestrationError("not-eligible", decision.reason);
      }
      return await runPostPrepareSequence(
        input, deps, store, current, session, authority, authoritativeContext, decision, token, now,
      );
    } finally {
      await session.release();
    }
  });
}

/**
 * Recovers a rollback whose publish-rollback effect was pending when the
 * process died (classifyMigrationRecovery action "readback",
 * recovery === "authoritative-readback-required", per protocol.ts). This
 * is the hardest recovery path plan-v2 names, and this implementation is
 * intentionally conservative rather than clever, per plan-v2 section 12's
 * closing paragraph on abandonment reconciling the backend selection
 * explicitly:
 *
 *  - If the durable maintenance journal shows selection-completed,
 *    targeting sqlite, for exactly this generationId, step 11's install
 *    and selection flip are proven to have happened (that journal state
 *    is durable and is exactly what assertMigrationReplayAdmission keys
 *    on per section 6), so this path completes publish-rollback with a
 *    freshly derived report rather than abandoning a change that already
 *    happened.
 *  - Otherwise, nothing durable proves the flip happened. This path
 *    abandons the pending publish-rollback effect back to the sealed
 *    returnPhase and, if the maintenance journal is still non-terminal
 *    (held or entering), aborts it -- which is itself the "reconciliation"
 *    plan-v2 asks for in this branch, because nothing was ever durably
 *    selected away from postgresql to reconcile back to.
 *  - NOT IMPLEMENTED, refusing explicitly: the case where the maintenance
 *    journal is durably terminal at selection-completed/sqlite (so
 *    abortMaintenance is no longer legal -- it only accepts held/entering)
 *    but this item's own evidence says the rollback must still be
 *    abandoned (e.g. a config/project-map publication step 11 could not
 *    prove complete, once that step is implemented). Reconciling that
 *    case requires a second maintenance cycle re-selecting postgresql,
 *    which needs the original activation's own terminalEvidenceSha256 --
 *    plausibly the authoritative activation selection binding's own
 *    witnessChecksumSha256, per section 14 -- and this item flags that
 *    mechanism as unconfirmed rather than executing an unverified
 *    backend-selection mutation. See this item's status report.
 */
async function recoverPendingPublishRollback(
  input: Readonly<RunMigrationRollbackInput>,
  deps: Readonly<ResolvedRollbackDependencies>,
  store: MigrationManifestStore,
  current: MigrationManifest,
  now: () => Date,
): Promise<RunMigrationRollbackOutcome> {
  const pending = current.pendingEffect;
  if (pending === null || pending.kind !== "publish-rollback") {
    throw new RollbackOrchestrationError("unexpected-state", "recoverPendingPublishRollback called without a pending publish-rollback effect");
  }

  const maintenance = readBackendMaintenanceJournal(input.homeDir);
  const selectionProvenComplete = maintenance !== null
    && maintenance.phase === "selection-completed"
    && maintenance.generationId === input.generationId
    && maintenance.targetBackend === "sqlite";

  return withBackendPublicationAppendBarrierAsync(input.homeDir, async (token) => {
    let working = current;

    if (selectionProvenComplete) {
      const reportId = deriveRollbackReportId({
        generationId: input.generationId,
        effectId: pending.effectId,
        kind: "rollback",
      });
      const reportCreatedAt = now().toISOString();
      const report = writeRollbackReport(input.homeDir, {
        version: 1,
        reportId,
        generationId: input.generationId,
        effectId: pending.effectId,
        kind: "rollback",
        eligibility: working.rollbackLineage.mode ?? null,
        mode: working.rollbackLineage.mode ?? "post-write",
        epochId: null,
        attemptId: null,
        sealedPublicationMaterialDigestSha256: null,
        reason: null,
      });
      working = publishManifest(store, input.generationId, working, completeMigrationEffect(working, {
        effectId: pending.effectId,
        completedAt: now().toISOString(),
        report: { kind: "rollback", reportId: report.reportId, reportSha256: report.checksumSha256, createdAt: reportCreatedAt },
        rollbackMode: working.rollbackLineage.mode ?? "post-write",
      }));
      return { manifest: working, report };
    }

    if (maintenance !== null && (maintenance.phase === "maintenance-held" || maintenance.phase === "maintenance-entering")) {
      await deps.coordinator.abortMaintenance({
        expectedChecksumSha256: maintenance.checksumSha256,
        sourceSelectionSha256: input.sourceSelectionSha256,
        abortEvidenceSha256: sha256(canonicalJson(["rollback-recovery-abort-v1", input.generationId, pending.effectId])),
      }, token);
    } else if (maintenance !== null && maintenance.phase === "selection-completed") {
      // The unimplemented reconciliation case -- see this function's doc
      // comment. Refuse loudly rather than mutate an unverified selection.
      throw new RollbackOrchestrationError(
        "not-implemented",
        "publish-rollback must be abandoned but the maintenance journal is already durably "
          + "selection-completed for a different or ambiguous target; re-selecting postgresql "
          + "requires a mechanism this item has not implemented -- see this item's status report",
      );
    }

    const reportId = deriveRollbackReportId({
      generationId: input.generationId,
      effectId: pending.effectId,
      kind: "abandonment",
    });
    const reportCreatedAt = now().toISOString();
    const report = writeRollbackReport(input.homeDir, {
      version: 1,
      reportId,
      generationId: input.generationId,
      effectId: pending.effectId,
      kind: "abandonment",
      eligibility: null,
      mode: null,
      epochId: null,
      attemptId: null,
      sealedPublicationMaterialDigestSha256: null,
      reason: "publish-rollback recovery could not prove the selection completed",
    });
    working = publishManifest(store, input.generationId, working, abandonMigrationEffect(working, {
      effectId: pending.effectId,
      abandonedAt: now().toISOString(),
      report: {
        kind: "abandonment",
        reportId: report.reportId,
        reportSha256: report.checksumSha256,
        createdAt: reportCreatedAt,
      },
    }));
    return { manifest: working, report };
  });
}

import { randomUUID } from "node:crypto";
import {
  resolveMigrationExpectedIdentity,
  resolveMigrationPreflight,
  type MigrationIdentityPreview,
  type MigrationPreflightResult,
  migrationIdentityPreview,
} from "./cli-preflight.js";
import {
  performMigrationApplyThroughCapture,
  type MigrationApplyThroughCaptureOutcome,
} from "./apply.js";
import {
  performMigrationApplyGenesisAndCopy,
  type MigrationApplyGenesisAndCopyOutcome,
} from "./apply-genesis-copy.js";
import { MigrationManifestStore } from "./manifest-store.js";
import { MigrationProtocolError } from "./protocol.js";
import { MIGRATION_UNEXPECTED_FAILURE_REASON, withMigrationBoundary } from "./boundary.js";
import type { MigrationDaemonPresence } from "./daemon-presence.js";
import type { BackendPublicationCoordinator } from "../storage/backend-publication.js";

/**
 * The `apply` command's CLI orchestration (section 3): the entry point.
 * Composes, in order: the same shared preflight `plan` uses (never a
 * second implementation -- see `cli-preflight.ts`'s own module doc), the
 * section 9 confirmation fence, capture through the hold
 * (`performMigrationApplyThroughCapture`), and manifest genesis and copy
 * (`performMigrationApplyGenesisAndCopy`) with the three ownership
 * parameters settled and proven in this candidate's own history:
 * `expectedOwner` from the resolved target's `migrationRole`,
 * `expectedIdentity` from the shared preflight's own
 * `resolveStorageIdentityContext` call (never re-derived), and
 * `ownerProcessId` as a fresh `randomUUID()` minted once per invocation
 * (proven independent of resume via a real-PostgreSQL interrupt-and-resume
 * test using three genuinely distinct owner ids across its three legs).
 *
 * **Section 9's genesis-and-two-observation fence.** The operator-supplied
 * `confirmGenerationId` (what `plan` printed at an earlier moment) and the
 * freshly re-run preflight's candidate id (what is true now) are two
 * independent observations in time, not two implementations of one
 * predicate -- corrupt either side (a stale token, or a state change
 * between `plan` and `apply`) and the fence still catches it. A missing
 * token refuses like any other missing confirmation; a moved candidate
 * refuses distinctly. Neither check is skipped or weakened by the other:
 * `performMigrationApplyThroughCapture`'s own internal
 * `resolveConfirmedMigrationGenerationId` layer-2 recheck, and capture's
 * own post-sampling reclassification, both still run underneath this
 * fence, unconditionally -- the fence guards against an operator acting on
 * a stale id; it does not, and must not, replace the independent defences
 * against a race the fence itself cannot see.
 *
 * `--dry-run` (section 9) stops after the fence, before any hold is taken:
 * the envelope reports the confirmed candidate with `applied: false`,
 * proved not to reach a mutating seam because `performMigrationApplyThroughCapture`
 * is never called on that path.
 */

export const DEFAULT_MIGRATION_APPLY_MAX_RECORDS = 500;
export const DEFAULT_MIGRATION_APPLY_MAX_BYTES = 16 * 1024 * 1024;

/** The two presence answers that reach an ok outcome; `unresolvable` refuses upstream. */
export type MigrationApplyDaemonPresence = Extract<
  MigrationDaemonPresence,
  { status: "present" } | { status: "authoritatively-absent" }
>;

export type MigrationApplyOutcome =
  | Readonly<{
    status: "ok";
    generationId: string;
    applied: boolean;
    phase?: string;
    /** The preflight's daemon-presence answer, carried into the exit-0 evidence (round-1 A-8). */
    daemonPresence: MigrationApplyDaemonPresence;
    /** Present only for `--dry-run`: what apply would mint, reported without minting it. */
    identityPreview?: MigrationIdentityPreview;
  }>
  | Readonly<{ status: "refuse"; reason: string; evidence?: string }>;

export type MigrationApplyOperations = Readonly<{
  performCapture: typeof performMigrationApplyThroughCapture;
  performGenesisAndCopy: typeof performMigrationApplyGenesisAndCopy;
  mintOwnerProcessId: () => string;
  resolveExpectedIdentity: typeof resolveMigrationExpectedIdentity;
}>;

export type MigrationApplyInput = Readonly<{
  cwd: string;
  homeDir: string;
  confirmGenerationId?: string;
  dryRun?: boolean;
  maxRecords?: number;
  maxBytes?: number;
  coordinator?: BackendPublicationCoordinator;
  manifestStore?: MigrationManifestStore;
  now?: Date;
  /**
   * Called once, before the confirmation fence and any write, when the
   * preflight observed a running daemon, so the operator hears about the
   * fenced consumer before the hold is taken (round-1 A-8).
   */
  onDaemonObserved?: (presence: Extract<MigrationDaemonPresence, { status: "present" }>) => void;
  /**
   * @internal Test-only escape hatch, matching `cli-plan.ts`'s own
   * convention, to reuse `resolveMigrationPreflight`'s injection seam
   * without duplicating its composition here.
   */
  _preflight?: () => Promise<MigrationPreflightResult>;
  /**
   * @internal Deterministic failure-injection seam for tests only, matching
   * the `_operationsForTesting` convention used elsewhere in
   * `src/migration/`.
   */
  _operationsForTesting?: Partial<MigrationApplyOperations>;
}>;

export function performMigrationApply(input: MigrationApplyInput): Promise<MigrationApplyOutcome> {
  return withMigrationBoundary(
    () => runMigrationApply(input),
    (evidence) => ({ status: "refuse", reason: MIGRATION_UNEXPECTED_FAILURE_REASON, evidence }),
  );
}

async function runMigrationApply(input: MigrationApplyInput): Promise<MigrationApplyOutcome> {
  const performCapture = input._operationsForTesting?.performCapture ?? performMigrationApplyThroughCapture;
  const performGenesisAndCopy = input._operationsForTesting?.performGenesisAndCopy ?? performMigrationApplyGenesisAndCopy;
  const mintOwnerProcessId = input._operationsForTesting?.mintOwnerProcessId ?? randomUUID;
  const resolveExpectedIdentity = input._operationsForTesting?.resolveExpectedIdentity ?? resolveMigrationExpectedIdentity;

  const runPreflight = input._preflight ?? (() => resolveMigrationPreflight({ cwd: input.cwd, homeDir: input.homeDir }));
  const preflight = await runPreflight();
  if (preflight.status === "refuse") {
    return preflight;
  }
  const daemonPresence = preflight.presence;
  if (daemonPresence.status === "present") input.onDaemonObserved?.(daemonPresence);

  // Section 9's confirmation fence: a missing token refuses like any other
  // missing confirmation; a moved candidate refuses distinctly. Neither is
  // a guess -- both reasons are already in refusal-mapping.ts's table.
  if (input.confirmGenerationId === undefined) {
    return { status: "refuse", reason: "confirmation-missing" };
  }
  if (input.confirmGenerationId !== preflight.candidate.generationId) {
    return { status: "refuse", reason: "confirmation-generation-moved" };
  }

  if (input.dryRun === true) {
    return {
      status: "ok", generationId: preflight.candidate.generationId, applied: false, daemonPresence,
      identityPreview: migrationIdentityPreview(preflight),
    };
  }

  // Only now, past the fence, may anything be minted (plan-v5 Part B (3)).
  const identity = await resolveExpectedIdentity({ preflight, cwd: input.cwd, homeDir: input.homeDir });
  if (identity.status === "refuse") return identity;

  const captureResult: MigrationApplyThroughCaptureOutcome = await performCapture({
    cwd: input.cwd,
    homeDir: input.homeDir,
    base: preflight.base,
    confirmGenerationId: input.confirmGenerationId,
    coordinator: input.coordinator,
    manifestStore: input.manifestStore,
    now: input.now,
  });
  if (captureResult.status === "refuse") {
    return captureResult;
  }

  const ownerProcessId = mintOwnerProcessId();
  const manifestStore = input.manifestStore ?? new MigrationManifestStore({ homeDir: input.homeDir });
  const genesisCopyResult: MigrationApplyGenesisAndCopyOutcome = await performGenesisAndCopy({
    homeDir: input.homeDir,
    generationId: captureResult.generationId,
    maintenanceChecksumSha256: captureResult.maintenanceChecksumSha256,
    settings: preflight.targetConfig.postgresql,
    expectedOwner: preflight.targetConfig.postgresql.migrationRole,
    expectedIdentity: identity.expectedIdentity,
    ownerProcessId,
    maxRecords: input.maxRecords ?? DEFAULT_MIGRATION_APPLY_MAX_RECORDS,
    maxBytes: input.maxBytes ?? DEFAULT_MIGRATION_APPLY_MAX_BYTES,
    manifestStore,
    now: input.now,
  });
  if (genesisCopyResult.status === "refuse") {
    return genesisCopyResult;
  }

  // Plan section 5.1 / round-1 A-16: the manifest head is read back, and the
  // phase the envelope reports is the one read, not the copy layer's own
  // return value.
  let head;
  try {
    head = manifestStore.read(captureResult.generationId);
  } catch (error) {
    return {
      status: "refuse",
      reason: "manifest-unresolvable",
      evidence: error instanceof MigrationProtocolError ? `manifest-${error.reason}` : "manifest-internal-error",
    };
  }
  if (head.phase !== genesisCopyResult.result.phase) {
    return { status: "refuse", reason: "copy-failed", evidence: "manifest-readback-mismatch" };
  }

  return {
    status: "ok",
    generationId: captureResult.generationId,
    applied: true,
    phase: head.phase,
    daemonPresence,
  };
}

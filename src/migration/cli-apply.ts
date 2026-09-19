import { randomUUID } from "node:crypto";
import { resolveMigrationPreflight, type MigrationPreflightResult } from "./cli-preflight.js";
import {
  performMigrationApplyThroughCapture,
  type MigrationApplyThroughCaptureOutcome,
} from "./apply.js";
import {
  performMigrationApplyGenesisAndCopy,
  type MigrationApplyGenesisAndCopyOutcome,
} from "./apply-genesis-copy.js";
import { MigrationManifestStore } from "./manifest-store.js";
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

export type MigrationApplyOutcome =
  | Readonly<{
    status: "ok";
    generationId: string;
    applied: boolean;
    phase?: string;
  }>
  | Readonly<{ status: "refuse"; reason: string; evidence?: string }>;

export type MigrationApplyOperations = Readonly<{
  performCapture: typeof performMigrationApplyThroughCapture;
  performGenesisAndCopy: typeof performMigrationApplyGenesisAndCopy;
  mintOwnerProcessId: () => string;
}>;

export async function performMigrationApply(input: Readonly<{
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
}>): Promise<MigrationApplyOutcome> {
  const performCapture = input._operationsForTesting?.performCapture ?? performMigrationApplyThroughCapture;
  const performGenesisAndCopy = input._operationsForTesting?.performGenesisAndCopy ?? performMigrationApplyGenesisAndCopy;
  const mintOwnerProcessId = input._operationsForTesting?.mintOwnerProcessId ?? randomUUID;

  const runPreflight = input._preflight ?? (() => resolveMigrationPreflight({ cwd: input.cwd, homeDir: input.homeDir }));
  const preflight = await runPreflight();
  if (preflight.status === "refuse") {
    return preflight;
  }

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
    return { status: "ok", generationId: preflight.candidate.generationId, applied: false };
  }

  const captureResult: MigrationApplyThroughCaptureOutcome = await performCapture({
    cwd: input.cwd,
    homeDir: input.homeDir,
    base: preflight.base,
    coordinator: input.coordinator,
    manifestStore: input.manifestStore,
    now: input.now,
  });
  if (captureResult.status === "refuse") {
    return captureResult;
  }

  const ownerProcessId = mintOwnerProcessId();
  const genesisCopyResult: MigrationApplyGenesisAndCopyOutcome = await performGenesisAndCopy({
    homeDir: input.homeDir,
    generationId: captureResult.generationId,
    maintenanceChecksumSha256: captureResult.maintenanceChecksumSha256,
    settings: preflight.targetConfig.postgresql,
    expectedOwner: preflight.targetConfig.postgresql.migrationRole,
    expectedIdentity: preflight.expectedIdentity,
    ownerProcessId,
    maxRecords: input.maxRecords ?? DEFAULT_MIGRATION_APPLY_MAX_RECORDS,
    maxBytes: input.maxBytes ?? DEFAULT_MIGRATION_APPLY_MAX_BYTES,
    manifestStore: input.manifestStore ?? new MigrationManifestStore({ homeDir: input.homeDir }),
    now: input.now,
  });
  if (genesisCopyResult.status === "refuse") {
    return genesisCopyResult;
  }

  return {
    status: "ok",
    generationId: captureResult.generationId,
    applied: true,
    phase: genesisCopyResult.result.phase,
  };
}

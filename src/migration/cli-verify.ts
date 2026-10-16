import { MigrationManifestStore } from "./manifest-store.js";
import { MigrationProtocolError } from "./protocol.js";
import {
  completePendingMigrationVerification,
  MigrationVerificationDriverError,
} from "./verify-generation.js";
import { MigrationVerificationReportStore, MigrationVerificationStoreError } from "./verification-store.js";
import { MIGRATION_UNEXPECTED_FAILURE_REASON, withMigrationBoundary } from "./boundary.js";
import {
  admitExistingMigrationCommand,
  refuseUnlessConfirmed,
} from "./cli-existing.js";
import type { MigrationEvidence } from "./envelope.js";
import type { ExistingGenerationInput } from "./existing-generation.js";

/**
 * The `verify` command's CLI orchestration (plan-v4 section 5 as amended by
 * plan-v5 Part B (2)). It owns two router cells and borrows a third:
 *
 * - **Row 23** (pending `verify-generation`): `completePendingMigrationVerification`,
 *   the persisted-report shortcut `verifyMigrationGeneration` has always had.
 *   It needs no destination, project map, lease or identity, so it works with
 *   PostgreSQL down. Exit 0 requires the read-back below, never the call's own
 *   return value.
 * - **Row 24** (already `verified`, nothing pending; `verify` is allowed there
 *   by owner ruling R9): an idempotent confirmation from persisted evidence.
 *   Nothing is written.
 * - **Row 22** (`copied`, nothing pending): the fresh computation, which needs
 *   #625's `computeMigrationProjectMapWitnessSha256`. That function is not in
 *   this build, and no value is invented in its place, so the command refuses
 *   with the closed reason `requires-625-project-map-witness` (exit 7) and
 *   changes nothing. The lease and the source append barrier belong to that
 *   path; none is taken here, which the envelope's `coordinationEffects`
 *   states.
 *
 * Owner check, then the `--confirm-generation` fence, then the first read of
 * persisted evidence; each reads only, so a refusal leaves durable state
 * byte-identical.
 */

export type MigrationVerifyCommandOutcome =
  | Readonly<{
    status: "ok";
    generationId: string;
    manifestPhase: string;
    applied: boolean;
    /** The command to run next, or null when nothing in this build follows. */
    next: string | null;
    evidence: MigrationEvidence;
  }>
  | Readonly<{
    status: "refuse";
    reason: string;
    evidence?: string;
    generationId?: string;
    next?: string | null;
    /** True only when a durable write preceded this refusal. */
    applied?: true;
  }>;

type VerifyRefusal = Extract<MigrationVerifyCommandOutcome, { status: "refuse" }>;

export type MigrationVerifyCommandOperations = Readonly<{
  completePending: typeof completePendingMigrationVerification;
  admit: typeof admitExistingMigrationCommand;
}>;

export type MigrationVerifyCommandInput = Readonly<{
  homeDir: string;
  generation?: string;
  confirmGenerationId?: string;
  dryRun?: boolean;
  manifestStore?: MigrationManifestStore;
  reportStore?: MigrationVerificationReportStore;
  /** @internal Test-only seam into the generation resolver. */
  _resolution?: Pick<ExistingGenerationInput, "_operationsForTesting">;
  /** @internal Deterministic failure-injection seam for tests only. */
  _operationsForTesting?: Partial<MigrationVerifyCommandOperations>;
}>;

export function performMigrationVerifyCommand(input: MigrationVerifyCommandInput): Promise<MigrationVerifyCommandOutcome> {
  return withMigrationBoundary(
    () => runMigrationVerifyCommand(input),
    // An unclassified throw cannot rule out that the completion had been written.
    (evidence) => ({ status: "refuse", reason: MIGRATION_UNEXPECTED_FAILURE_REASON, evidence, applied: true }),
  );
}

/** The verification driver's typed reasons that row 23 can reach, mapped to the closed table. */
const DRIVER_REASONS: ReadonlySet<string> = new Set(["report-identity-conflict", "destination-drift", "invalid-input"]);

function persistedEvidenceRefusal(generationId: string, reason: string, evidence: string): VerifyRefusal {
  return { status: "refuse", reason, evidence, generationId };
}

/**
 * Reads the manifest and its verification report back and requires them to
 * agree: phase `verified`, nothing pending, the last verification report
 * reference naming a persisted report that is activation-eligible. Returns the
 * evidence for an ok outcome or a refusal.
 */
function readVerifiedEvidence(
  generationId: string,
  manifestStore: MigrationManifestStore,
  reportStore: MigrationVerificationReportStore,
  expectedReportSha256: string | null,
): Readonly<{ status: "verified"; evidence: MigrationEvidence }> | VerifyRefusal {
  try {
    const manifest = manifestStore.read(generationId);
    const reference = [...manifest.reports].reverse().find((report) => report.kind === "verification");
    if (manifest.phase !== "verified" || manifest.pendingEffect !== null || reference === undefined) {
      return persistedEvidenceRefusal(generationId, "verify-readback-mismatch", `manifest-${manifest.phase}`);
    }
    const report = reportStore.read(generationId, reference.reportSha256);
    if (!report.activationEligible) {
      return persistedEvidenceRefusal(generationId, "verify-readback-mismatch", "report-not-eligible");
    }
    if (reference.reportSha256 !== report.reportSha256
      || reference.reportId !== report.reportId
      || (expectedReportSha256 !== null && expectedReportSha256 !== report.reportSha256)) {
      return persistedEvidenceRefusal(generationId, "verify-readback-mismatch", "report-reference-mismatch");
    }
    return {
      status: "verified",
      evidence: {
        reportId: report.reportId,
        reportSha256: report.reportSha256,
        activationEligible: report.activationEligible,
      },
    };
  } catch (error) {
    if (error instanceof MigrationProtocolError) {
      return persistedEvidenceRefusal(generationId, "manifest-unresolvable", `manifest-${error.reason}`);
    }
    if (error instanceof MigrationVerificationStoreError) {
      return persistedEvidenceRefusal(generationId, "verify-report-unresolvable", `report-${error.reason}`);
    }
    throw error;
  }
}

async function runMigrationVerifyCommand(input: MigrationVerifyCommandInput): Promise<MigrationVerifyCommandOutcome> {
  const completePending = input._operationsForTesting?.completePending ?? completePendingMigrationVerification;
  const admit = input._operationsForTesting?.admit ?? admitExistingMigrationCommand;
  const manifestStore = input.manifestStore ?? new MigrationManifestStore({ homeDir: input.homeDir });
  const reportStore = input.reportStore ?? new MigrationVerificationReportStore({ homeDir: input.homeDir });

  const admission = await admit({
    command: "verify",
    homeDir: input.homeDir,
    ...(input.generation === undefined ? {} : { generation: input.generation }),
    resolution: { manifestStore, ...input._resolution },
  });
  if (admission.status === "refuse") return admission;
  const { context } = admission;
  const generationId = context.generationId;

  const unconfirmed = refuseUnlessConfirmed({ expectedGenerationId: generationId, confirmGenerationId: input.confirmGenerationId });
  if (unconfirmed !== null) return unconfirmed;

  switch (context.route.row) {
    case 22:
      // The fresh computation needs #625's project-map witness, which this
      // build does not have. Nothing was read beyond routing, nothing is written.
      return { status: "refuse", reason: "requires-625-project-map-witness", generationId };

    case 24: {
      const confirmed = readVerifiedEvidence(generationId, manifestStore, reportStore, null);
      if (confirmed.status !== "verified") return confirmed;
      return {
        status: "ok", generationId, manifestPhase: "verified", applied: false, next: "report",
        evidence: { ...confirmed.evidence, cell: 24, coordinationEffects: "none" },
      };
    }

    case 23: {
      if (input.dryRun === true) {
        // Route-only: completing the pending effect writes the manifest, and
        // the checks it makes cannot be run without that write. Nothing here
        // is predicted, which the evidence says.
        return {
          status: "ok", generationId, manifestPhase: context.manifest!.phase, applied: false,
          next: "verify (drop --dry-run to complete)",
          evidence: { cell: 23, predictive: false, pendingEffect: "verify-generation", coordinationEffects: "none" },
        };
      }
      let completed;
      try {
        completed = completePending({ homeDir: input.homeDir, generationId });
      } catch (error) {
        if (error instanceof MigrationVerificationDriverError && DRIVER_REASONS.has(error.reason)) {
          return { status: "refuse", reason: `verify-${error.reason}`, generationId };
        }
        if (error instanceof MigrationProtocolError) {
          return persistedEvidenceRefusal(generationId, "manifest-unresolvable", `manifest-${error.reason}`);
        }
        if (error instanceof MigrationVerificationStoreError) {
          return persistedEvidenceRefusal(generationId, "verify-report-unresolvable", `report-${error.reason}`);
        }
        throw error;
      }
      if (completed === null) {
        // The router saw a pending verify-generation effect a moment ago and
        // the driver does not: the manifest moved underneath this command.
        return persistedEvidenceRefusal(generationId, "verify-readback-mismatch", "pending-effect-moved");
      }
      const confirmed = readVerifiedEvidence(generationId, manifestStore, reportStore, completed.report.reportSha256);
      if (confirmed.status !== "verified") return { ...confirmed, applied: true };
      return {
        status: "ok", generationId, manifestPhase: "verified", applied: true, next: "report",
        evidence: { ...confirmed.evidence, cell: 23, coordinationEffects: "none" },
      };
    }

    default:
      // The router admitted `verify` only at rows 22 to 24. Anything else is a
      // defect in the router or here, never a state to guess about.
      throw new Error(`verify was admitted at an unexpected router row`);
  }
}


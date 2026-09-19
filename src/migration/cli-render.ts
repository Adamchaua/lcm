import type { MigrationCommandName } from "./exit-classes.js";
import { migrationExitClassForName, migrationExitClassForCode } from "./exit-classes.js";
import { migrationRefusalMapping } from "./refusal-mapping.js";
import {
  buildMigrationEnvelope,
  type MigrationEnvelope,
  type MigrationEvidence,
} from "./envelope.js";
import type { MigrationPlanOutcome } from "./cli-plan.js";
import type { MigrationDryRunOutcome } from "./cli-dry-run.js";
import { migrationDryRunEvidence } from "./cli-dry-run.js";
import type { MigrationApplyOutcome } from "./cli-apply.js";
import type { MigrationAbortCommandOutcome } from "./cli-abort.js";

/**
 * The single place every migration command's own outcome type is turned
 * into section 10's envelope. Deliberately separate from `bin/lcm.ts`'s
 * Commander wiring so every branch here is unit-testable without
 * constructing a real CLI invocation -- the CLI action handlers become
 * thin glue: call the orchestration function, call the matching
 * `render*` function here, write the result, set `process.exitCode`.
 *
 * A refusal reason not present in `MIGRATION_REFUSAL_REASONS` throws
 * (via `migrationRefusalMapping`) rather than silently defaulting an exit
 * class -- an unclassified refusal reaching this layer is a defect in the
 * table, not something to paper over with a guessed code.
 */

/**
 * The known set of `apply`'s own refusal reasons that occur strictly
 * after capture has already durably taken the hold and written a
 * snapshot -- `capture-failed` (a held, partially-captured state) and
 * every genesis/copy-stage failure (`genesis-*`, `copy-failed`), which
 * only run after capture already succeeded in the same invocation. Every
 * other apply refusal reason (preflight, confirmation fence, journal
 * resolution) occurs before any durable mutation in this invocation.
 * `applied` in the envelope reports this distinction so an operator
 * reading a failed `apply` knows whether state moved.
 */
const APPLY_REASONS_WITH_DURABLE_MUTATION: ReadonlySet<string> = new Set([
  "capture-failed",
  "genesis-inspection-failed",
  "genesis-create-failed",
  "genesis-dry-run-begin-failed",
  "genesis-dry-run-complete-failed",
  "copy-failed",
]);

function refusalEnvelope(input: Readonly<{
  command: MigrationCommandName;
  reason: string;
  evidenceDetail?: string;
  applied: boolean;
  generation?: string | null;
  manifestPhase?: string | null;
}>): MigrationEnvelope {
  const mapping = migrationRefusalMapping(input.reason);
  const evidence: MigrationEvidence = input.evidenceDetail === undefined
    ? {}
    : { detail: input.evidenceDetail };
  return buildMigrationEnvelope({
    command: input.command,
    outcome: mapping.exitClass,
    exitCode: migrationExitClassForName(mapping.exitClass).code,
    generation: input.generation ?? null,
    manifestPhase: input.manifestPhase ?? null,
    applied: input.applied,
    next: null,
    evidence,
    refusal: { reason: input.reason, remedy: mapping.remedy },
    restart: null,
  });
}

function okEnvelope(input: Readonly<{
  command: MigrationCommandName;
  applied: boolean;
  generation?: string | null;
  manifestPhase?: string | null;
  next?: string | null;
  evidence?: MigrationEvidence;
}>): MigrationEnvelope {
  return buildMigrationEnvelope({
    command: input.command,
    outcome: "ok",
    exitCode: migrationExitClassForCode(0).code,
    generation: input.generation ?? null,
    manifestPhase: input.manifestPhase ?? null,
    applied: input.applied,
    next: input.next ?? null,
    evidence: input.evidence ?? {},
    refusal: null,
    restart: null,
  });
}

export function renderMigrationPlanEnvelope(outcome: MigrationPlanOutcome): MigrationEnvelope {
  if (outcome.status === "refuse") {
    return refusalEnvelope({
      command: "plan", reason: outcome.reason, evidenceDetail: outcome.evidence, applied: false,
    });
  }
  return okEnvelope({
    command: "plan",
    applied: false,
    generation: outcome.generationId,
    next: "apply",
    evidence: {
      disposition: outcome.disposition,
      daemonPresent: outcome.daemonPresence.status === "present",
      ...(outcome.daemonPresence.status === "present"
        ? { daemonStorageBackend: outcome.daemonPresence.storageBackend }
        : {}),
    },
  });
}

export function renderMigrationDryRunEnvelope(outcome: MigrationDryRunOutcome): MigrationEnvelope {
  if (outcome.status === "refuse") {
    return refusalEnvelope({
      command: "dry-run", reason: outcome.reason, evidenceDetail: outcome.evidence, applied: false,
    });
  }
  return okEnvelope({
    command: "dry-run",
    applied: false,
    evidence: migrationDryRunEvidence(outcome.dryRun),
  });
}

export function renderMigrationApplyEnvelope(outcome: MigrationApplyOutcome): MigrationEnvelope {
  if (outcome.status === "refuse") {
    return refusalEnvelope({
      command: "apply",
      reason: outcome.reason,
      evidenceDetail: outcome.evidence,
      applied: APPLY_REASONS_WITH_DURABLE_MUTATION.has(outcome.reason),
    });
  }
  return okEnvelope({
    command: "apply",
    applied: outcome.applied,
    generation: outcome.generationId,
    manifestPhase: outcome.phase ?? null,
    next: outcome.applied ? null : "apply (drop --dry-run to copy for real)",
  });
}

export function renderMigrationAbortEnvelope(outcome: MigrationAbortCommandOutcome): MigrationEnvelope {
  if (outcome.status === "refuse") {
    return refusalEnvelope({
      command: "abort", reason: outcome.reason, evidenceDetail: outcome.evidence, applied: false,
    });
  }
  return okEnvelope({
    command: "abort",
    applied: true,
    generation: outcome.generationId,
    manifestPhase: outcome.manifestPhase,
    evidence: { journalPhase: outcome.journalPhase },
  });
}


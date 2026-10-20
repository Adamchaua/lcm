import { isTerminalBackendMaintenancePhase } from "../storage/backend-publication.js";
import { readDaemonConfigSnapshot, type StorageBackend } from "../daemon/config.js";
import { configPath, daemonPidPath } from "../runtime-paths.js";
import { checkActivationRestartAdmission, type ActivationRestartCheckResult } from "./activation-restart-check.js";
import { classifyMigrationDaemonPresence, type MigrationDaemonPresence } from "./daemon-presence.js";
import { combineMigrationRestart, type MigrationRestartClass } from "./cli-restart.js";
import { classifyMigrationRecovery } from "./protocol.js";
import { MigrationVerificationReportStore } from "./verification-store.js";
import { MIGRATION_UNEXPECTED_FAILURE_REASON, unexpectedFailureEvidence, withMigrationBoundary } from "./boundary.js";
import type { MigrationEnvelopeRestart, MigrationEvidence } from "./envelope.js";
import { resolveExistingMigrationGeneration, type ExistingGenerationContext, type ExistingGenerationInput } from "./existing-generation.js";
import { observeMigrationMaintenanceJournal } from "./journal-observation.js";
import { MigrationManifestStore } from "./manifest-store.js";

/**
 * The `report` command's CLI orchestration (plan-v4 section 7 as amended by
 * plan-v5 Part B, "section 7 selected backend"). It only reads. It runs no
 * preflight and takes no consumer lock, publication lock, append barrier,
 * lease or write lock, and it mints nothing; the journal is read with the
 * plain readers, never the consumer variant that serializes with writers.
 *
 * It resolves the generation (the journal's own when it is terminal and none
 * is named, so a report after an abort needs no flag), shows what each
 * reader saw as ids, digests, phases and booleans, and names `nextAction`
 * from the same router `resume` and the mutating commands use, so the three
 * cannot disagree. Readers that belong to #625 and #626 print
 * `not-available-in-this-build` until those merge.
 *
 * **Exit codes.** 0 when the generation was read and no contradiction was
 * found; 2 when the generation cannot be resolved; 4 for a foreign
 * publication in flight; 5 for unresolvable or contradictory evidence,
 * including either restart observation that cannot be made; 8 when the
 * durable selection is correct but a live daemon still holds the stale
 * startup backend. Every non-zero exit still prints what was read.
 *
 * **Restart.** The checker is called only when a selection is already
 * durable (manifest `active` is postgresql; manifest `rolled-back` or the
 * settled abort of row 5 is sqlite; a `selection-completed` hold names its
 * own `targetBackend`). Its verdict and the daemon presence are two
 * observations and neither decides alone (plan-v4 section 7's matrix).
 */

export const NOT_AVAILABLE_IN_THIS_BUILD = "not-available-in-this-build";

export type MigrationReportOutcome = Readonly<{
  /** Absent for a report that was read; a closed reason when the exit is non-zero. */
  reason?: string;
  generationId: string | null;
  manifestPhase: string | null;
  next: string | null;
  evidence: MigrationEvidence;
  restart: MigrationEnvelopeRestart | null;
}>;

export type MigrationReportCommandOperations = Readonly<{
  resolve: typeof resolveExistingMigrationGeneration;
  checkRestart: typeof checkActivationRestartAdmission;
  classifyPresence: typeof classifyMigrationDaemonPresence;
  readDaemonPort: (homeDir: string) => number;
}>;

export type MigrationReportCommandInput = Readonly<{
  homeDir: string;
  generation?: string;
  manifestStore?: MigrationManifestStore;
  reportStore?: MigrationVerificationReportStore;
  /** @internal Test-only seam into the generation resolver. */
  _resolution?: Pick<ExistingGenerationInput, "_operationsForTesting">;
  /** @internal Deterministic failure-injection seam for tests only. */
  _operationsForTesting?: Partial<MigrationReportCommandOperations>;
}>;

export function performMigrationReportCommand(input: MigrationReportCommandInput): Promise<MigrationReportOutcome> {
  return withMigrationBoundary(
    () => runMigrationReportCommand(input),
    // A report writes nothing, so an unclassified throw is never applied.
    (evidence) => ({ reason: MIGRATION_UNEXPECTED_FAILURE_REASON, generationId: null, manifestPhase: null, next: null, evidence: { detail: evidence }, restart: null }),
  );
}

/** Rows the router gives no owner and no way forward: the report still prints, but it exits non-zero. */
const REPORT_ROW_REASONS: Readonly<Record<number, string>> = Object.freeze({
  1: "route-unresolvable",
  2: "route-publication-in-flight",
  3: "route-foreign-publication",
  9: "route-contradiction",
  25: "route-contradiction",
});

function journalEvidence(context: ExistingGenerationContext): MigrationEvidence {
  const observation = context.journal;
  switch (observation.kind) {
    case "hold":
      return { journalKind: "hold", journalPhase: observation.journal.phase, journalGeneration: observation.journal.generationId };
    case "publication":
      return { journalKind: "publication", journalPhase: observation.phase };
    default:
      return { journalKind: observation.kind };
  }
}

function manifestEvidence(context: ExistingGenerationContext): MigrationEvidence {
  const { manifest } = context;
  if (manifest === null) return { manifestPresent: false, recovery: "none", pendingEffect: null };
  return {
    manifestPresent: true,
    manifestRevision: manifest.revision,
    recovery: classifyMigrationRecovery(manifest).action,
    pendingEffect: manifest.pendingEffect?.kind ?? null,
    activationEligible: manifest.activationEligible,
  };
}

function verificationEvidence(
  context: ExistingGenerationContext,
  reportStore: MigrationVerificationReportStore,
): MigrationEvidence {
  const reference = [...(context.manifest?.reports ?? [])].reverse().find((report) => report.kind === "verification");
  if (reference === undefined) return { verificationReport: "absent" };
  try {
    const report = reportStore.read(context.generationId, reference.reportSha256);
    return {
      verificationReport: "present",
      verificationReportSha256: report.reportSha256,
      verificationClean: report.clean,
      verificationActivationEligible: report.activationEligible,
      verificationMismatchTotal: report.mismatchTotals.reduce((sum, entry) => sum + entry.count, 0),
      verificationClassCoverageComplete: report.body.classCoverage.every((entry) => entry.ran),
      verificationPublicProbeCoverageComplete: report.body.publicProbeCoverage.every((entry) => entry.ran),
    };
  } catch {
    // The reference exists but the report cannot be read: shown as such, with no message.
    return { verificationReport: "unreadable", verificationReportSha256: reference.reportSha256 };
  }
}

/** The backend a durable selection names, `null` when none is durable, or `"unresolvable"`. */
function selectedBackend(context: ExistingGenerationContext): StorageBackend | null | "unresolvable" {
  const phase = context.manifest?.phase;
  if (phase === "active") return "postgresql";
  if (phase === "rolled-back" || context.route.row === 5) return "sqlite";
  if (context.journal.kind === "hold" && context.journal.journal.phase === "selection-completed") {
    return context.journal.journal.targetBackend ?? "unresolvable";
  }
  return null;
}

type RestartOutcome = Readonly<{ reason?: string; restart: MigrationEnvelopeRestart | null; evidence: MigrationEvidence }>;

const REPORT_RESTART_REASONS: Readonly<Record<Exclude<MigrationRestartClass, "ok">, string>> = Object.freeze({
  required: "report-restart-required",
  contradiction: "report-restart-contradiction",
  unresolvable: "report-restart-unresolvable",
});

function combineRestart(
  verdict: ActivationRestartCheckResult,
  presence: MigrationDaemonPresence,
  selected: StorageBackend,
): RestartOutcome {
  const combined = combineMigrationRestart(verdict, presence, selected);
  return {
    ...(combined.class === "ok" ? {} : { reason: REPORT_RESTART_REASONS[combined.class] }),
    restart: combined.restart,
    evidence: combined.evidence,
  };
}

async function restartEvidence(
  context: ExistingGenerationContext,
  homeDir: string,
  ops: Partial<MigrationReportCommandOperations> | undefined,
): Promise<RestartOutcome> {
  const selected = selectedBackend(context);
  if (selected === null) return { restart: null, evidence: { selectedBackend: null } };
  if (selected === "unresolvable") {
    return { reason: "report-selection-unresolvable", restart: null, evidence: { selectedBackend: null } };
  }
  const checkRestart = ops?.checkRestart ?? checkActivationRestartAdmission;
  const classifyPresence = ops?.classifyPresence ?? classifyMigrationDaemonPresence;
  const readDaemonPort = ops?.readDaemonPort ?? ((home: string) => readDaemonConfigSnapshot(configPath(home)).config.daemon.port);
  let verdict: ActivationRestartCheckResult;
  let presence: MigrationDaemonPresence;
  try {
    verdict = await checkRestart({ selectedBackend: selected, pidFilePath: daemonPidPath(homeDir), port: readDaemonPort(homeDir) });
    presence = await classifyPresence({ homeDir });
  } catch (error) {
    // Either observation failing closes the report: it is never read as "satisfied".
    return {
      reason: "report-restart-unresolvable", restart: null,
      evidence: { selectedBackend: selected, restartObservation: unexpectedFailureEvidence(error) },
    };
  }
  return combineRestart(verdict, presence, selected);
}

async function runMigrationReportCommand(input: MigrationReportCommandInput): Promise<MigrationReportOutcome> {
  const ops = input._operationsForTesting;
  const resolve = ops?.resolve ?? resolveExistingMigrationGeneration;
  const store = input.manifestStore ?? new MigrationManifestStore({ homeDir: input.homeDir });
  const reportStore = input.reportStore ?? new MigrationVerificationReportStore({ homeDir: input.homeDir });
  const resolutionOps = input._resolution?._operationsForTesting;
  const observeJournal = resolutionOps?.observeJournal ?? observeMigrationMaintenanceJournal;

  // One journal read feeds both the default generation and the router.
  const observation = observeJournal({ homeDir: input.homeDir });
  const generation = input.generation
    ?? (observation.kind === "hold" && isTerminalBackendMaintenancePhase(observation.journal.phase) ? observation.journal.generationId : undefined);
  const resolution = await resolve({
    homeDir: input.homeDir,
    ...(generation === undefined ? {} : { generation }),
    manifestStore: store,
    _operationsForTesting: { ...resolutionOps, observeJournal: () => observation },
  });
  if (resolution.status === "refuse") {
    return {
      reason: resolution.reason, generationId: null, manifestPhase: null, next: null, restart: null,
      evidence: resolution.evidence === undefined ? {} : { detail: resolution.evidence },
    };
  }
  const { context } = resolution;
  const { route } = context;

  const restart = await restartEvidence(context, input.homeDir, ops);
  const evidence: MigrationEvidence = {
    ...journalEvidence(context),
    snapshot: context.snapshot,
    ...manifestEvidence(context),
    ...verificationEvidence(context, reportStore),
    cell: route.row,
    primary: route.primary,
    allowed: route.allowed.join(","),
    ...restart.evidence,
    activationLink: NOT_AVAILABLE_IN_THIS_BUILD,
    activationReport: NOT_AVAILABLE_IN_THIS_BUILD,
    generationBinding: NOT_AVAILABLE_IN_THIS_BUILD,
    rollbackEvidence: NOT_AVAILABLE_IN_THIS_BUILD,
  };
  const reason = REPORT_ROW_REASONS[route.row] ?? restart.reason;
  return {
    ...(reason === undefined ? {} : { reason }),
    generationId: context.generationId,
    manifestPhase: context.manifest?.phase ?? null,
    next: route.nextAction === "none" ? null : route.nextAction,
    evidence,
    restart: restart.restart,
  };
}



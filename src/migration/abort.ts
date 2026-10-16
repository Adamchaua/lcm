import {
  BackendPublicationCoordinator,
  BackendPublicationJournalError,
  backendPublicationCanonicalSha256,
  isTerminalBackendMaintenancePhase,
  type BackendMaintenanceJournal,
} from "../storage/backend-publication.js";
import {
  MigrationManifestStore,
} from "./manifest-store.js";
import {
  beginMigrationEffect,
  classifyMigrationRecovery,
  completeMigrationEffect,
  MigrationProtocolError,
  type MigrationManifest,
} from "./protocol.js";

/**
 * Section 4.6's abort gate and the `abort` operation itself. `abortMaintenance`
 * terminalizes the journal and does not touch the manifest; the manifest's
 * own `abort` effect is a separate write. This module treats `abort` as one
 * recovery-classifying operation that completes whichever of the two writes
 * is missing, never as two independent writes a caller could interleave with
 * something else.
 */

function journalFailureEvidence(error: unknown): string {
  if (error instanceof BackendPublicationJournalError) return `journal-${error.reason}`;
  return "journal-internal-error";
}

export type MigrationAbortGateStatus =
  | Readonly<{ status: "ready" }>
  | Readonly<{ status: "incomplete-pair"; evidence: string }>
  | Readonly<{ status: "unresolvable"; evidence: string }>;

/**
 * `apply` never probes for a fresh candidate while the journal and manifest
 * disagree (section 4.6). A non-terminal journal is not this gate's concern
 * at all: only a terminal journal (the one case `resolveMigrationHoldContinuation`
 * routes to `probe-fresh`) needs its manifest checked before probing is safe.
 *
 * A manifest that is genuinely absent is not a disagreement: it means
 * genesis never ran for this generation, which is a legitimate terminal
 * state (e.g. aborted before capture). Only a manifest that is *present but
 * not settled* is the dangerous case that must refuse and name `abort`.
 */
export function classifyMigrationAbortGate(input: Readonly<{
  journalTerminal: boolean;
  generationId: string;
  manifestStore: MigrationManifestStore;
}>): MigrationAbortGateStatus {
  if (!input.journalTerminal) return { status: "ready" };
  const presence = input.manifestStore.probeManifestPresence(input.generationId);
  if (presence.status === "unresolvable") {
    return { status: "unresolvable", evidence: `manifest-${presence.reason}` };
  }
  if (presence.status === "absent") return { status: "ready" };
  let manifest: MigrationManifest;
  try {
    manifest = input.manifestStore.read(input.generationId);
  } catch (error) {
    return {
      status: "unresolvable",
      evidence: error instanceof MigrationProtocolError ? `manifest-${error.reason}` : "manifest-internal-error",
    };
  }
  const recovery = classifyMigrationRecovery(manifest);
  if (recovery.action === "settled") return { status: "ready" };
  return { status: "incomplete-pair", evidence: `manifest-${recovery.action}` };
}

export type MigrationAbortResult =
  /** `mutated` is false for an idempotent repeat that found both writes already made. */
  | Readonly<{ status: "completed"; mutated: boolean }>
  | Readonly<{ status: "dry-run" }>
  /**
   * `mutated` reports whether a durable write (the journal termination or
   * either manifest write) was made before this refusal, so a caller never
   * has to guess whether state moved (round-1 A-2).
   */
  | Readonly<{ status: "refuse"; evidence: string; mutated: boolean }>;

function abortEffectId(generationId: string): string {
  return backendPublicationCanonicalSha256({ kind: "migration-abort-effect", generationId });
}

function manifestFailureEvidence(error: unknown): string {
  return error instanceof MigrationProtocolError ? `manifest-${error.reason}` : "manifest-internal-error";
}

/**
 * Completes whichever of the two writes (journal termination, manifest
 * settlement) is missing, and is idempotent under repetition: calling this
 * again once both are already settled observes that and reports `completed`
 * without attempting either write again.
 *
 * **Classify, then mutate (round-1 A-1).** Every read and the manifest's
 * recovery classification happen before the first durable write. A manifest
 * whose pending copy effect only `resume` can settle is refused while the
 * journal is still untouched: terminalizing the journal first would strand a
 * terminal journal beside a manifest no registered command can settle.
 *
 * `abortEvidenceSha256` and `sourceSelectionSha256` for the journal-side
 * write come from the caller's confirmed evidence, never re-derived here
 * (section 4.6: `abort` confirms against the live journal's own values).
 *
 * This item's scope stops at the copy-phase manifest effects it owns
 * (section 13's "implementable now" list: `planned` through `verified`).
 * A manifest with a pending retry-idempotent or readback-pending effect is
 * refused rather than resumed or abandoned here — completing an in-flight
 * copy effect is `resume`'s router (section 8), and `abandonMigrationEffect`
 * only applies to activation/rollback effects, neither of which this
 * candidate implements.
 */
export type MigrationAbortOperations = Readonly<{
  beginEffect: typeof beginMigrationEffect;
  completeEffect: typeof completeMigrationEffect;
}>;

export async function performMigrationAbort(input: Readonly<{
  homeDir: string;
  coordinator: BackendPublicationCoordinator;
  journal: BackendMaintenanceJournal;
  abortEvidenceSha256: string;
  manifestStore?: MigrationManifestStore;
  now?: Date;
  /** Run every read and classification, then stop before the first write. */
  dryRun?: boolean;
  /**
   * @internal Deterministic failure-injection seam for tests only, matching
   * the `_operationsForTesting` convention used elsewhere in
   * `src/migration/`. `beginMigrationEffect`/`completeMigrationEffect` are
   * pure functions whose only documented failure mode is a typed
   * `MigrationProtocolError`; this default is never overridden in
   * production.
   */
  _operationsForTesting?: Partial<MigrationAbortOperations>;
}>): Promise<MigrationAbortResult> {
  const beginEffect = input._operationsForTesting?.beginEffect ?? beginMigrationEffect;
  const completeEffect = input._operationsForTesting?.completeEffect ?? completeMigrationEffect;
  let journal = input.journal;
  const journalNeedsWrite = !isTerminalBackendMaintenancePhase(journal.phase);
  if (journalNeedsWrite) {
    if (journal.phase !== "maintenance-held" && journal.phase !== "maintenance-entering") {
      return { status: "refuse", evidence: `journal-${journal.phase}`, mutated: false };
    }
  } else if (journal.phase !== "maintenance-aborted") {
    // selection-completed: a successful cutover, not an abort target.
    return { status: "refuse", evidence: `journal-${journal.phase}`, mutated: false };
  }

  // Everything below up to the first write is read-only.
  const store = input.manifestStore ?? new MigrationManifestStore({ homeDir: input.homeDir });
  const presence = store.probeManifestPresence(journal.generationId);
  if (presence.status === "unresolvable") {
    return { status: "refuse", evidence: `manifest-${presence.reason}`, mutated: false };
  }
  let manifest: MigrationManifest | null = null;
  if (presence.status === "present") {
    try {
      manifest = store.read(journal.generationId);
    } catch (error) {
      return { status: "refuse", evidence: manifestFailureEvidence(error), mutated: false };
    }
    const recovery = classifyMigrationRecovery(manifest);
    if (recovery.action === "settled") {
      manifest = null;
    } else if (recovery.action !== "ready") {
      return { status: "refuse", evidence: `manifest-${recovery.action}`, mutated: false };
    }
  }

  if (input.dryRun === true) return { status: "dry-run" };

  let mutated = false;
  if (journalNeedsWrite) {
    try {
      journal = await input.coordinator.abortMaintenance({
        expectedChecksumSha256: journal.checksumSha256,
        sourceSelectionSha256: journal.sourceSelectionSha256,
        abortEvidenceSha256: input.abortEvidenceSha256,
      });
      mutated = true;
    } catch (error) {
      return { status: "refuse", evidence: journalFailureEvidence(error), mutated: false };
    }
  }
  if (manifest === null) return { status: "completed", mutated };

  const now = (input.now ?? new Date()).toISOString();
  const effectId = abortEffectId(journal.generationId);
  let begun: MigrationManifest;
  try {
    begun = beginEffect(manifest, {
      effectId,
      kind: "abort",
      inputSha256: journal.checksumSha256,
      startedAt: now,
    });
  } catch (error) {
    return { status: "refuse", evidence: manifestFailureEvidence(error), mutated };
  }
  try {
    store.update(journal.generationId, manifest.checksumSha256, () => begun);
  } catch (error) {
    return { status: "refuse", evidence: manifestFailureEvidence(error), mutated };
  }
  mutated = true;
  let candidate: MigrationManifest;
  try {
    candidate = completeEffect(begun, {
      effectId,
      completedAt: now,
      report: {
        kind: "abort",
        reportId: backendPublicationCanonicalSha256({ kind: "migration-abort-report-id", generationId: journal.generationId, effectId }),
        reportSha256: backendPublicationCanonicalSha256({
          version: 1,
          kind: "migration-abort-report",
          generationId: journal.generationId,
          abortEvidenceSha256: input.abortEvidenceSha256,
          completedAt: now,
        }),
        createdAt: now,
      },
    });
  } catch (error) {
    return { status: "refuse", evidence: manifestFailureEvidence(error), mutated };
  }
  try {
    store.update(journal.generationId, begun.checksumSha256, () => candidate);
  } catch (error) {
    return { status: "refuse", evidence: manifestFailureEvidence(error), mutated };
  }
  return { status: "completed", mutated: true };
}

export type MigrationAbortRefusalClass = "precondition" | "unresumable" | "evidence";

export type MigrationAbortRefusalClassification = Readonly<{
  reason: string;
  class: MigrationAbortRefusalClass;
}>;

/**
 * Classifies `performMigrationAbort`'s flat `evidence` string by the actual
 * fact it represents, never by the mere fact that it refused. This mirrors
 * `classifyEnteringRecoveryFailure`'s discipline exactly, for the same
 * coordinator and largely the same underlying error family: only a reason
 * this function can positively attribute to a specific, source-verified
 * fact is classified as anything other than unresolvable evidence.
 *
 * Read directly at source, not guessed:
 *
 * - `journal-selection-prepared` / `journal-selection-completed`: the
 *   journal's own pre-check in `performMigrationAbort` for "not in an
 *   abortable phase at all" (`abort.ts`'s own two explicit
 *   `journal-${journal.phase}` refusals). A genuine, well-understood
 *   precondition: there is nothing to abort.
 * - `journal-unexpected-state`: `BackendPublicationCoordinator#abortMaintenance`'s
 *   own compare-and-swap check (`backend-publication.ts`'s `abortMaintenance`:
 *   phase, checksum or `sourceSelectionSha256` no longer match what the
 *   caller observed). The one `BackendPublicationJournalError` reason
 *   `abortMaintenance` itself asserts is a precondition mismatch, exactly as
 *   `classifyEnteringRecoveryFailure` treats the same reason from the same
 *   coordinator.
 * - `journal-invalid-input`: `abortMaintenance`'s own malformed-CAS-input
 *   check. The CLI constructed the compare-and-swap input itself, so this
 *   reflects an internal defect, never an operator-fixable precondition.
 * - `manifest-resume` / `manifest-readback`: `classifyMigrationRecovery`'s
 *   own explicit "a pending copy effect exists" answer (`protocol.ts`), not
 *   an error at all. This candidate does not implement `resume`, so neither
 *   disposition has an automatic path here.
 * - Everything else (`journal-publication-evidence-missing`,
 *   `journal-unsafe-storage`, `journal-malformed-journal`,
 *   `journal-checksum-mismatch`, `journal-unresolved-publication`,
 *   `journal-permit-mismatch`, `journal-backend-mismatch`,
 *   `journal-internal-error`, every other `manifest-<protocol reason>`, and
 *   `manifest-internal-error`) is not a reason this function can positively
 *   attribute to a specific fact from `abort.ts`'s own call sites, so it is
 *   unresolvable evidence, never a guessed precondition or contention: an
 *   unclassifiable failure must not be asserted as a conclusion.
 */
export function classifyMigrationAbortRefusal(evidence: string): MigrationAbortRefusalClassification {
  if (evidence === "journal-selection-prepared" || evidence === "journal-selection-completed") {
    return { reason: "abort-wrong-phase", class: "precondition" };
  }
  if (evidence === "journal-unexpected-state") {
    return { reason: "abort-journal-moved", class: "precondition" };
  }
  if (evidence === "journal-invalid-input") {
    return { reason: "abort-invalid-input", class: "unresumable" };
  }
  if (evidence === "manifest-resume" || evidence === "manifest-readback") {
    return { reason: "abort-manifest-needs-resume", class: "unresumable" };
  }
  return { reason: "abort-unresolvable", class: "evidence" };
}

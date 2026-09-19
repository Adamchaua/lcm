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
  | Readonly<{ status: "completed" }>
  | Readonly<{ status: "refuse"; evidence: string }>;

function abortEffectId(generationId: string): string {
  return backendPublicationCanonicalSha256({ kind: "migration-abort-effect", generationId });
}

/**
 * Completes whichever of the two writes (journal termination, manifest
 * settlement) is missing, and is idempotent under repetition: calling this
 * again once both are already settled observes that and reports `completed`
 * without attempting either write again.
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
  if (!isTerminalBackendMaintenancePhase(journal.phase)) {
    if (journal.phase !== "maintenance-held" && journal.phase !== "maintenance-entering") {
      return { status: "refuse", evidence: `journal-${journal.phase}` };
    }
    try {
      journal = await input.coordinator.abortMaintenance({
        expectedChecksumSha256: journal.checksumSha256,
        sourceSelectionSha256: journal.sourceSelectionSha256,
        abortEvidenceSha256: input.abortEvidenceSha256,
      });
    } catch (error) {
      return { status: "refuse", evidence: journalFailureEvidence(error) };
    }
  } else if (journal.phase !== "maintenance-aborted") {
    // selection-completed: a successful cutover, not an abort target.
    return { status: "refuse", evidence: `journal-${journal.phase}` };
  }

  const store = input.manifestStore ?? new MigrationManifestStore({ homeDir: input.homeDir });
  const presence = store.probeManifestPresence(journal.generationId);
  if (presence.status === "unresolvable") {
    return { status: "refuse", evidence: `manifest-${presence.reason}` };
  }
  if (presence.status === "absent") {
    return { status: "completed" };
  }

  let manifest: MigrationManifest;
  try {
    manifest = store.read(journal.generationId);
  } catch (error) {
    return {
      status: "refuse",
      evidence: error instanceof MigrationProtocolError ? `manifest-${error.reason}` : "manifest-internal-error",
    };
  }
  const recovery = classifyMigrationRecovery(manifest);
  if (recovery.action === "settled") {
    return { status: "completed" };
  }
  if (recovery.action !== "ready") {
    return { status: "refuse", evidence: `manifest-${recovery.action}` };
  }

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
    return {
      status: "refuse",
      evidence: error instanceof MigrationProtocolError ? `manifest-${error.reason}` : "manifest-internal-error",
    };
  }
  try {
    store.update(journal.generationId, manifest.checksumSha256, () => begun);
  } catch (error) {
    return {
      status: "refuse",
      evidence: error instanceof MigrationProtocolError ? `manifest-${error.reason}` : "manifest-internal-error",
    };
  }
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
    return {
      status: "refuse",
      evidence: error instanceof MigrationProtocolError ? `manifest-${error.reason}` : "manifest-internal-error",
    };
  }
  try {
    store.update(journal.generationId, begun.checksumSha256, () => candidate);
  } catch (error) {
    return {
      status: "refuse",
      evidence: error instanceof MigrationProtocolError ? `manifest-${error.reason}` : "manifest-internal-error",
    };
  }
  return { status: "completed" };
}

import {
  BackendPublicationCoordinator,
  backendPublicationCanonicalSha256,
  isTerminalBackendMaintenancePhase,
  readBackendMaintenanceJournal,
  type BackendMaintenanceJournal,
} from "../storage/backend-publication.js";
import { observeMigrationMaintenanceJournal } from "./journal-observation.js";
import {
  performMigrationAbort,
  classifyMigrationAbortRefusal,
} from "./abort.js";
import { MigrationManifestStore } from "./manifest-store.js";
import { classifyMigrationRecovery, MigrationProtocolError } from "./protocol.js";
import { maintenanceOnlyDriver } from "./apply.js";

/**
 * The `abort` command's CLI orchestration (section 3): observes the live
 * journal, mints the abort's own compare-and-swap evidence, drives the
 * single recovery-classifying `performMigrationAbort` operation, then
 * satisfies section 5.1's exit-0 postcondition -- "journal terminal and
 * manifest settled, both read back" -- by re-reading durable state rather
 * than trusting the operation's own return value.
 *
 * `abortEvidenceSha256`'s preimage (plan-v2's own named open question) is
 * `{version: 1, kind: "migration-abort-cli-request", generationId,
 * checksumSha256}`: a deterministic digest over the exact journal state
 * this invocation observed, following the same canonical-hashing
 * convention as `migrationQueueEvidenceSentinel`. Two different abort
 * invocations against the same journal state produce the same evidence
 * (idempotent, matching `performMigrationAbort`'s own idempotence); a
 * changed journal state produces different evidence.
 */

export type MigrationAbortCommandOutcome =
  | Readonly<{ status: "ok"; generationId: string; journalPhase: string; manifestPhase: string | null }>
  | Readonly<{ status: "refuse"; reason: string; evidence?: string }>;

export type MigrationAbortCommandOperations = Readonly<{
  observeJournal: typeof observeMigrationMaintenanceJournal;
  performAbort: typeof performMigrationAbort;
  readJournal: typeof readBackendMaintenanceJournal;
}>;

function manifestProtocolEvidence(error: unknown): string {
  return error instanceof MigrationProtocolError ? `manifest-${error.reason}` : "manifest-internal-error";
}

export async function performMigrationAbortCommand(input: Readonly<{
  homeDir: string;
  coordinator?: BackendPublicationCoordinator;
  manifestStore?: MigrationManifestStore;
  now?: Date;
  /**
   * @internal Deterministic failure-injection seam for tests only, matching
   * the `_operationsForTesting` convention used elsewhere in
   * `src/migration/`.
   */
  _operationsForTesting?: Partial<MigrationAbortCommandOperations>;
}>): Promise<MigrationAbortCommandOutcome> {
  const observeJournal = input._operationsForTesting?.observeJournal ?? observeMigrationMaintenanceJournal;
  const performAbort = input._operationsForTesting?.performAbort ?? performMigrationAbort;
  const readJournal = input._operationsForTesting?.readJournal ?? readBackendMaintenanceJournal;
  const coordinator = input.coordinator
    ?? new BackendPublicationCoordinator({ homeDir: input.homeDir, driver: maintenanceOnlyDriver() });
  const store = input.manifestStore ?? new MigrationManifestStore({ homeDir: input.homeDir });

  const observation = observeJournal({ homeDir: input.homeDir });
  if (observation.kind === "publication") {
    return { status: "refuse", reason: "publication-occupies-slot" };
  }
  if (observation.kind === "unresolvable") {
    return { status: "refuse", reason: "journal-unresolvable", evidence: observation.evidence };
  }
  if (observation.kind === "absent") {
    // Nothing to abort at all -- a distinct fact from an existing journal
    // in a non-abortable phase, which classifyMigrationAbortRefusal covers.
    return { status: "refuse", reason: "abort-nothing-to-abort" };
  }

  const journal: BackendMaintenanceJournal = observation.journal;
  const abortEvidenceSha256 = backendPublicationCanonicalSha256({
    version: 1,
    kind: "migration-abort-cli-request",
    generationId: journal.generationId,
    checksumSha256: journal.checksumSha256,
  });

  const result = await performAbort({
    homeDir: input.homeDir,
    coordinator,
    journal,
    abortEvidenceSha256,
    manifestStore: store,
    now: input.now,
  });

  if (result.status === "refuse") {
    const classified = classifyMigrationAbortRefusal(result.evidence);
    return { status: "refuse", reason: classified.reason, evidence: result.evidence };
  }

  // Section 5.1's exit-0 postcondition: read back, never trust the
  // operation's own "completed" claim as the readback itself.
  const finalJournal = readJournal(input.homeDir);
  if (finalJournal === null || !isTerminalBackendMaintenancePhase(finalJournal.phase)) {
    return { status: "refuse", reason: "abort-readback-mismatch" };
  }

  const presence = store.probeManifestPresence(journal.generationId);
  if (presence.status === "unresolvable") {
    return { status: "refuse", reason: "abort-unresolvable", evidence: `manifest-${presence.reason}` };
  }
  if (presence.status === "absent") {
    // Genuinely absent is a legitimate terminal state (aborted before
    // capture ever reached genesis), not a readback failure.
    return { status: "ok", generationId: journal.generationId, journalPhase: finalJournal.phase, manifestPhase: null };
  }

  let manifest;
  try {
    manifest = store.read(journal.generationId);
  } catch (error) {
    return { status: "refuse", reason: "abort-unresolvable", evidence: manifestProtocolEvidence(error) };
  }
  const recovery = classifyMigrationRecovery(manifest);
  if (recovery.action !== "settled") {
    // performMigrationAbort itself would not have reported "completed"
    // with an unsettled manifest, so this is a genuine readback
    // disagreement rather than an expected state.
    return { status: "refuse", reason: "abort-readback-mismatch" };
  }
  return {
    status: "ok",
    generationId: journal.generationId,
    journalPhase: finalJournal.phase,
    manifestPhase: recovery.phase,
  };
}

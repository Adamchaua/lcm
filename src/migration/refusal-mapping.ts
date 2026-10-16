import type { MigrationExitClassName } from "./exit-classes.js";

/**
 * Section 12's named mechanism: "the closed refusal-reason and exit-class
 * vocabulary lives in one exported constant consumed by both the CLI and
 * the test". This is that constant. `bin/lcm.ts`'s command actions map a
 * refusal's `reason` string to an exit class and remedy by looking it up
 * here, never by re-deriving the mapping inline; the section 12 runbook
 * conformance test compares the runbook's own machine-readable inventory
 * block against this exact table in both directions.
 *
 * Every reason string a production refusal path in this candidate can
 * actually emit is listed. A reason absent from this table is a defect in
 * the table, not a signal to fall back to a guessed class — the CLI's own
 * lookup refuses (never silently defaults) when a reason is not found here,
 * matching the "never conclude from absence" rule the rest of this item is
 * built on.
 *
 * Remedies are static text, per `bin/lcm.ts:4307-4308`'s existing rule and
 * section 10's: never interpolates a message, a driver error, or any other
 * dynamic value.
 */

export type MigrationRefusalMapping = Readonly<{
  reason: string;
  exitClass: MigrationExitClassName;
  remedy: string;
}>;

/**
 * Section 5.1's row-level rule, restated per entry so it is checkable
 * mechanically rather than only in prose: `incomplete-recoverable` (exit 6)
 * requires that `resume` can genuinely finish the state. This candidate
 * does not implement `resume`, so no reason it can itself emit maps to
 * exit 6 yet — every held-plus-unsettled case here is `refused-precondition`
 * (exit 2) naming `abort`, never exit 6, exactly as section 5 requires for
 * an unresumable state.
 */
export const MIGRATION_REFUSAL_REASONS: readonly MigrationRefusalMapping[] = Object.freeze([
  // --- Section 4.4/4.9's genesis-and-copy ownership plumbing, and the
  // target resolution the root ruled on (docs/migration-operations.md
  // documents storage.backend vs storage.postgresql's split explicitly). ---
  Object.freeze({
    reason: "invalid-expected-owner", exitClass: "refused-precondition",
    remedy: "storage.postgresql.migrationRole (or LCM_POSTGRES_MIGRATION_ROLE) is not a valid PostgreSQL role name. Fix the configured value before retrying.",
  }),
  Object.freeze({
    reason: "machine-identity-unregistered", exitClass: "refused-precondition",
    remedy: "This machine has no registered PostgreSQL identity. Run `lcm machine register` before retrying.",
  }),
  Object.freeze({
    reason: "migration-target-identity-unresolvable", exitClass: "refused-evidence",
    remedy: "The destination PostgreSQL project identity could not be resolved or minted. Run `lcm doctor` before retrying.",
  }),
  Object.freeze({
    reason: "migration-target-missing", exitClass: "refused-precondition",
    remedy: "No usable PostgreSQL target is configured. Set storage.postgresql (url, caFile, migrationRole) or the LCM_POSTGRES_URL / LCM_POSTGRES_CA_FILE / LCM_POSTGRES_MIGRATION_ROLE environment variables.",
  }),
  Object.freeze({
    reason: "migration-target-unresolvable", exitClass: "refused-evidence",
    remedy: "The PostgreSQL target configuration could not be read or parsed. Run `lcm doctor` before retrying.",
  }),
  Object.freeze({
    reason: "migration-target-verification-failed", exitClass: "refused-precondition",
    remedy: "The PostgreSQL target was reached but failed TLS or migration-role verification. Fix the role grants or TLS configuration, then retry.",
  }),
  Object.freeze({
    reason: "migration-target-verification-unresolvable", exitClass: "refused-evidence",
    remedy: "The PostgreSQL target could not be reached to verify TLS or role access. Check network connectivity and the target address, then retry.",
  }),

  // --- dry-run's own refusal (section 3: owns dryRunAuthenticatedSqliteMigrationSource only) ---
  Object.freeze({
    reason: "dry-run-failed", exitClass: "refused-evidence",
    remedy: "The SQLite source could not be dry-run checked. Run `lcm doctor` before retrying.",
  }),

  // --- Section 4.2: journal observation ---
  Object.freeze({
    reason: "publication-occupies-slot", exitClass: "refused-contention",
    remedy: "A v2 publication is in progress. Wait for it to complete, then retry.",
  }),
  Object.freeze({
    reason: "journal-unresolvable", exitClass: "refused-evidence",
    remedy: "The maintenance journal could not be read. Run `lcm doctor` and inspect ~/.lcm/backend-publication before retrying.",
  }),

  // --- Section 4.9 exposure 1: generation identity resolution ---
  Object.freeze({
    reason: "generation-occupied-since-probe", exitClass: "refused-contention",
    remedy: "Another local actor took the candidate generation between the probe and the hold. Retry.",
  }),
  Object.freeze({
    reason: "generation-unresolvable-since-probe", exitClass: "refused-evidence",
    remedy: "The candidate generation could not be re-verified immediately before the hold. Run `lcm doctor` before retrying.",
  }),
  Object.freeze({
    reason: "generation-probe-bound-exceeded", exitClass: "refused-precondition",
    remedy: "Every candidate ordinal up to the probe bound is occupied. Clean up terminal generations, then retry.",
  }),
  Object.freeze({
    reason: "generation-occupancy-refused", exitClass: "refused-evidence",
    remedy: "A candidate generation's occupancy could not be classified. Run `lcm doctor` before retrying.",
  }),
  // Section 5's corrected exit-7 row: "see applied". Neither of these two
  // producers mutates anything, unlike exit 7's other producer (section 8's
  // unsettled-pair case), so applied is always false here; the reason
  // string is what distinguishes them for the operator.
  Object.freeze({
    reason: "generation-invalid-input", exitClass: "failed-operator-required",
    remedy: "The CLI constructed an invalid candidate generation identity. This is an internal defect; file an issue rather than retrying.",
  }),
  Object.freeze({
    reason: "generation-identifier-bound-exceeded", exitClass: "failed-operator-required",
    remedy: "A candidate generation id exceeded the identifier length bound. This is an internal defect; file an issue rather than retrying.",
  }),

  // --- Section 4.4: multi-machine installation ---
  Object.freeze({
    reason: "multi-machine-installation", exitClass: "refused-precondition",
    remedy: "This project is shared across machines. SQLite-to-PostgreSQL migration requires a single-machine (local) project.",
  }),

  // --- Section 4.4/4.9: hold entry ---
  Object.freeze({
    reason: "hold-entry-failed", exitClass: "refused-contention",
    remedy: "Entering the maintenance hold was refused. Wait and retry, or run `lcm migration abort` if a prior attempt is stuck.",
  }),
  Object.freeze({
    reason: "hold-entry-readback-mismatch", exitClass: "refused-evidence",
    remedy: "The maintenance hold could not be confirmed after being entered. Run `lcm doctor` before retrying.",
  }),

  // --- Section 4.8: capture ---
  Object.freeze({
    reason: "capture-failed", exitClass: "failed-operator-required",
    remedy: "SQLite snapshot capture failed after the hold was taken. Run `lcm migration abort` to release the hold, then investigate before retrying.",
  }),

  // --- Section 4.5: continuation match predicates ---
  Object.freeze({
    reason: "continuation-mismatched-hold", exitClass: "refused-precondition",
    remedy: "An existing maintenance hold does not match this project's current selection. Run `lcm migration abort` before retrying.",
  }),
  Object.freeze({
    reason: "continuation-resume-required", exitClass: "refused-precondition",
    remedy: "A prior cutover reached a state only `resume` can continue. Run `lcm migration resume`.",
  }),
  Object.freeze({
    reason: "continuation-unclassified", exitClass: "failed-operator-required",
    remedy: "The maintenance journal's phase could not be classified into a known continuation. This is an internal defect; file an issue.",
  }),

  // --- Section 4.6: the abort gate ---
  Object.freeze({
    reason: "abort-gate-unresolvable", exitClass: "refused-evidence",
    remedy: "The manifest for a terminal generation could not be read. Run `lcm doctor` before retrying.",
  }),
  Object.freeze({
    reason: "abort-or-resume-required", exitClass: "refused-precondition",
    remedy: "A terminal maintenance journal has an unsettled manifest. Run `lcm migration abort` or `lcm migration resume` before starting a fresh cutover.",
  }),

  // --- A-1 recovery (maintenance-entering) ---
  Object.freeze({
    reason: "entering-recovery-precondition", exitClass: "refused-precondition",
    remedy: "The recovered entering journal does not match this project's current selection. Run `lcm migration abort` before retrying.",
  }),
  Object.freeze({
    reason: "entering-recovery-contention", exitClass: "refused-contention",
    remedy: "Another actor holds the publication lock during recovery. Wait and retry.",
  }),
  Object.freeze({
    reason: "entering-recovery-evidence", exitClass: "refused-evidence",
    remedy: "The entering journal's recovery could not be verified. Run `lcm doctor` before retrying.",
  }),
  Object.freeze({
    reason: "entering-recovery-unclassified", exitClass: "failed-operator-required",
    remedy: "The entering journal's recovery failure could not be classified. This is an internal defect; file an issue.",
  }),

  // --- Section 8: manifest genesis and copy ---
  Object.freeze({
    reason: "snapshot-unresolvable", exitClass: "refused-evidence",
    remedy: "The captured SQLite snapshot could not be classified. Run `lcm doctor` before retrying.",
  }),
  Object.freeze({
    reason: "capture-incomplete", exitClass: "refused-precondition",
    remedy: "Capture-before-genesis ordering requires a complete snapshot before manifest genesis. Retry `lcm migration apply`.",
  }),
  Object.freeze({
    reason: "manifest-unresolvable", exitClass: "refused-evidence",
    remedy: "The migration manifest could not be read. Run `lcm doctor` before retrying.",
  }),
  Object.freeze({
    reason: "genesis-inspection-failed", exitClass: "failed-operator-required",
    remedy: "Inspecting the source and destination witnesses for manifest genesis failed. Investigate the target PostgreSQL connection before retrying.",
  }),
  Object.freeze({
    reason: "genesis-create-failed", exitClass: "failed-operator-required",
    remedy: "Manifest genesis failed after a successful capture. Run `lcm doctor`; the snapshot is preserved and safe to retry from.",
  }),
  Object.freeze({
    reason: "genesis-dry-run-begin-failed", exitClass: "failed-operator-required",
    remedy: "Beginning the dry-run copy effect failed. Run `lcm doctor` before retrying.",
  }),
  Object.freeze({
    reason: "genesis-dry-run-complete-failed", exitClass: "failed-operator-required",
    remedy: "Completing the dry-run copy effect failed. Run `lcm doctor` before retrying.",
  }),
  Object.freeze({
    reason: "copy-failed", exitClass: "failed-operator-required",
    remedy: "Copying captured data to the destination failed. The source snapshot is preserved; run `lcm doctor` before retrying.",
  }),

  // --- Section 9: confirmation fence ---
  Object.freeze({
    reason: "confirmation-missing", exitClass: "refused-confirmation",
    remedy: "Run `lcm migration plan` first, then pass its printed generation id to `apply --confirm-generation <id>`.",
  }),
  Object.freeze({
    reason: "confirmation-generation-moved", exitClass: "refused-confirmation",
    remedy: "The candidate generation changed since `lcm migration plan` was run. Re-run `lcm migration plan` and confirm the new id.",
  }),

  // --- Section 7: daemon presence policy ---
  Object.freeze({
    reason: "daemon-presence-unresolvable", exitClass: "refused-evidence",
    remedy: "Daemon presence could not be positively established. Run `lcm daemon status`, resolve the failure, and retry.",
  }),

  // --- abort's own refusals, classified by classifyMigrationAbortRefusal
  // (abort.ts) rather than by the raw evidence string, for the exact
  // reason recorded there: a wrong phase, a coordinator CAS mismatch, an
  // internal-defect malformed input, and "resume is required" are
  // different facts, and every reason this classifier cannot positively
  // attribute lands on abort-unresolvable rather than being guessed. ---
  Object.freeze({
    reason: "abort-wrong-phase", exitClass: "refused-precondition",
    remedy: "The maintenance journal is not in an abortable phase (it is either absent or already past a successful cutover). Nothing to abort.",
  }),
  Object.freeze({
    reason: "abort-journal-moved", exitClass: "refused-precondition",
    remedy: "The maintenance journal changed since it was last observed. Re-run `lcm migration abort` to act on its current state.",
  }),
  Object.freeze({
    reason: "abort-invalid-input", exitClass: "failed-operator-required",
    remedy: "The CLI constructed an invalid abort request. This is an internal defect; file an issue rather than retrying.",
  }),
  Object.freeze({
    reason: "abort-manifest-needs-resume", exitClass: "failed-operator-required",
    remedy: "The manifest has an in-progress copy effect that only `resume` can complete or abandon. Nothing was changed. This release does not register resume; file an issue.",
  }),
  Object.freeze({
    reason: "abort-unresolvable", exitClass: "refused-evidence",
    remedy: "The abort could not be classified into a known precondition or defect. Run `lcm doctor` before retrying.",
  }),
  Object.freeze({
    reason: "abort-confirmation-missing", exitClass: "refused-confirmation",
    remedy: "Pass --confirm-generation with the generation id of the live maintenance hold. This refusal reports that id in its generation field; nothing was changed.",
  }),
  Object.freeze({
    reason: "abort-confirmation-moved", exitClass: "refused-confirmation",
    remedy: "--confirm-generation does not match the live maintenance hold. Pass the generation id this refusal reports; nothing was changed.",
  }),
  Object.freeze({
    reason: "abort-nothing-to-abort", exitClass: "refused-precondition",
    remedy: "There is no maintenance hold to abort.",
  }),
  Object.freeze({
    reason: "abort-readback-mismatch", exitClass: "failed-operator-required",
    remedy: "The abort appeared to complete but its terminal state could not be confirmed on readback. Run `lcm doctor` and inspect the maintenance journal and manifest directly.",
  }),
] satisfies MigrationRefusalMapping[]);

const REFUSAL_BY_REASON: ReadonlyMap<string, MigrationRefusalMapping> = new Map(
  MIGRATION_REFUSAL_REASONS.map((entry) => [entry.reason, entry]),
);

/**
 * Looks up a refusal reason's exit class and remedy. Refuses (throws)
 * rather than returning a guessed default when the reason is not in the
 * table: an unclassified refusal reason reaching the CLI is a defect in
 * this table, and silently defaulting it to some exit class would hide
 * that defect behind a plausible-looking exit code instead of surfacing it.
 */
export function migrationRefusalMapping(reason: string): MigrationRefusalMapping {
  const found = REFUSAL_BY_REASON.get(reason);
  if (found === undefined) {
    throw new Error(`migration CLI has no exit-class mapping for refusal reason: ${reason}`);
  }
  return found;
}

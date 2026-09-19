# Reversible migration rollback

LCM can reverse a PostgreSQL migration attempt back to SQLite. This page
describes what rollback does, what it deliberately leaves untouched, how to
read a refusal, and how to recover after an interruption. It assumes you have
already read [Reversible migration and cutover journal](migration-cutover.md),
which covers the shared journal, phases, and crash-recovery discipline
rollback builds on.

## The two shapes of a rollback, and the one that copies nothing

Rollback has two outcomes, decided from evidence at the moment it runs, never
chosen by the operator:

- **Pre-write or unactivated rollback copies nothing.** If PostgreSQL was
  never activated, or was activated but nothing was durably written to it
  since, the live SQLite database at the canonical path is already correct
  and current. No rollback generation is built, nothing is installed, no
  runtime sidecar is materialized, and the live database is not touched. The
  reversal is the maintenance-selection flip back to SQLite, nothing else.
  Reconstructing the database from the preserved snapshot in this case would
  not be a missing feature; it would replace a correct live file with a
  reconstruction and is treated as a defect if it ever happens.
- **Post-write rollback rebuilds a fresh generation.** If PostgreSQL received
  writes after activation, rollback builds a new SQLite generation from a
  fenced PostgreSQL snapshot, verifies it twice against independent
  readbacks, installs it at the canonical path, and only then flips the
  selection back to SQLite.

Either way, rollback never deletes or truncates anything it did not itself
create in the same run.

## What is preserved, and never overwritten

- The immutable snapshot captured before the original migration (tracked
  since issue #622) stays untouched at private mode 0400 in its own
  generation directory. Rollback never reads its bytes; on a post-write
  rollback the new generation is built fresh from PostgreSQL, not from this
  snapshot.
- On a post-write rollback, the live pre-rollback SQLite database is moved
  aside to a lineage path, never truncated, replaced in place, or unlinked.
  It is checkpointed and witnessed by content hash both before and after the
  move, so the preserved copy is provably byte-identical to what was live.

## Recovery procedure after an interrupted rollback

A rollback can be interrupted at any point -- before entering maintenance,
while maintenance is held, mid-build, or after the destination selection has
already flipped but before the run finished recording that fact. Every one of
those windows resumes to exactly one authoritative outcome; none of them can
strand a generation in a state that a retry cannot resolve.

On a post-write rollback specifically, a retry after a crash **never
resumes copying into the same partial generation**. It builds a brand-new
generation directory, one attempt number higher than any attempt already on
disk for that generation and destination revision. The incomplete or failed
generation from the earlier attempt is left exactly where it is: private,
un-deleted, and, if the earlier attempt got far enough to know it failed
verification, quarantined read-only. This is deliberate. A failed or
incomplete generation is evidence of what the earlier attempt actually wrote,
and quarantining it is safer than any hidden repair.

Simply re-running the same rollback operation triggers this recovery
automatically; there is nothing an operator needs to do to make a stalled
rollback resumable, other than removing whatever caused the crash (an
unreachable PostgreSQL host, a permissions problem, and so on) and running it
again.

## Operator-owned cleanup of quarantined and incomplete generations

Rollback generations, including quarantined and abandoned ones, live under
`<home>/.lcm/migration-rollback-generations/`. **LCM never deletes anything
in this directory.** Every attempt, successful or not, accumulates there
indefinitely. This is intentional: a failed attempt is the only record of
what went wrong, and an operator investigating a rollback failure needs that
evidence to still exist.

Because nothing is deleted automatically, disk usage under this directory
grows with every rollback attempt on every generation, successful or not.
Reviewing and removing directories you no longer need is an operator
decision, made after you have confirmed you do not need the evidence they
contain. LCM does not provide a command for this today; treat each directory
like any other evidence file you manage by hand.

## Refusals, and what to do about each one

Rollback refuses rather than guessing whenever it cannot prove what it needs
to prove. Every refusal is fail-closed: nothing has been overwritten by the
time you see it. The table below groups refusals by what they mean and what
to check.

| What you will see | What it means | What to check |
| --- | --- | --- |
| Operability fact unresolvable (lock contention, an unreadable or malformed publication journal) | Rollback could not authoritatively determine whether PostgreSQL is currently the active backend, so it will not guess. | Confirm nothing else is holding the backend-publication lock; inspect the publication journal for corruption; retry once the underlying condition clears. |
| "backend maintenance holds the live publication slot and no durable rollback-authority artifact exists" | Something else (not this rollback attempt) currently holds backend maintenance, and there is no evidence tying that hold to this rollback. | This is not this rollback's own in-progress maintenance. Identify what else is holding maintenance before retrying. |
| "the live operability fact disagrees with the durable rollback-authority artifact" | A value recorded durably before maintenance began no longer matches what a fresh read reports, for the exact same generation. Rollback treats this as untrustworthy evidence rather than picking a side. | Investigate why the backend's operability state changed between the recorded value and now -- this should not happen for one generation's own rollback and points at something external. |
| "operability-fact:published-but-unbound: destination is operable under postgresql but no activation selection binding is bound yet" | PostgreSQL is live and operable, but the record of which activation attempt made it so has not been durably written yet. Treating this as "never activated" would license discarding real committed writes, so rollback refuses instead. | Wait for the in-flight activation to finish durably recording its selection binding, then retry. |
| "destination identity does not match the manifest's sealed witness" / "...does not match the authoritative epoch" | The PostgreSQL system rollback is looking at is not the same PostgreSQL system the manifest or the activation attempt recorded. | Confirm you are pointed at the correct PostgreSQL target; do not proceed by forcing a match. |
| "observed census schema is not comparable to the frozen portable record schema" | The row-count census read from PostgreSQL was produced under a different portable-record schema version than rollback expects, so a pre-write/post-write comparison would not be meaningful. | Confirm the LCM version that ran the original migration matches the version running rollback. |
| A refusal reason surfaced from the classifier comparing the current PostgreSQL delta and census against the activation baseline | Rollback could not determine, from the evidence available, whether PostgreSQL has been written to since activation. | Treat this the same as any other refusal to guess: it means the census or delta comparison itself was inconclusive, not that no write occurred. |
| "rollback generation ... already exists" | The exact generation directory rollback was about to create is already occupied. This should not happen given the attempt-numbering scheme above; it points at an unexpected collision. | Do not delete the existing directory to "fix" this. Report it; this indicates the attempt-numbering derivation and the filesystem disagree. |
| "could not enumerate existing rollback generation build attempts" / "...has more entries than this enumeration will scan" | Rollback could not safely determine the next attempt number for this generation, either because the private generations directory could not be read or because it holds an implausibly large number of entries. Rollback refuses rather than risk reusing an attempt number that is already evidence. | Check filesystem permissions on `.lcm/migration-rollback-generations/`; if the entry count is genuinely large, that is itself worth investigating -- it means many prior attempts were never cleaned up. |
| Independent verification failure recorded in a generation's `witness.json` `reason` field (`transfer:*`, `independent-verification:manifest-readback-failed`, `independent-verification:manifest-sha-mismatch`, `independent-verification:readback-failed`, `independent-verification:content-mismatch`) | The newly built generation failed one of the two independent verification passes rollback runs before it will ever install a generation. The generation was quarantined, not installed. | Read the `witness.json` file in that generation's directory for the exact reason. The quarantined generation and its manifest are preserved; do not repair a partial generation by editing its files. Rollback will build a fresh attempt on retry. |
| "publish-rollback must be abandoned but the maintenance journal is already durably selection-completed for a different or ambiguous target" | A crash-recovery path found backend selection already durably completed toward a target rollback cannot reconcile automatically. This is a known, explicitly unimplemented case, flagged loudly rather than silently guessed at. | This needs manual investigation; do not attempt to force a re-selection. |

Every refusal preserves whatever durable evidence already existed. None of
them require, or benefit from, deleting files to "retry cleanly."

## The maintenance window scales with data size

Rollback holds the same PostgreSQL fence used by the forward migration for
the full duration of its destination scan -- reading the current census and
delta, and, on a post-write rollback, transferring every domain into the new
SQLite generation. The fence is renewed across long scans rather than held in
a single non-renewable lease, but it is held throughout. Size any expected
outage window from the amount of data PostgreSQL holds, not from a fixed
estimate: a larger destination means a longer window during which PostgreSQL
writes from this project are fenced.

## What this page does not claim: backlog drain after rollback

Appends made locally while maintenance is held are preserved and remain
admitted through the same local outbox mechanism used during the original
cutover, whether the direction is forward (cutover) or backward (rollback).
This page makes **no claim about when a retained backlog is drained** after a
rollback completes. Preservation and correct routing of those appends is
established and tested; a guarantee that they are eventually drained, rather
than preserved indefinitely, is not. Do not assume a rollback flushes a
backlog that a prior cutover left pending; nothing here guarantees that it
does.

## Current rollout boundary: no operator-reachable entry point yet

Rollback's config and project-map publication step -- the piece that would
make other LCM consumers durably aware that the backend selection changed --
is not wired today, because the production publication driver those
consumers require does not exist yet. The maintenance journal's own selection
record is still durably completed correctly, so backend selection and replay
admission already route to SQLite the moment a rollback finishes. But there
is currently no CLI command, daemon trigger, or other operator-reachable
entry point that starts a rollback. This is an internal orchestration API
today, exercised only in tests, not a feature you can invoke yet. This page
will be updated with the command once one exists; do not look for one in the
meantime.

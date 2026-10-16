# Migration Operations: SQLite to PostgreSQL Cutover

This document is the operator runbook for the `lcm migration` command group, which performs a
reversible, in-place cutover of an LCM installation from its local SQLite storage to a configured
PostgreSQL destination. Read this in full before running `apply` against a project you care about.

## Before you run `apply`: what it actually does to your installation

**`apply` puts your installation into a maintenance hold that only `abort` can currently leave.**
This is the single most important fact in this document, and it is stated here, first, because an
operator who runs `apply` expecting it to be one step in a longer sequence needs to know before
running it, not after.

A successful `apply` captures your SQLite data, mints a migration manifest, and copies the captured
data to the configured PostgreSQL destination. It does this under a maintenance hold on your local
installation. That hold is not released when `apply` finishes. While the hold is held, ordinary LCM
storage operations on this installation — hook writes, memory search, compaction, anything that
touches local storage as a consumer — are fenced and will refuse or retry rather than proceed.

**`activate` (the command that would complete the cutover by switching your installation over to
the copied PostgreSQL data and releasing the hold) is not implemented in this release.** It ships in
a later integration candidate of this Epic, alongside `resume`, `verify`, `report`, `rollback`, and the
restart-verification step `activate` depends on. Until then, the only way to leave the hold `apply`
creates is `lcm migration abort`, which discards the hold and the captured snapshot and returns your
installation to normal, unfenced SQLite operation. Nothing about your PostgreSQL destination is
affected by `abort`; the copy, if it reached PostgreSQL, is simply not used.


**What exists today, plainly:** `plan`, `dry-run`, `apply`, and `abort` are registered, working
commands. `report`, `verify`, `activate`, and `rollback` are **not registered and not
available** -- there is no CLI command by those names to run, regardless of what this document or
the CLI's internal contract data name them as (they are named because this Epic's design covers
all nine eventual commands; naming a command is not the same as registering it). Forward
completion of a cutover past capture-and-copy is not available. **`abort` is the only exit from
a hold.**

So: `apply` is not yet a step toward a completed cutover you can run today. It is currently useful
for two things — proving that capture, manifest genesis and copy work correctly against your real
PostgreSQL target, and for testing the mechanism ahead of the integration release that adds
`activate`. If you need your installation to keep operating normally, either do not run `apply` yet,
or run `abort` immediately afterward once you have confirmed what you needed to confirm.

## Configuration: `storage.backend` versus `storage.postgresql`

`storage.backend` in `config.json` names which backend is **active** for ordinary LCM operation —
currently `sqlite` for any installation that has not completed a cutover. `storage.postgresql`
(plus its `LCM_POSTGRES_URL` / `LCM_POSTGRES_CA_FILE` / `LCM_POSTGRES_MIGRATION_ROLE` environment
fallbacks) names **how to reach PostgreSQL** as a migration destination. Migration commands read
the latter regardless of what the former says — `storage.backend` staying `sqlite` for the whole
duration of `plan`, `dry-run` and `apply` is expected and correct, not a sign that anything is
misconfigured.

`storage.postgresql.url` and `storage.postgresql.caFile` must not be written into `config.json`
directly; the ordinary (non-migration) configuration loader refuses a stored secret there by
design. Supply them through the `LCM_POSTGRES_URL` and `LCM_POSTGRES_CA_FILE` environment variables
instead. `storage.postgresql.migrationRole` (or its `LCM_POSTGRES_MIGRATION_ROLE` fallback) may be
set in either place.

Your project must not be linked to a PostgreSQL project through `lcm project create` or
`lcm project link` before running migration commands. Migration resolves (and, on first use, mints)
its own destination project identity directly against PostgreSQL; the local project-to-project
binding those commands create is reserved for later activation and, if already set, will make
capture refuse (`multi-machine-installation`) rather than proceed.

## Commands

All four commands accept `--json`, which prints exactly one JSON document to stdout (see
"The JSON envelope" below) and sends progress and human-readable text to stderr instead. Without
`--json`, a short human-readable summary line goes to stdout; progress still goes to stderr either
way.

### `lcm migration plan [--json]`

Non-mutating. Checks every precondition `apply` will check — target configuration, PostgreSQL
reachability and TLS/role verification, daemon presence, and the candidate migration generation —
and prints the result without taking any hold, capturing anything, or writing anything. Run this
first. Its printed generation id is the exact value `apply --confirm-generation` must be given.

Exit 0 postcondition: every precondition read succeeded and the emitted evidence is complete,
including a positively established daemon-presence answer and a computed candidate generation id.

### `lcm migration dry-run [--json]`

Non-mutating, and deliberately narrower than `plan`: it checks only that the local SQLite source
can be read and classified for capture. It does not resolve a destination, does not take a hold,
and does not touch the maintenance journal. Use it to check the SQLite side alone, independent of
PostgreSQL reachability or daemon state.

Exit 0 postcondition: the dry-run completed and its result was read back.

### `lcm migration apply --confirm-generation <id> [--dry-run] [--max-records <n>] [--max-bytes <n>] [--json]`

Mutating (unless `--dry-run` is given). The entry point: resolves the same preconditions `plan`
checks, confirms `--confirm-generation` against a freshly re-resolved candidate id, takes the
maintenance hold, captures the SQLite source, mints the migration manifest, and copies the captured
data to PostgreSQL in batches bounded by `--max-records` and `--max-bytes` (both optional; sane
defaults apply).

`--confirm-generation <id>` is required in practice, though not enforced at the command-line
parsing level: omitting it reaches the same confirmation-fence refusal (`confirmation-missing`,
exit 3) that a stale or wrong id reaches, rather than a generic usage error, so the operator always
sees the same closed vocabulary regardless of how the token went missing. The id must come from a
`plan` run against the same project state; if the candidate generation moved between `plan` and
`apply` (because local state changed), `apply` refuses `confirmation-generation-moved` (exit 3)
rather than silently applying against a different generation.

`--dry-run` stops immediately after the confirmation fence, before the hold is taken or anything is
captured. The emitted envelope reports the confirmed candidate with `applied: false`.

Exit 0 postcondition: the maintenance journal re-reads at the expected phase and checksum; the
captured snapshot classifies `complete`; the manifest head is read back and reads at the expected
phase (`copied`) -- the phase the envelope reports is the one read, not the copy layer's own report.

**Read "Before you run apply" above before using this command for real.**

### `lcm migration abort --confirm-generation <id> [--dry-run] [--json]`

Mutating (unless `--dry-run` is given). The only way to leave a maintenance hold in this release.
Classifies the live maintenance journal and the manifest first, and only then completes whichever
of the journal termination and the manifest settlement is still outstanding — idempotent under
repetition, so running it again against an already-aborted state is safe and simply confirms the
terminal state. Discards the captured snapshot's standing as a migration-in-progress; nothing on
the PostgreSQL side is deleted or undone, since `abort` never reaches PostgreSQL at all.

`abort` writes nothing unless it can finish the whole recovery. If the manifest carries an
in-progress copy effect that only `resume` can settle, `abort` refuses
(`abort-manifest-needs-resume`) while the hold is still intact, rather than releasing the hold and
leaving a manifest nothing can settle.

`--confirm-generation <id>` must equal the generation id of the live maintenance hold. Omitting it
refuses `abort-confirmation-missing` and a different id refuses `abort-confirmation-moved` (both
exit 3, nothing changed); either refusal reports the live generation id in its `generation` field,
so you can re-run with it. `--dry-run` runs every read and check, reports `applied: false`, and
changes nothing; it still requires the token and refuses with the class the real run would get.

Exit 0 postcondition: the maintenance journal reads terminal and the manifest reads settled, both
read back after the operation, not assumed from the operation reporting success.

## What every command can refuse, and what to do about it

Every refusal names a closed reason string, an exit class (below), and a static remedy —
never a raw driver error message, a file path, or anything else that could vary between runs of the
same underlying condition. The complete, machine-checked table (identical to what the CLI itself
consults) is in "Machine-readable inventory" at the end of this document; the entries most worth
knowing by name:

- `confirmation-missing` / `confirmation-generation-moved` (exit 3): re-run `plan` and pass its
  printed id. `apply` checks the id twice: against its preflight, and again inside the capture step
  immediately before it takes the hold. If another local actor occupied your candidate generation
  in between, the second check refuses `confirmation-generation-moved` and nothing is written.
- `hold-entry-contention` / `hold-entry-slot-occupied` (exit 4), `hold-entry-precondition`
  (exit 2), `hold-entry-evidence` (exit 5): the maintenance hold was **not** entered, so there is
  nothing of yours to `abort`. Wait for the other actor, or re-run `plan`, or run `lcm doctor`,
  as the remedy says.
- `capture-contention` (exit 4) / `capture-unresolvable` (exit 5): capture was interrupted after the
  hold was taken. The hold is still in place; re-run `apply` with the same `--confirm-generation` to
  continue, or `abort` to release it. `capture-failed` (exit 7) is reserved for capture's own
  failures.
- `continuation-partial-snapshot` (exit 2): a held generation whose snapshot is partial or replaced
  cannot be continued. `abort` is the only command that applies.
- `daemon-presence-unresolvable` (exit 5): `apply` could not positively determine whether a daemon
  is running. Run `lcm daemon status`, resolve the failure, and retry. A daemon that genuinely is
  not running is **not** a refusal here — see "Daemon presence" below.
- `multi-machine-installation` (exit 2): this project is already linked to a PostgreSQL project
  (see "Configuration" above). Migration requires an unlinked, single-machine project.
- `abort-nothing-to-abort` (exit 2): there is no hold to leave. Nothing to do.
- `unexpected-failure` (exit 5): something threw that no command classified. The command still prints
  exactly one envelope; its evidence is only the error's name. Check `applied` (reported `true` for
  `apply` and `abort`, which cannot rule out an earlier write), run `lcm doctor`, and re-run
  `lcm migration plan` to see the current state.
- Anything ending `-unresolvable` or classed `refused-evidence` (exit 5): the command could not
  establish the state it needed to decide anything — this is different from the state actively
  forbidding the operation (exit 2), and the remedy is almost always `lcm doctor` followed by a
  retry.
- Anything classed `failed-operator-required` (exit 7): no automatic path resolves this. Some of
  these mean nothing was mutated (an internal defect in a generated identifier, for example);
  others mean a mutation already happened and is durable (a capture or copy failure after the hold
  was taken). The JSON envelope's `applied` field says which — check it before assuming either way.
  File an issue rather than retrying blindly.

## The exit classes

Nine classes, closed, never reused for a different meaning. Exit 0 always carries a positively
read-back postcondition (named per command above); a command never returns 0 merely because nothing
threw. Exit 5 ("I could not establish the state") is distinct from exit 2 ("I established the
state and it forbids this") -- they call for different operator responses, and conflating them
would tell an operator a definite "no" when the honest answer was "unknown".

| Code | Class | Meaning |
| --- | --- | --- |
| 0 | `ok` | Completed and its named postcondition was positively read back |
| 1 | `usage` | Malformed invocation. Never reaches a storage seam |
| 2 | `refused-precondition` | State does not admit this operation. Remedy names the command that does |
| 3 | `refused-confirmation` | A mutating boundary was not confirmed |
| 4 | `refused-contention` | Another actor holds the lock, barrier or lease |
| 5 | `refused-evidence` | Evidence is absent, unattributable, or failed its comparison |
| 6 | `incomplete-recoverable` | Durably begun, not terminal, and `resume` can finish it (not reachable in this release -- see "Commands not available today") |
| 7 | `failed-operator-required` | No automatic path resolves this; a human must decide. Check `applied` for whether anything mutated |
| 8 | `restart-required` | Durable state correct; a live daemon holds a stale startup backend (not reachable in this release -- see "Commands not available today") |

## State routing: which command owns which situation

This table exists so that every state your installation can be in has exactly one command that
owns getting you out of it. Commands not listed as the owner for a row refuse exit 2, naming the
owner in their remedy.

| Maintenance journal | Snapshot | Manifest | Owning command | Other commands return |
| --- | --- | --- | --- | --- |
| absent, or terminal with a settled pair | absent | absent | `apply` (fresh cutover) | 2 |
| `entering`, matching this project | any | any | `apply` (recovers automatically) or `abort` | 2 |
| `held`, matching | absent | absent | `apply` (continues to capture) | 2 |
| `held`, matching | `partial` or `replaced` | any | **`abort` only** | 2, remedy `abort`, never 6 |
| `held`, matching | `complete` | absent | `apply` (mints the manifest and copies) | 2 |
| `held`, matching | `complete` | copy in progress | `resume` (not implemented -- see below; `abort` also always available) | 2 |
| `held`, mismatched with this project's current selection | any | any | `abort` | 2 |
| terminal | any | not settled | `abort` or `resume` (not implemented; use `abort`) | 2 |
| any | `tampered` | any | none -- exit 5 with evidence preserved; this is a security-relevant signal, not something any command resolves automatically | 5 |
| settled pair with no forward path | any | any | none -- exit 7; file an issue | 7 |

A generation classifying `partial` or `replaced` is **never deleted**. Every failed or abandoned
capture attempt is preserved on disk exactly as-is; `abort` releases the hold without touching that
evidence. Nothing this command group does removes a generation's captured artifacts. Each aborted-
after-capture attempt does, however, permanently consume one probe ordinal for this project's base
identity -- retrying after `abort` computes a fresh, later ordinal rather than reusing the aborted
one, so a project that aborts many attempts will see its candidate generation numbers climb; this is
expected and not a sign of a leak.

## Commands not available today

`resume`, `verify`, `activate`, and `rollback` are named in this Epic's design and in the state-
routing table above, because the design covers all nine eventual commands -- naming a command is
not the same as registering it. **None of the four is registered as a CLI command in this release.**
There is nothing to run by those names. Where the table above names one of them as the owner of a
state, `abort` remains available as the actual, working exit from that state today.

`rollback` specifically is not merely deferred by sequencing: its underlying orchestration has a
known safety gap (tracked separately, issue #1433) that makes it safe to exist unregistered in this
codebase but unsafe to expose as a runnable command. It will not be registered until that gap is
closed, independent of when `resume`, `verify` and `activate` become available.

`report` is also not registered as a CLI command in this release, despite being named in this
Epic's design as manifest-level-only for now; it and its fuller verification-report body readback
both land with the `verify` integration.

Do not read any of this as "coming soon": it is a statement of what you can and cannot do with this
release, today. When `resume`, `verify`, `report`, `activate` and `rollback` do become available,
this document will say so in the command reference above, the same way `plan`, `dry-run`, `apply`
and `abort` are documented there now.

## The maintenance hold, in more detail

When `apply` takes the maintenance hold, it spans the entire capture-and-copy window: capturing the
SQLite source, minting the migration manifest, and copying every batch of records to PostgreSQL.
**The maintenance window scales with the amount of data being migrated** -- a small project's hold
lasts seconds; a large one's can last substantially longer, bounded by how much data has to be read
from SQLite and written to PostgreSQL. There is no separate "how long will this take" answer beyond
the size of what is being copied.

**Daemon presence during the hold.** `apply` positively establishes whether a daemon is running
before taking the hold (never assumed, and never refused merely because none is running -- see
"Daemon presence" below). If a daemon **is** running, ordinary consumer admission -- including that
daemon's own passive-event sweep -- is fenced for the whole hold. A running daemon will log-and-
retry rather than make progress for the duration of the window; this is expected non-progress, not
corruption, and it resolves itself once the hold ends (via `abort` in this release). `apply` writes
one line to stderr, before it takes the hold, when a daemon is observed running, and records
`daemonPresent` (and `daemonStorageBackend` when present) in its JSON evidence, as `plan` does.

### Daemon presence

`apply` and `plan` both positively establish daemon presence before proceeding, distinguishing three
genuinely different facts: a daemon is running (recorded, including which storage backend it
reports); no daemon is running, positively confirmed by the absence of both a pid file and any live
process for it; or presence could not be determined at all (refuses `daemon-presence-unresolvable`,
exit 5). A daemon not running is **not** a precondition failure -- nothing in this migration needs a
daemon, and refusing on its absence would force you to start one immediately before a hold that
would then make that daemon's own sweeps fail, which is the exact situation this check exists to
warn about, not require.

## What is preserved, and what the probe bound means

**Nothing is ever deleted by this command group.** A failed, aborted, or superseded migration
generation's captured artifacts stay on disk exactly as they were at the point of failure or abort.
`abort` releases the hold and settles the manifest; it does not remove the snapshot, the manifest,
or any evidence associated with the attempt. If you need to reclaim disk space from old attempts,
that is a separate, manual operation outside this command group's scope -- not something `abort`
or any other migration command does for you.

Each project's migration identity is a stable base (derived from the local project and the
PostgreSQL target's non-secret coordinates) plus a small integer **probe ordinal** that increments
each time a fresh cutover attempt is needed -- most visibly, each time an attempt is aborted after
capture and a new one is started. The probe ordinal is bounded; if every ordinal up to that bound is
occupied by a terminal (not cleaned up) generation, `apply`/`plan` refuse
`generation-probe-bound-exceeded` (exit 2), naming cleanup of terminal generations as the remedy.
This is not expected in ordinary use; it would only happen after a large number of aborted attempts
against the same project and target without ever reclaiming their artifacts.

## No drain-liveness claim

A cutover, including a successful `apply`, **does not flush a pending local event backlog**.
Preserving pending events correctly and routing them to the right place on the next read is not the
same as draining them -- nothing in this Epic currently guarantees that a retained backlog is
processed to completion by any specific point in the migration sequence. **The daemon restart that
accompanies eventual activation is what resumes processing** of anything still pending, not the
migration commands themselves. Do not assume a pending backlog is empty because `apply` succeeded.

## Fencing residue: what this command group does not protect against

The maintenance hold and every refusal in this command group fence **same-host LCM processes only**.
There is no exclusion proof, and none is claimed, across any of the following:

- **A second LCM installation** pointed at the same PostgreSQL database or the same SQLite files
  through a different `~/.lcm` home directory or a different host.
- **A direct `sqlite3` (or any other non-LCM) session** opened against the same SQLite database
  file while a hold is active. LCM's fencing has no way to see or block a connection that does not
  go through its own storage layer.
- **Another host** entirely, for the same reason as the first point.

If you operate more than one LCM installation, or otherwise touch these SQLite files or this
PostgreSQL database outside of this LCM installation's own commands, you are responsible for not
doing so concurrently with a migration hold. This command group cannot detect or prevent that.

## Machine-readable inventory (checked by CI against the CLI's own source of truth)

This block is compared, in both directions, against this candidate's exported exit-class,
command-contract, and refusal-reason constants by a dedicated test
(`test/migration/runbook-conformance.test.ts`). If this block and the source ever disagree, that
test fails -- this section is not prose, and keeping it manually in sync is not the mechanism that
guarantees it stays accurate; the test is. Do not hand-edit this block without re-running that test.

`status: "implemented"` means the command is registered and runnable today. `status: "outline"`
means the command name and its eventual contract are documented for forward compatibility with the
rest of this Epic, but the command itself does not exist yet -- see "Commands not available today"
above.

```json
{
  "exitClasses": [
    {
      "code": 0,
      "name": "ok",
      "description": "Completed and its named postcondition was positively read back."
    },
    {
      "code": 1,
      "name": "usage",
      "description": "Malformed invocation. Never reaches a storage seam."
    },
    {
      "code": 2,
      "name": "refused-precondition",
      "description": "State does not admit this operation. Remedy names the command that does."
    },
    {
      "code": 3,
      "name": "refused-confirmation",
      "description": "A mutating boundary was not confirmed."
    },
    {
      "code": 4,
      "name": "refused-contention",
      "description": "Another actor holds the lock, barrier or lease."
    },
    {
      "code": 5,
      "name": "refused-evidence",
      "description": "Evidence is absent, unattributable, or failed its comparison."
    },
    {
      "code": 6,
      "name": "incomplete-recoverable",
      "description": "Durably begun, not terminal, and resume can finish it."
    },
    {
      "code": 7,
      "name": "failed-operator-required",
      "description": "No automatic path resolves this."
    },
    {
      "code": 8,
      "name": "restart-required",
      "description": "Durable state correct; a live daemon holds a stale startup backend, so the cutover is not reportable as successful."
    }
  ],
  "commands": [
    {
      "command": "plan",
      "status": "implemented",
      "exitZeroPostcondition": "Every precondition read succeeded and the emitted evidence is complete, including a positively established daemon presence answer and a computed candidate id.",
      "canEmit": [
        0,
        1,
        2,
        4,
        5
      ]
    },
    {
      "command": "dry-run",
      "status": "implemented",
      "exitZeroPostcondition": "The dry-run completed and its result was read back.",
      "canEmit": [
        0,
        1,
        2,
        4,
        5
      ]
    },
    {
      "command": "apply",
      "status": "implemented",
      "exitZeroPostcondition": "Journal re-read at the expected phase and checksum; snapshot classifies complete; manifest head reads at the expected phase.",
      "canEmit": [
        0,
        1,
        2,
        3,
        4,
        5,
        6,
        7
      ]
    },
    {
      "command": "resume",
      "status": "outline",
      "exitZeroPostcondition": "The state it routed to reached its next durable checkpoint, read back.",
      "canEmit": [
        0,
        1,
        2,
        3,
        4,
        5,
        6,
        7
      ]
    },
    {
      "command": "verify",
      "status": "outline",
      "exitZeroPostcondition": "Verification report persisted and re-read; manifest at verified.",
      "canEmit": [
        0,
        1,
        2,
        3,
        4,
        5,
        6,
        7
      ]
    },
    {
      "command": "report",
      "status": "outline",
      "exitZeroPostcondition": "Every read succeeded and evidence is complete. Manifest-level only in this candidate; the verification-report body readback lands with #624's integration.",
      "canEmit": [
        0,
        1,
        2,
        5,
        8
      ]
    },
    {
      "command": "activate",
      "status": "outline",
      "exitZeroPostcondition": "Manifest read back at its durable phase and the restart verifier answered satisfied.",
      "canEmit": [
        0,
        1,
        2,
        3,
        4,
        5,
        6,
        7,
        8
      ]
    },
    {
      "command": "rollback",
      "status": "outline",
      "exitZeroPostcondition": "Manifest read back at rolled-back.",
      "canEmit": [
        0,
        1,
        2,
        3,
        4,
        5,
        6,
        7
      ]
    },
    {
      "command": "abort",
      "status": "implemented",
      "exitZeroPostcondition": "Journal terminal and manifest settled, both read back.",
      "canEmit": [
        0,
        1,
        2,
        3,
        4,
        5,
        7
      ]
    }
  ],
  "refusals": [
    {
      "reason": "unexpected-failure",
      "exitClass": "refused-evidence",
      "remedy": "The command hit an unexpected internal failure. Run `lcm doctor`, then `lcm migration plan` to see the current state, and file an issue quoting the evidence."
    },
    {
      "reason": "invalid-expected-owner",
      "exitClass": "refused-precondition",
      "remedy": "storage.postgresql.migrationRole (or LCM_POSTGRES_MIGRATION_ROLE) is not a valid PostgreSQL role name. Fix the configured value before retrying."
    },
    {
      "reason": "machine-identity-unregistered",
      "exitClass": "refused-precondition",
      "remedy": "This machine has no registered PostgreSQL identity. Run `lcm machine register` before retrying."
    },
    {
      "reason": "migration-target-identity-unresolvable",
      "exitClass": "refused-evidence",
      "remedy": "The destination PostgreSQL project identity could not be resolved or minted. Run `lcm doctor` before retrying."
    },
    {
      "reason": "migration-target-missing",
      "exitClass": "refused-precondition",
      "remedy": "No usable PostgreSQL target is configured. Set storage.postgresql (url, caFile, migrationRole) or the LCM_POSTGRES_URL / LCM_POSTGRES_CA_FILE / LCM_POSTGRES_MIGRATION_ROLE environment variables."
    },
    {
      "reason": "migration-target-unresolvable",
      "exitClass": "refused-evidence",
      "remedy": "The PostgreSQL target configuration could not be read or parsed. Run `lcm doctor` before retrying."
    },
    {
      "reason": "migration-target-verification-failed",
      "exitClass": "refused-precondition",
      "remedy": "The PostgreSQL target was reached but failed TLS or migration-role verification. Fix the role grants or TLS configuration, then retry."
    },
    {
      "reason": "migration-target-verification-unresolvable",
      "exitClass": "refused-evidence",
      "remedy": "The PostgreSQL target could not be reached to verify TLS or role access. Check network connectivity and the target address, then retry."
    },
    {
      "reason": "dry-run-failed",
      "exitClass": "refused-evidence",
      "remedy": "The SQLite source could not be dry-run checked. Run `lcm doctor` before retrying."
    },
    {
      "reason": "publication-occupies-slot",
      "exitClass": "refused-contention",
      "remedy": "A v2 publication is in progress. Wait for it to complete, then retry."
    },
    {
      "reason": "journal-unresolvable",
      "exitClass": "refused-evidence",
      "remedy": "The maintenance journal could not be read. Run `lcm doctor` and inspect ~/.lcm/backend-publication before retrying."
    },
    {
      "reason": "generation-occupied-since-probe",
      "exitClass": "refused-contention",
      "remedy": "Another local actor took the candidate generation between the probe and the hold. Retry."
    },
    {
      "reason": "generation-unresolvable-since-probe",
      "exitClass": "refused-evidence",
      "remedy": "The candidate generation could not be re-verified immediately before the hold. Run `lcm doctor` before retrying."
    },
    {
      "reason": "generation-probe-bound-exceeded",
      "exitClass": "refused-precondition",
      "remedy": "Every candidate ordinal up to the probe bound is occupied. Clean up terminal generations, then retry."
    },
    {
      "reason": "generation-occupancy-refused",
      "exitClass": "refused-evidence",
      "remedy": "A candidate generation's occupancy could not be classified. Run `lcm doctor` before retrying."
    },
    {
      "reason": "generation-invalid-input",
      "exitClass": "failed-operator-required",
      "remedy": "The CLI constructed an invalid candidate generation identity. This is an internal defect; file an issue rather than retrying."
    },
    {
      "reason": "generation-identifier-bound-exceeded",
      "exitClass": "failed-operator-required",
      "remedy": "A candidate generation id exceeded the identifier length bound. This is an internal defect; file an issue rather than retrying."
    },
    {
      "reason": "multi-machine-installation",
      "exitClass": "refused-precondition",
      "remedy": "This project is shared across machines. SQLite-to-PostgreSQL migration requires a single-machine (local) project."
    },
    {
      "reason": "hold-entry-contention",
      "exitClass": "refused-contention",
      "remedy": "Another actor holds the publication lock, so the maintenance hold was not entered. Wait, then retry `lcm migration apply`."
    },
    {
      "reason": "hold-entry-slot-occupied",
      "exitClass": "refused-contention",
      "remedy": "A publication or another maintenance hold occupies the journal slot. Wait for it to finish, then re-run `lcm migration plan`."
    },
    {
      "reason": "hold-entry-precondition",
      "exitClass": "refused-precondition",
      "remedy": "The maintenance journal changed while the hold was being entered. Re-run `lcm migration plan` and confirm the id it prints."
    },
    {
      "reason": "hold-entry-evidence",
      "exitClass": "refused-evidence",
      "remedy": "The maintenance journal could not be read or verified while entering the hold. Run `lcm doctor` before retrying."
    },
    {
      "reason": "hold-entry-readback-mismatch",
      "exitClass": "refused-evidence",
      "remedy": "The maintenance hold could not be confirmed after being entered. Run `lcm doctor` before retrying."
    },
    {
      "reason": "capture-failed",
      "exitClass": "failed-operator-required",
      "remedy": "SQLite snapshot capture failed after the hold was taken. Run `lcm migration abort` to release the hold, then investigate before retrying."
    },
    {
      "reason": "capture-contention",
      "exitClass": "refused-contention",
      "remedy": "Another actor held a lock during capture. The maintenance hold is still in place; re-run `lcm migration apply` with the same --confirm-generation to continue, or run `lcm migration abort` to release it."
    },
    {
      "reason": "capture-unresolvable",
      "exitClass": "refused-evidence",
      "remedy": "The maintenance journal could not be verified during capture. The maintenance hold is still in place; run `lcm doctor`, then re-run `lcm migration apply` to continue or `lcm migration abort` to release it."
    },
    {
      "reason": "continuation-mismatched-hold",
      "exitClass": "refused-precondition",
      "remedy": "An existing maintenance hold does not match this project's current selection. Run `lcm migration abort` before retrying."
    },
    {
      "reason": "continuation-partial-snapshot",
      "exitClass": "refused-precondition",
      "remedy": "The held generation's snapshot is partial or replaced and cannot be resumed. Run `lcm migration abort` to release the hold; the captured evidence is preserved."
    },
    {
      "reason": "continuation-resume-required",
      "exitClass": "refused-precondition",
      "remedy": "A prior cutover reached a state only `resume` can continue. Run `lcm migration resume`."
    },
    {
      "reason": "continuation-unclassified",
      "exitClass": "failed-operator-required",
      "remedy": "The maintenance journal's phase could not be classified into a known continuation. This is an internal defect; file an issue."
    },
    {
      "reason": "abort-gate-unresolvable",
      "exitClass": "refused-evidence",
      "remedy": "The manifest for a terminal generation could not be read. Run `lcm doctor` before retrying."
    },
    {
      "reason": "abort-or-resume-required",
      "exitClass": "refused-precondition",
      "remedy": "A terminal maintenance journal has an unsettled manifest. Run `lcm migration abort` or `lcm migration resume` before starting a fresh cutover."
    },
    {
      "reason": "entering-recovery-precondition",
      "exitClass": "refused-precondition",
      "remedy": "The recovered entering journal does not match this project's current selection. Run `lcm migration abort` before retrying."
    },
    {
      "reason": "entering-recovery-contention",
      "exitClass": "refused-contention",
      "remedy": "Another actor holds the publication lock during recovery. Wait and retry."
    },
    {
      "reason": "entering-recovery-evidence",
      "exitClass": "refused-evidence",
      "remedy": "The entering journal's recovery could not be verified. Run `lcm doctor` before retrying."
    },
    {
      "reason": "entering-recovery-unclassified",
      "exitClass": "failed-operator-required",
      "remedy": "The entering journal's recovery failure could not be classified. This is an internal defect; file an issue."
    },
    {
      "reason": "snapshot-unresolvable",
      "exitClass": "refused-evidence",
      "remedy": "The captured SQLite snapshot could not be classified. Run `lcm doctor` before retrying."
    },
    {
      "reason": "capture-incomplete",
      "exitClass": "refused-precondition",
      "remedy": "Capture-before-genesis ordering requires a complete snapshot before manifest genesis. Retry `lcm migration apply`."
    },
    {
      "reason": "manifest-unresolvable",
      "exitClass": "refused-evidence",
      "remedy": "The migration manifest could not be read. Run `lcm doctor` before retrying."
    },
    {
      "reason": "genesis-inspection-failed",
      "exitClass": "failed-operator-required",
      "remedy": "Inspecting the source and destination witnesses for manifest genesis failed. Investigate the target PostgreSQL connection before retrying."
    },
    {
      "reason": "genesis-create-failed",
      "exitClass": "failed-operator-required",
      "remedy": "Manifest genesis failed after a successful capture. Run `lcm doctor`; the snapshot is preserved and safe to retry from."
    },
    {
      "reason": "genesis-dry-run-begin-failed",
      "exitClass": "failed-operator-required",
      "remedy": "Beginning the dry-run copy effect failed. Run `lcm doctor` before retrying."
    },
    {
      "reason": "genesis-dry-run-complete-failed",
      "exitClass": "failed-operator-required",
      "remedy": "Completing the dry-run copy effect failed. Run `lcm doctor` before retrying."
    },
    {
      "reason": "copy-failed",
      "exitClass": "failed-operator-required",
      "remedy": "Copying captured data to the destination failed. The source snapshot is preserved; run `lcm doctor` before retrying."
    },
    {
      "reason": "confirmation-missing",
      "exitClass": "refused-confirmation",
      "remedy": "Run `lcm migration plan` first, then pass its printed generation id to `apply --confirm-generation <id>`."
    },
    {
      "reason": "confirmation-generation-moved",
      "exitClass": "refused-confirmation",
      "remedy": "The candidate generation changed since `lcm migration plan` was run. Re-run `lcm migration plan` and confirm the new id."
    },
    {
      "reason": "daemon-presence-unresolvable",
      "exitClass": "refused-evidence",
      "remedy": "Daemon presence could not be positively established. Run `lcm daemon status`, resolve the failure, and retry."
    },
    {
      "reason": "abort-wrong-phase",
      "exitClass": "refused-precondition",
      "remedy": "The maintenance journal is not in an abortable phase (it is either absent or already past a successful cutover). Nothing to abort."
    },
    {
      "reason": "abort-journal-moved",
      "exitClass": "refused-precondition",
      "remedy": "The maintenance journal changed since it was last observed. Re-run `lcm migration abort` to act on its current state."
    },
    {
      "reason": "abort-invalid-input",
      "exitClass": "failed-operator-required",
      "remedy": "The CLI constructed an invalid abort request. This is an internal defect; file an issue rather than retrying."
    },
    {
      "reason": "abort-manifest-needs-resume",
      "exitClass": "failed-operator-required",
      "remedy": "The manifest has an in-progress copy effect that only `resume` can complete or abandon. Nothing was changed. This release does not register resume; file an issue."
    },
    {
      "reason": "abort-unresolvable",
      "exitClass": "refused-evidence",
      "remedy": "The abort could not be classified into a known precondition or defect. Run `lcm doctor` before retrying."
    },
    {
      "reason": "abort-confirmation-missing",
      "exitClass": "refused-confirmation",
      "remedy": "Pass --confirm-generation with the generation id of the live maintenance hold. This refusal reports that id in its generation field; nothing was changed."
    },
    {
      "reason": "abort-confirmation-moved",
      "exitClass": "refused-confirmation",
      "remedy": "--confirm-generation does not match the live maintenance hold. Pass the generation id this refusal reports; nothing was changed."
    },
    {
      "reason": "abort-nothing-to-abort",
      "exitClass": "refused-precondition",
      "remedy": "There is no maintenance hold to abort."
    },
    {
      "reason": "abort-readback-mismatch",
      "exitClass": "failed-operator-required",
      "remedy": "The abort appeared to complete but its terminal state could not be confirmed on readback. Run `lcm doctor` and inspect the maintenance journal and manifest directly."
    }
  ]
}
```

## See also

- `docs/migration-cutover.md` -- the internal design of the checksum-sealed migration journal and
  capture protocol this command group drives. Read this document (the operator runbook) first;
  that one is for understanding the mechanism, not for running commands.
- `docs/backend-publication.md` -- the backend publication and maintenance-journal protocol
  `apply`'s hold is built on, including why a live daemon's frozen startup backend is a separate
  gate from durable state correctness.
- `lcm migration <command> --help` -- flag-level reference for each command, generated from the
  same source this document is checked against.

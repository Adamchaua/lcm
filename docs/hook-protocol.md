# Claude Code Hook Protocol

This document describes the stdin payload fields that Claude Code delivers to each lcm hook command.

All hooks receive a JSON object via stdin. lcm hooks are invoked as shell commands:

```
lcm <hook-command> < <stdin-json>
```

## Hook entrypoints and legacy-root migration

Installed hook entrypoints (`post-tool`, `restore`, `session-end`,
`session-snapshot`, `user-prompt`, and `compact --hook`) skip the CLI's
global legacy-root migration preflight, so a busy backend publication lock
cannot fail a hook before its own handler runs. Interactive `lcm compact` and
installation keep the preflight.

- Hook-side legacy-root migration is attempted only through the dispatch
  bootstrap (`bootstrapLcmHome`): on every `session-snapshot` with a
  `session_id`, and on `restore` or `session-end` with a `session_id` only
  until that session's bootstrap flag exists (once per session). For
  `restore` and `session-end`, a bootstrap failure other than a publication
  journal error is best-effort and the hook continues; `session-snapshot`
  skips its work instead. `user-prompt`, `compact --hook`, and invocations
  without a `session_id` never migrate. Migration otherwise happens at
  installation or through the interactive CLI.
- Hooks do not enforce the legacy-and-active home coexistence refusal as a
  hook failure; installation and the interactive CLI commands that keep the
  preflight still do.
- Ordinary publication-lock contention follows each hook's own bounded policy.
  Admission fences and the pre-handler configuration load treat it as a
  best-effort outcome (exit `0`). UserPromptSubmit's durable local enqueue is
  retry-required: it exits non-zero if its append barrier stays busy past the
  bounded wait.
- Malformed, tampered, or unresolved publication evidence still fails closed
  wherever a hook already rethrows it.

## Local passive-event durability

Passive-event capture is an explicit offline boundary. `PostToolUse` and
`UserPromptSubmit` commit only to the per-project SQLite sidecar under
`~/.lcm/events/`; they never open PostgreSQL, resolve PostgreSQL credentials, or
wait for a network request. Daemon notification remains best-effort and is not
part of the hook commit.

Every captured row has a versioned local delivery envelope:

| Envelope field | Purpose |
|-------|-------------|
| `event_uuid` | Stable UUID used for idempotent remote insertion and exact replay |
| `event_version` | Compatibility version for decoding the event |
| `machine_id` | Durable registered machine UUID, or assigned before first delivery when capture occurred before registration |
| `machine_sequence` | Installation-global, 19-digit exact-`bigint` sequence used for per-machine ordering |
| `type` and payload columns | Scrubbed event type plus session sequence, category, data, priority, source hook, predecessor, and capture time |
| delivery state and timestamps | Durable claim, retry, replication, acknowledgement, quarantine, and remote-prune checkpoints |

Local promotion may add predecessor correlation while an envelope is still
pending. That metadata is frozen atomically when the first delivery claim
begins, so a later local correlation pass cannot change an envelope that may
already exist in PostgreSQL.

Promotion that already holds consumer publication admission forwards the same
live token through predecessor correlation. An error-to-fix pair can therefore
persist its predecessor and complete local acknowledgement on its first pass
without contending with its own admission. A held maintenance journal still
blocks correlation updates.

The sequence allocator is a separate local SQLite file,
`~/.lcm/events/.machine-sequence.sqlite`. Reservation and checkpoint update are
one transaction. A crash between reservation and sidecar insertion can leave a
gap, but no committed event can reuse a sequence.

Legacy sidecars upgrade transactionally. Immutable legacy content derives a
deterministic compatibility UUID, existing local `processed_at` metadata is
preserved, and delivery starts independently. Local passive-learning
processing does not imply PostgreSQL acknowledgement and cannot prevent later
delivery.

This release decodes envelope version `1`. A positive but unsupported version
is quarantined locally before any network insertion, remains visible through
`lcm events quarantine`, and can be replayed by exact UUID after compatible
software is installed. Later machine-sequence events may continue because the
quarantine is an explicit terminal checkpoint, not a retryable outage. A drain
that encounters an already-remote unsupported claim applies the same
quarantine policy instead of invoking an incompatible effect decoder.

The staged replication worker owns all PostgreSQL I/O. It resolves uncertain
insertion, application, and pruning through exact readback before advancing the
local checkpoint. Hooks are therefore unchanged by PostgreSQL outages: they
commit locally and return successfully while the durable backlog waits.

## PreCompact Hook

**Command:** `lcm compact --hook`

Invoked by Claude Code before it runs its built-in compaction. When the admitted
daemon is available, lcm writes a DAG summary and may return summary text on
stdout. The hook exits `0`, so Claude Code can continue its own compaction.

The installed command has no timeout or retry overrides. Its wrapper does not
resolve PostgreSQL connection credentials before entering the fail-open hook
path. If the configured backend is unavailable, its runtime credentials are
absent, or daemon admission fails, the hook exits `0` with no output and does
not block Claude Code's compaction. A customized hook command with explicit
`--timeout-ms` or `--retry-*` overrides reads only the secret-free LLM request
policy projection needed to validate those flags; it still does not resolve
PostgreSQL credentials before dispatch.

This fail-open behavior is specific to the installed best-effort hook. Manual
CLI operations, daemon startup and restart, and MCP request admission continue
to resolve the full effective configuration and fail closed when required
credentials or backend support are unavailable.

**Stdin fields:**

| Field | Type | Description |
|-------|------|-------------|
| `session_id` | string | Session identifier |
| `cwd` | string | Working directory of the Claude Code session |
| `hook_event_name` | string | `"PreCompact"` |

**Response:** Exit code `0`, with summary text on stdout when lcm compaction
succeeds or no output when lcm defers to Claude Code.

## SessionStart Hook

**Command:** `lcm restore`

Invoked at the start of a Claude Code session. lcm restores recent summaries and promoted memory, injects them as a user message prefix, and prints a `<context>` block on stdout.

SessionStart serializes its local sidecar maintenance with backend publication:
it uses one live consumer token to enter the append barrier while it opens,
prunes, inspects, and physically closes the local outbox. If another publication
already holds that lock, the best-effort maintenance and promotion trigger are
skipped. Daemon startup and the restore request run outside these retained
locks and still perform their own admission checks. Authenticated
publication-journal errors fail closed.

**Stdin fields:**

| Field | Type | Description |
|-------|------|-------------|
| `session_id` | string | Session identifier |
| `cwd` | string | Working directory |
| `hook_event_name` | string | `"SessionStart"` |

**Response:** Exit code `0`. Context is injected via stdout (printed as a `<context>` block that Claude Code prepends to the session).

## SessionEnd Hook

**Command:** `lcm session-end`

Invoked when the Claude Code session ends. lcm ingests the completed session transcript and triggers passive-learning event promotion.

After daemon admission, the hook reads one authenticated snapshot of its settings
before sending the transcript for ingestion. Compaction and filter-notification
settings changed while ingestion is in progress apply to the next invocation.
If configuration cannot be admitted, the hook sends no ingest request and stores
no transcript messages from that invocation. Ordinary configuration contention
still permits session exit; it can occur before this snapshot is read.

After ingesting a Claude transcript, lcm waits up to one second for the daemon
to acknowledge its session-completion record. The daemon records the message
count from stored history; repeating completion updates the same session record
with the current stored count. This wait covers completion bookkeeping only.
Compaction and promotion remain independent, best-effort background requests.
Ordinary scheduling failures, including publication-lock contention, do not
prevent the remaining background requests or Claude's completion attempt.
A failed scheduling stage may already have sent its request before a final
publication check failed; its delivery is uncertain and the hook does not retry
it. Local typed publication-journal failures stop subsequent stages and retain
the fail-closed admission behavior.

Completion is best-effort when the daemon is unavailable, busy, or refuses
publication admission. Ordinary completion failures still allow session exit.

Concurrent operations in the same daemon queue their publication and storage
admission, including early project identity checks. This prevents ordinary
in-flight PostgreSQL work from immediately rejecting completion or promotion
because that daemon already owns the publication lock. Publication validation
and refusal of another process's lock remain in force. A queued completion
canceled before entry does no storage work. Prolonged work can still exceed the
one-second best-effort wait and the hook may abandon completion; no timeout is
extended and no arbitrary-load latency guarantee is made. The conformance
observer retains its separate five-second observation window.
A timeout leaves persistence uncertain: the daemon may have committed the
record before the acknowledgment was interrupted. Local publication-journal
errors continue to fail closed. Codex Stop events remain turn-scoped and do not
mark the session complete; their session-snapshot behavior is unchanged.

**Stdin fields:**

| Field | Type | Description |
|-------|------|-------------|
| `session_id` | string | Session identifier |
| `cwd` | string | Working directory |
| `hook_event_name` | string | `"SessionEnd"` |

**Response:** Ordinary failures return exit code `0` and do not block session
exit. Local typed publication-journal failures return exit code `1` with the
publication-admission diagnostic.

## UserPromptSubmit Hook

**Command:** `lcm user-prompt`

Invoked on each user prompt. lcm searches memory for relevant hints and injects a `<memory-hints>` block into the prompt.

**Stdin fields:**

| Field | Type | Description |
|-------|------|-------------|
| `session_id` | string | Session identifier |
| `cwd` | string | Working directory |
| `prompt` | string | The user's prompt text |
| `hook_event_name` | string | `"UserPromptSubmit"` |

**Response:** Exit code `0`. Hints are injected via stdout when relevant matches are found.

Before persisting extracted passive events, the hook checks whether the mapped
local project storage is the exact authenticated retired-identity fence
described in [Project identity](project-identity.md#retired-local-identities).
For that one condition it intentionally skips the prompt's passive events,
writes one fixed bounded terminal diagnostic directing the user to
`lcm project renew-retired-identity`, and continues prompt search. It does not
append a generic `ENOTDIR` row to the sidecar or `~/.lcm/logs/events.log`, does
not open the normal hook-error circuit, and never renews identity implicitly.
If stderr is unavailable, the diagnostic is best effort and hook exit remains
successful. Malformed or uncertain fence topology keeps the ordinary strict
error path.

## PostToolUse Hook

**Command:** `lcm post-tool`

Invoked after every tool call. lcm extracts structured events (decisions, errors, git ops, etc.) and writes them to the passive-learning sidecar database.

**Stdin fields:**

| Field | Type | Description |
|-------|------|-------------|
| `session_id` | string | Session identifier |
| `cwd` | string | Working directory |
| `tool_name` | string | Name of the tool that was called |
| `tool_input` | object | The tool's input arguments |
| `tool_response` | any | The tool's response object |
| `tool_output` | string | Plaintext output (if available) |
| `hook_event_name` | string | `"PostToolUse"` |

**Response:** Normal capture exits with code `0`. This hook runs on every tool
call and must be fast; it does no network I/O and only writes to a local
sidecar SQLite database. The CLI dispatches PostToolUse without running the
legacy-root bootstrap migration; installation and session startup own that
boundary. The local event is appended before any selected-state
publication admission is attempted. After that durable boundary:

- missing publication evidence is treated as a successful best-effort outcome
  (`0`) and does not emit a failure diagnostic;
- typed private publication-lock contention is also a successful best-effort
  outcome (`0`), while its ordinary typed error is recorded safely;
- malformed, tampered, unsafe, mismatched, or unresolved publication evidence
  remains fail-closed for selected-state work. After the local event is
  preserved, the hook stops before selected-state mutation, records the fixed
  diagnostic below, and returns code `0` with a protocol-safe JSON
  `systemMessage` on stdout. This is a successful observer-hook protocol
  result, not permission to continue selected-state work and not a hook
  process failure.

If publication admission fails before the local event can be durably appended,
the hook does not report a successful observer result; the direct top-level CLI
path retains its fixed stderr diagnostic and exit code `1`. Hook append
admission waits for contention for at most five seconds, including time queued
behind another hook in the same process. Once admitted, opening the outbox,
allocating sequences, inserting every event, reading health, and physically
closing the outbox and sequence handles complete under that single admission.
The hook never retries its event writes; an admission timeout occurs before
the first write and requires the host to retry the hook.

The fixed diagnostic is:

```text
lcm: backend publication admission blocked; preserve the evidence, run 'lcm doctor', and resolve the authenticated publication before retrying.
```

Raw publication messages, causes, stacks, paths, URLs, credentials, and journal
contents are never included in that user-facing line.

For a post-enqueue refusal, stdout contains exactly one JSON property:

```json
{"systemMessage":"lcm: backend publication admission blocked; preserve the evidence, run 'lcm doctor', and resolve the authenticated publication before retrying."}
```

The `daemon_port` payload field is ignored. PostToolUse never sends the daemon
bearer token or captured event data to a payload-selected listener; queued
events are collected by the daemon's bounded background processing instead.

### Codex native PostToolUse capture

The Codex connector uses the following exact hook entry in the canonical
`~/.codex/hooks.json` file (or the equivalent path selected by the existing
connector install scope):

```json
{
  "PostToolUse": [
    {
      "matcher": "*",
      "hooks": [
        {
          "type": "command",
          "command": "lcm post-tool --client codex"
        }
      ]
    }
  ]
}
```

The `matcher`, hook `type`, and command are structural contract values. The
installed connector may also retain its timeout and status-message metadata,
but the command must remain exactly `lcm post-tool --client codex`; extra
arguments do not satisfy the contract. Install it with:

```bash
lcm connectors install codex
lcm connectors doctor codex
```

The `--global` option selects the existing global connector scope; no new
configuration option is required for native command capture, and the 2,000-
character adapter bound is fixed rather than configurable.

Codex sends native tool names `functions.exec` and `functions.exec_command`.
For those names, lcm accepts only the bounded semantic command (`command`, or
`cmd` when `command` is absent) and a direct status projection. `tool_output` is
checked before `tool_response`; status fields are considered in this order:
`isError`, `is_error`, `exit_code`, and `exitCode`. Boolean values are used
directly, while finite numeric exit codes map zero to success and nonzero to an
error. A valid false or zero value is authoritative. Nested or invalid values
are ignored.

The adapter does not persist raw Codex responses, stdout, stderr, or unknown
fields, and it does not infer file events from shell text or unrecognized
file-like fields. The existing event truncation and scrubbing pipeline still
runs on derived event data. Commands whose trimmed text begins with `lcm
store` are suppressed to prevent LCM's own writes from feeding back into
passive learning.

`lcm connectors doctor codex` performs two checks for the targeted Codex
connector. It first verifies the exact structural hook contract above. Only
when that check passes does it run the native-exec functional probe. The probe
is pure and in-memory: it exercises normalization and extraction without
invoking the PostToolUse handler, opening an EventsDb, appending sidecar
events, writing hook files, or creating a database. A structurally absent or
incomplete hook never reports functional success; its functional result is
reported as:

```text
Codex: native exec capture functional check skipped
```

When the exact structure and the pure probe both pass, doctor reports:

```text
✓ Codex: PostToolUse hook installed
✓ Codex: native exec capture functional
```

## SessionSnapshot Hook

**Command:** `lcm session-snapshot`

An optional periodic hook that incrementally ingests the live session transcript between `SessionEnd` events. This is used for long-running sessions where you want memory to be updated without waiting for the session to end. Codex uses this command on `Stop` for rolling snapshots, on `PreCompact` to force-ingest deltas immediately before manual or automatic compaction, and on `SubagentStop` to ingest a finished subagent (see [Codex subagent lifecycle](#codex-subagent-lifecycle)).

Snapshot ingestion is skipped when daemon bootstrap cannot verify the configured daemon PID, installed version, and exact loopback listener. This prevents transcript paths, request bodies, and bearer credentials from being sent to an occupied but unverified port.

**Stdin fields:**

| Field | Type | Description |
|-------|------|-------------|
| `session_id` | string | Session identifier |
| `cwd` | string | Working directory |
| `transcript_path` | string | Path to the live JSONL session transcript |
| `agent_id` | string | Codex subagent thread id; keys the subagent's memory instead of `session_id` |
| `agent_transcript_path` | string | Codex `SubagentStop` only: path to the subagent's own rollout, used instead of `transcript_path` |
| `hook_event_name` | string | `"SessionSnapshot"`, `"PreCompact"` or `"SubagentStop"` (if provided) |

**Response:** Exit code `0`.

## Codex subagent lifecycle

Codex runs a separate thread for every subagent it spawns. Those threads fire
`SubagentStart` and `SubagentStop` instead of `SessionStart` and `Stop`, and
the `lcm connectors install codex` hook set registers both. Internal Codex
subagents run no hooks, so LCM sees nothing from them.

Every hook payload from a subagent carries `session_id`, which is the root
thread of the whole agent tree, and `agent_id`, which is the subagent's own
thread. LCM treats a Codex payload with a non-empty string `agent_id` as a
subagent and keys its memory by `agent_id`, so a subagent's messages, tool
events and restore state never mix into its parent's conversation. Root Codex
sessions and other clients are unchanged, even if their payload happens to
carry `agent_id`. A malformed `agent_id` (empty or not a string) is handled
as a root payload.

| Event | Command | Behavior for a subagent |
|-------|---------|-------------------------|
| `SubagentStart` | `lcm restore --client codex` | Prints project memory (orientation, promoted knowledge, learned insights and project instructions) on stdout, which Codex gives the subagent as context. The restore lock is per subagent, so the parent and sibling subagents never suppress it. The best-effort outbox maintenance that a root start performs is skipped. |
| `UserPromptSubmit` | `lcm user-prompt --client codex` | Searches memory under the subagent's key. The prompt itself is not recorded as a user decision, because the parent wrote it. |
| `PostToolUse` | `lcm post-tool --client codex` | Records tool events under the subagent's key. |
| `PreCompact` | `lcm session-snapshot --client codex` | Ingests the subagent's own rollout under its key. |
| `SubagentStop` | `lcm session-snapshot --client codex` | Ingests the subagent's rollout (`agent_transcript_path`) under its key, bypassing the snapshot throttle. The parent's rollout (`transcript_path`, which may be `null`) is never read for a subagent. |

`SubagentStop` handling never blocks or continues the subagent: it writes
nothing to stdout, returns no decision, and never exits with code `2`. Ordinary
failures exit `0`. An unresolved backend publication keeps its fail-closed
exit `1` with a diagnostic on stderr, which Codex reports as a failed hook.
A `SubagentStop` payload without a valid `agent_id` or without
`agent_transcript_path` is ignored.

**Limits:**

- The immediate parent of a subagent is not stored by LCM. It can be recovered
  from the subagent's rollout: its `session_meta` record has `id` (the
  subagent's session key in LCM) and `parent_thread_id`. Deleting the rollout
  removes that link, and LCM offers no query for it yet.
- A subagent that is interrupted or fails may never emit `SubagentStop`. Its
  tool observations are already stored, and its rollout can still be imported
  with `lcm import --codex`.
- Codex delivers a parent-to-child prompt through `UserPromptSubmit` only for
  some delivery paths, so prompt-time recall inside a subagent is not
  guaranteed. `SubagentStart` is the dependable point where it receives
  memory.
- A subagent forked from its parent starts with the parent's history in its
  rollout. When the rollout's first record is a `session_meta` with a numeric
  `subagent_history_start_ordinal`, LCM skips the records that precede it, so
  the parent's messages are not stored again under the subagent. Only rollouts
  that Codex stamps with per-record ordinals (`history_mode: "paginated"`) are
  filtered completely; in other rollouts only records that carry an explicit
  ordinal below the boundary are skipped, and a forked subagent without them
  keeps the inherited history. `lcm import --codex` applies the same rule.
- A subagent conversation stored before this change keeps its inherited
  history: each ingest follows whichever reading (with or without the inherited
  prefix) extends what is already stored. If the stored messages match neither
  reading, for example after the rollout was rewritten, LCM appends nothing for
  that subagent, writes a diagnostic to the hook error log, and leaves the rest
  of the conversation untouched. Adding, removing or changing a sensitive
  pattern (or a built-in scrubber change) after a subagent was stored changes
  how its text is redacted, so it has the same effect for that subagent.
- When one session id has several stored conversations, ingest continues to
  append to the most recent one, as it does for every other client.
- Sibling subagents count as distinct sessions for passive pattern
  reinforcement, so a pattern that several siblings repeat gains confidence
  faster than the same pattern repeated within one session. Promotion rules are
  unchanged.

## Auto-heal

All lcm hooks self-repair on each invocation: before dispatching, `validateAndFixHooks()` checks that all required hook entries remain registered in `~/.claude/settings.json` and re-adds any missing entries. This means lcm hooks survive `claude settings reset` or manual edits to the settings file.

### Passive promotion acknowledgement

Passive promotion and explicit event draining mark a queued event processed
only after its selected project transaction succeeds. Queue acknowledgement
uses the same live publication admission as the project operation, so it does
not contend with its own publication lock after committing a memory or migration
receipt. A completed receipt remains authoritative on a retry; its effect is
not repeated. If acknowledgement fails, the event remains queued for retry.

Physical outbox opening and local queue reads use short queued publication
scopes, separate from the selected project batch. Scrubber setup remains outside
retained admission. Callers supplying a retained publication token reuse it
for local preparation, acknowledgement, and owned storage cleanup. The token is valid
only while its owning admission scope remains active.

### Publication fence finalization

Before a hook's publication fence finishes, LCM validates the retained root
directory again and attempts to close its descriptor even if validation fails.
When both steps succeed, an operation failure is preserved unchanged, including
its original error identity and cause.

If final validation or descriptor closure also fails, an existing publication
journal error retains its reason and message unless its reason is
`publication-evidence-missing`. The combined error preserves the original failure
as the first entry in its aggregate evidence, followed by final-validation and
descriptor-close failures in that order. The original error is never modified;
any evidence it already contains remains attached to it.

All other cases with a finalization failure, including missing publication
evidence, lock contention, ordinary operation failures, and otherwise successful
operations, are classified as `unsafe-storage`. An otherwise successful operation
cannot return success from the fence after either finalization step fails. Its
evidence contains only the cleanup failures: one failure is retained directly as
the cause, and multiple failures are aggregated in validation-then-close order.
The public diagnostic remains sanitized; filesystem details stay in error
evidence. PreCompact records initial `unsafe-storage` admission failures through
its existing error logger and still returns exit code 0 with empty output.
Consumers that already throw on journal errors now also fail closed on these
typed finalization failures; consumers that return exit code 0 continue to do so.
Thus reclassification can change which existing error-handling branch runs, and
a typed fence failure does not imply a nonzero exit code from every hook.

### Native ingest source changes and cancellation

When `/ingest` receives a native transcript path, parsed messages and native
archival use the same open file snapshot. Each attempt prepares parsed messages
and its scrubber before requesting backend publication admission. Once admitted,
LCM revalidates the snapshot before storing messages and preserves exact source
and message link checks. If a fully read and validated source changes during ingestion, LCM
makes one fresh attempt only when the original byte prefix remains identical;
appended bytes are allowed. Shrink or rewrite of that prefix fails the request.

Mutation before the first complete validated snapshot is available also fails
without an internal retry. A failure closing the source or quarantine after an
otherwise retryable source change also fails the request without retrying; the
source-change and cleanup failures are retained together in one ingest error.
For an eligible append,
a stable second attempt completes without recording an ingest error. Inserted
message and redaction counts include both attempts without duplicating committed
messages. A source that changes again fails the request; a later hook event can
resume native archival using the existing checkpoint. Before a retry prepares
its input, the prior attempt finishes and releases its project resources and
publication admission. The retry checks publication state and the original
project identity again; a blocked publication or changed identity fails closed.

An initially missing or rejected transcript path retains the empty-input behavior.
A source that disappears after path validation, or fails snapshot validation,
fails closed. Validation now precedes parsed-message persistence for native paths,
so an invalid source cannot first commit its parsed projection. Existing explicit
`messages` requests retain their input behavior.

At parse time, independent of the snapshot retry policy above, LCM ignores null,
primitive, array, and unsupported record siblings in Claude message content
arrays, at the top level and at every existing nested `tool_result` level. Valid
text siblings remain in their original order and are joined with newlines, so a
malformed sibling no longer discards the valid text around it. A message with no
retained text is still omitted.

Intentional request cancellation returns HTTP 499 with
`{"status":"cancelled","error":"ingest cancelled"}` when the connection is still
writable. Active storage work finishes before project resources close, including
an already-running native snapshot and token query. Cancellation prevents another
attempt and is not recorded as an ingest error. Ordinary storage, source, and
linkage failures remain errors even if cancellation occurs at the same time.
The snapshot is held in process memory, as with the previous whole-file parser;
this is not a new total-size or execution-time limit.

Previously retained ingest errors remain in diagnostic history. This repair does
not remove historical errors or change their retention period.

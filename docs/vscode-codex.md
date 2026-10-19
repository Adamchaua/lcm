# VS Code and Codex setup

This repository has the shared memory backend needed for VS Code and Codex.
Codex supports complete CLI or MCP connector bundles; GitHub Copilot in VS Code
uses the CLI guidance bundle.

For normal use, install and update the published package through npm:

```bash
npm install -g @donadiosolutions/lcm@latest
```

Claude Code uses the same npm package. Run `lcm install` for its native hooks,
MCP server, commands, and skills; direct Claude Marketplace installation is no
longer supported.

## Install from a repo checkout

If you are working from this repository directly instead of the published npm package:

```bash
mkdir -p .superpowers/pnpm
pnpm_bootstrap_root="$(mktemp -d "$PWD/.superpowers/pnpm/run.XXXXXXXX")"
pnpm_bin="$(node scripts/bootstrap-pnpm.mjs --destination "$pnpm_bootstrap_root/verified")"
export PATH="$pnpm_bin:$PATH"
pnpm install --frozen-lockfile
pnpm run build
```

Run `node dist/lcm.mjs ...` instead of `lcm ...` in the commands below to
use the checkout directly. To install a built artifact globally, follow the
exact-tarball procedure in [Development](development.md#install-a-built-checkout).
The source-clone installer, `bash install.sh`, also bootstraps the verified
pnpm pin and performs a frozen install and build before installing its Node
launcher. It then runs `lcm install`.

## Install the VS Code connector

For GitHub Copilot in VS Code:

```bash
lcm connectors install github-copilot --transport cli
lcm connectors doctor github-copilot
```

This writes a repo-local skill file at `.github/skills/lcm-memory/SKILL.md`.

Rules connectors append one managed Markdown block to the target document. The
installer keeps the document byte-consistent when it reinstalls that block: it
uses CRLF when the retained document or generated block uses CRLF, otherwise
LF, normalizes the separator and generated block to that style, and emits one
final line break. Markdown-significant trailing spaces and tabs are preserved.

## Install the Codex connector

For Codex in the current repository:

```bash
lcm connectors install codex
lcm connectors doctor codex
```

This writes the default Codex CLI bundle:

- `~/.codex/hooks.json`
- `~/.codex/config.toml` with `[features].hooks = true`
- `.codex/skills/lcm-memory/SKILL.md`
- `~/.codex/AGENTS.md` with one minimal managed memory-retrieval rule

The `AGENTS.md` entry requires Codex to use the `lcm-memory` skill before
starting substantive work or when it needs further project understanding. The
skill remains the detailed operational guidance, while passive hook injection
can satisfy routine context recovery without another explicit search. Existing
user content is preserved with one blank line before the managed entry. A fresh
or default Codex CLI install does not add, remove, or inspect MCP configuration.

Connector installation selects one complete transport bundle:

```bash
lcm connectors install <agent> [--transport cli|mcp] [--global]
lcm connectors remove <agent> [--global]
```

The precedence order is explicit `--transport`, then stored
`connectors.transports.<agent-id>`, then the registry default; implicit defaults
are not persisted. Claude Code, Qwen Code, and Zed default to MCP. Codex and
every other agent default to CLI. Cline and Augment are CLI-only until
verifiable MCP adapters exist. Guidance never falls back between transports,
and removal removes the whole LCM-owned bundle.

To opt Codex into MCP, use:

```bash
lcm connectors install codex --transport mcp
lcm connectors doctor codex
```

The Codex MCP connector treats an absent `lcm` registration as absent only for
a positive safe-integer exit status and either exact
`codex mcp get lcm --json` diagnostic:
`No MCP server named 'lcm' found.` and
`Error: No MCP server named 'lcm' found.`. The latter is the diagnostic emitted
by Codex 0.147.0. The connector trims the diagnostic before this exact match,
but otherwise fails closed: a zero or negative exit status, a non-integer status, a
different server name, extra output, or any other near-match is reported as an
unavailable/error state rather than being treated as an absent registration.
If native inspection is unavailable, connector doctor reads the stored Codex
transport through a bounded, stable configuration snapshot without taking the
publication mutation lock.

The MCP bundle uses native `codex mcp` commands for Codex registration and
requires no TOML editing. Use
`lcm connectors install codex --transport cli` to converge back to the CLI
bundle. The MCP bundle does not retain or install the CLI-only managed
`~/.codex/AGENTS.md` entry. Explicit or stored CLI convergence may remove only
the exact LCM-owned MCP registration.

On Linux, LCM forwards the user-session bus to those nested commands only as
the exact validated pair `XDG_RUNTIME_DIR=/run/user/<uid>` and
`DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/<uid>/bus`. The runtime directory
must be canonical, user-owned, and mode `0700`; the matching endpoint must be
a canonical user-owned socket. LCM omits both values if either side is missing,
malformed, oversized, redirected, foreign-owned, non-socket, or mismatched,
and it does not inherit unrelated process environment variables.

The hook connector installs these Codex events:

| Event | Command | Behavior |
|---|---|---|
| `SessionStart` (`startup\|resume\|clear\|compact\|fork`) | `lcm restore --client codex` | Restores project context when Codex starts, resumes, clears, compacts, or forks a session |
| `UserPromptSubmit` | `lcm user-prompt --client codex` | Searches memory and injects prompt-time hints |
| `PostToolUse` | `lcm post-tool --client codex` | Captures bounded semantic signals from Codex shell (`Bash`) and MCP tool results, plus native file, decision, plan, and delegation tools |
| `PreToolUse` | `lcm pre-tool --client codex` | Optional, off by default (`hooks.preToolRecall`). Adds advisory memory hints before a shell command, `apply_patch` edit, or MCP tool call; see [Opt-in PreToolUse memory hints](configuration.md#opt-in-pretooluse-memory-hints-codex) |
| `PreCompact` | `lcm session-snapshot --client codex` | Force-ingests transcript deltas before manual or automatic Codex compaction |
| `Stop` | `lcm session-snapshot --client codex` | Ingests transcript deltas and triggers compaction once the configured token threshold is reached |
| `Interrupt` | `lcm session-snapshot --client codex --terminal` | Saves the transcript when you interrupt a running turn |
| `SessionEnd` | `lcm session-snapshot --client codex --terminal` | Saves the transcript when Codex shuts a session down gracefully |

Codex must trust the project `.codex/` layer for project-local hooks to load. For a global setup, run:

```bash
lcm connectors install codex --global
lcm connectors doctor codex --global
```

### Codex hook readiness

Installing the hooks is not enough for Codex to run them. Codex keeps a
per-hook enabled flag and a trust record in its user `config.toml`
(`[hooks.state."<hooks.json path>:<event>:<group>:<handler>"]`), and it runs a
user hook only while that hook is enabled and trusted. `lcm connectors doctor codex`
(or the same command with `--global`) reads `~/.codex/hooks.json` and
`~/.codex/config.toml` without writing and reports, for each LCM hook, whether
Codex can actually run it. The report appears when you name the agent
(`lcm connectors doctor codex`); a bare `lcm connectors doctor` does not run it.

| Status | Meaning | What to do |
|---|---|---|
| ready | Enabled and trusted in the base user config. This is a static check. | Nothing |
| missing | The hook is not in `hooks.json`. | `lcm connectors install codex --global` |
| disabled | You disabled the hook in Codex. LCM never changes this and install preserves it. | Re-enable it in Codex `/hooks` to restore the capability |
| untrusted | Codex has no trust record for the hook yet, so it does not run. | Review and trust it in Codex `/hooks` |
| modified | The hook definition differs from the one you trusted, so Codex requires a new review. | Review and trust it again in Codex `/hooks` |
| state unknown | `config.toml` is not valid TOML, or its hook state uses a form LCM cannot read. | Check Codex `/hooks` |
| feature disabled | `[features] hooks` is `false`; no LCM lifecycle hook can run. LCM leaves your setting unchanged. | Enable the feature if you want LCM hooks |
| hooks file unreadable | `hooks.json` is unreadable or does not match the schema Codex expects. | Fix the file or reinstall |
| failing / degraded | A recent LCM-local observation (below) shows a nonzero exit, a thrown error, or logged hook errors. | Run `lcm doctor` and check `~/.lcm/logs/events.log` |

When several statuses apply, the first of these wins: hooks file unreadable,
feature disabled, missing, state unknown, disabled, untrusted, modified,
failing, degraded, ready. Doctor exits non-zero for every status except ready
and degraded. It also compares the codex CLI on `PATH` with the minimum supported
version (0.163.0); desktop and IDE builds may differ, and an unavailable CLI is
a warning. A hook whose installed definition no longer matches the current LCM
definition is flagged with a reinstall hint. Reinstalling changes that
definition, so Codex asks you to trust the hook again.

Doctor checks only the base user config. Profile layers, session flags,
managed requirements, and Codex launched with hook-trust bypass are not
visible to it, so a ready hook is not a guarantee that Codex ran it. Doctor is
stricter than Codex about `hooks.json`: Codex ignores an unreadable file with a
warning, while doctor reports it.

Reinstalling LCM hooks keeps your per-hook choices. Because Codex keys the
enabled flag and trust record by position, `lcm connectors install codex`
replaces each LCM hook in the exact position it already occupies and appends
only hooks that are missing. It never writes `[hooks.state]`. If an update would
move another hook (duplicate LCM hooks for one event, or a matcher change in a
group that also holds other hooks), install stops before writing either file
and explains how to proceed. An explicit `[features] hooks = false` is left
as you set it, and install says so. Install ends with a reminder to open Codex
`/hooks` and trust the LCM hooks.

When Codex runs an LCM hook, LCM also persists the outcome of a completed run
for each event under `~/.lcm/state/codex-hooks/` (outcome and time only, no
payload). Doctor shows it as a *last persisted LCM-local observation* and
treats it as unauthenticated: it can mark a hook failing or degraded, but never
promotes a hook to ready. It is the last record that was persisted, not
necessarily the latest run: to keep the PostToolUse path cheap, a run whose
outcome matches the stored one (for example exit code 0 again) is not written
again within 60 seconds, and runs that overlap are not ordered. Runs that Codex
times out or kills, hooks that Codex does not run because they are disabled or
untrusted, and silent fail-open returns leave no record. Records older than 30
days, older than the last change to `hooks.json`, or dated more than five
minutes in the future (clock skew) are ignored. Doctor does not establish that
hooks work at runtime.

### Saving memory when a turn is interrupted or a session ends

Codex asks you to review hook definitions it has not seen before. The `Interrupt`
and `SessionEnd` hooks are new definitions, so after updating LCM, reinstall the
connector and approve them in Codex; until then Codex does not run them.

`lcm connectors doctor codex` checks these two hooks like the others (enabled,
trusted, current definition). They leave no last-observation record, because the
command must not spend any of its three seconds on bookkeeping; its own failures
go to `~/.lcm/logs/events.log`, described below.

`Stop` only runs when a turn completes normally. Without the two terminal hooks,
text written during a turn you interrupt, and the tail of a session that ends
between `Stop` events, would stay out of LCM until a later snapshot. The
`Interrupt` and `SessionEnd` hooks save that transcript tail.

What each case does today:

| Situation | Saved by |
|---|---|
| A turn completes normally | `Stop` (unchanged) |
| You interrupt a turn, then keep working | `Interrupt`, and again at the next `Stop` |
| Codex exits gracefully while idle | `SessionEnd` |
| Codex shuts down gracefully with a turn running | `Interrupt` for that turn, then `SessionEnd` |
| Codex crashes or is killed | Not saved until a later snapshot of that session |
| Subagent sessions, and sessions that Codex replaces or ends on a budget limit | Not covered: Codex does not run these hooks for them |

Codex gives these two hooks at most three seconds, counting its login shell, and
kills the process group at the limit. The command therefore never starts, repairs
or configures the daemon. It checks that the daemon already running for this
installation is the expected one (process, listener, version, storage backend,
program and runtime digest, and your token), then hands the transcript path to it
and exits. The daemon reads, scrubs and stores the transcript after the command
has gone, using the same ingest as every other snapshot. Nothing is compacted,
promoted or marked complete by these hooks; Codex's `SessionEnd` does not use
`lcm session-end`.

The command always exits with status 0 and prints nothing. If the save could not be
handed over, it records one line in `~/.lcm/logs/events.log` (without the project
directory) under the event name `Interrupt`, `SessionEnd` or `TerminalSnapshot`:

| Logged reason | Meaning |
|---|---|
| `transcript-unavailable` | Codex gave no transcript, or it is not a readable regular file |
| `invalid-input` | The hook payload was malformed, incomplete or over 1 MiB |
| `daemon-unavailable` | No running, expected daemon could be verified in time; nothing was started |
| `publication-refused` | Backend publication admission blocked the hand-off; nothing was sent |
| `deadline-exhausted` | The hook ran out of its time budget before it could send |
| `ingest-failed` | The daemon refused the request or answered with an error |
| `unconfirmed` | The request was sent but no acknowledgment arrived in time; the daemon may or may not have received it |

No line means the daemon acknowledged the request (HTTP 202). From that point the
daemon owns the work: it keeps running the ingest even if Codex has killed the
hook, and it stays running until accepted work finishes. Accepted work can still be
lost if the daemon itself is stopped or killed first, or if it cannot finish within
30 seconds of being accepted or while the daemon is shutting down. The daemon
accepts at most eight sessions at a time and answers 503 beyond that; an `Interrupt`
followed closely by `SessionEnd` for one session is combined so the newest
transcript tail is read once more rather than duplicated.

If shutdown happens while a project's storage open is still pending, the shared
storage factory can close before that open settles, so accepted work may be
cancelled rather than committed (tracked in #1582).

`LCM_ENABLED=false` turns these hooks into a no-op: the command exits before it
reads its input, contacts the daemon or writes any diagnostic.

Whether a stored span ended in an interruption is only as visible as Codex makes
it, and LCM never adds a marker of its own:

- Codex writes a `<turn_aborted>` marker before it runs the hook, but only when
  its interrupt message is enabled (`agent_interrupt_message_enabled`). Unless
  multi-agent v2 is in use, the marker is a user-role message, so it is parsed,
  stored with the conversation and searchable like any other text.
- With multi-agent v2 the marker is a developer-role message, and the parser does
  not read developer messages. It is kept only in the raw transcript archive.
- Codex's own `TurnAborted` event is written after the hook, so it is not in the
  transcript the hook saves. A later ingest archives it; it is never a parsed,
  searchable message.
- When Codex wrote no marker, the interrupted turn and a completed one cannot be
  told apart in LCM. A continuation turn after an interruption is stored like any
  other turn.

The time limit is an engineering bound, not a guarantee: LCM budgets 1.5 seconds of
its own process time and stops starting work after 1.35 seconds, but it cannot
control the user's login shell or a stalled filesystem. The daemon route that
receives the hand-off (`POST /ingest/terminal`) is meant for the hook only and
accepts requests from any holder of the daemon token.

On macOS and Windows the exact-listener check needs a subprocess with a fixed one
second timeout, which does not fit the 400 millisecond verification window, so the
command refuses there and logs `daemon-unavailable`; the terminal hooks save memory
on Linux only for now.

### Memory after compaction and in forked conversations

Codex drops hook-injected context when it compacts a conversation, and a forked
conversation starts from a copy of its parent's history. The `SessionStart` hook
therefore also runs after compaction (`compact`) and when a conversation is
forked (`fork`), and restores recent summaries, promoted project knowledge,
passive insights, and stored project instructions.

Each restoration starts with the line `<!-- lcm-restoration -->`. On `resume`,
`fork`, and `compact`, the hook reads the session's own rollout under
`$CODEX_HOME` (default `~/.codex`) and prints nothing when a restoration since
the latest compaction or rollback is still in the conversation, so a resumed or
forked conversation does not receive the same block twice. `startup` and
`clear` always print.

Existing installs keep the old `startup|resume|clear` matcher until you re-run
`lcm connectors install codex`. If the LCM restore hook has its own
`SessionStart` group in `hooks.json`, install updates the matcher in place.
If that group also holds other hooks and its matcher is not already
`startup|resume|clear|compact|fork`, install stops without writing either file
and reports that the group matcher must change. Move the LCM handler into its
own `SessionStart` group at the end of that event in `hooks.json` and re-run
install, or run `lcm connectors remove codex` and then `lcm connectors install
codex`. Either manual change can move other hooks between the positions Codex
uses for their enabled flag and trust record. Open Codex `/hooks` afterwards
and review every hook that moved, restoring the enabled settings you intend;
Codex asks you to trust the hook again.

Known limits:

- Referenced (paginated-thread) forks, rollouts outside `$CODEX_HOME`, unreadable
  rollouts, and restorations printed by earlier LCM versions (no marker line)
  print a fresh restoration, which can duplicate an existing one once per event.
- A restoration carried only inside Codex's compaction replacement history is
  not detected, so the next `resume` or `fork` prints again.
- If Codex fails to write the compaction record (or other history) to its
  rollout, the post-compaction hook can see the pre-compaction restoration and
  skip, and the live continuation can lack restored memory while those write
  failures persist.
- Memory promoted after the parent's last restoration is not injected into a
  fork that inherited a restoration; per-prompt hints and the next compaction
  surface it.
- Restored summaries can lag content captured at `PreCompact`, because
  summarization is asynchronous.
- Guardian review and post-turn compactions restore at the next
  `SessionStart` drain.
- Messages copied into a fork are ingested again for the fork; this is tracked
  in #1578.

### Codex PostToolUse capture boundary

The installed PostToolUse hook must be an exact command hook under a `*`
matcher:

```json
{
  "matcher": "*",
  "hooks": [
    { "type": "command", "command": "lcm post-tool --client codex" }
  ]
}
```

The doctor's capture self-test runs a pure, no-write check over representative
native payloads. It does not run the hook handler, write hook files, create an
event database, open an EventsDb, or append sidecar events, and it reports
`native exec normalization self-test passed (fixtures only; not proof of runtime execution)`.
It does not show that Codex runs the hook; that is the readiness report above.

Codex capture is deliberately narrow. Current Codex reports shell commands
(`exec_command` and the `write_stdin` polls that finish them) to hooks as the
tool `Bash`; LCM also accepts the legacy names `functions.exec` and
`functions.exec_command` as aliases. The adapter takes `tool_input.command`, or
`tool_input.cmd` when `command` is absent, and bounds the accepted command to
2,000 characters before passing it through the existing event-data truncation
and sensitive-data scrubbing. MCP tools (`mcp__<server>__<tool>`) are recorded
by tool name only.

Codex's PostToolUse payload carries no shell exit status, only the output text,
and LCM never parses that text. A completed git or install command is
therefore stored as a `tool_outcome_unknown` observation (for example
`Bash outcome unknown: git commit`) instead of a success. Unknown
observations are kept as passive history but are never promoted, reinforced, or
treated as the fix for an earlier error. A structured status
(`isError`, `is_error`, `exit_code`, `exitCode`) is still honored when a payload
supplies one. A successful MCP result is recorded as before. Codex does not run
PostToolUse for a failed or interrupted MCP call or for an interrupted shell
command, so those cannot be observed. See
[Codex native PostToolUse capture](hook-protocol.md#codex-native-posttooluse-capture)
for the full matrix. Raw stdout/stderr, raw responses, MCP arguments and
content, and file-like fields are not persisted or interpreted as file events.
A trimmed command beginning with `lcm store` is suppressed to avoid a feedback
loop from LCM's own storage calls. The native `apply_patch`, `spawn_agent`,
`request_user_input`, and `update_plan` tools are captured separately as
bounded file, dispatch, decision, and plan events; see
[Codex native activity](passive-learning.md#codex-native-activity). There is no
new configuration option for these fixed capture rules.

Because this hook runs after every tool call, its CLI entrypoint does not run
legacy-root bootstrap migration before reading and dispatching the payload.
LCM installation and session startup establish or migrate the private root;
PostToolUse remains an observer and cannot contend on that startup boundary.

The other installed hook entrypoints (restore, session-end, session-snapshot,
user-prompt, pre-tool, and `compact --hook`) also skip that migration. See
[Hook entrypoints and legacy-root migration](hook-protocol.md#hook-entrypoints-and-legacy-root-migration)
for which invocations still migrate and how publication-lock contention is
handled.

If selected-state publication admission is blocked after a PostToolUse event
has been durably appended, the event remains preserved locally. Missing
publication evidence and typed private lock contention are successful
best-effort hook outcomes and do not add a hook-error ledger entry. Other
malformed, tampered, unsafe, mismatched, or
unresolved evidence fails closed for selected-state work and surfaces this exact
fixed diagnostic. After the event is durable, the PostToolUse hook returns code
`0` with a JSON `systemMessage` containing that same line, so Codex can render
actionable feedback without treating the observer process as failed. A direct
invocation that fails before durable enqueue retains the fixed stderr diagnostic
and exit code `1`. Selected-state work remains refused:

```text
lcm: backend publication admission blocked; preserve the evidence, run 'lcm doctor', and resolve the authenticated publication before retrying.
```

The diagnostic never includes the raw publication error, cause, stack, path,
URL, credential, or journal contents. Follow the preserve-evidence, `lcm
doctor`, and owning-publication-recovery sequence in
[`backend-publication.md`](backend-publication.md) before retrying Codex.

Reinstalling generated Markdown connectors is byte-idempotent: the Codex skill
`.codex/skills/lcm-memory/SKILL.md` remains byte-identical to its canonical
template with exactly one final newline. The skill and explicit rules fallback
share one catalog of operation names, purposes, lifecycle triggers, and CLI/MCP
spellings. Their lean workflow uses automatically injected memory first,
requires immediate explicit storage of every newly recognized durable learning
with its rationale, and treats automatic capture as complementary rather than a
substitute. Normal rules append installs remove and reappend their managed block
without changing the established LF or CRLF style. One-run healing is limited to
recognized current or legacy managed
blocks, the maximal union of their overlapping or touching recognized ranges,
and a current marker followed only by one or more exact `# Workflow Instruction`
lines as a recoverable header-only partial region. These recognized regions are
replaced with one canonical block in the established style. Arbitrary
ambiguous or malformed unmatched marker/header combinations are preserved
conservatively and may require a second reinstall to become byte-stable; user-
authored Markdown outside recognized regions, including heading lines, is never
removed by this recovery behavior.

Removing a rules connector deletes its file only when managed-block removal
leaves zero bytes. Spaces, tabs, form-feed, and other non-CR/LF user Markdown
bytes are preserved and written with exactly one established terminal EOL;
content consisting only of blank lines is deleted.

To import existing Codex sessions into LCM:

```bash
lcm import --codex
lcm import --provider all
```

## Current limitations

1. GitHub Copilot in VS Code is skill-based today. There is no automatic session restore, turn ingestion, prompt-time search injection, or compaction hook.
2. The GitHub Copilot connector does not register MCP automatically. The current supported path is instructions/skill guidance plus the `lcm` CLI.
3. Codex MCP is opt-in. The explicit MCP bundle uses native `codex mcp`
   commands; default/fresh Codex CLI installation remains hook+skill+minimal
   rules and does not inspect MCP.
4. Codex `Stop` hooks are turn-scoped, not final-session hooks. LCM therefore uses rolling snapshots and thresholded compaction instead of marking Codex sessions complete on each `Stop`; the `PreCompact` snapshot hook fills the pre-compaction gap.
5. Claude Code and Codex use native integrations, but their setup commands remain different.

## Improvement candidates

1. Add first-class `lcm setup vscode` and `lcm setup codex` commands instead of overloading `lcm install`.
2. Extend native Codex MCP adapter coverage only after each adapter is verifiable; Cline and Augment remain CLI-only until then.
3. Add a real VS Code runtime adapter for restore, writeback, and prompt-time recall instead of skill-only guidance.
4. Connector diagnostics now validate the exact Codex PostToolUse structure and
   its pure native-exec capture path; no database or hook-file writes are part
   of the check.

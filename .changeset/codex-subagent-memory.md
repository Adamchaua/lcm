---
"@donadiosolutions/lcm": minor
---

Record and recall Codex subagents as their own sessions. The Codex hook
connector now registers `SubagentStart` and `SubagentStop`, so a subagent
receives project memory when it starts and its rollout is ingested under its own
thread id when it finishes. Subagent tool events and compaction snapshots are
keyed by that id instead of the shared tree session, so they no longer mix into
the parent conversation, and parent-authored delegation prompts are not stored
as user decisions. Run `lcm connectors install codex` to register the new hooks.

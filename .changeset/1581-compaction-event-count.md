---
"@donadiosolutions/lcm": patch
---

Store transcript messages that follow a compaction event. `/ingest` and
`/compact` no longer count compaction event rows as transcript messages when
deciding what is new, so a session that was compacted keeps ingesting its later
messages, and native linkage skips event rows.
`postgresql-runtime-transcript-grants.sql` now also grants column-limited
`SELECT` on `message_parts` so native linkage can recognize event rows;
deployments that applied the conversation grants already have that read.

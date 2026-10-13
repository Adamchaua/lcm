---
"@donadiosolutions/lcm": patch
---

Installed hook entrypoints (restore, session-end, session-snapshot, user-prompt,
and `compact --hook`) no longer fail with exit code 1 when the backend
publication lock is busy. They skip the CLI legacy-root migration preflight, and
the hook dispatcher treats lock contention while loading the hook configuration
as a best-effort exit 0 for compact, restore, and session-end. Session snapshots
no longer load the configuration at all.

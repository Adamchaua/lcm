---
"@donadiosolutions/lcm": minor
---

Add the `lcm migration` command group: `plan`, `dry-run`, `apply`, and
`abort` for the reversible SQLite-to-PostgreSQL cutover. `plan` previews
the next migration generation without mutating anything; `dry-run` checks
the SQLite source in isolation; `apply` captures the source, mints a
migration manifest, and copies the captured data to PostgreSQL; `abort`
is the recovery exit from a held migration attempt.

**`apply` puts the installation into a maintenance hold that only `abort`
can currently leave.** Forward completion of a cutover (`activate`,
`resume`, `verify`, full `report`, `rollback`) ships in a later release of
this Epic. Until then, a successful `apply` fences ordinary SQLite
storage operations for the duration of the hold, and `abort` is the only
way to release it and return to normal operation; nothing on the
PostgreSQL side is affected by `abort`.

See `docs/migration-operations.md` for the full operator runbook,
including the exit-code vocabulary, refusal reasons, the daemon-presence
policy, and what this command group does and does not protect against.

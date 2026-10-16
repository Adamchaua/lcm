---
"@donadiosolutions/lcm": minor
---

Add the `lcm migration` command group for the reversible SQLite-to-PostgreSQL
cutover: `plan`, `dry-run`, `apply`, `resume`, `verify`, `report` and
`abort`. `plan` previews the next migration generation without mutating
anything; `dry-run` checks the SQLite source in isolation; `apply` captures the
source, mints a migration manifest, and copies the captured data to PostgreSQL;
`resume` runs the one step a held generation is waiting for (the dry-run effect,
the copy, or a carried effect) and stops at the next checkpoint; `verify`
finishes a pending verification from persisted evidence and confirms a verified
generation; `report` is a read-only account of one generation that names the
command to run next and checks whether a daemon needs a restart; `abort` is the
recovery exit from a held attempt and is safe to repeat.

Every command that acts on an existing generation asks one router which command
owns the state it is in, so a command that does not own it refuses and names the
one that does. `apply` no longer creates the local project map entry or the
destination PostgreSQL project until its `--confirm-generation` matches, and
never creates either while a hold exists. `verify` of a copied generation with
nothing pending needs the project-map witness the activation work provides and
refuses `requires-625-project-map-witness` until then.

**`apply` puts the installation into a maintenance hold that only `abort` can
currently leave.** `activate` and `rollback` ship in a later release of this
Epic. Until then, a successful `apply` fences ordinary SQLite storage
operations for the duration of the hold, and `abort` is the only way to release
it and return to normal operation; nothing on the PostgreSQL side is affected by
`abort`.

See `docs/migration-operations.md` for the full operator runbook, including the
exit-code vocabulary, refusal reasons, the daemon-presence policy, and what this
command group does and does not protect against.

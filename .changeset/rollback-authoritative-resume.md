---
"@donadiosolutions/lcm": minor
---

Add reversible migration rollback: reverse a completed PostgreSQL
activation back to SQLite. When the project is bound to PostgreSQL and
selected, and PostgreSQL has no activation evidence or was activated but never
written to, rollback flips the active backend selection back to SQLite
without copying any data. When
PostgreSQL has been written to since activation, rollback builds a
fresh SQLite generation from a fenced PostgreSQL snapshot, verifies
it independently before installing it, and preserves the prior live
database and the original pre-migration snapshot untouched. The
rollback publishes the SQLite selection through the same coordinator as
activation, refuses while another project is still bound to PostgreSQL,
and refuses a generation whose project was never bound to PostgreSQL
(leave it with `lcm migration abort`). Every step is resumable after a crash, including
after the selection flips and during the coordinator publication: a retry never guesses which
outcome already happened, an interrupted build never reuses a
partial generation, and an incomplete or failed attempt is kept as
evidence rather than deleted. There is no operator-facing command
for this yet; it ships as an internal capability that a future
release will expose.

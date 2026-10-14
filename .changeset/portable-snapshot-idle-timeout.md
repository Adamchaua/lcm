---
"@donadiosolutions/lcm": minor
---

Add `storage.postgresql.snapshotIdleTimeoutMs` (default 300000 ms) so a
portable transfer's read-only snapshot transaction has its own
idle-in-transaction bound, independent of `statementTimeoutMs`.

This setting does NOT relax any protection: it bounds only the longest
single idle gap between statements inside the snapshot, because
PostgreSQL resets that timer every time the snapshot issues a query. A
live transfer that keeps reading, however long it takes overall, is
never killed by this setting; only a snapshot that genuinely stalls or
is abandoned for longer than the bound is reclaimed, exactly as before,
just measured against its own correct bound instead of the connection's
much shorter statement-execution bound.

Previously the snapshot's idle-in-transaction bound was derived from
`statementTimeoutMs`, so a healthy portable cross-backend transfer whose
snapshot merely sat open between reads for longer than that
statement-scale duration could be killed by PostgreSQL (SQLSTATE 25P03)
for doing exactly what a snapshot is designed to do, and the transfer
would fail with a sanitized `source-unavailable` error. Separating the
two bounds fixes that false-positive kill. The new setting is optional
on the public `PostgreSqlConnectionSettings` type, so this change is
additive, not breaking.

A genuine idle-kill (or a connection actually torn while the snapshot
was idle) is now classified as retryable `source-unavailable` instead
of non-retryable `source-invalid`, and `PortableStreamError` gains an
optional, non-serialized `cause` carrying the already-sanitized
underlying storage error, so operators can see why a retry is
recommended without exposing raw driver detail in logs or JSON.

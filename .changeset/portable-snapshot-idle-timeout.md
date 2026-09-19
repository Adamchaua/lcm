---
"@donadiosolutions/lcm": minor
---

Add `storage.postgresql.snapshotIdleTimeoutMs` to bound how long a portable
transfer's read-only snapshot transaction may sit idle, independent of
`statementTimeoutMs`. Previously the snapshot's idle-in-transaction bound
was derived from `statementTimeoutMs`, so a portable cross-backend transfer
that held its snapshot open past that bound (PostgreSQL SQLSTATE 25P03) could
fail with a sanitized `source-unavailable` error even when the snapshot was
idle only because it was doing exactly what it is designed to do. The new
setting defaults to 300000 ms and is optional on the public
`PostgreSqlConnectionSettings` type, so this is additive rather than
breaking. A mid-transfer idle-kill is now classified as retryable
`source-unavailable` instead of `source-invalid`, and `PortableStreamError`
gains an optional, non-serialized `cause` carrying the already-sanitized
underlying storage error.

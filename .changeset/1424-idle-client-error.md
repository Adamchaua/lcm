---
"@donadiosolutions/lcm": patch
---

Handle the asynchronous connection error that PostgreSQL emits when it kills an
idle checked-out connection, for example through
`idle_in_transaction_session_timeout`. Previously a query or transaction whose
callback sat idle past the server timeout could raise an unhandled error and
crash the process; the operation now fails with a storage error and the dead
connection is discarded instead of returned to the pool.

---
"@donadiosolutions/lcm": patch
---

Drain a machine's whole ready backlog of PostgreSQL passive events in one
replication pass instead of one event per pass, up to the batch size.

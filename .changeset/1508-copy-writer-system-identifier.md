---
"@donadiosolutions/lcm": patch
---

Refuse migration copy writes, including lease acquire, renew and release, to a
PostgreSQL cluster whose system identifier differs from the one recorded when
the copy probed the destination.

---
"@donadiosolutions/lcm": patch
---

Refuse to complete a PostgreSQL migration copy whose destination gained
canonical rows after verification. While holding the project publication
fence, completion now compares, per non-identity domain, a database-side
count of the destination's canonical rows with the run's transfer-ledger
tally. A surplus refuses as `destination-unexpected-rows` and a deficit
refuses as `verification-failed`, so a row committed by another writer
between verification and completion no longer completes silently. Identity
domains stay outside the comparison, and the post-commit readback of an
already completed run does not repeat it.

---
"@donadiosolutions/lcm": patch
---

Treat an existing journal-less backend-publication directory as unresolvable
PostgreSQL publication evidence, bind a migration copy to the destination's
PostgreSQL system identifier (manifests written before this change must be
copied again to be verified), and accept only canonical positive decimal pids
in the activation restart check.

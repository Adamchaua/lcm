---
"@donadiosolutions/lcm": patch
---

Re-check PostgreSQL schema readiness inside the portable source's read-only
snapshot so catalog changes between admission and snapshot are not exported.

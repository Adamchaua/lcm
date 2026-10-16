---
"@donadiosolutions/lcm": patch
---

Treat an empty or non-string `metadata.projectId` in `lcm store` as the `manual` origin so it cannot merge into another origin's memory on SQLite.

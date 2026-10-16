---
"@donadiosolutions/lcm": patch
---

`lcm mcp` now waits briefly for the managed daemon's own publication work at
startup instead of exiting with a publication-busy error. Any other lock owner
or unverifiable daemon still fails closed.

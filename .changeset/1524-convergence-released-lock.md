---
"@donadiosolutions/lcm": patch
---

Authenticate the publication lock owner recorded when contention occurs, so
`lcm mcp` startup after a daemon restart no longer exits when the daemon
releases the lock before convergence can read it again. The retry stays within
the existing two-second window, and contention on other locks, missing daemon
identity, and foreign, malformed, stale, or unhealthy owners still fail closed.

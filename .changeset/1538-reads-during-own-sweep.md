---
"@donadiosolutions/lcm": patch
---

PostgreSQL daemon read routes (`/search`, `/grep`, `/recent`, `/describe`, `/expand`)
no longer fail while the daemon's own publication work, such as a replication
sweep phase, holds the publication lock. A read that contends retries once,
waiting up to one second for a turn in the daemon's publication queue, and
otherwise returns the sanitized `503`; contention and an expired wait are
retryable, while a genuine storage failure keeps `retryable: false`.

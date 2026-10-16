---
"@donadiosolutions/lcm": patch
---

Stop treating a daemon whose `/health` omits its storage backend as SQLite unless it is a published release through 1.4.3. A newer daemon that omits the backend is now unknown and is refused for reuse, unauthenticated replacement, and restart.

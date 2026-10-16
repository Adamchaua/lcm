---
"@donadiosolutions/lcm": patch
---

Portable SQLite sources now detect same-timestamp writes after capture. A
captured file whose timestamps are within two seconds of its authenticating
read is re-hashed on every check instead of trusted from unchanged metadata.

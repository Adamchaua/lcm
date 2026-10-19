---
"@donadiosolutions/lcm": patch
---

Make `lcm connectors install codex` stop, leaving `hooks.json` and
`config.toml` untouched, when `hooks.json` is not valid JSON or repeats a key,
instead of replacing it with only the LCM hooks. `lcm doctor` now also reports
a `hooks.json` with a repeated key or a non-integer `timeout` or
`additionalContextLimit` as unreadable.

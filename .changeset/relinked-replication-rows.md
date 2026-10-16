---
"@donadiosolutions/lcm": patch
---

Passive-event replication no longer leaves rows stuck after a project is
relinked to another remote project: rows still awaiting the previous project
are withdrawn from it (or acknowledged, or kept quarantined, depending on
what that project did with them) and uploaded to the new one. The replication
pass also opens the scanned sidecar before resolving the project's identity,
so a missing sidecar no longer creates or publishes project-map evidence.

---
"@donadiosolutions/lcm": patch
---

A passive event whose upload reached the previous remote project before a
relink, but was not recorded locally, is now delivered to the new project, and
the other events of its upload batch are no longer held back. When an upload
fails and the new project lacks some of the rows, the previous project's copies
are withdrawn, acknowledged, or kept quarantined as for other relinked rows, and
the batch is uploaded once more without the rows that cannot go.

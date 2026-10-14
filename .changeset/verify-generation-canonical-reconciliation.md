---
"@donadiosolutions/lcm": minor
---

Add migration verification with canonical reconciliation evidence for the
reversible SQLite-to-PostgreSQL cutover. A copied generation is now
independently re-verified against the immutable source snapshot and the live
destination inside a single fenced read-only window, producing a durable,
content-addressed report before any activation step may consider the
generation.

Publication requires both a clean report (no recorded mismatches, including
the public-probe sample class) and full reconciliation class coverage and
full public-probe coverage; the persisted report records all three as
`classCoverage`, `publicProbeCoverage` and `activationEligible` fields
(the two coverage vectors are independent, so a genuine listing-ordering
mismatch is never discarded just because the unrelated search probe could
not evaluate that pass), so eligibility is provable from the artifact
rather than assumed. Both coverage vectors are earned, not declared: a class
or probe is marked as run only when the comparisons behind it completed in
that pass, so a comparison that was never invoked leaves its bit false and
the report ineligible. A report with mismatches is still persisted in full
as operator evidence, but requires explicit abort and a new generation
rather than an in-place retry.
Reconciliation now includes a sequence self-consistency bound (an identity
sequence's on-disk state must not allow the next allocation to collide with
a copied row, distinguishing a privilege gap from a genuinely never-called
sequence rather than collapsing both into the same refusal), and the
step-5 public reads run two probes through the real PostgreSQL repository
paths: an ordered-listing probe compared against the source's own canonical
entries as identity and title pairs per millisecond (so two conversations
that trade titles inside one millisecond are caught), and a search
self-match probe that finds a sampled message by its own content through
`lcm.search_v1`, sampled from a fixed-size early
slice of the source's canonical order rather than the whole domain. If no
sampled message can be found this way, the search probe is marked not-run
in `publicProbeCoverage` and activation eligibility is refused for that
pass rather than silently treated as a pass, since a search configuration
wrong in a way no digest comparison can see is exactly what this probe
exists to catch.

Reconciliation also includes a foreign-key edge-set equality check (a
`relation`-class mismatch names the child record whose reference no
longer matches the source, catching a remapped-to-the-wrong-parent
identity that an ordinary dangling-reference check cannot see) and a
transfer-ledger check (a `ledger`-class mismatch when the destination's
recorded transfer run, batch checkpoints or identity mapping disagree
with the manifest or the census). The destination-schema witness now
verifies the destination's own applied-migrations history rather than
the currently running binary's compiled-in migration bundle, and a
hand-maintained map of which columns have an identity sequence to bound
is itself checked against the live schema on every run, refusing rather
than silently under-covering a column a future migration adds.

Verification cost scales with the row count in scope: the census reads and
re-hashes each row individually, so its wall time is roughly linear in row
count rather than a flat per-domain cost, and the census, sequence check and
read-only guard all run inside one fenced window bounded by a single
verification lease that is never renewed mid-window. See
`docs/migration-cutover.md` for how to measure it with
`pnpm run test:postgresql:census-cost` and for the lease sizing guidance.
Verification also keeps the identity and dependency-edge sets of both sides,
and the full conversation listing, in memory at once; the same guide
documents that memory bound.

The verification lease is held until the report has been durably
persisted, not released beforehand, so a second worker cannot acquire it
and start a concurrent recomputation while this attempt's own persist is
still in flight.

Verification checks that it still holds that lease right after the census
window closes and again right before the report is written, and refuses
with a `lease-lost` error, writing nothing, when a check finds the lease
lost. It does not renew the lease, and the lease can still expire during the
local report write or while the manifest effect is begun and completed,
which get no new guarantee.

The sequence self-consistency bound is table-wide, not scoped to the
project being verified: identity sequences are shared per table across
every project, so a colliding row in a different project would otherwise
go undetected whenever the verified project's own copy of that domain
happened to be empty. The search self-match probe now requires a
correlated match, not merely a non-empty result: it resolves each
candidate's own destination-native key through the transfer ledger and
confirms that exact key appears among the search results, so a search
path that returns some unrelated but non-empty result can no longer be
mistaken for a working self-match. The ledger check additionally
reconciles the destination's recorded identity set against the census's
own per-domain identities (not only their count and uniqueness), so a
substitution that preserves cardinality and injectivity while recording
the wrong identities is now caught.

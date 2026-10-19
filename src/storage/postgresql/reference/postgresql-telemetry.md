# PostgreSQL telemetry and redaction contract

This guide is the normative contract that issues #637, #638, #639, and #640
implement for PostgreSQL operational observations. Until those issues merge,
the implemented surface is the existing sanitized backend snapshot described
in [observational diagnostics](../../../../docs/cli.md#observational-diagnostics).
Nothing in this guide changes behavior by itself: each implementing issue
encodes the rules below in its own code and tests, and updates this guide when
it adds a metric, label, or status.

## Scope and principles

In this guide, telemetry means local, on-demand, read-only observations that
LCM surfaces through the sanitized backend snapshot already used by
`stats`, `status`, pool diagnostics, and `doctor`.

- LCM never uploads telemetry. There is no hosted monitoring, background
  exporter, second collector, or automatic tuning. A future local exporter may
  only render this same allowlisted snapshot.
- Telemetry applies to the PostgreSQL backend only. SQLite, the default,
  reports every telemetry family as `not-applicable`. A configured PostgreSQL
  backend never falls back to SQLite telemetry.
- Only cataloged fields may be emitted. Each catalog entry fixes a name, a
  type, a unit, and its permitted dimensions. A collector drops everything
  else.
- Collection never mutates application or administrative state. It calls no
  reset function, runs no DDL, runs no `CREATE EXTENSION` or `ALTER EXTENSION`,
  and performs no repair, pruning, or settings change. The probe statements
  themselves appear in `pg_stat_statements` as ordinary statistics. That is
  not a mutation of LCM data and not a reset.
- Failing to observe a family is different from observing a bad condition. A
  family that cannot be observed reports its own status. That status never
  changes application correctness, admission, or startup, and never hides an
  existing classification in the snapshot. A valid observation of an unhealthy
  condition, such as pool saturation, may feed the documented health thresholds
  that #638 owns. A missing collector privilege or missing telemetry blocks
  production certification under #640; it does not block ordinary operation.

## Forbidden content

The following content is never exported, never logged, and never placed in an
error or remediation message. Where the table says "never read", the
collector does not even receive it.

| Content | Rule |
|---|---|
| Statement text of any kind: `pg_stat_statements.query`, `pg_stat_activity.query`, plan or `EXPLAIN` output text | Never read, except for the single bounded exception in [Query fingerprints](#query-fingerprints). Normalization does not make text safe: constants can remain in stored text, such as utility statements or entries kept after high deallocation. |
| SQL literals and bound parameter values | Never exported or logged. |
| Transcript, message, summary, memory, tag, prompt, inference input or output, file content, and search terms | Never exported or logged. |
| Credentials: connection URLs, passwords, client keys and certificates, tokens, authorization headers, and `LCM_POSTGRES_URL` values | Never exported or logged. |
| CA bytes, certificate bodies, certificate fingerprints, and CA file paths | Never exported or logged. |
| API keys of any provider | Never exported or logged. |
| Real host names, IP addresses, ports, database names, role or user names, `application_name`, `client_addr`, backend process IDs, local paths, raw driver or server error text, and SQLSTATE detail or hint fields | Never exported or logged. Roles and databases appear only as the fixed aliases in [Labels and cardinality](#labels-and-cardinality). |
| Unbounded labels: any label value not fixed when the package is built, such as free text, IDs from data rows, conversation, session, or event IDs, UUIDs, timestamps, and query identifiers | Never used as a label value. |

A collector may use a SQLSTATE code internally to classify a failure. Only the
closed status in [Observation status](#observation-status) leaves the process.

## Observation status

Every telemetry family reports one status from a closed set, together with
`observedAt` (UTC milliseconds) and the epoch fields that apply to the family.

| Status | Meaning |
|---|---|
| `not-applicable` | The backend is SQLite, or the family does not apply. |
| `disabled` | The source exists but server configuration turned it off. For the statement family this means `pg_stat_statements.track = none` only. |
| `unavailable` | The family source is absent, or a family-wide probe failure prevents a usable observation: missing or unloaded extension, connection failure, malformed result, or no computable query identifier. Explicit privilege denial and deadline or cancellation use their specific statuses instead. |
| `permission-denied` | The server denied the probe: SQLSTATE 42501, 28000, or 28P01, or another explicit privilege denial. |
| `timeout` | The probe hit a deadline or was cancelled: SQLSTATE 57014, the snapshot deadline, or the caller signal. |
| `stale` | `observedAt` is older than the family's declared freshness bound, or the values are not tied to the current epoch. |
| `reset` | Counters restarted since the previous comparable observation. Current cumulative values are valid, and no rate is computed across the reset. |
| `partial` | Cataloged fields or entries are missing for a reason other than the expected absences listed below: the deallocation counter advanced, a family cap was reached, a value is out of range, a sub-probe failed, or a counter decreased without an explained cause. |
| `observed` | Complete and fresh, allowing the expected omissions, with no established higher-priority family fact. Each contributing entry is internally consistent. A pooled record may contain entries with different statistics windows; no common interval is required. A first observation may be observed without a baseline. Temporal comparisons follow the per-entry epoch, membership, and mapping rules in [Comparison context](#comparison-context). |

Rows that belong to other roles are excluded by design and are not a
permission condition. `pg_stat_statements.track_planning` and
`track_io_timing` being off omit only the dependent fields (reason
`disabled-setting`); they never change the family status.

When several family-level facts apply, the family status is the first that
applies, among facts actually established:

```text
not-applicable > disabled > permission-denied > timeout > unavailable >
stale > reset > partial > observed
```

Apply this ladder only to established family-level facts. Permission-denied,
timeout, and unavailable describe failures that prevent a usable observation
of the family. If a sub-probe fails while usable family observations remain,
retain its specific reason on each affected field and establish `partial`,
rather than promoting that field failure to a family-wide failure. A
`stale` or `reset` fact still outranks `partial`. Stale values cannot be
compared, so `stale` outranks `reset`. Reset and partial can occur together;
reset is the stronger constraint on interpretation. Per-field reasons remain
present under whichever family status wins.

A family lists each omitted field from its closed field catalog with one
reason:

| Reason | Meaning | Lowers family status? |
|---|---|---|
| `unavailable` | The field's source or sub-probe failed. | Yes, to `partial`. |
| `timeout` | The sub-probe hit its deadline. | Yes, to `partial`. |
| `permission-denied` | The sub-probe was denied. | Yes, to `partial`. |
| `out-of-range` | The value is not finite or is negative, or an integer counter is not an exact safe integer (above 2^53 - 1). | Yes, to `partial`. |
| `reset` | The value cannot be compared across a reset. | Accompanies `reset`. |
| `disabled-setting` | The controlling server setting is off. | No. |
| `no-entry` | No row exists for a cataloged operation. This is never reported as zero. | No. |
| `no-baseline` | No prior observation or other proof can establish the value. | No. |

In this table, "Yes, to `partial`" means that the omission establishes
`partial` unless a higher-priority family fact applies. The expected omissions
(`disabled-setting`, `no-entry`, and `no-baseline`) do not establish `partial`.

An unknown telemetry status renders as `unavailable`. Telemetry families are
new nested sections of the same snapshot; the existing readiness and
classification values are unchanged, and an unknown readiness still renders as
`unverified` and an unknown classification as `unavailable`.

On-demand observations are fresh within the shared snapshot deadline
(`BACKEND_DIAGNOSTIC_DEADLINE_MS`, currently 2000 ms). Each family runs within
the remaining deadline. A family that retains samples declares its own
freshness bound. #637 and #638 declare their measured share of the deadline in
their pull requests, and #640 certifies overhead.

## Epochs, resets, and rates

Cumulative counters are only comparable inside one epoch.

- The statement epoch is the tuple of `pg_postmaster_start_time()`, the
  `pg_stat_statements_info.stats_reset` timestamp, and the entry's
  `stats_since`. It governs calls, rows, totals, block and WAL counters, mean,
  and standard deviation.
- The min/max epoch is the entry's `minmax_stats_since`. It governs only the
  execution-time minimum and maximum. A min/max-only reset is not a full reset.
- `pg_stat_statements_info.stats_reset` advances when all statement statistics
  are discarded. A targeted reset that is not min/max-only discards the
  matching entries, and eviction also removes entries. Until an entry is
  re-created it is absent; it does not show an in-place `stats_since` change. A
  cataloged operation with no entry reports `no-entry`. When a previously
  contributing entry disappears, the contributor membership changes and
  operation-wide rates are suppressed. Absence alone does not establish a
  reset. A re-created entry has a new `stats_since`, and an established epoch
  change invalidates comparison, whatever the cause.
- Monotonic counters never decrease inside an epoch. A decrease without an
  epoch change suppresses rates and marks the family `partial` without
  asserting a cause. With an epoch change the family is `reset`. Changes in
  min, max, mean, or standard deviation never imply a reset on their own.
- Growth in the deallocation counter means entries were evicted. It
  establishes `partial`, independently of the absence rules above, and never
  `reset`.
- Server timestamps are compared only with server timestamps.
- A rate needs two observations from the same epoch. Otherwise LCM reports no
  rate.
- LCM reports aggregates only and never synthesizes percentiles. Workload
  latency percentiles belong to #629.
- Every number is finite and non-negative. Integer counters, including the
  numeric WAL byte total, must also be exact safe integers (at most
  2^53 - 1); floating-point durations, means, deviations, and ratios need not
  be integral. A field that violates this rule is omitted with reason
  `out-of-range`, never rounded or clamped.

### Comparison context

Statuses derived by comparison (`reset`, decrease and eviction `partial`) and
all rates need a prior observation. #637 owns a bounded comparison context
inside the shared snapshot path:

- at most one prior context per scope, with a bounded entry count;
- only allowlisted counters plus internal identity and epoch data;
- invalidation on scope, publication, or mapping change; and
- no background collector, persistence file, exporter, or timer.

#638 reuses this pattern for temporal health fields, and #640 drives sequential
observations to certify it.

Comparison is per entry: same role and database scope, top-level statement,
same internal query identifier. It requires that entry's statement epoch to be
unchanged, and the operation's contributing entries and mapping to be
unchanged. Otherwise LCM reports no operation-wide rate; it never compares only
the surviving contributors. A min/max-only change invalidates the extrema
comparison and nothing else.

The first observation has no prior context. It reports cumulative values and
epoch metadata, has status `observed` if it is otherwise complete, and has no
rate. It makes no reset, decrease, or eviction claim. The missing baseline is a
per-field reason, never a false reset.

## Query fingerprints

#637 owns the statement-statistics family, which reads
`pg_stat_statements` for the LCM runtime role.

### Operation identity

- The exported identity is an LCM operation identifier of the form
  `<domain>.<operation>` from a packaged operation catalog that #637 owns and
  tests. The catalog has at most 64 entries. Only cataloged operations are
  exported. An unknown or drifted operation is omitted (fail closed) and never
  fails startup.
- Source rows are filtered to `toplevel = true`, `userid` equal to the OID of
  the runtime role, and `dbid` equal to the current database. This filter runs
  before any aggregation. The runtime role's OID comes from `pg_roles` for
  `current_user`, never from `pg_authid`. Rows of other roles may be visible as
  statistics, but LCM excludes them and never folds them into any bucket. The
  collector needs no `pg_read_all_stats` or `pg_monitor` membership, and LCM
  does not recommend either.
- The query identifier is an internal join key only. LCM never exports it,
  never uses it as a label, and never retains it past the bounded comparison
  context. One operation maps to zero or more identifiers, because different
  templates and `search_path` values produce different ones. Unrelated
  statements of the same role and database can collide into one identifier;
  the contract accepts that as a known limitation.
- LCM exports no bucket for statements that do not map to a cataloged
  operation. Utility statements are therefore never exported, and no text is
  read to classify them.

### Mapping

The mapping from operation to query identifier belongs to #637. Whatever
mechanism it chooses must:

- read no statement text;
- never use `ANALYZE`;
- stay within a bounded cost inside the snapshot deadline;
- preserve the exact signed 64-bit identifier, carried as a string internally;
  and
- ship tests proving that the mapping matches real executions.

One permitted mechanism is a bounded `EXPLAIN (GENERIC_PLAN, VERBOSE, FORMAT
JSON)` of a packaged statement template. PostgreSQL shows the query identifier
only in verbose output. This is the one exception to the rule that plan output
is never read: the collector may receive that result transiently, solely to
extract the top-level query identifier. It retains, logs, emits, or uses
nothing else from it, and it never runs on SQL that is not packaged with LCM.
If the server computes no identifier at all, the family is `unavailable`;
there is no text-based fallback. A cataloged operation that simply has no entry
gets reason `no-entry` per field.

### Scope

Query counters are role-and-database aggregates, even inside a
selected-project request. A selected-project request still returns the query
family, labelled `scope=aggregate`. LCM never labels or presents these
counters as project-specific and emits no project-scoped query series.

### Metric catalog

Each operation record carries the following 22 metrics. JSON output may use the
camelCase form of the same names.

| Metric | Unit | Source column | Condition |
|---|---|---|---|
| `query_calls_total` | count | `calls` | |
| `query_rows_total` | count | `rows` | |
| `query_exec_time_total_ms` | ms | `total_exec_time` | |
| `query_exec_time_min_ms` | ms | `min_exec_time` | Extrema rules below |
| `query_exec_time_max_ms` | ms | `max_exec_time` | Extrema rules below |
| `query_exec_time_mean_ms` | ms | derived | |
| `query_exec_time_stddev_ms` | ms | derived | |
| `query_plan_time_total_ms` | ms | `total_plan_time` | Only when `pg_stat_statements.track_planning` is on |
| `query_shared_blks_hit_total`, `query_shared_blks_read_total`, `query_shared_blks_dirtied_total`, `query_shared_blks_written_total` | blocks | `shared_blks_*` | |
| `query_local_blks_hit_total`, `query_local_blks_read_total`, `query_local_blks_dirtied_total`, `query_local_blks_written_total` | blocks | `local_blks_*` | |
| `query_temp_blks_read_total`, `query_temp_blks_written_total` | blocks | `temp_blks_*` | |
| `query_shared_blk_read_time_ms`, `query_shared_blk_write_time_ms` | ms | `shared_blk_read_time`, `shared_blk_write_time` | Only when `track_io_timing` is on |
| `query_wal_records_total` | count | `wal_records` | |
| `query_wal_bytes_total` | bytes | `wal_bytes` | |

Three family-level values accompany the records: `statements_dealloc_total`
(count), `statements_stats_reset` (server timestamp), and `block_size` (bytes,
from `current_setting('block_size')`, reported once). The collector reads
`current_setting` for `pg_stat_statements.track`,
`pg_stat_statements.track_planning`, and `track_io_timing`. An off setting omits
the dependent fields with reason `disabled-setting`, never as zero. LCM never
enables any of these settings.

### Aggregation

An operation record is a pooled summary over its contributing entries, each
over its own statistics window. The per-entry `stats_since` and
`minmax_stats_since` values naturally differ, so the record is never described
as covering one common interval. For entry i, let n_i be the call count, m_i
the mean execution time, and s_i the population standard deviation, and let N
be the sum of n_i.

- Calls, rows, totals, block counters, and WAL counters are sums.
- The pooled mean is the sum of `total_exec_time` divided by N.
- The pooled standard deviation is
  sqrt(sum(n_i * (s_i^2 + m_i^2)) / N - mean^2), or a numerically stable
  equivalent.
- LCM omits mean and standard deviation if N is 0, if any input is missing, or
  if the variance is negative or not finite.
- After aggregation, LCM rechecks every numeric value for finiteness and
  non-negativity. Integer counter fields, including WAL bytes, must also
  remain exact safe integers; floating-point durations, means, deviations,
  and ratios are not required to be integral. Every omission carries a
  per-field reason.

PostgreSQL has four source min/max columns; only the execution-time minimum
and maximum are cataloged. The pooled minimum is the smallest and the pooled
maximum the largest contributing value. LCM omits an extremum when it cannot
establish that the window's extrema are initialized. After a min/max-only
reset, PostgreSQL reports 0 until the next execution, and lifetime calls do not
prove initialization. A fresh observation may conservatively omit ambiguous
extrema with reason `no-baseline`; a comparison context can establish
initialization. #637 includes a fixture for this sequence: pre-reset calls,
min/max-only reset, no execution, then resumed execution.

## Runtime health families

#638 extends the existing snapshot fields with the families below, and owns
the thresholds and remediation text. Collection uses the snapshot's existing
path: the diagnostic-probe runtime or the daemon pool counters, as recorded in
the pool origin. It is bounded, cancellable, and cannot starve runtime pools.

This table specifies required signals. Existing fields retain the #619 snapshot
schema. New extension status and version fields and the inbox and replay
fields described only in prose are not yet complete catalog entries and must
not be emitted on that basis. Before emitting them, #638 must update this guide
with each field's exact name, type, unit (or unitless), source, permitted
dimensions, omission reasons, and finite family bound, together with its tests.
The same requirement applies to any other new field that lacks this catalog
information.

| Family | Fields | Notes |
|---|---|---|
| Pool | `pool_configured_max`, `pool_total`, `pool_idle`, `pool_waiting` (connections); `pool_saturation_ratio` | The first four are existing snapshot fields with origin `daemon`, `diagnostic-probe`, or `local`. The ratio is total divided by configured maximum, omitted when the maximum is not above 0. `pool_acquire_timeouts_total` is reserved for a future catalog revision and is not an emitted field until the pool supplies a defined counter. #638 must explicitly document whether that capability is supported. Its absence is neither a zero timeout count nor evidence of timeout-free operation. `observed` means completeness of the active catalog. Adding the counter requires the catalog update and tests described above; an unavailable counter after admission to that catalog follows the normal per-field failure rules. |
| Migration | `migration_applied_count`, `migration_expected_count` (counts); `migration_history_status` | Status is one of `current`, `behind`, `ahead`, `drift`, `checksum-mismatch`, `unavailable`. LCM compares migration IDs and checksums against the packaged set in-process, as readiness already does. It emits only the two counts and the closed status, never ID lists, checksums, or SQL. |
| Extensions | `pg_stat_statements`, `pg_trgm`, `pgcrypto`, `unaccent` | Each reports its name, the existing closed status, and the installed and default versions only when they match `^[0-9]+(\.[0-9]+){0,2}$`; otherwise the version is `unrecognized`. No remediation text and no installed schema. The optional set is empty for P4. |
| Queue and replay | Existing outbox counts; `outbox_oldest_pending_age_seconds`; inbox claimed and quarantined counts; replay lag in seconds | The outbox age uses the local wall clock over local files. Inbox counts and replay lag come from server rows and use the server clock (`clock_timestamp()`). Never event IDs, payloads, or paths. |

Queue and replay values may be scoped to a selected project through bound
parameters, the existing snapshot pattern. Aggregate scope reports totals only,
never a per-project breakdown.

## Labels and cardinality

Label keys and values are fixed when the package is built. The family is the
structural snapshot section identifier, not a dimension on emitted values.

| Label | Permitted values |
|---|---|
| `operation` | The #637 operation catalog, at most 64 entries. |
| `extension` | `pg_stat_statements`, `pg_trgm`, `pgcrypto`, `unaccent`. |
| `origin` | `daemon`, `diagnostic-probe`, `local`. |
| `scope` | `aggregate`, `selected`. |

Each family uses only its own label tuple:

| Family | Label tuple |
|---|---|
| Query | operation, scope |
| Pool | origin, scope |
| Migration | scope |
| Extensions | extension |
| Queue and replay | scope |

The observation status is one value per family, not a series dimension. The
`role_class` values (`runtime`, `migration`, `administrator`) and a
current-database alias exist only in #639 runbooks and are never collector
dimensions. Project and machine UUIDs remain snapshot metadata and are never
labels. A query identifier is never a label.

The query family emits at most 22 metrics for each of 64 operations plus the 3
family-level values, which is 1411 scalar values per snapshot. #637 and #638
declare finite limits for candidate rows read, mapping probes, and retained
comparison entries. Their tests prove truncation, not just a SQL `LIMIT`:
reaching a limit yields status `partial`.

## Privilege boundaries

- Collectors use the existing restricted runtime role and its reviewed grants.
  They need no superuser, `pg_monitor`, `pg_read_all_stats`, or
  `pg_read_all_settings`; reading the listed settings with `current_setting`
  needs none of them. A new grant enters only through a reviewed change to the
  runtime grant scripts and the readiness verifier in the pull request that
  needs it.
- LCM never calls `pg_stat_statements_reset` or any `pg_stat_reset*` function
  and never uses `ANALYZE` inside `EXPLAIN`.
- Each family declares a finite maximum number of statements, including its
  statistics reads, role and setting lookups, and any packaged-template
  mapping probes. Combine reads where practical. Every statement is
  cancellable through the caller's signal and has a `statement_timeout`
  within the remaining shared snapshot deadline. The combined work stays
  within that deadline and the declared row, mapping-probe, and
  comparison-entry limits.
- A #639 runbook that needs another role, such as a provider administrator,
  documents that requirement and sanitizes its output to role-class and
  database aliases.

## Sanitization canaries

Implementations prove the forbidden-content rules with seeded canaries. Each
test seeds unique values in:

- SQL parameter values and a literal inside a utility statement;
- message, summary, memory, tag, prompt, and inference text;
- a project path;
- a URL password, a client key, and a CA PEM body;
- provider API keys in the `sk-`, `sk-ant-`, and `ghp_` shapes;
- real role, database, and host names; and
- `application_name`.

The test then asserts that none of them appears in JSON, rendered text,
verbose output, error responses, logs, or standard error. It checks the raw
value and its JSON-escaped, URL-encoded, base64, and hex forms.

#637 fixtures, #639 runbook tests, and #640 load runs consume these canaries.
They complement the existing redaction tests. The closure evidence and
regression coverage of the closed sanitizer bugs #903, #917, #924, #925, #1332,
#1336, #1344, #1346, #1349, and #1374 are #640 gate inputs and are not owned
here.

## Deeper audit policy

`pg_stat_monitor` and `pgaudit` are not part of the required P4 delivery. LCM
does not install, configure, require, or read them. It also does not use
`auto_explain`, statement or parameter logging, or server-log scraping.

They remain future opt-in research, considered only after a measured need that
`pg_stat_statements` plus the runtime health families cannot answer. Any such
work needs a separate issue, a privacy review, and an explicit operator opt-in
that is off by default. It must obey the same forbidden-content, label, and
canary rules. Statement and audit logs contain statement text and parameters by
design, so they never feed LCM telemetry directly.

## Changing the contract

A pull request that adds a metric, label, or status updates this guide in the
same pull request and adds canary coverage for it.

See also the [schema reference](postgresql-schema.md) for extension readiness
and the [privacy guide](../../../../docs/privacy.md) for the overall local data
boundary.

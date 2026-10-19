import { AssertionError } from 'node:assert/strict';

// The daemon's passive-event replication pass acquires and releases one fenced
// lease per remote-bound project on its machine (resource_type passive-events,
// operation replicate, resource_key and owner_machine_id both the machine id),
// and re-acquires it on every start or pass. Those bookkeeping rows may appear
// or advance across a restart without any user-visible change, so only that
// exact released shape, bound to the fixture machine and its bound projects, is
// exempt from the exact table digest.
//
// Count rule. A PostgreSQL run shows that the number of leased projects is not
// a function of the bound-project count: a project only holds a lease once its
// sidecar has been replicated (the fixture's secondary never does), so the set
// grows from 0 during the run (0, 1, 2, 3, 4 projects over the snapshots). The
// strictest deterministic rule is therefore: at most one exempt row per
// project (also the primary key), every one a bound project, and, because
// leases are released and never deleted, every project exempt at an earlier
// snapshot is still exempt at a later one.
const DAEMON_OWNER = /^lcm-daemon:[0-9a-f-]{36}$/u;

function requireThat(condition, code) {
  if (!condition) throw new AssertionError({ message: `surface-parity-parent:${code}` });
}

const isPassive = row => row !== null && typeof row === 'object' && row.resource_type === 'passive-events';

/**
 * Split every fenced_leases row into the rows that stay in the digest and the
 * project ids of the exempt passive-replication leases.
 *
 * authority.machineId is the fixture machine; authority.projectIds are the
 * projects bound to it when the rows were read; authority.previous (optional)
 * is the exempt set returned by the preceding snapshot. Any passive-events row
 * that is not a released replicate lease of a bound project on the fixture
 * machine fails with a stable id, as does a duplicate or a vanished lease.
 */
export function partitionFencedLeases(rows, authority) {
  requireThat(Array.isArray(rows), 'passive-replication-lease-rows');
  const bound = new Set(authority.projectIds);
  const exempt = new Set();
  const pinned = [];
  for (const row of rows) {
    if (!isPassive(row)) { pinned.push(row); continue; }
    requireThat(row.operation === 'replicate' && bound.has(row.project_id)
      && row.resource_key === authority.machineId && row.owner_machine_id === authority.machineId
      && typeof row.owner_process_id === 'string' && DAEMON_OWNER.test(row.owner_process_id)
      && Number.isSafeInteger(row.fencing_token) && row.fencing_token >= 1
      && typeof row.released_at === 'string' && row.released_at !== '', 'passive-replication-lease-shape');
    requireThat(!exempt.has(row.project_id), 'passive-replication-lease-duplicate');
    exempt.add(row.project_id);
  }
  for (const project of authority.previous ?? []) requireThat(exempt.has(project), 'passive-replication-lease-vanished');
  return { pinned, exempt: [...exempt].sort() };
}

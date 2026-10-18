import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  PostgreSqlPassiveEventRepository,
} from "../../src/storage/postgresql/passive-event-repository.js";
import {
  assertHarnessReady,
  type PostgreSqlTestDatabase,
  withPostgreSqlTestDatabase,
} from "./harness.js";

beforeAll(assertHarnessReady);

const MAX_POSTGRESQL_BIGINT = 9_223_372_036_854_775_807n;

async function grantPassiveEventRuntimePrivileges(
  database: PostgreSqlTestDatabase,
): Promise<void> {
  const template = readFileSync(
    join(
      process.cwd(),
      "src/storage/postgresql/reference/postgresql-runtime-coordination-grants.sql",
    ),
    "utf8",
  );
  const sql = template
    .split("\n")
    .filter((line) => !line.startsWith("\\"))
    .join("\n")
    .replaceAll(':"lcm_runtime_role"', '"lcm_test_runtime"');
  await database.migrator.query({ text: sql }, {
    domain: "passive-events",
    operation: "grantPassiveEventRuntimePrivileges",
  });
}

async function createProject(
  database: PostgreSqlTestDatabase,
  label: string,
): Promise<string> {
  const result = await database.migrator.query<{ project_id: string }>({
    text: `INSERT INTO lcm.projects(identity_key, display_name)
           VALUES($1, $2)
           RETURNING project_id`,
    values: [createHash("sha256").update(label).digest("hex"), label],
  }, { domain: "passive-events", operation: "createPassiveEventProject" });
  return result.rows[0].project_id;
}

async function createMachine(
  database: PostgreSqlTestDatabase,
  label: string,
): Promise<string> {
  const result = await database.migrator.query<{ machine_id: string }>({
    text: `INSERT INTO lcm.machines(identity_key, display_name)
           VALUES($1, $2)
           RETURNING machine_id`,
    values: [
      `machine:${createHash("sha256").update(label).digest("hex")}`,
      label,
    ],
  }, { domain: "passive-events", operation: "createPassiveEventMachine" });
  return result.rows[0].machine_id;
}

function input(
  machineId: string,
  eventId: string,
  machineSequence: bigint,
  data: string,
) {
  return {
    machineId,
    eventId,
    eventVersion: 1,
    machineSequence,
    eventType: "choice",
    payload: {
      sessionId: "session",
      sessionSequence: Number(machineSequence % 100n),
      category: "decision",
      data,
      priority: 1,
      sourceHook: "PostToolUse",
      previousEventId: null,
      createdAt: "2026-07-29 12:00:00",
    },
  } as const;
}

describe("PostgreSQL 18 passive-event repository", () => {
  it("inserts exact-bigint envelopes idempotently and fails closed on collisions", async () => {
    await withPostgreSqlTestDatabase("passive-insert", async (database) => {
      await grantPassiveEventRuntimePrivileges(database);
      const projectId = await createProject(database, "Passive insert project");
      const otherProjectId = await createProject(database, "Passive insert other project");
      const machineId = await createMachine(database, "Passive insert machine");
      const eventId = "12345678-1234-4abc-8def-123456789abc";
      const repository = new PostgreSqlPassiveEventRepository(
        database.runtime,
        projectId,
        machineId,
      );
      const envelope = input(
        machineId,
        eventId,
        MAX_POSTGRESQL_BIGINT,
        "SQLite",
      );

      const [inserted] = await repository.insertEvents([envelope]);
      expect(inserted).toMatchObject({
        projectId,
        machineId,
        eventId,
        machineSequence: MAX_POSTGRESQL_BIGINT,
        status: "pending",
      });
      const [duplicate] = await repository.insertEvents([envelope]);
      expect(duplicate.inboxId).toBe(inserted.inboxId);
      await expect(repository.insertEvents([{
        ...envelope,
        payload: { ...envelope.payload, data: "PostgreSQL" },
      }])).rejects.toMatchObject({
        name: "PostgreSqlPassiveEventDataError",
        field: "idempotency_collision",
        eventId,
      });
      await expect(repository.insertEvents([
        input(
          machineId,
          "87654321-4321-5abc-8def-123456789abc",
          MAX_POSTGRESQL_BIGINT,
          "sequence collision",
        ),
      ])).rejects.toMatchObject({
        name: "PostgreSqlPassiveEventDataError",
        field: "idempotency_readback",
      });

      const otherProject = new PostgreSqlPassiveEventRepository(
        database.runtime,
        otherProjectId,
        machineId,
      );
      await expect(otherProject.readEvent({ machineId, eventId }))
        .resolves.toBeNull();
    });
  });

  it("commits an effect with applied, rolls failures back, and transitions exact claims", async () => {
    await withPostgreSqlTestDatabase("passive-complete", async (database) => {
      await grantPassiveEventRuntimePrivileges(database);
      const projectId = await createProject(database, "Passive complete project");
      const firstMachine = await createMachine(database, "Passive complete machine A");
      const secondMachine = await createMachine(database, "Passive complete machine B");
      await database.migrator.query({
        text: `CREATE TABLE public.passive_event_effects(
                 event_id uuid PRIMARY KEY,
                 payload jsonb NOT NULL
               );
               REVOKE ALL ON public.passive_event_effects FROM PUBLIC;
               GRANT INSERT, SELECT ON public.passive_event_effects
               TO lcm_test_runtime`,
      }, { domain: "passive-events", operation: "createPassiveEventEffects" });
      const repository = new PostgreSqlPassiveEventRepository(
        database.runtime,
        projectId,
        firstMachine,
      );
      const firstId = "12345678-1234-4abc-8def-123456789abc";
      const secondId = "87654321-4321-5abc-8def-123456789abc";
      const otherId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      await repository.insertEvents([
        input(firstMachine, firstId, 1n, "first"),
        input(firstMachine, secondId, 2n, "second"),
      ]);
      await new PostgreSqlPassiveEventRepository(
        database.runtime,
        projectId,
        secondMachine,
      ).insertEvents([
        input(secondMachine, otherId, 1n, "other machine"),
      ]);
      const lease = await repository.acquireDrainLease("worker", 30_000);
      expect(lease).not.toBeNull();
      const claims = await repository.claimEvents({
        claimOwner: `worker:${lease!.fencingToken.toString()}`,
        limit: 10,
        staleClaimMs: 1_000,
      });
      expect(claims.map(({ machineId, machineSequence }) => ({
        machineId,
        machineSequence,
      }))).toEqual([
        { machineId: firstMachine, machineSequence: 1n },
        { machineId: secondMachine, machineSequence: 1n },
      ]);

      const firstClaim = claims.find(({ machineId }) => machineId === firstMachine)!;
      await expect(repository.completeApplied({
        claim: firstClaim,
        processId: "worker",
        fencingToken: lease!.fencingToken,
      }, async (transaction, claimed) => {
        await transaction.query({
          text: `INSERT INTO public.passive_event_effects(event_id, payload)
                 VALUES($1, $2::pg_catalog.jsonb)`,
          values: [claimed.eventId, JSON.stringify(claimed.payload)],
        }, {
          domain: "passive-events",
          operation: "applyPassiveEventEffect",
          projectId,
          machineId: firstMachine,
        });
        return "committed";
      })).resolves.toMatchObject({
        result: "committed",
        event: { status: "applied", eventId: firstId },
      });
      const effect = await database.migrator.query<{ count: string }>({
        text: `SELECT COUNT(*)::pg_catalog.text AS count
               FROM public.passive_event_effects
               WHERE event_id = $1`,
        values: [firstId],
      }, { domain: "passive-events", operation: "verifyPassiveEventEffect" });
      expect(effect.rows[0].count).toBe("1");

      const otherClaim = claims.find(({ machineId }) => machineId === secondMachine)!;
      await repository.quarantine({
        claim: otherClaim,
        processId: "worker",
        fencingToken: lease!.fencingToken,
        reason: "poison",
      });

      const [secondClaim] = await repository.claimEvents({
        claimOwner: `worker:${lease!.fencingToken.toString()}`,
        limit: 10,
        staleClaimMs: 1_000,
      });
      expect(secondClaim.eventId).toBe(secondId);
      await expect(repository.completeApplied({
        claim: secondClaim,
        processId: "worker",
        fencingToken: lease!.fencingToken,
      }, async (transaction, claimed) => {
        await transaction.query({
          text: `INSERT INTO public.passive_event_effects(event_id, payload)
                 VALUES($1, $2::pg_catalog.jsonb)`,
          values: [claimed.eventId, JSON.stringify(claimed.payload)],
        }, {
          domain: "passive-events",
          operation: "applyThenRejectPassiveEvent",
          projectId,
          machineId: firstMachine,
        });
        throw new Error("injected apply failure");
      })).rejects.toBeDefined();
      const rolledBack = await database.migrator.query<{
        effect_count: string;
        status: string;
      }>({
        text: `SELECT
                 (
                   SELECT COUNT(*)::pg_catalog.text
                   FROM public.passive_event_effects
                   WHERE event_id = $2
                 ) AS effect_count,
                 status
               FROM lcm.passive_event_inbox
               WHERE project_id = $1
                 AND event_id = $2`,
        values: [projectId, secondId],
      }, { domain: "passive-events", operation: "verifyPassiveEventRollback" });
      expect(rolledBack.rows[0]).toEqual({
        effect_count: "0",
        status: "claimed",
      });
      await expect(repository.scheduleRetry({
        claim: secondClaim,
        processId: "worker",
        fencingToken: lease!.fencingToken,
        delayMs: 1,
      })).resolves.toMatchObject({ status: "retry" });
      await expect(repository.replayQuarantined({
        machineId: secondMachine,
        eventId: otherId,
      })).resolves.toMatchObject({ status: "pending" });
      await repository.releaseDrainLease("worker", lease!.fencingToken);
    });
  });

  it("prunes only exact applied rows and preserves nonterminal, quarantined, and foreign rows", async () => {
    await withPostgreSqlTestDatabase("passive-prune", async (database) => {
      await grantPassiveEventRuntimePrivileges(database);
      const projectId = await createProject(database, "Passive prune project");
      const foreignProjectId = await createProject(database, "Passive prune foreign project");
      const machineId = await createMachine(database, "Passive prune machine");
      const foreignMachineId = await createMachine(database, "Passive prune foreign machine");
      const repository = new PostgreSqlPassiveEventRepository(
        database.runtime,
        projectId,
        machineId,
      );
      const ids = {
        applied: "11111111-1111-4111-8111-111111111111",
        pending: "22222222-2222-4222-8222-222222222222",
        retry: "33333333-3333-4333-8333-333333333333",
        quarantined: "44444444-4444-4444-8444-444444444444",
        foreign: "55555555-5555-4555-8555-555555555555",
      } as const;
      const own = await repository.insertEvents([
        input(machineId, ids.applied, 1n, "applied"),
        input(machineId, ids.pending, 2n, "pending"),
        input(machineId, ids.retry, 3n, "retry"),
        input(machineId, ids.quarantined, 4n, "quarantined"),
      ]);
      const [foreign] = await new PostgreSqlPassiveEventRepository(
        database.runtime,
        foreignProjectId,
        foreignMachineId,
      ).insertEvents([
        input(foreignMachineId, ids.foreign, 1n, "foreign"),
      ]);
      await database.migrator.query({
        text: `UPDATE lcm.passive_event_inbox
               SET status = CASE event_id
                     WHEN $2::pg_catalog.uuid THEN 'applied'
                     WHEN $3::pg_catalog.uuid THEN 'retry'
                     WHEN $4::pg_catalog.uuid THEN 'quarantined'
                     ELSE status
                   END,
                   applied_at = CASE
                     WHEN event_id = $2 THEN pg_catalog.statement_timestamp()
                     ELSE NULL
                   END,
                   next_attempt_at = CASE
                     WHEN event_id = $3
                       THEN pg_catalog.statement_timestamp() + interval '1 minute'
                     ELSE next_attempt_at
                   END,
                   quarantined_at = CASE
                     WHEN event_id = $4 THEN pg_catalog.statement_timestamp()
                     ELSE NULL
                   END,
                   quarantine_reason = CASE
                     WHEN event_id = $4 THEN 'poison'
                     ELSE NULL
                   END
               WHERE project_id = $1`,
        values: [
          projectId,
          ids.applied,
          ids.retry,
          ids.quarantined,
        ],
      }, { domain: "passive-events", operation: "seedPassiveEventPruneStates" });
      await database.migrator.query({
        text: `UPDATE lcm.passive_event_inbox
               SET status = 'applied',
                   applied_at = pg_catalog.statement_timestamp()
               WHERE project_id = $1
                 AND event_id = $2`,
        values: [foreignProjectId, ids.foreign],
      }, { domain: "passive-events", operation: "seedForeignAppliedEvent" });

      const byId = new Map(own.map((event) => [event.eventId, event]));
      await expect(repository.pruneApplied([
        {
          machineId,
          eventId: ids.applied,
          inboxId: byId.get(ids.applied)!.inboxId,
        },
        {
          machineId,
          eventId: ids.pending,
          inboxId: byId.get(ids.pending)!.inboxId,
        },
        {
          machineId,
          eventId: ids.retry,
          inboxId: byId.get(ids.retry)!.inboxId,
        },
        {
          machineId,
          eventId: ids.quarantined,
          inboxId: byId.get(ids.quarantined)!.inboxId,
        },
        {
          machineId: foreignMachineId,
          eventId: ids.foreign,
          inboxId: foreign.inboxId,
        },
      ])).resolves.toBe(1n);

      const remaining = await database.migrator.query<{
        project_id: string;
        event_id: string;
        status: string;
      }>({
        text: `SELECT project_id, event_id, status
               FROM lcm.passive_event_inbox
               ORDER BY project_id, event_id`,
      }, { domain: "passive-events", operation: "verifyExactPassiveEventPrune" });
      expect(remaining.rows).toEqual(expect.arrayContaining([
        { project_id: projectId, event_id: ids.pending, status: "pending" },
        { project_id: projectId, event_id: ids.retry, status: "retry" },
        { project_id: projectId, event_id: ids.quarantined, status: "quarantined" },
        { project_id: foreignProjectId, event_id: ids.foreign, status: "applied" },
      ]));
      expect(remaining.rows.some(({ event_id }) => event_id === ids.applied))
        .toBe(false);
    });
  });

  describe("withdrawing this machine's copies from other projects (#1509)", () => {
    const eventIds = Array.from(
      { length: 12 },
      (_, index) => `aaaaaaaa-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    );

    async function seed(
      database: PostgreSqlTestDatabase,
      eventId: string,
      assignments: string,
    ): Promise<void> {
      await database.migrator.query({
        text: `UPDATE lcm.passive_event_inbox SET ${assignments} WHERE event_id = $1`,
        values: [eventId],
      }, { domain: "passive-events", operation: "seedReleasedPassiveEvent" });
    }

    async function remaining(database: PostgreSqlTestDatabase): Promise<string[]> {
      const rows = await database.migrator.query<{ label: string }>({
        text: `SELECT project.display_name || ':' || event_id::pg_catalog.text || ':' || status AS label
               FROM lcm.passive_event_inbox AS event
               JOIN lcm.projects AS project USING (project_id)`,
      }, { domain: "passive-events", operation: "listRemainingPassiveEvents" });
      return rows.rows.map(({ label }) => label).sort();
    }

    type HeldTransaction = Parameters<Parameters<PostgreSqlTestDatabase["runtime"]["transaction"]>[0]>[0];

    const heldRowCapMs = 5_000;
    const blockedPollAttempts = 40;
    const blockedPollIntervalMs = 50;

    function within<T>(promise: Promise<T>, milliseconds: number, what: string): Promise<T> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${what} did not happen within ${milliseconds} ms`)),
          milliseconds,
        );
      });
      return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
    }

    // Polls, a finite number of times, until a backend of the runtime role is
    // waiting on a lock held by the holder's backend while running the release
    // statement, and returns that backend's pid.
    async function findBlockedRelease(
      database: PostgreSqlTestDatabase,
      projectId: string,
      holderPid: number,
    ): Promise<number> {
      for (let attempt = 0; attempt < blockedPollAttempts; attempt += 1) {
        const blocked = await database.runtime.query<{ pid: number }>({
          text: `SELECT pid FROM pg_catalog.pg_stat_activity
                 WHERE datname = pg_catalog.current_database()
                   AND wait_event_type = 'Lock'
                   AND pg_catalog.pg_blocking_pids(pid) @> ARRAY[$1::pg_catalog.int4]
                   AND query LIKE '%FOR UPDATE OF event%'`,
          values: [holderPid],
        }, { domain: "passive-events", operation: "findBlockedPassiveEventRelease", projectId });
        if (blocked.rows.length === 1) return blocked.rows[0].pid;
        await new Promise((resolve) => setTimeout(resolve, blockedPollIntervalMs));
      }
      throw new Error("the release statement was never blocked on the holder's row lock");
    }

    // Starts the release while another transaction holds every row of the
    // machine, proves from pg_stat_activity that the release statement is
    // blocked on that transaction's row lock, then lets writeWhileHeld change
    // rows inside the holder (given the release backend's pid) and commit.
    // Every wait is bounded, and on every failure path the holder is rolled
    // back and both promises are settled before this returns or throws.
    async function releaseWhileRowsAreHeld<T>(
      database: PostgreSqlTestDatabase,
      machineId: string,
      projectId: string,
      startRelease: () => Promise<T>,
      writeWhileHeld: (transaction: HeldTransaction, releasePid: number) => Promise<void>,
    ): Promise<T> {
      let proceed!: (releasePid: number) => void;
      let abort!: (reason: Error) => void;
      const holderMayFinish = new Promise<number>((resolve, reject) => {
        proceed = resolve;
        abort = reject;
      });
      holderMayFinish.catch(() => undefined);
      let holderLocked!: (holderPid: number) => void;
      let holderFailed!: (reason: unknown) => void;
      const locked = new Promise<number>((resolve, reject) => {
        holderLocked = resolve;
        holderFailed = reject;
      });
      const context = { domain: "passive-events", operation: "holdReleasedPassiveEvents", projectId };
      const holder = database.runtime.transaction(async (transaction) => {
        const pid = await transaction.query<{ pid: number }>({
          text: "SELECT pg_catalog.pg_backend_pid() AS pid",
        }, context);
        await transaction.query({
          text: `SELECT 1 FROM lcm.passive_event_inbox
                 WHERE machine_id = $1 FOR UPDATE`,
          values: [machineId],
        }, context);
        holderLocked(pid.rows[0].pid);
        await writeWhileHeld(transaction, await holderMayFinish);
      }, context);
      holder.catch(holderFailed);
      let release: Promise<T> | undefined;
      try {
        const holderPid = await within(locked, heldRowCapMs, "the holder taking its row locks");
        release = startRelease();
        proceed(await findBlockedRelease(database, projectId, holderPid));
        await within(holder, heldRowCapMs, "the holder committing");
        return await within(release, heldRowCapMs, "the release finishing");
      } finally {
        abort(new Error("release race aborted"));
        await within(
          Promise.allSettled(release === undefined ? [holder] : [holder, release]),
          heldRowCapMs,
          "the holder and the release settling",
        );
      }
    }

    it("deletes only safe copies of its own rows and reports the rest", async () => {
      await withPostgreSqlTestDatabase("passive-release", async (database) => {
        await grantPassiveEventRuntimePrivileges(database);
        const oldId = await createProject(database, "old");
        const boundId = await createProject(database, "bound");
        const machineId = await createMachine(database, "Passive release machine");
        const otherMachineId = await createMachine(database, "Passive release other machine");
        const old = new PostgreSqlPassiveEventRepository(database.runtime, oldId, machineId);
        const bound = new PostgreSqlPassiveEventRepository(database.runtime, boundId, machineId);
        const [pending, retry, staleClaim, freshClaim, applied, quarantined, envelope, inbox] =
          eventIds;
        const inserted = await old.insertEvents(
          [pending, retry, staleClaim, freshClaim, applied, quarantined, envelope, inbox]
            .map((eventId, index) => input(machineId, eventId, BigInt(index + 1), eventId)),
        );
        const inboxOf = new Map(inserted.map((event) => [event.eventId, event.inboxId]));
        const [boundCopy] = await bound.insertEvents([input(machineId, eventIds[8], 9n, "bound")]);
        await new PostgreSqlPassiveEventRepository(database.runtime, oldId, otherMachineId)
          .insertEvents([input(otherMachineId, eventIds[9], 1n, "other machine")]);
        await seed(database, retry, "status = 'retry'");
        await seed(
          database,
          staleClaim,
          `received_at = pg_catalog.statement_timestamp() - interval '1 hour',
            status = 'claimed', claimed_by = 'dead',
            claimed_at = pg_catalog.statement_timestamp() - interval '30 minutes'`,
        );
        await seed(
          database,
          freshClaim,
          "status = 'claimed', claimed_by = 'alive', claimed_at = pg_catalog.statement_timestamp()",
        );
        await seed(database, applied, "status = 'applied', applied_at = pg_catalog.statement_timestamp()");
        await seed(
          database,
          quarantined,
          "status = 'quarantined', quarantined_at = pg_catalog.statement_timestamp(), quarantine_reason = 'poison'",
        );

        const keys = [
          ...[pending, retry, staleClaim, freshClaim, applied, quarantined]
            .map((eventId, index) =>
              ({ ...input(machineId, eventId, BigInt(index + 1), eventId), inboxId: inboxOf.get(eventId)! })),
          // The envelope differs from the stored copy.
          { ...input(machineId, envelope, 7n, "forged"), inboxId: inboxOf.get(envelope)! },
          // The recorded inbox id is not the stored copy's.
          { ...input(machineId, inbox, 8n, inbox), inboxId: inboxOf.get(inbox)! + 1000n },
          { ...input(machineId, eventIds[8], 9n, "bound"), inboxId: boundCopy.inboxId },
          { ...input(machineId, eventIds[10], 11n, "never inserted"), inboxId: 4242n },
        ];
        await expect(bound.releaseFromOtherProjects(keys, { staleClaimMs: 60_000 }))
          .resolves.toEqual([
            { eventId: pending, outcome: "released" },
            { eventId: retry, outcome: "released" },
            { eventId: staleClaim, outcome: "released" },
            { eventId: freshClaim, outcome: "busy" },
            { eventId: applied, outcome: "applied", inboxId: inboxOf.get(applied)! },
            {
              eventId: quarantined,
              outcome: "quarantined",
              inboxId: inboxOf.get(quarantined)!,
              quarantineReason: "poison",
            },
            { eventId: envelope, outcome: "mismatch" },
            { eventId: inbox, outcome: "mismatch" },
            { eventId: eventIds[8], outcome: "bound" },
            { eventId: eventIds[10], outcome: "absent" },
          ]);
        // Quarantine, the live claim, mismatches, the bound project's row and
        // another machine's row all survive; nothing else does.
        expect(await remaining(database)).toEqual([
          `bound:${eventIds[8]}:pending`,
          `old:${eventIds[9]}:pending`,
          `old:${envelope}:pending`,
          `old:${freshClaim}:claimed`,
          `old:${inbox}:pending`,
          `old:${quarantined}:quarantined`,
        ].sort());

        // The withdrawn row can now be uploaded to the bound project.
        await expect(bound.insertEvents([input(machineId, pending, 1n, pending)]))
          .resolves.toMatchObject([{ projectId: boundId, status: "pending" }]);
        // Repeating the call finds nothing left to release.
        await expect(bound.releaseFromOtherProjects(keys.slice(0, 3), { staleClaimMs: 60_000 }))
          .resolves.toEqual([
            { eventId: pending, outcome: "bound" },
            { eventId: retry, outcome: "absent" },
            { eventId: staleClaim, outcome: "absent" },
          ]);
      });
    });

    it("releases a copy by event id alone so the rolled-back batch can be inserted (#1511)", async () => {
      await withPostgreSqlTestDatabase("passive-release-without-inbox-id", async (database) => {
        await grantPassiveEventRuntimePrivileges(database);
        const oldId = await createProject(database, "old");
        const boundId = await createProject(database, "bound");
        const machineId = await createMachine(database, "Passive release without inbox id machine");
        const old = new PostgreSqlPassiveEventRepository(database.runtime, oldId, machineId);
        const bound = new PostgreSqlPassiveEventRepository(database.runtime, boundId, machineId);
        const [unrelated, pending, applied, envelope] = eventIds;
        const inserted = await old.insertEvents([
          input(machineId, pending, 2n, pending),
          input(machineId, applied, 3n, applied),
          input(machineId, envelope, 4n, envelope),
        ]);
        const appliedInboxId = inserted.find((event) => event.eventId === applied)!.inboxId;
        await seed(database, applied, "status = 'applied', applied_at = pg_catalog.statement_timestamp()");

        // The copy in the old project fails the whole bound batch, so the
        // unrelated row ahead of it is not inserted either.
        const batch = [input(machineId, unrelated, 1n, unrelated), input(machineId, pending, 2n, pending)];
        await expect(bound.insertEvents(batch)).rejects.toMatchObject({
          name: "PostgreSqlPassiveEventDataError",
          field: "idempotency_readback",
          eventId: pending,
        });
        expect(await bound.readEvents(batch.map(({ machineId: machine, eventId }) =>
          ({ machineId: machine, eventId })))).toEqual([]);

        // The upload that went to the old project was never recorded locally,
        // so the keys carry no inbox id.
        await expect(bound.releaseFromOtherProjects([
          input(machineId, unrelated, 1n, unrelated),
          input(machineId, pending, 2n, pending),
          input(machineId, applied, 3n, applied),
          // The envelope differs from the stored copy.
          input(machineId, envelope, 4n, "forged"),
        ], { staleClaimMs: 60_000 })).resolves.toEqual([
          { eventId: unrelated, outcome: "absent" },
          { eventId: pending, outcome: "released" },
          { eventId: applied, outcome: "applied", inboxId: appliedInboxId },
          { eventId: envelope, outcome: "mismatch" },
        ]);
        expect(await remaining(database)).toEqual([`old:${envelope}:pending`]);

        await expect(bound.insertEvents(batch)).resolves.toMatchObject([
          { eventId: unrelated, projectId: boundId, status: "pending" },
          { eventId: pending, projectId: boundId, status: "pending" },
        ]);
      });
    });

    it("rejects keys of another machine and duplicate keys without touching any row", async () => {
      await withPostgreSqlTestDatabase("passive-release-input", async (database) => {
        await grantPassiveEventRuntimePrivileges(database);
        const oldId = await createProject(database, "old");
        const boundId = await createProject(database, "bound");
        const machineId = await createMachine(database, "Passive release input machine");
        const otherMachineId = await createMachine(database, "Passive release input other");
        const old = new PostgreSqlPassiveEventRepository(database.runtime, oldId, machineId);
        const otherOld = new PostgreSqlPassiveEventRepository(database.runtime, oldId, otherMachineId);
        const bound = new PostgreSqlPassiveEventRepository(database.runtime, boundId, machineId);
        const [mine] = await old.insertEvents([input(machineId, eventIds[0], 1n, "mine")]);
        const [theirs] = await otherOld.insertEvents([input(otherMachineId, eventIds[1], 1n, "theirs")]);
        await expect(bound.releaseFromOtherProjects([
          { ...input(otherMachineId, eventIds[1], 1n, "theirs"), inboxId: theirs.inboxId },
        ], { staleClaimMs: 60_000 })).rejects.toMatchObject({
          name: "PostgreSqlPassiveEventDataError",
          field: "machine_id",
        });
        // The row of another machine is not reachable by event id alone either.
        await expect(bound.releaseFromOtherProjects([
          { ...input(machineId, eventIds[1], 1n, "theirs"), inboxId: theirs.inboxId },
        ], { staleClaimMs: 60_000 })).resolves.toEqual([{ eventId: eventIds[1], outcome: "absent" }]);
        const key = { ...input(machineId, eventIds[0], 1n, "mine"), inboxId: mine.inboxId };
        await expect(bound.releaseFromOtherProjects([key, key], { staleClaimMs: 60_000 }))
          .rejects.toMatchObject({ field: "duplicate_batch_event_id" });
        expect((await remaining(database)).length).toBe(2);
      });
    });

    it("classifies a copy on the version it locked, whoever held it first", async () => {
      await withPostgreSqlTestDatabase("passive-release-race", async (database) => {
        await grantPassiveEventRuntimePrivileges(database);
        const oldId = await createProject(database, "old");
        const boundId = await createProject(database, "bound");
        const machineId = await createMachine(database, "Passive release race machine");
        const old = new PostgreSqlPassiveEventRepository(database.runtime, oldId, machineId);
        const bound = new PostgreSqlPassiveEventRepository(database.runtime, boundId, machineId);
        const [claimedLater, appliedLater] = eventIds;
        const inserted = await old.insertEvents([
          input(machineId, claimedLater, 1n, "claimed later"),
          input(machineId, appliedLater, 2n, "applied later"),
        ]);
        const keys = inserted.map((event) => ({
          ...input(event.machineId, event.eventId, event.machineSequence, String((event.payload as { data: string }).data)),
          inboxId: event.inboxId,
        }));

        // Another process holds both rows and changes them before committing;
        // the release statement is proven blocked on that row lock first.
        const released = await releaseWhileRowsAreHeld(
          database,
          machineId,
          oldId,
          () => bound.releaseFromOtherProjects(keys, { staleClaimMs: 60_000 }),
          async (transaction) => {
            await transaction.query({
              text: `UPDATE lcm.passive_event_inbox
                     SET status = 'claimed', claimed_by = 'live',
                         claimed_at = pg_catalog.statement_timestamp()
                     WHERE event_id = $1`,
              values: [claimedLater],
            }, { domain: "passive-events", operation: "claimReleasedPassiveEvent", projectId: oldId });
            await transaction.query({
              text: `UPDATE lcm.passive_event_inbox
                     SET status = 'applied', applied_at = pg_catalog.statement_timestamp()
                     WHERE event_id = $1`,
              values: [appliedLater],
            }, { domain: "passive-events", operation: "applyReleasedPassiveEvent", projectId: oldId });
          },
        );
        // It then judges the committed versions: a live claim is left alone
        // and an applied copy is deleted.
        expect(released).toEqual([
          { eventId: claimedLater, outcome: "busy" },
          { eventId: appliedLater, outcome: "applied", inboxId: inserted[1].inboxId },
        ]);
        expect(await remaining(database)).toEqual([`old:${claimedLater}:claimed`]);
      });
    });

    it("counts a claim exactly staleClaimMs old on database time as stale", async () => {
      await withPostgreSqlTestDatabase("passive-release-boundary", async (database) => {
        await grantPassiveEventRuntimePrivileges(database);
        const oldId = await createProject(database, "old");
        const boundId = await createProject(database, "bound");
        const machineId = await createMachine(database, "Passive release boundary machine");
        const old = new PostgreSqlPassiveEventRepository(database.runtime, oldId, machineId);
        const bound = new PostgreSqlPassiveEventRepository(database.runtime, boundId, machineId);
        const [onCutoff, newerThanCutoff, olderThanCutoff] = eventIds;
        const inserted = await old.insertEvents(
          [onCutoff, newerThanCutoff, olderThanCutoff]
            .map((eventId, index) => input(machineId, eventId, BigInt(index + 1), eventId)),
        );
        // Every claim starts on the side of the cutoff opposite to the one it
        // ends on, so only the version committed by the holder can give the
        // expected outcome.
        for (const [eventId, claimedAt] of [
          [onCutoff, "pg_catalog.statement_timestamp()"],
          [newerThanCutoff, "pg_catalog.statement_timestamp() - interval '30 minutes'"],
          [olderThanCutoff, "pg_catalog.statement_timestamp()"],
        ]) {
          await seed(
            database,
            eventId,
            `received_at = pg_catalog.statement_timestamp() - interval '1 hour',
              status = 'claimed', claimed_by = 'dead', claimed_at = ${claimedAt}`,
          );
        }
        const staleClaimMs = 60_000;

        // The release statement's statement_timestamp() is its pg_stat_activity
        // query_start, known only once it runs. While it waits for the row
        // locks, the holder moves each claim to that cutoff plus a skew,
        // computed in SQL with the production expression.
        const released = await releaseWhileRowsAreHeld(
          database,
          machineId,
          oldId,
          () => bound.releaseFromOtherProjects(
            inserted.map((event) => ({
              ...input(machineId, event.eventId, event.machineSequence, event.eventId),
              inboxId: event.inboxId,
            })),
            { staleClaimMs },
          ),
          async (transaction, releasePid) => {
            for (const [eventId, skew] of [
              [onCutoff, "0 microseconds"],
              [newerThanCutoff, "1 microsecond"],
              [olderThanCutoff, "-1 microsecond"],
            ]) {
              const moved = await transaction.query({
                text: `UPDATE lcm.passive_event_inbox
                       SET claimed_at = (
                         SELECT query_start FROM pg_catalog.pg_stat_activity
                         WHERE pid = $1::pg_catalog.int4
                       ) - $2::pg_catalog.float8 * interval '1 millisecond'
                         + $3::pg_catalog.interval
                       WHERE event_id = $4`,
                values: [releasePid, staleClaimMs, skew, eventId],
              }, { domain: "passive-events", operation: "moveClaimToCutoff", projectId: oldId });
              expect(moved.rowCount).toBe(1);
            }
          },
        );

        // A claim on the cutoff is stale, one a microsecond newer is live and
        // one a microsecond older is stale.
        expect(released).toEqual([
          { eventId: onCutoff, outcome: "released" },
          { eventId: newerThanCutoff, outcome: "busy" },
          { eventId: olderThanCutoff, outcome: "released" },
        ]);
        expect(await remaining(database)).toEqual([`old:${newerThanCutoff}:claimed`]);
      });
    });

    it("leaves a stale claimer unable to resurrect a released copy", async () => {
      await withPostgreSqlTestDatabase("passive-release-stale", async (database) => {
        await grantPassiveEventRuntimePrivileges(database);
        const oldId = await createProject(database, "old");
        const boundId = await createProject(database, "bound");
        const machineId = await createMachine(database, "Passive release stale machine");
        const old = new PostgreSqlPassiveEventRepository(database.runtime, oldId, machineId);
        const bound = new PostgreSqlPassiveEventRepository(database.runtime, boundId, machineId);
        const [event] = await old.insertEvents([input(machineId, eventIds[0], 1n, "stale")]);
        const lease = await old.acquireDrainLease("old-worker", 30_000);
        const [claim] = await old.claimEvents({
          claimOwner: "old-worker:1",
          limit: 1,
          staleClaimMs: 1_000,
        });
        await seed(
          database,
          eventIds[0],
          `received_at = pg_catalog.statement_timestamp() - interval '1 hour',
            claimed_at = pg_catalog.statement_timestamp() - interval '30 minutes'`,
        );
        await expect(bound.releaseFromOtherProjects(
          [{ ...input(machineId, eventIds[0], 1n, "stale"), inboxId: event.inboxId }],
          { staleClaimMs: 60_000 },
        )).resolves.toEqual([{ eventId: eventIds[0], outcome: "released" }]);

        let applied = false;
        await expect(old.completeApplied({
          claim,
          processId: "old-worker",
          fencingToken: lease!.fencingToken,
        }, async () => { applied = true; })).rejects.toMatchObject({ field: "claimed_row" });
        expect(applied).toBe(false);
        expect(await remaining(database)).toEqual([]);
      });
    });
  });
});

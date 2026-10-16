/**
 * The production rollback session (src/migration/rollback-session.ts) against a
 * real PostgreSQL 18 database: a real lease on lcm.fenced_leases, real
 * read-only snapshots, the real census and export. Quiescence (a local
 * append-barrier concern with its own tests) is the one collaborator
 * satisfied by a stand-in; everything on the PostgreSQL side is real.
 *
 * The orchestration (runMigrationRollback) runs with the real session, a real
 * coordinator and a real manifest store, so the cases below prove the
 * behaviours end to end: pre-write on an unchanged destination, post-write
 * after a racing post-epoch write, a lost fence mid-window, and the
 * build-versus-revalidation equality of plan-v3.1 amendment A6.
 */

import { mkdirSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  BackendPublicationCoordinator,
  readBackendMaintenanceJournal,
  type BackendPublicationDriver,
} from "../../src/storage/backend-publication.js";
import { MigrationManifestStore } from "../../src/migration/manifest-store.js";
import {
  beginMigrationEffect,
  completeMigrationEffect,
  createMigrationManifest,
  type MigrationManifest,
  type MigrationStorageWitness,
} from "../../src/migration/protocol.js";
import { runMigrationRollback, type RunMigrationRollbackInput } from "../../src/migration/rollback.js";
import {
  DEFAULT_ROLLBACK_SESSION_DEPENDENCIES,
  RollbackSessionError,
  openRollbackFencedSession,
  type RollbackSessionDependencies,
  type RollbackSessionTarget,
} from "../../src/migration/rollback-session.js";
import {
  buildMigrationCanonicalDelta,
  buildMigrationCensusVector,
  captureDestinationIdentity,
  readFencedDestinationCensus,
} from "../../src/migration/verify-generation.js";
import { fixtureActivationScenario } from "../fixtures/migration-activation-records.js";
import { assertHarnessReady, settings, withPostgreSqlTestDatabase, type PostgreSqlTestDatabase } from "./harness.js";
import { applyAllRuntimeGrants } from "./operational-fixture.js";
import { PORTABLE_POSTGRESQL_FIXTURE, seedPortablePostgreSql } from "./portable-fixture.js";

beforeAll(assertHarnessReady);

const fixture = PORTABLE_POSTGRESQL_FIXTURE;
const factoryContext = { domain: "factory", operation: "rollbackSessionIntegration" } as const;
const capturedAt = "2026-09-06T00:00:00.000Z";
const ROSTER = [{ machineId: fixture.machineId, queueCutoff: null, evidenceSha256: "7".repeat(64) }];

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "lcm-rollback-session-pg-"));
  mkdirSync(join(dir, ".lcm"), { mode: 0o700 });
  dirs.push(dir);
  return dir;
}

function unexpectedDriver(): BackendPublicationDriver {
  const unexpected = async (): Promise<never> => { throw new Error("rollback does not publish project-map or config here"); };
  return {
    observeLocalState: unexpected, publishProjectMap: unexpected, publishConfig: unexpected,
    restoreConfig: unexpected, restoreProjectMap: unexpected,
  };
}

function storageWitness(backend: "sqlite" | "postgresql", seed: string): MigrationStorageWitness {
  return {
    version: 1, backend, identitySha256: seed.repeat(64).slice(0, 64), schemaSha256: "2".repeat(64),
    contentSha256: "3".repeat(64), capturedAt,
  };
}

/** A manifest at phase "verified", reached through the ordinary forward effect sequence. */
function manifestAtVerified(store: MigrationManifestStore, generationId: string): MigrationManifest {
  let m = store.create(createMigrationManifest({
    generationId, source: storageWitness("sqlite", "1"), destination: storageWitness("postgresql", "4"),
    parentGenerationId: null, preservedSourceGenerationId: generationId, createdAt: capturedAt,
  }));
  const step = (kind: string, extra: Record<string, unknown> = {}) => {
    m = store.update(generationId, m.checksumSha256, (current) => beginMigrationEffect(current, {
      kind: kind as never, effectId: kind, inputSha256: "a".repeat(64), startedAt: capturedAt,
    }));
    m = store.update(generationId, m.checksumSha256, (current) => completeMigrationEffect(current, {
      effectId: kind, completedAt: capturedAt, ...extra,
    }));
  };
  step("verify-dry-run", { report: { kind: "dry-run", reportId: "r1", reportSha256: "b".repeat(64), createdAt: capturedAt } });
  step("copy-batch", { checkpoint: { domain: "conversations", ordinal: 1, recordCount: 1, sourceCheckpointSha256: "c".repeat(64), destinationCommitSha256: "d".repeat(64) } });
  step("complete-copy");
  step("verify-generation", {
    report: { kind: "verification", reportId: "r2", reportSha256: "b".repeat(64), createdAt: capturedAt },
    activationEligible: true,
  });
  return m;
}

function targetFor(database: PostgreSqlTestDatabase): RollbackSessionTarget {
  return {
    settings: settings(database.runtimeUrl),
    expectedOwner: "lcm_test_migrator",
    expectedIdentity: fixture.expectedIdentity,
    localProjectId: fixture.localProjectId,
    remoteProjectId: fixture.projectId,
    machineId: fixture.machineId,
  };
}

/** Everything real except the local append-barrier quiescence check. */
const dependencies: RollbackSessionDependencies = {
  ...DEFAULT_ROLLBACK_SESSION_DEPENDENCIES,
  checkQuiescence: async () => ({
    status: "satisfied", reason: "quiescence-observed", detail: "stand-in",
    quiescenceFence: { version: 1, kind: "lcm-activation-writer-quiescence-v1", payload: "{}", evidenceSha256: "a".repeat(64) },
  }),
};

async function scan(database: PostgreSqlTestDatabase) {
  const snapshot = await database.runtime.openReadOnlySnapshot({ projectId: fixture.projectId });
  try {
    const read = await readFencedDestinationCensus(snapshot, {
      settings: settings(database.runtimeUrl), expectedOwner: "lcm_test_migrator",
      expectedIdentity: fixture.expectedIdentity, scratchParent: tmpdir(),
    });
    return { delta: buildMigrationCanonicalDelta(read.census), census: buildMigrationCensusVector(read.census) };
  } finally {
    await snapshot.close();
  }
}

/** The activation the rollback unwinds, built from a REAL baseline scan of this database. */
async function activationFor(database: PostgreSqlTestDatabase, generationId: string) {
  const baseline = await scan(database);
  const destinationIdentity = await captureDestinationIdentity(database.runtime, fixture.projectId);
  return fixtureActivationScenario({
    generationId, destinationIdentity, censusVector: baseline.census, canonicalDeltaBaseline: baseline.delta,
  });
}

async function insertConversation(database: PostgreSqlTestDatabase, sessionId: string): Promise<void> {
  await database.migrator.query({
    text: "INSERT INTO lcm.conversations (project_id, session_id, title, bootstrapped_at, created_at, updated_at) "
      + "VALUES ($1, $2, NULL, NULL, $3, $3)",
    values: [fixture.projectId, sessionId, fixture.laterTimestamp],
  }, factoryContext);
}

/** An in-place change: neither a record count nor a terminal identity moves, so only the census can see it. */
async function editFirstMessage(database: PostgreSqlTestDatabase, content: string): Promise<void> {
  await database.migrator.query({
    text: "UPDATE lcm.messages SET content = $2 WHERE ctid = "
      + "(SELECT ctid FROM lcm.messages WHERE project_id = $1 ORDER BY conversation_id, seq LIMIT 1)",
    values: [fixture.projectId, content],
  }, factoryContext);
}

async function leaseRow(database: PostgreSqlTestDatabase) {
  const result = await database.migrator.query<{ operation: string; owner_machine_id: string; released: boolean; live: boolean }>({
    text: "SELECT operation, owner_machine_id::text AS owner_machine_id, released_at IS NOT NULL AS released, "
      + "expires_at > statement_timestamp() AS live FROM lcm.fenced_leases WHERE project_id = $1",
    values: [fixture.projectId],
  }, factoryContext);
  return result.rows[0];
}

type Run = Readonly<{
  homeDir: string;
  generationId: string;
  canonicalPath: string;
  database: PostgreSqlTestDatabase;
  /** Wraps the opened session, for injecting a change at an exact point of the window. */
  wrap?: (session: Awaited<ReturnType<typeof openRollbackFencedSession>>) => void;
}>;

async function runRollback(run: Run, scenario: Awaited<ReturnType<typeof activationFor>>) {
  const input: RunMigrationRollbackInput = {
    homeDir: run.homeDir, generationId: run.generationId, canonicalPath: run.canonicalPath,
    projectIdentity: { scope: "shared", projectId: fixture.projectId }, localProjectId: "local-1",
    sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
  };
  return runMigrationRollback(input, {
    coordinator: new BackendPublicationCoordinator({ homeDir: run.homeDir, driver: unexpectedDriver() }),
    resolveWitnessBindings: () => scenario.bindings,
    resolveActivationEvidence: () => scenario.evidence,
    resolveAuthoritativeContext: async () => scenario.context,
    openFencedSession: async (request) => {
      const session = await openRollbackFencedSession(request, targetFor(run.database), dependencies);
      run.wrap?.(session);
      return session;
    },
  });
}

async function prepared(database: PostgreSqlTestDatabase, generationId: string) {
  await applyAllRuntimeGrants(database);
  await seedPortablePostgreSql(database.migrator);
  // The fixture's second machine holds a session instruction under the same scope hash as this
  // machine's. The SQLite cache is machine-local and cannot represent both (issue #1518), so this
  // suite rolls back a single-machine instruction set.
  await database.migrator.query({
    text: "DELETE FROM lcm.session_instructions WHERE machine_id = $1",
    values: [fixture.secondaryMachineId],
  }, factoryContext);
  const homeDir = tempHome();
  manifestAtVerified(new MigrationManifestStore({ homeDir }), generationId);
  return { homeDir, canonicalPath: join(homeDir, "live.sqlite"), scenario: await activationFor(database, generationId) };
}

describe("production rollback session against PostgreSQL 18", { timeout: 180_000 }, () => {
  it("holds a real lease for the coordinator's identity, renews and asserts it, refuses once the fence is lost, and releases", async () => {
    await withPostgreSqlTestDatabase("rollback-session-lease", async (database) => {
      await applyAllRuntimeGrants(database);
      await seedPortablePostgreSql(database.migrator);
      const homeDir = tempHome();
      const manifest = manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-lease");
      const session = await openRollbackFencedSession(
        { homeDir, manifest, lockToken: {} as never }, targetFor(database), dependencies,
      );
      const held = await leaseRow(database);
      expect(held).toMatchObject({ released: false, live: true, owner_machine_id: fixture.machineId });
      expect(held!.operation).toMatch(/^backend-publication:sqlite:[0-9a-f]{64}$/u);
      expect(session.selectionAuthority.resourceKey).toBe(fixture.projectId);

      await session.renew();

      // The fence is lost underneath the open window: the next renew refuses, it never re-acquires.
      await database.migrator.query({
        text: "UPDATE lcm.fenced_leases SET released_at = statement_timestamp() WHERE project_id = $1",
        values: [fixture.projectId],
      }, factoryContext);
      await expect(session.renew()).rejects.toBeInstanceOf(RollbackSessionError);
      await session.release();
    });
  });

  it("releases the lease on release(), and a second session for the same rollback may then acquire it", async () => {
    await withPostgreSqlTestDatabase("rollback-session-release", async (database) => {
      await applyAllRuntimeGrants(database);
      await seedPortablePostgreSql(database.migrator);
      const homeDir = tempHome();
      const manifest = manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-release");
      const open = () => openRollbackFencedSession({ homeDir, manifest, lockToken: {} as never }, targetFor(database), dependencies);
      const first = await open();
      // Same rollback, lease still live: acquiring again is the idempotent re-acquire of a crashed attempt.
      const second = await open();
      expect(second.selectionAuthority.fencingToken).toBe(first.selectionAuthority.fencingToken);
      await first.release();
      expect((await leaseRow(database))!.released).toBe(true);
      await second.release();
    });
  });

  it("rolls back pre-write on an unchanged destination: no data moves and the lease is released", async () => {
    await withPostgreSqlTestDatabase("rollback-session-pre-write", async (database) => {
      const { homeDir, canonicalPath, scenario } = await prepared(database, "gen-pre");
      const outcome = await runRollback({ homeDir, generationId: "gen-pre", canonicalPath, database }, scenario);
      expect(outcome.manifest.phase).toBe("rolled-back");
      expect(outcome.manifest.rollbackLineage.mode).toBe("pre-write");
      expect(existsSync(canonicalPath)).toBe(false);
      expect((await leaseRow(database))!.released).toBe(true);
    });
  });

  it("rolls back post-write after a racing post-epoch write, exporting the written data into the installed database", async () => {
    await withPostgreSqlTestDatabase("rollback-session-post-write", async (database) => {
      const { homeDir, canonicalPath, scenario } = await prepared(database, "gen-post");
      await insertConversation(database, "raced-session");
      const outcome = await runRollback({ homeDir, generationId: "gen-post", canonicalPath, database }, scenario);
      expect(outcome.manifest.rollbackLineage.mode).toBe("post-write");
      const installed = new DatabaseSync(canonicalPath, { readOnly: true });
      try {
        const row = installed.prepare("SELECT count(*) AS n FROM conversations WHERE session_id = ?").get("raced-session") as { n: number };
        expect(row.n).toBe(1);
      } finally {
        installed.close();
      }
      expect((await leaseRow(database))!.released).toBe(true);
    });
  });

  it("classifies an in-place post-epoch change as post-write although the delta is unchanged, because the census sees it", async () => {
    await withPostgreSqlTestDatabase("rollback-session-in-place", async (database) => {
      const { homeDir, canonicalPath, scenario } = await prepared(database, "gen-inplace");
      await editFirstMessage(database, "Edited after activation");
      const outcome = await runRollback({ homeDir, generationId: "gen-inplace", canonicalPath, database }, scenario);
      expect(outcome.manifest.rollbackLineage.mode).toBe("post-write");
    });
  });

  it("refuses when the fence is lost mid-window, installing and selecting nothing", async () => {
    await withPostgreSqlTestDatabase("rollback-session-fence-loss", async (database) => {
      const { homeDir, canonicalPath, scenario } = await prepared(database, "gen-fence");
      await insertConversation(database, "raced-session");
      await expect(runRollback({
        homeDir, generationId: "gen-fence", canonicalPath, database,
        wrap: (session) => {
          const renew = session.renew.bind(session);
          session.renew = async () => {
            await database.migrator.query({
              text: "UPDATE lcm.fenced_leases SET released_at = statement_timestamp() WHERE project_id = $1",
              values: [fixture.projectId],
            }, factoryContext);
            await renew();
          };
        },
      }, scenario)).rejects.toMatchObject({ name: "RollbackSessionError", reason: "lease-lost" });
      expect(existsSync(canonicalPath)).toBe(false);
      expect(readBackendMaintenanceJournal(homeDir)?.phase).toBe("maintenance-held");
    });
  });

  it("A6: refuses an unfenced change between build and revalidation that leaves the mode at post-write, installing and selecting nothing", async () => {
    await withPostgreSqlTestDatabase("rollback-session-a6", async (database) => {
      const { homeDir, canonicalPath, scenario } = await prepared(database, "gen-a6");
      await insertConversation(database, "raced-session");
      await expect(runRollback({
        homeDir, generationId: "gen-a6", canonicalPath, database,
        wrap: (session) => {
          const renew = session.renew.bind(session);
          // renew() is the first thing step 10 does, after the export snapshot was built from.
          session.renew = async () => {
            await editFirstMessage(database, "Changed after the export snapshot");
            await renew();
          };
        },
      }, scenario)).rejects.toMatchObject({ reason: "not-eligible", message: expect.stringContaining("census differs") });
      expect(existsSync(canonicalPath)).toBe(false);
      expect(readBackendMaintenanceJournal(homeDir)?.phase).toBe("maintenance-held");
    });
  });
});


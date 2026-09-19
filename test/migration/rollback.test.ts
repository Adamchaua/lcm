/**
 * Tests for src/migration/rollback.ts's runMigrationRollback orchestration
 * (plan-v2 section 5's twelve steps).
 *
 * SCOPE, stated honestly. This file exercises the orchestration logic --
 * recovery classification, maintenance entry/exit, the prepare-rollback
 * and publish-rollback effect lifecycle, report persistence, and binding
 * writes -- against a REAL BackendPublicationCoordinator and a REAL
 * MigrationManifestStore, using injected FAKES only for the boundaries
 * runMigrationRollback itself takes as required dependencies (Boundaries
 * A, B, D, D2, E, F). It does not exercise a live PostgreSQL fenced
 * session (Boundary F's real implementation does not exist on this
 * branch -- see rollback.ts's module doc); RollbackFencedSession is
 * faked here to a SQLite-backed PortableRecordStream, exactly the same
 * discipline rollback-generation.test.ts already uses for
 * buildRollbackGeneration.
 *
 * This is NOT the full plan-v2 section 7 mandatory test list. In
 * particular it does not include a PG18-sourced drift test (no real
 * PostgreSQL harness is exercised here at all) or the full red-proof
 * mutation matrix that list requires; see this item's status report for
 * the explicit list of what remains.
 */

import { mkdirSync, mkdtempSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { runLcmMigrations } from "../../src/db/migration.js";
import {
  openSqlitePortableSource,
  sqlitePortableFileSha256,
} from "../../src/storage/sqlite/portable-source.js";
import { createPortableRecordStream, type PortableRecordStream } from "../../src/storage/portable-record-stream.js";
import { canonicalSha256, PORTABLE_RECORD_SCHEMA_SHA256 } from "../../src/storage/portable-record.js";
import {
  BackendPublicationCoordinator,
  readBackendMaintenanceJournal,
  type BackendPublicationDriver,
} from "../../src/storage/backend-publication.js";
import { MigrationManifestStore } from "../../src/migration/manifest-store.js";
import {
  createMigrationManifest,
  beginMigrationEffect,
  completeMigrationEffect,
  type MigrationManifest,
  type MigrationStorageWitness,
} from "../../src/migration/protocol.js";
import {
  runMigrationRollback,
  readRollbackReport,
  RollbackOrchestrationError,
  type RunMigrationRollbackDependencies,
  type RollbackFencedSession,
  type MigrationSelectionBindingRecorder,
  type MigrationWitnessBindingRecorder,
} from "../../src/migration/rollback.js";
import {
  fixtureCanonicalDelta,
  fixtureCensusVector,
  fixtureDestinationIdentity,
  fixtureSchemaWitness,
  fixtureResolvedWithActivationSelection,
  fixtureAuthoritativelyAbsent,
  fixtureUnresolvable,
  fixtureOperabilityAbsent,
  referenceClassifyRollbackMode,
} from "../fixtures/rollback-eligibility-witness-schema.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "lcm-rollback-orch-home-"));
  mkdirSync(join(dir, ".lcm"), { mode: 0o700 });
  dirs.push(dir);
  return dir;
}

const identity = { scope: "local" as const, projectId: "a".repeat(64) };
const facts = { machines: [{ identityKey: "local-machine", machineId: null }], aliases: [] };
const capturedAt = "2026-09-06T00:00:00.000Z";
const sourceCapturedAt = "2026-09-06T00:00:00.000000Z";

function sqliteFixture(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "lcm-rollback-orch-src-"));
  dirs.push(dir);
  const path = join(dir, "source.db");
  const db = new DatabaseSync(path);
  try { runLcmMigrations(db, { fts5Available: false }); } finally { db.close(); }
  chmodSync(path, 0o600);
  return { dir, path };
}

async function sqliteSourceStream(): Promise<PortableRecordStream> {
  const file = sqliteFixture();
  return createPortableRecordStream(await openSqlitePortableSource({
    databasePath: file.path,
    scratchParent: file.dir,
    projectIdentity: identity,
    identityFacts: facts,
    expectedFileSha256: sqlitePortableFileSha256(file.path),
    expectedFactsSha256: canonicalSha256(facts),
    capturedAt: sourceCapturedAt,
    capturedSidecars: {
      events: { absent: true, evidenceSha256: "f".repeat(64) },
      instructions: { absent: true, evidenceSha256: "e".repeat(64) },
    },
  }));
}

function unexpectedDriver(): BackendPublicationDriver {
  const unexpected = async (): Promise<never> => {
    throw new Error("driver must not run: this orchestration never calls project-map/config publication");
  };
  return {
    observeLocalState: unexpected,
    publishProjectMap: unexpected,
    publishConfig: unexpected,
    restoreConfig: unexpected,
    restoreProjectMap: unexpected,
  };
}

function coordinatorFor(homeDir: string): BackendPublicationCoordinator {
  return new BackendPublicationCoordinator({ homeDir, driver: unexpectedDriver() });
}

function storageWitness(backend: "sqlite" | "postgresql", seed: string): MigrationStorageWitness {
  return {
    version: 1,
    backend,
    identitySha256: seed.repeat(64).slice(0, 64),
    schemaSha256: "2".repeat(64),
    contentSha256: "3".repeat(64),
    capturedAt,
  };
}

/** Drives a fresh manifest all the way to phase "verified" via the ordinary forward-migration effect sequence, matching protocol.ts's legalEffect chain. */
function manifestAtVerified(store: MigrationManifestStore, generationId: string): MigrationManifest {
  let m = store.create(createMigrationManifest({
    generationId,
    source: storageWitness("sqlite", "1"),
    destination: storageWitness("postgresql", "4"),
    parentGenerationId: null,
    preservedSourceGenerationId: generationId,
    createdAt: capturedAt,
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

function fakeSession(input: Readonly<{
  resourceType?: string;
  resourceKey?: string;
  observations: readonly Readonly<{
    manifestDestinationWitnessSha256: string;
    destinationIdentity: ReturnType<typeof fixtureDestinationIdentity>;
    postEpochDelta: ReturnType<typeof fixtureCanonicalDelta>;
    postEpochCensus: ReturnType<typeof fixtureCensusVector> | null;
  }>[];
  source: () => Promise<PortableRecordStream>;
}>): RollbackFencedSession {
  let call = 0;
  return {
    selectionAuthority: {
      version: 1,
      resourceType: input.resourceType ?? "sqlite-generation",
      resourceKey: input.resourceKey ?? "gen",
      fencingToken: "fence-1",
      ownerProcessId: "proc-1",
    },
    quiescenceFenceEvidenceSha256: "q".repeat(64),
    async renew(): Promise<void> {},
    async captureReadback() {
      const observed = input.observations[Math.min(call, input.observations.length - 1)]!;
      call += 1;
      return {
        observedPortableRecordSchemaSha256: observed.postEpochCensus === null ? "irrelevant" : PORTABLE_RECORD_SCHEMA_SHA256,
        destinationIdentity: observed.destinationIdentity,
        postEpochDelta: observed.postEpochDelta,
        postEpochCensus: observed.postEpochCensus,
        manifestDestinationWitnessSha256: observed.manifestDestinationWitnessSha256,
      };
    },
    openPortableSource: input.source,
    async release(): Promise<void> {},
    computeRollbackTerminalEvidenceSha256(evidence): string {
      return canonicalSha256(["test-terminal-evidence-v1", evidence]);
    },
  };
}

const MACHINE_ID = "018f0b5d-1234-4abc-8def-1234567890ab";
const ROSTER = [{ machineId: MACHINE_ID, queueCutoff: null, evidenceSha256: "7".repeat(64) }];

describe("runMigrationRollback", () => {
  it("refuses immediately when the generation is already settled at a terminal, non-active phase", async () => {
    const homeDir = tempHome();
    const store = new MigrationManifestStore({ homeDir });
    let m = manifestAtVerified(store, "gen-settled");
    m = store.update("gen-settled", m.checksumSha256, (c) => beginMigrationEffect(c, {
      kind: "prepare-rollback", effectId: "pr", inputSha256: "a".repeat(64), startedAt: capturedAt,
    }));
    m = store.update("gen-settled", m.checksumSha256, (c) => completeMigrationEffect(c, { effectId: "pr", completedAt: capturedAt }));
    m = store.update("gen-settled", m.checksumSha256, (c) => beginMigrationEffect(c, {
      kind: "publish-rollback", effectId: "pub", inputSha256: "a".repeat(64), startedAt: capturedAt,
    }));
    m = store.update("gen-settled", m.checksumSha256, (c) => completeMigrationEffect(c, {
      effectId: "pub", completedAt: capturedAt,
      report: { kind: "rollback", reportId: "r3", reportSha256: "b".repeat(64), createdAt: capturedAt },
      rollbackMode: "pre-write",
    }));
    expect(m.phase).toBe("rolled-back");

    await expect(runMigrationRollback({

      homeDir, generationId: "gen-settled", canonicalPath: join(homeDir, "live.sqlite"),
      projectIdentity: identity, localProjectId: "local-1",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    }, {
      coordinator: coordinatorFor(homeDir),
      resolveWitnessBindings: () => fixtureAuthoritativelyAbsent,
      classifyRollbackMode: referenceClassifyRollbackMode,
      recordSelectionBinding: () => undefined,
      recordWitnessBinding: () => undefined,
      resolveAuthoritativeContext: async () => null,
      openFencedSession: async () => { throw new Error("must not open a session for a settled generation"); },
    })).rejects.toMatchObject({ name: "RollbackOrchestrationError", reason: "unexpected-state" });
  });

  it("refuses before any durable change when witness-binding resolution is unresolvable, entering no maintenance", async () => {
    const homeDir = tempHome();
    const store = new MigrationManifestStore({ homeDir });
    manifestAtVerified(store, "gen-refuse");

    await expect(runMigrationRollback({
      homeDir, generationId: "gen-refuse", canonicalPath: join(homeDir, "live.sqlite"),
      projectIdentity: identity, localProjectId: "local-1",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    }, {
      coordinator: coordinatorFor(homeDir),
      resolveWitnessBindings: () => fixtureUnresolvable("simulated read failure"),
      classifyRollbackMode: referenceClassifyRollbackMode,
      recordSelectionBinding: () => undefined,
      recordWitnessBinding: () => undefined,
      resolveAuthoritativeContext: async () => null,
      openFencedSession: async () => { throw new Error("must not open a session when authority is refused"); },
    })).rejects.toMatchObject({
      name: "RollbackOrchestrationError",
      reason: "not-eligible",
    });

    // Breakable independently: the positive control below (fixtureAuthoritativelyAbsent
    // instead of fixtureUnresolvable, same everything else) reaches maintenance and a
    // different failure point, proving this assertion is not vacuously true.
    expect(readBackendMaintenanceJournal(homeDir)).toBeNull();
  });

  it("does not refuse on the identical setup when witness resolution instead reports authoritative absence (positive control)", async () => {
    const homeDir = tempHome();
    const store = new MigrationManifestStore({ homeDir });
    manifestAtVerified(store, "gen-control");

    const outcome = await runMigrationRollback({
      homeDir, generationId: "gen-control", canonicalPath: join(homeDir, "live.sqlite"),
      projectIdentity: identity, localProjectId: "local-1",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    }, {
      coordinator: coordinatorFor(homeDir),
      resolveWitnessBindings: () => fixtureAuthoritativelyAbsent,
      classifyRollbackMode: referenceClassifyRollbackMode,
      recordSelectionBinding: () => undefined,
      recordWitnessBinding: () => undefined,
      resolveAuthoritativeContext: async () => null,
      openFencedSession: async () => {
        const destinationIdentity = fixtureDestinationIdentity("d");
        return fakeSession({
          observations: [{
            manifestDestinationWitnessSha256: destinationIdentity.sealedWitnessSha256,
            destinationIdentity,
            postEpochDelta: fixtureCanonicalDelta("delta"),
            postEpochCensus: null,
          }],
          source: sqliteSourceStream,
        });
      },
    }).catch((error: unknown) => error);
    // "unactivated" always yields mode "pre-write", which this item does
    // not implement (step 9's data-movement-none path) -- so this
    // positive control reaches a DIFFERENT, later failure than the
    // unresolvable case above, proving the two setups are not
    // indistinguishable to the code under test.
    expect(outcome).toMatchObject({ name: "RollbackOrchestrationError", reason: "not-implemented" });
    const manifest = new MigrationManifestStore({ homeDir }).read("gen-control");
    expect(manifest.phase).toBe("rolling-back");
  });

  it("post-write: builds, installs, materializes, publishes, and reports, ending at phase rolled-back", async () => {
    const homeDir = tempHome();
    const store = new MigrationManifestStore({ homeDir });
    manifestAtVerified(store, "gen-post");
    const canonicalPath = join(homeDir, "live.sqlite");
    const selectionBindings: unknown[] = [];
    const witnessBindings: unknown[] = [];
    const destinationIdentity = fixtureDestinationIdentity("d");
    const baseline = fixtureCanonicalDelta("baseline");

    const outcome = await runMigrationRollback({
      homeDir, generationId: "gen-post", canonicalPath,
      projectIdentity: identity, localProjectId: "local-post",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    }, {
      coordinator: coordinatorFor(homeDir),
      resolveWitnessBindings: () => fixtureResolvedWithActivationSelection({
        epochId: "epoch-1", attemptId: "attempt-1", manifestRevision: 1,
        witnessChecksumSha256: "w".repeat(64), publicationId: "pub-1",
      }),
      classifyRollbackMode: referenceClassifyRollbackMode,
      recordSelectionBinding: (input) => { selectionBindings.push(input.binding); },
      recordWitnessBinding: (input) => { witnessBindings.push(input.binding); },
      resolveAuthoritativeContext: async () => ({
        epoch: { destinationIdentity, censusVector: fixtureCensusVector("census"), schemaWitness: fixtureSchemaWitness("schema") },
        attempt: { canonicalDeltaBaseline: baseline },
      }),
      openFencedSession: async () => fakeSession({
        observations: [{
          manifestDestinationWitnessSha256: storageWitness("postgresql", "4").identitySha256,
          destinationIdentity,
          // Deliberately different from the baseline -- referenceClassifyRollbackMode
          // returns "post-write" as soon as the deltas differ, on the delta axis
          // alone, independent of the census.
          postEpochDelta: fixtureCanonicalDelta("changed"),
          postEpochCensus: null,
        }],
        source: sqliteSourceStream,
      }),
    });

    expect(outcome.manifest.phase).toBe("rolled-back");
    expect(outcome.manifest.rollbackLineage.mode).toBe("post-write");
    expect(outcome.report).not.toBeNull();
    expect(outcome.report!.mode).toBe("post-write");
    expect(outcome.report!.eligibility).toBe("post-write");

    // Breakable independently: the report on disk is a fresh read, not
    // the in-memory return value.
    const reread = readRollbackReport(homeDir, "gen-post", outcome.report!.reportId);
    expect(reread).not.toBeNull();
    expect(reread!.checksumSha256).toBe(outcome.report!.checksumSha256);

    expect(selectionBindings).toHaveLength(1);
    expect(witnessBindings).toHaveLength(1);
    expect((selectionBindings[0] as { kind: string }).kind).toBe("rollback");
    expect((witnessBindings[0] as { kind: string }).kind).toBe("rollback");

    const maintenance = readBackendMaintenanceJournal(homeDir);
    expect(maintenance?.phase).toBe("selection-completed");
    expect(maintenance?.targetBackend).toBe("sqlite");

    const installed = new DatabaseSync(canonicalPath, { readOnly: true });
    try {
      const row = installed.prepare(
        "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name LIKE 'portable_archive_%'",
      ).get() as { n: number };
      expect(row.n).toBeGreaterThan(0);
    } finally {
      installed.close();
    }
  });

  it("aborts maintenance cleanly when eligibility refuses after maintenance is already entered", async () => {
    const homeDir = tempHome();
    const store = new MigrationManifestStore({ homeDir });
    manifestAtVerified(store, "gen-refuse-late");
    const destinationIdentity = fixtureDestinationIdentity("d");

    await expect(runMigrationRollback({
      homeDir, generationId: "gen-refuse-late", canonicalPath: join(homeDir, "live.sqlite"),
      projectIdentity: identity, localProjectId: "local-1",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    }, {
      coordinator: coordinatorFor(homeDir),
      resolveWitnessBindings: () => fixtureResolvedWithActivationSelection({
        epochId: "epoch-1", attemptId: "attempt-1", manifestRevision: 1,
        witnessChecksumSha256: "w".repeat(64), publicationId: "pub-1",
      }),
      classifyRollbackMode: referenceClassifyRollbackMode,
      recordSelectionBinding: () => undefined,
      recordWitnessBinding: () => undefined,
      resolveAuthoritativeContext: async () => ({
        // A destination identity that will NOT match the observation
        // below -- the identity gate refuses before any durable change
        // other than the maintenance entry itself.
        epoch: { destinationIdentity: fixtureDestinationIdentity("different"), censusVector: fixtureCensusVector("c"), schemaWitness: fixtureSchemaWitness("s") },
        attempt: { canonicalDeltaBaseline: fixtureCanonicalDelta("baseline") },
      }),
      openFencedSession: async () => fakeSession({
        observations: [{
          manifestDestinationWitnessSha256: storageWitness("postgresql", "4").identitySha256,
          destinationIdentity,
          postEpochDelta: fixtureCanonicalDelta("changed"),
          postEpochCensus: null,
        }],
        source: sqliteSourceStream,
      }),
    })).rejects.toMatchObject({ name: "RollbackOrchestrationError", reason: "not-eligible" });

    const maintenance = readBackendMaintenanceJournal(homeDir);
    expect(maintenance?.phase).toBe("maintenance-aborted");
  });
});


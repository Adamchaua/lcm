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

import { existsSync, mkdirSync, mkdtempSync, chmodSync, rmSync } from "node:fs";
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
  deriveRollbackPublicationId,
  deriveRollbackPrepareInputSha256,
  writeRollbackAuthorityArtifact,
  readRollbackAuthorityArtifact,
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

  it("does not refuse on the identical setup when witness resolution instead reports authoritative absence (positive control), and completes as an unactivated selection reversal", async () => {
    const homeDir = tempHome();
    const store = new MigrationManifestStore({ homeDir });
    manifestAtVerified(store, "gen-control");
    const canonicalPath = join(homeDir, "live.sqlite");
    const selectionBindings: unknown[] = [];
    const witnessBindings: unknown[] = [];

    const outcome = await runMigrationRollback({
      homeDir, generationId: "gen-control", canonicalPath,
      projectIdentity: identity, localProjectId: "local-1",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    }, {
      coordinator: coordinatorFor(homeDir),
      resolveWitnessBindings: () => fixtureAuthoritativelyAbsent,
      classifyRollbackMode: referenceClassifyRollbackMode,
      recordSelectionBinding: (input) => { selectionBindings.push(input.binding); },
      recordWitnessBinding: (input) => { witnessBindings.push(input.binding); },
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
    });
    // "unactivated" always yields mode "pre-write" (plan-v2 section 1: no
    // epoch ever existed, so there is nothing to compare beyond the
    // manifest's own sealed destination witness) -- so this positive
    // control reaches a DIFFERENT, later outcome (success) than the
    // unresolvable case above (refusal before maintenance), proving the
    // two setups are not indistinguishable to the code under test.
    expect(outcome.manifest.phase).toBe("rolled-back");
    expect(outcome.manifest.rollbackLineage.mode).toBe("pre-write");
    expect(outcome.report).not.toBeNull();
    expect(outcome.report!.mode).toBe("pre-write");
    expect(outcome.report!.eligibility).toBe("unactivated");

    // No selection was ever published, so there is no activation
    // epoch/attempt to name: neither a witness nor a selection binding
    // is written for "unactivated" (see rollback.ts's OPEN QUESTION
    // comment on this exact point).
    expect(selectionBindings).toHaveLength(0);
    expect(witnessBindings).toHaveLength(0);

    // Selection reversal, not reinstallation: the maintenance selection
    // flips to sqlite, but nothing is installed at canonicalPath -- this
    // rollback never touches the live database.
    const maintenance = readBackendMaintenanceJournal(homeDir);
    expect(maintenance?.phase).toBe("selection-completed");
    expect(maintenance?.targetBackend).toBe("sqlite");
    expect(existsSync(canonicalPath)).toBe(false);
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

  it("refuses as a racing post-activation write when step 10's revalidation observes a mode change from step 9's, leaving the generation preserved and unreferenced", async () => {
    // A pre-write decision at step 9 (delta matches baseline, census
    // matches) followed by a DIFFERENT observation at step 10 (delta now
    // drifted, simulating a write that landed inside the fenced window
    // between the two readbacks). Breakable independently: the positive
    // control below (identical setup, but the second observation equals
    // the first) completes successfully instead of refusing, proving this
    // refusal comes from the mismatch and not from the fixture shape.
    const homeDir = tempHome();
    const store = new MigrationManifestStore({ homeDir });
    manifestAtVerified(store, "gen-race");
    const destinationIdentity = fixtureDestinationIdentity("d");
    const baseline = fixtureCanonicalDelta("race-baseline");
    const census = fixtureCensusVector("race-census");

    await expect(runMigrationRollback({
      homeDir, generationId: "gen-race", canonicalPath: join(homeDir, "live.sqlite"),
      projectIdentity: identity, localProjectId: "local-1",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    }, {
      coordinator: coordinatorFor(homeDir),
      resolveWitnessBindings: () => fixtureResolvedWithActivationSelection({
        epochId: "epoch-race", attemptId: "attempt-race", manifestRevision: 1,
        witnessChecksumSha256: "w".repeat(64), publicationId: "pub-race",
      }),
      classifyRollbackMode: referenceClassifyRollbackMode,
      recordSelectionBinding: () => undefined,
      recordWitnessBinding: () => undefined,
      resolveAuthoritativeContext: async () => ({
        epoch: { destinationIdentity, censusVector: census, schemaWitness: fixtureSchemaWitness("s") },
        attempt: { canonicalDeltaBaseline: baseline },
      }),
      openFencedSession: async () => fakeSession({
        observations: [
          {
            manifestDestinationWitnessSha256: storageWitness("postgresql", "4").identitySha256,
            destinationIdentity, postEpochDelta: baseline, postEpochCensus: census,
          },
          {
            manifestDestinationWitnessSha256: storageWitness("postgresql", "4").identitySha256,
            destinationIdentity, postEpochDelta: fixtureCanonicalDelta("race-write-landed"), postEpochCensus: null,
          },
        ],
        source: sqliteSourceStream,
      }),
    })).rejects.toMatchObject({
      name: "RollbackOrchestrationError",
      reason: "not-eligible",
      message: expect.stringContaining("revalidation observed mode"),
    });

    const manifest = new MigrationManifestStore({ homeDir }).read("gen-race");
    expect(manifest.phase).toBe("rolling-back");
    expect(manifest.pendingEffect).toBeNull();
  });

  it("positive control for the race test above: an unchanged second observation completes as pre-write instead of refusing", async () => {
    const homeDir = tempHome();
    const store = new MigrationManifestStore({ homeDir });
    manifestAtVerified(store, "gen-race-control");
    const destinationIdentity = fixtureDestinationIdentity("d");
    const baseline = fixtureCanonicalDelta("race-control-baseline");
    const census = fixtureCensusVector("race-control-census");
    const observation = {
      manifestDestinationWitnessSha256: storageWitness("postgresql", "4").identitySha256,
      destinationIdentity, postEpochDelta: baseline, postEpochCensus: census,
    };

    const outcome = await runMigrationRollback({
      homeDir, generationId: "gen-race-control", canonicalPath: join(homeDir, "live.sqlite"),
      projectIdentity: identity, localProjectId: "local-1",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    }, {
      coordinator: coordinatorFor(homeDir),
      resolveWitnessBindings: () => fixtureResolvedWithActivationSelection({
        epochId: "epoch-race-control", attemptId: "attempt-race-control", manifestRevision: 1,
        witnessChecksumSha256: "w".repeat(64), publicationId: "pub-race-control",
      }),
      classifyRollbackMode: referenceClassifyRollbackMode,
      recordSelectionBinding: () => undefined,
      recordWitnessBinding: () => undefined,
      resolveAuthoritativeContext: async () => ({
        epoch: { destinationIdentity, censusVector: census, schemaWitness: fixtureSchemaWitness("s") },
        attempt: { canonicalDeltaBaseline: baseline },
      }),
      openFencedSession: async () => fakeSession({ observations: [observation, observation], source: sqliteSourceStream }),
    });
    expect(outcome.manifest.phase).toBe("rolled-back");
    expect(outcome.manifest.rollbackLineage.mode).toBe("pre-write");
  });

  it("takeover-and-retry: resolves the epoch/attempt via the BOUND attempt only, never the unbound one, even though both are present as witnesses", async () => {
    const homeDir = tempHome();
    const store = new MigrationManifestStore({ homeDir });
    manifestAtVerified(store, "gen-takeover");
    const destinationIdentity = fixtureDestinationIdentity("d");
    const baselineBound = fixtureCanonicalDelta("bound-baseline");
    const censusBound = fixtureCensusVector("bound-census");
    const baselineUnboundWrong = fixtureCanonicalDelta("unbound-wrong-baseline");
    const selectionBindings: unknown[] = [];
    const witnessBindings: unknown[] = [];
    const resolveAuthoritativeContextCalls: string[] = [];

    // Two attempts share one generation after a takeover: "attempt-old"
    // was superseded and never selected (a witness only); "attempt-new"
    // is the one an actual selection was published against. Both are
    // returned as witnesses -- only "attempt-new" is a selection.
    const resolution = {
      state: "resolved" as const,
      witnesses: [
        { kind: "activation" as const, epochId: "epoch-takeover", attemptId: "attempt-old", manifestRevision: 1, witnessChecksumSha256: "a".repeat(64) },
        { kind: "activation" as const, epochId: "epoch-takeover", attemptId: "attempt-new", manifestRevision: 2, witnessChecksumSha256: "b".repeat(64) },
      ],
      selections: [
        { kind: "activation" as const, epochId: "epoch-takeover", attemptId: "attempt-new", manifestRevision: 2, witnessChecksumSha256: "b".repeat(64), publicationId: "pub-new" },
      ],
    };

    const outcome = await runMigrationRollback({
      homeDir, generationId: "gen-takeover", canonicalPath: join(homeDir, "live.sqlite"),
      projectIdentity: identity, localProjectId: "local-1",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    }, {
      coordinator: coordinatorFor(homeDir),
      resolveWitnessBindings: () => resolution,
      classifyRollbackMode: referenceClassifyRollbackMode,
      recordSelectionBinding: (input) => { selectionBindings.push(input.binding); },
      recordWitnessBinding: (input) => { witnessBindings.push(input.binding); },
      resolveAuthoritativeContext: async (input) => {
        resolveAuthoritativeContextCalls.push(input.attemptId);
        if (input.attemptId !== "attempt-new") {
          // If this were ever reached with the unbound attempt, a
          // mismatching baseline makes the wrong-attempt path diverge
          // (post-write here vs. pre-write below) rather than silently
          // agreeing with the correct path's outcome.
          return {
            epoch: { destinationIdentity, censusVector: fixtureCensusVector("unbound-wrong-census"), schemaWitness: fixtureSchemaWitness("s") },
            attempt: { canonicalDeltaBaseline: baselineUnboundWrong },
          };
        }
        return {
          epoch: { destinationIdentity, censusVector: censusBound, schemaWitness: fixtureSchemaWitness("s") },
          attempt: { canonicalDeltaBaseline: baselineBound },
        };
      },
      openFencedSession: async () => fakeSession({
        observations: [{
          manifestDestinationWitnessSha256: storageWitness("postgresql", "4").identitySha256,
          destinationIdentity, postEpochDelta: baselineBound, postEpochCensus: censusBound,
        }],
        source: sqliteSourceStream,
      }),
    });

    expect(resolveAuthoritativeContextCalls).toEqual(["attempt-new"]);
    expect(outcome.manifest.phase).toBe("rolled-back");
    expect(outcome.manifest.rollbackLineage.mode).toBe("pre-write");
    expect(selectionBindings).toHaveLength(1);
    expect(witnessBindings).toHaveLength(1);
    expect((selectionBindings[0] as { attemptId: string }).attemptId).toBe("attempt-new");
    expect((witnessBindings[0] as { attemptId: string }).attemptId).toBe("attempt-new");
   expect(existsSync(join(homeDir, "live.sqlite"))).toBe(false);
 });

  // donadiosolutions/lcm#1432. Three separate crash-and-resume tests,
  // one per named boundary plan-v2 section 7 requires interruption
  // recovery for: (1) maintenance entered but prepare-rollback never
  // begun, (2) prepare-rollback begun but not completed, (3) prepare-
  // rollback completed (continueAfterPrepareRollback's own domain --
  // this is the crash the withdrawn predecessor test targeted). All
  // three previously failed because readBackendPublicationOperabilityFact
  // observes the still-held maintenance journal on any retry and
  // answers "unresolvable", which resolveActivationAuthority turns into
  // a permanent refusal; (1) and (2) additionally failed because
  // enterMaintenance itself refuses to re-enter an already-held
  // journal. Each test reconstructs its crash point precisely (manual
  // state construction for (1)/(2), a REAL crash via a throwing fake
  // session for (3)) against a REAL BackendPublicationCoordinator and
  // MigrationManifestStore, then retries and asserts success.

  it("resumes after a crash between step 2 and step 7: maintenance is held, no prepare-rollback effect was ever begun (donadiosolutions/lcm#1432)", async () => {
    const homeDir = tempHome();
    const store = new MigrationManifestStore({ homeDir });
    manifestAtVerified(store, "gen-resume-2-7");
    const canonicalPath = join(homeDir, "live.sqlite");
    const coordinator = coordinatorFor(homeDir);

    // Simulates the crash: step 2 (enterMaintenance) durably succeeded
    // and the durable rollback-authority artifact was persisted (both
    // steps runMigrationRollback performs before entering the retained
    // token window), then the process died before step 3 ever opened a
    // session -- so the manifest is untouched, still phase "verified"
    // with no pending effect, exactly like a manifest that was NEVER
    // attempted. classifyMigrationRecovery cannot tell these apart; only
    // the durable maintenance journal and artifact can.
    const publicationId = deriveRollbackPublicationId("gen-resume-2-7");
    await coordinator.enterMaintenance({
      publicationId, generationId: "gen-resume-2-7",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
      now: new Date(capturedAt),
    });
    writeRollbackAuthorityArtifact(homeDir, {
      version: 1,
      generationId: "gen-resume-2-7",
      operabilityFactState: "authoritatively-absent",
      operabilityFactValueSha256: null,
      authorityStatus: "unactivated",
      epochId: null,
      attemptId: null,
    });
    expect(readBackendMaintenanceJournal(homeDir)?.phase).toBe("maintenance-held");

    const destinationIdentity = fixtureDestinationIdentity("d");
    const outcome = await runMigrationRollback({
      homeDir, generationId: "gen-resume-2-7", canonicalPath,
      projectIdentity: identity, localProjectId: "local-1",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    }, {
      coordinator,
      resolveWitnessBindings: () => fixtureAuthoritativelyAbsent,
      classifyRollbackMode: referenceClassifyRollbackMode,
      recordSelectionBinding: () => undefined,
      recordWitnessBinding: () => undefined,
      resolveAuthoritativeContext: async () => null,
      openFencedSession: async () => fakeSession({
        observations: [{
          manifestDestinationWitnessSha256: destinationIdentity.sealedWitnessSha256,
          destinationIdentity,
          postEpochDelta: fixtureCanonicalDelta("delta"),
          postEpochCensus: null,
        }],
        source: sqliteSourceStream,
      }),
    });

    expect(outcome.manifest.phase).toBe("rolled-back");
    expect(outcome.manifest.rollbackLineage.mode).toBe("pre-write");
    expect(outcome.report).not.toBeNull();
    expect(outcome.report!.eligibility).toBe("unactivated");
    expect(readBackendMaintenanceJournal(homeDir)?.phase).toBe("selection-completed");
  });

  it("resumes after a crash between step 7's begin and step 8's complete: prepare-rollback is pending (donadiosolutions/lcm#1432)", async () => {
    const homeDir = tempHome();
    const store = new MigrationManifestStore({ homeDir });
    const verified = manifestAtVerified(store, "gen-resume-7-8");
    const canonicalPath = join(homeDir, "live.sqlite");
    const coordinator = coordinatorFor(homeDir);

    const publicationId = deriveRollbackPublicationId("gen-resume-7-8");
    await coordinator.enterMaintenance({
      publicationId, generationId: "gen-resume-7-8",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
      now: new Date(capturedAt),
    });
    writeRollbackAuthorityArtifact(homeDir, {
      version: 1,
      generationId: "gen-resume-7-8",
      operabilityFactState: "authoritatively-absent",
      operabilityFactValueSha256: null,
      authorityStatus: "unactivated",
      epochId: null,
      attemptId: null,
    });
    // Simulates the crash: step 7's begin durably succeeded (the SAME
    // deterministic prepareInputSha256 runMigrationRollback itself would
    // compute for this manifest state and fakeSession's default
    // resourceType/resourceKey), then the process died before step 8's
    // complete. classifyMigrationRecovery reads this as "resume" (a
    // pending, retry-idempotent prepare-rollback).
    const prepareInputSha256 = deriveRollbackPrepareInputSha256({
      generationId: "gen-resume-7-8", manifestRevision: verified.revision, manifestChecksumSha256: verified.checksumSha256,
      epochId: null, resourceType: "sqlite-generation", resourceKey: "gen",
    });
    const prepareEffectId = "rollback-prepare-" + prepareInputSha256;
    const withPending = store.update("gen-resume-7-8", verified.checksumSha256, (c) => beginMigrationEffect(c, {
      kind: "prepare-rollback", effectId: prepareEffectId, inputSha256: prepareInputSha256, startedAt: capturedAt,
    }));
    expect(withPending.pendingEffect?.kind).toBe("prepare-rollback");
    expect(withPending.phase).toBe("verified");

    const destinationIdentity = fixtureDestinationIdentity("d");
    const outcome = await runMigrationRollback({
      homeDir, generationId: "gen-resume-7-8", canonicalPath,
      projectIdentity: identity, localProjectId: "local-1",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    }, {
      coordinator,
      resolveWitnessBindings: () => fixtureAuthoritativelyAbsent,
      classifyRollbackMode: referenceClassifyRollbackMode,
      recordSelectionBinding: () => undefined,
      recordWitnessBinding: () => undefined,
      resolveAuthoritativeContext: async () => null,
      openFencedSession: async () => fakeSession({
        observations: [{
          manifestDestinationWitnessSha256: destinationIdentity.sealedWitnessSha256,
          destinationIdentity,
          postEpochDelta: fixtureCanonicalDelta("delta"),
          postEpochCensus: null,
        }],
        source: sqliteSourceStream,
      }),
    });

    expect(outcome.manifest.phase).toBe("rolled-back");
    expect(outcome.manifest.rollbackLineage.mode).toBe("pre-write");
  });

  it("resumes after a crash between step 8 and step 9 via continueAfterPrepareRollback (donadiosolutions/lcm#1432, the predecessor's withdrawn test)", async () => {
    const homeDir = tempHome();
    const store = new MigrationManifestStore({ homeDir });
    manifestAtVerified(store, "gen-resume-8-9");
    const canonicalPath = join(homeDir, "live.sqlite");
    const destinationIdentity = fixtureDestinationIdentity("d");
    const coordinator = coordinatorFor(homeDir);

    // The FIRST call runs for real through step 8 (prepare-rollback
    // durably completes) and then crashes for real at step 10's renew(),
    // inside runPostPrepareSequence -- no manual state reconstruction.
    const crashingSession = fakeSession({
      observations: [{
        manifestDestinationWitnessSha256: destinationIdentity.sealedWitnessSha256,
        destinationIdentity,
        postEpochDelta: fixtureCanonicalDelta("delta"),
        postEpochCensus: null,
      }],
      source: sqliteSourceStream,
    });
    crashingSession.renew = async () => { throw new Error("simulated crash after step 8"); };

    await expect(runMigrationRollback({
      homeDir, generationId: "gen-resume-8-9", canonicalPath,
      projectIdentity: identity, localProjectId: "local-1",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    }, {
      coordinator,
      resolveWitnessBindings: () => fixtureAuthoritativelyAbsent,
      classifyRollbackMode: referenceClassifyRollbackMode,
      recordSelectionBinding: () => undefined,
      recordWitnessBinding: () => undefined,
      resolveAuthoritativeContext: async () => null,
      openFencedSession: async () => crashingSession,
    })).rejects.toThrow("simulated crash after step 8");

    const midManifest = new MigrationManifestStore({ homeDir }).read("gen-resume-8-9");
    expect(midManifest.phase).toBe("rolling-back");
    expect(midManifest.pendingEffect).toBeNull();
    expect(readBackendMaintenanceJournal(homeDir)?.phase).toBe("maintenance-held");
    expect(readRollbackAuthorityArtifact(homeDir, "gen-resume-8-9")).not.toBeNull();

    // The SECOND call is a fresh process: classifyMigrationRecovery
    // reads "ready" at phase "rolling-back" and routes to
    // continueAfterPrepareRollback, which must recover the operability
    // fact and authority from the durable artifact rather than
    // re-deriving them live (the maintenance journal still holds the
    // slot, so a live re-read would still answer "unresolvable").
    const outcome = await runMigrationRollback({
      homeDir, generationId: "gen-resume-8-9", canonicalPath,
      projectIdentity: identity, localProjectId: "local-1",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    }, {
      coordinator,
      resolveWitnessBindings: () => fixtureAuthoritativelyAbsent,
      classifyRollbackMode: referenceClassifyRollbackMode,
      recordSelectionBinding: () => undefined,
      recordWitnessBinding: () => undefined,
      resolveAuthoritativeContext: async () => null,
      openFencedSession: async () => fakeSession({
        observations: [{
          manifestDestinationWitnessSha256: destinationIdentity.sealedWitnessSha256,
          destinationIdentity,
          postEpochDelta: fixtureCanonicalDelta("delta"),
          postEpochCensus: null,
        }],
        source: sqliteSourceStream,
      }),
    });

    expect(outcome.manifest.phase).toBe("rolled-back");
    expect(outcome.manifest.rollbackLineage.mode).toBe("pre-write");
    expect(outcome.report).not.toBeNull();
    expect(outcome.report!.eligibility).toBe("unactivated");
  });

 it("abandons a pending publish-rollback effect back to the sealed returnPhase when the selection was never durably proven complete", async () => {
    const homeDir = tempHome();
    const store = new MigrationManifestStore({ homeDir });
    const verified = manifestAtVerified(store, "gen-abandon");
    const coordinator = coordinatorFor(homeDir);

    const publicationId = deriveRollbackPublicationId("gen-abandon");
    await coordinator.enterMaintenance({
      publicationId, generationId: "gen-abandon",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
      now: new Date(capturedAt),
    });
    const prepareInputSha256 = deriveRollbackPrepareInputSha256({
      generationId: "gen-abandon", manifestRevision: verified.revision, manifestChecksumSha256: verified.checksumSha256,
      epochId: null, resourceType: "sqlite-generation", resourceKey: "gen",
    });
    const prepareEffectId = "rollback-prepare-" + prepareInputSha256;
    let m = store.update("gen-abandon", verified.checksumSha256, (c) => beginMigrationEffect(c, {
      kind: "prepare-rollback", effectId: prepareEffectId, inputSha256: prepareInputSha256, startedAt: capturedAt,
    }));
    m = store.update("gen-abandon", m.checksumSha256, (c) => completeMigrationEffect(c, { effectId: prepareEffectId, completedAt: capturedAt }));
    // Simulates a crash mid step-11, after publish-rollback began but
    // before the maintenance selection ever reached selection-completed
    // -- the maintenance journal is still at "maintenance-held" from the
    // enterMaintenance call above.
    m = store.update("gen-abandon", m.checksumSha256, (c) => beginMigrationEffect(c, {
      kind: "publish-rollback", effectId: "pub-abandon", inputSha256: "a".repeat(64), startedAt: capturedAt,
    }));
    expect(m.phase).toBe("rolling-back");
    expect(m.pendingEffect?.kind).toBe("publish-rollback");
    expect(readBackendMaintenanceJournal(homeDir)?.phase).toBe("maintenance-held");

    const outcome = await runMigrationRollback({
      homeDir, generationId: "gen-abandon", canonicalPath: join(homeDir, "live.sqlite"),
      projectIdentity: identity, localProjectId: "local-1",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    }, {
      coordinator,
      resolveWitnessBindings: () => fixtureAuthoritativelyAbsent,
      classifyRollbackMode: referenceClassifyRollbackMode,
      recordSelectionBinding: () => undefined,
      recordWitnessBinding: () => undefined,
      resolveAuthoritativeContext: async () => null,
      openFencedSession: async () => { throw new Error("must not open a session during abandonment recovery"); },
    });

    expect(outcome.manifest.phase).toBe("verified");
    expect(outcome.manifest.rollbackLineage.returnPhase).toBeNull();
    expect(outcome.manifest.pendingEffect).toBeNull();
    expect(outcome.report).not.toBeNull();
    expect(outcome.report!.kind).toBe("abandonment");
    expect(outcome.report!.reason).not.toBeNull();
    const maintenance = readBackendMaintenanceJournal(homeDir);
    expect(maintenance?.phase).toBe("maintenance-aborted");
  });
});

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

import { existsSync, mkdirSync, mkdtempSync, chmodSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  withBackendPublicationConsumerLockAsync,
  backendPublicationJournalPath,
  type BackendPublicationDriver,
} from "../../src/storage/backend-publication.js";
import { MigrationManifestStore } from "../../src/migration/manifest-store.js";
import {
  migrationActivationEvidenceDirectory,
  recordMigrationActivationAttempt,
  recordMigrationActivationEpoch,
  recordMigrationActivationWitness,
} from "../../src/migration/activation-evidence-store.js";
import {
  migrationGenerationBindingDirectory,
  recordMigrationSelectionBinding,
  recordMigrationWitnessBinding,
  resolveMigrationWitnessBindings,
} from "../../src/migration/generation-binding-store.js";
import { assertMigrationReplayAdmission } from "../../src/migration/maintenance.js";
import { publicationMaterial, workingPublicationDriver } from "../fixtures/backend-publication-driver.js";
import { clearProjectMapCache, projectMapPath } from "../../src/project-map.js";
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
  writeRollbackReport,
  deriveRollbackAuthorityArtifactId,
  readRollbackAuthorityArtifact,
  readBackendPublicationOperabilityFact,
  type RunMigrationRollbackDependencies,
  type RollbackFencedSession,
  type MigrationSelectionBindingRecorder,
  type MigrationWitnessBindingRecorder,
} from "../../src/migration/rollback.js";
import {
  fixtureActivationScenario,
  fixtureActivationWitness,
  fixtureAttempt,
  fixtureBindingsAbsent,
  fixtureBindingsUnresolvable,
  fixtureCanonicalDelta,
  fixtureCensusVector,
  fixtureDestinationIdentity,
  fixtureEpoch,
  fixtureEvidenceAbsent,
} from "../fixtures/migration-activation-records.js";

/** A project map whose only remote binding is the covered project (plan-v3.2 A14). */
const COVERED_REMOTE_PROJECT_ID = "01990000-0000-7000-8000-0000000000aa";
function coveredOnlyProjectMap(localProjectId: string): ReturnType<NonNullable<RunMigrationRollbackDependencies["readProjectMap"]>> {
  return { [localProjectId]: { canonical: "/covered", aliases: [], remoteProjectId: COVERED_REMOTE_PROJECT_ID } };
}

/** runMigrationRollback with the covered project as the sole remotely bound project, unless a test says otherwise. */
function runRollback(
  input: Parameters<typeof runMigrationRollback>[0],
  deps: RunMigrationRollbackDependencies,
): ReturnType<typeof runMigrationRollback> {
  return runMigrationRollback(input, { readProjectMap: () => coveredOnlyProjectMap(input.localProjectId), ...deps });
}

// Post-write cases build, verify and install real SQLite generations; under
// coverage instrumentation that exceeds the 5s default.
vi.setConfig({ testTimeout: 60_000 });

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

/** Binding store and evidence store both authoritatively empty: nothing was ever activated. */
function absentDeps() {
  return {
    resolveWitnessBindings: () => fixtureBindingsAbsent,
    resolveActivationEvidence: () => fixtureEvidenceAbsent,
  } as const;
}

/** The stores as one published activation leaves them, with the full records its selection names. */
function authoritativeDeps(scenario: ReturnType<typeof fixtureActivationScenario>) {
  return {
    resolveWitnessBindings: () => scenario.bindings,
    resolveActivationEvidence: () => scenario.evidence,
    resolveAuthoritativeContext: async () => scenario.context,
  } as const;
}

// ---------------------------------------------------------------------------
// donadiosolutions/lcm#1432 disagreement-refusal tests: a REAL completed
// postgresql BackendPublicationJournal, constructed via a fake driver
// (no live PostgreSQL, no network) so the "live side" of the
// operability-fact disagreement check can be independently corrupted
// with a genuinely resolvable "present" fact, not merely a fabricated
// artifact. Mirrors test/backend-publication.test.ts's own
// material()/makeDriver()/prepare()+resume() pattern -- deliberately NOT
// imported from that file (test files do not share fixtures across
// modules in this repo) but faithful to the same construction.
// ---------------------------------------------------------------------------

/**
 * Drives a REAL BackendPublicationCoordinator through prepare()+resume()
 * against a fake (in-memory) driver, landing a genuine version-2
 * BackendPublicationJournal at phase "completed", targetBackend
 * "postgresql", in the live slot -- exactly the state
 * readBackendPublicationOperabilityFact resolves as "present". No
 * maintenance journal is ever touched, so this never collides with the
 * rollback orchestration's own enterMaintenance in the same homeDir.
 */
async function establishCompletedPostgresqlPublication(homeDir: string): Promise<void> {
  const materialInput = publicationMaterial();
  const driver = workingPublicationDriver(materialInput);
  const pub = new BackendPublicationCoordinator({ homeDir, driver });
  await pub.prepare({
    publicationId: "disagreement-fixture-publication",
    sourceBackend: "sqlite",
    targetBackend: "postgresql",
    material: materialInput,
    projects: [{ localProjectId: "local-project", remoteProjectId: "remote-project", evidenceSha256: "a".repeat(64) }],
    now: new Date(capturedAt),
  });
  await pub.resume();
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
  /** What the export snapshot reports; defaults to the first observation's delta and a fixed census. */
  exportEvidence?: Readonly<{ canonicalDelta: ReturnType<typeof fixtureCanonicalDelta>; censusVector: ReturnType<typeof fixtureCensusVector> }>;
  /** The census a requireCensus readback reports; defaults to the export census. */
  requiredCensus?: ReturnType<typeof fixtureCensusVector>;
}>): RollbackFencedSession {
  let call = 0;
  const exportEvidence = input.exportEvidence ?? {
    canonicalDelta: input.observations[0]!.postEpochDelta,
    censusVector: fixtureCensusVector("fake-export-census"),
  };
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
    async captureReadback(request) {
      const observed = input.observations[Math.min(call, input.observations.length - 1)]!;
      call += 1;
      const census = observed.postEpochCensus
        ?? (request.requireCensus === true ? (input.requiredCensus ?? exportEvidence.censusVector) : null);
      return {
        observedPortableRecordSchemaSha256: census === null ? "irrelevant" : PORTABLE_RECORD_SCHEMA_SHA256,
        destinationIdentity: observed.destinationIdentity,
        postEpochDelta: observed.postEpochDelta,
        postEpochCensus: census,
        manifestDestinationWitnessSha256: observed.manifestDestinationWitnessSha256,
      };
    },
    async openPortableSource() {
      return { stream: await input.source(), ...exportEvidence };
    },
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

    await expect(runRollback({

      homeDir, generationId: "gen-settled", canonicalPath: join(homeDir, "live.sqlite"),
      projectIdentity: identity, localProjectId: "local-1",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    }, {
      coordinator: coordinatorFor(homeDir),
      ...absentDeps(),
      recordSelectionBinding: () => undefined,
      recordWitnessBinding: () => undefined,
      openFencedSession: async () => { throw new Error("must not open a session for a settled generation"); },
    })).rejects.toMatchObject({ name: "RollbackOrchestrationError", reason: "unexpected-state" });
  });

  it("refuses before any durable change when witness-binding resolution is unresolvable, entering no maintenance", async () => {
    const homeDir = tempHome();
    const store = new MigrationManifestStore({ homeDir });
    manifestAtVerified(store, "gen-refuse");

    await expect(runRollback({
      homeDir, generationId: "gen-refuse", canonicalPath: join(homeDir, "live.sqlite"),
      projectIdentity: identity, localProjectId: "local-1",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    }, {
      coordinator: coordinatorFor(homeDir),
      resolveWitnessBindings: () => fixtureBindingsUnresolvable("simulated read failure"),
      resolveActivationEvidence: () => fixtureEvidenceAbsent,
      recordSelectionBinding: () => undefined,
      recordWitnessBinding: () => undefined,
      openFencedSession: async () => { throw new Error("must not open a session when authority is refused"); },
    })).rejects.toMatchObject({
      name: "RollbackOrchestrationError",
      reason: "not-eligible",
    });

    // Breakable independently: the positive control below (an absent binding store
    // instead of an unresolvable one, same everything else) reaches maintenance and a
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

    const outcome = await runRollback({
      homeDir, generationId: "gen-control", canonicalPath,
      projectIdentity: identity, localProjectId: "local-1",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    }, {
      coordinator: coordinatorFor(homeDir),
      ...absentDeps(),
      recordSelectionBinding: (input) => { selectionBindings.push(input.binding); },
      recordWitnessBinding: (input) => { witnessBindings.push(input.binding); },
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

    const outcome = await runRollback({
      homeDir, generationId: "gen-post", canonicalPath,
      projectIdentity: identity, localProjectId: "local-post",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    }, {
      coordinator: coordinatorFor(homeDir),
      ...authoritativeDeps(fixtureActivationScenario({
        destinationIdentity: destinationIdentity, censusVector: fixtureCensusVector("census"), canonicalDeltaBaseline: baseline,
      })),
      recordSelectionBinding: (input) => { selectionBindings.push(input.binding); },
      recordWitnessBinding: (input) => { witnessBindings.push(input.binding); },
      openFencedSession: async () => fakeSession({
        observations: [{
          manifestDestinationWitnessSha256: storageWitness("postgresql", "4").identitySha256,
          destinationIdentity,
          // Deliberately different from the baseline -- classifyMigrationRollbackMode
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

    await expect(runRollback({
      homeDir, generationId: "gen-refuse-late", canonicalPath: join(homeDir, "live.sqlite"),
      projectIdentity: identity, localProjectId: "local-1",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    }, {
      coordinator: coordinatorFor(homeDir),
      // A destination identity that will NOT match the observation below --
      // the identity gate refuses before any durable change other than the
      // maintenance entry itself.
      ...authoritativeDeps(fixtureActivationScenario({
        destinationIdentity: fixtureDestinationIdentity("different"),
        canonicalDeltaBaseline: fixtureCanonicalDelta("baseline"),
      })),
      recordSelectionBinding: () => undefined,
      recordWitnessBinding: () => undefined,
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

    await expect(runRollback({
      homeDir, generationId: "gen-race", canonicalPath: join(homeDir, "live.sqlite"),
      projectIdentity: identity, localProjectId: "local-1",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    }, {
      coordinator: coordinatorFor(homeDir),
      ...authoritativeDeps(fixtureActivationScenario({
        destinationIdentity: destinationIdentity, censusVector: census, canonicalDeltaBaseline: baseline,
      })),
      recordSelectionBinding: () => undefined,
      recordWitnessBinding: () => undefined,
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

    const outcome = await runRollback({
      homeDir, generationId: "gen-race-control", canonicalPath: join(homeDir, "live.sqlite"),
      projectIdentity: identity, localProjectId: "local-1",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    }, {
      coordinator: coordinatorFor(homeDir),
      ...authoritativeDeps(fixtureActivationScenario({
        destinationIdentity: destinationIdentity, censusVector: census, canonicalDeltaBaseline: baseline,
      })),
      recordSelectionBinding: () => undefined,
      recordWitnessBinding: () => undefined,
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

    // Two attempts share one epoch after a takeover: the old attempt was
    // superseded and never selected (a witness only); the new attempt is
    // the one an actual selection was published against. Both witnesses are
    // recorded in both stores -- only the new attempt has a selection.
    const epoch = fixtureEpoch({ generationId: "gen-takeover", seed: "takeover", destinationIdentity, censusVector: censusBound });
    const attemptOld = fixtureAttempt({ epoch, seed: "old", canonicalDeltaBaseline: baselineUnboundWrong });
    const attemptNew = fixtureAttempt({ epoch, seed: "new", canonicalDeltaBaseline: baselineBound });
    const witnessOld = fixtureActivationWitness(epoch, attemptOld);
    const witnessNew = fixtureActivationWitness(epoch, attemptNew);
    const bindingFor = (attempt: typeof attemptOld, witness: typeof witnessOld, manifestRevision: number) => ({
      kind: "activation" as const, epochId: epoch.epochId, attemptId: attempt.attemptId,
      manifestRevision, witnessChecksumSha256: witness.checksumSha256,
    });
    const resolution = {
      state: "resolved" as const,
      witnesses: [bindingFor(attemptOld, witnessOld, 1), bindingFor(attemptNew, witnessNew, 2)],
      selections: [{ ...bindingFor(attemptNew, witnessNew, 2), publicationId: "pub-new" }],
    };

    const outcome = await runRollback({
      homeDir, generationId: "gen-takeover", canonicalPath: join(homeDir, "live.sqlite"),
      projectIdentity: identity, localProjectId: "local-1",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    }, {
      coordinator: coordinatorFor(homeDir),
      resolveWitnessBindings: () => resolution,
      resolveActivationEvidence: () => ({
        state: "resolved", epochs: [epoch], attempts: [attemptOld, attemptNew], witnesses: [witnessOld, witnessNew],
      }),
      recordSelectionBinding: (input) => { selectionBindings.push(input.binding); },
      recordWitnessBinding: (input) => { witnessBindings.push(input.binding); },
      resolveAuthoritativeContext: async (input) => {
        resolveAuthoritativeContextCalls.push(input.attemptId);
        // If this were ever reached with the unbound attempt, its
        // mismatching baseline makes the wrong-attempt path diverge
        // (post-write here vs. pre-write below) rather than silently
        // agreeing with the correct path's outcome.
        return { epoch, attempt: input.attemptId === attemptNew.attemptId ? attemptNew : attemptOld, witness: null };
      },
      openFencedSession: async () => fakeSession({
        observations: [{
          manifestDestinationWitnessSha256: storageWitness("postgresql", "4").identitySha256,
          destinationIdentity, postEpochDelta: baselineBound, postEpochCensus: censusBound,
        }],
        source: sqliteSourceStream,
      }),
    });

    expect(resolveAuthoritativeContextCalls).toEqual([attemptNew.attemptId]);
    expect(outcome.manifest.phase).toBe("rolled-back");
    expect(outcome.manifest.rollbackLineage.mode).toBe("pre-write");
    expect(selectionBindings).toHaveLength(1);
    expect(witnessBindings).toHaveLength(1);
    expect((selectionBindings[0] as { attemptId: string }).attemptId).toBe(attemptNew.attemptId);
    expect((witnessBindings[0] as { attemptId: string }).attemptId).toBe(attemptNew.attemptId);
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
    const outcome = await runRollback({
      homeDir, generationId: "gen-resume-2-7", canonicalPath,
      projectIdentity: identity, localProjectId: "local-1",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    }, {
      coordinator,
      ...absentDeps(),
      recordSelectionBinding: () => undefined,
      recordWitnessBinding: () => undefined,
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
    const outcome = await runRollback({
      homeDir, generationId: "gen-resume-7-8", canonicalPath,
      projectIdentity: identity, localProjectId: "local-1",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    }, {
      coordinator,
      ...absentDeps(),
      recordSelectionBinding: () => undefined,
      recordWitnessBinding: () => undefined,
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

    await expect(runRollback({
      homeDir, generationId: "gen-resume-8-9", canonicalPath,
      projectIdentity: identity, localProjectId: "local-1",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    }, {
      coordinator,
      ...absentDeps(),
      recordSelectionBinding: () => undefined,
      recordWitnessBinding: () => undefined,
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
    const outcome = await runRollback({
      homeDir, generationId: "gen-resume-8-9", canonicalPath,
      projectIdentity: identity, localProjectId: "local-1",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    }, {
      coordinator,
      ...absentDeps(),
      recordSelectionBinding: () => undefined,
      recordWitnessBinding: () => undefined,
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

    const outcome = await runRollback({
      homeDir, generationId: "gen-abandon", canonicalPath: join(homeDir, "live.sqlite"),
      projectIdentity: identity, localProjectId: "local-1",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    }, {
      coordinator,
      ...absentDeps(),
      recordSelectionBinding: () => undefined,
      recordWitnessBinding: () => undefined,
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

  // donadiosolutions/lcm#1432, plan-v2 section 10 red-proof requirement.
  // "the artifact's recorded fact disagrees with a resolvable live read
  // must produce a refusal" -- proven with BOTH sides independently
  // corruptible, for BOTH comparisons resolveRollbackOperabilityFact and
  // assertAuthorityAgreesWithArtifact perform: the operability fact
  // VALUE, and the resolved AUTHORITY. One shared baseline (agreement,
  // succeeds) plus four mutations, each corrupting exactly one side of
  // exactly one comparison. The "live fact" mutation uses a REAL
  // completed postgresql BackendPublicationJournal (via a fake driver,
  // no network) rather than a fabricated value, so that side is a
  // genuine production code path, not another hand-set fixture.

  it("disagreement baseline: artifact and a resolvable live read agree on both the operability fact and the authority -- succeeds (positive control)", async () => {
    const homeDir = tempHome();
    const store = new MigrationManifestStore({ homeDir });
    manifestAtVerified(store, "gen-agree");
    const canonicalPath = join(homeDir, "live.sqlite");
    writeRollbackAuthorityArtifact(homeDir, {
      version: 1,
      generationId: "gen-agree",
      operabilityFactState: "authoritatively-absent",
      operabilityFactValueSha256: null,
      authorityStatus: "unactivated",
      epochId: null,
      attemptId: null,
    });
    const destinationIdentity = fixtureDestinationIdentity("d");
    const outcome = await runRollback({
      homeDir, generationId: "gen-agree", canonicalPath,
      projectIdentity: identity, localProjectId: "local-1",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    }, {
      coordinator: coordinatorFor(homeDir),
      ...absentDeps(),
      recordSelectionBinding: () => undefined,
      recordWitnessBinding: () => undefined,
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
    expect(readRollbackAuthorityArtifact(homeDir, "gen-agree")).not.toBeNull();
  });

  it("disagreement mutation (artifact side, operability fact): artifact records present, a resolvable live read finds authoritatively-absent -- refuses", async () => {
    const homeDir = tempHome();
    const store = new MigrationManifestStore({ homeDir });
    manifestAtVerified(store, "gen-fact-artifact-wrong");
    writeRollbackAuthorityArtifact(homeDir, {
      version: 1,
      generationId: "gen-fact-artifact-wrong",
      operabilityFactState: "present",
      operabilityFactValueSha256: "e".repeat(64),
      authorityStatus: "unactivated",
      epochId: null,
      attemptId: null,
    });
    await expect(runRollback({
      homeDir, generationId: "gen-fact-artifact-wrong", canonicalPath: join(homeDir, "live.sqlite"),
      projectIdentity: identity, localProjectId: "local-1",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    }, {
      coordinator: coordinatorFor(homeDir),
      ...absentDeps(),
      recordSelectionBinding: () => undefined,
      recordWitnessBinding: () => undefined,
      openFencedSession: async () => { throw new Error("must not open a session: refusal happens before maintenance"); },
    })).rejects.toMatchObject({
      name: "RollbackOrchestrationError",
      reason: "not-eligible",
      message: expect.stringContaining("disagrees with the durable rollback-authority artifact"),
    });
  });

  it("disagreement mutation (live side, operability fact): artifact records authoritatively-absent, a resolvable live read finds a REAL completed postgresql publication -- refuses", async () => {
    const homeDir = tempHome();
    const store = new MigrationManifestStore({ homeDir });
    manifestAtVerified(store, "gen-fact-live-wrong");
    writeRollbackAuthorityArtifact(homeDir, {
      version: 1,
      generationId: "gen-fact-live-wrong",
      operabilityFactState: "authoritatively-absent",
      operabilityFactValueSha256: null,
      authorityStatus: "unactivated",
      epochId: null,
      attemptId: null,
    });
    await establishCompletedPostgresqlPublication(homeDir);
    const live = await readBackendPublicationOperabilityFact({ homeDir });
    expect(live.state).toBe("present");

    await expect(runRollback({
      homeDir, generationId: "gen-fact-live-wrong", canonicalPath: join(homeDir, "live.sqlite"),
      projectIdentity: identity, localProjectId: "local-1",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    }, {
      coordinator: coordinatorFor(homeDir),
      ...absentDeps(),
      recordSelectionBinding: () => undefined,
      recordWitnessBinding: () => undefined,
      openFencedSession: async () => { throw new Error("must not open a session: refusal happens before maintenance"); },
    })).rejects.toMatchObject({
      name: "RollbackOrchestrationError",
      reason: "not-eligible",
      message: expect.stringContaining("disagrees with the durable rollback-authority artifact"),
    });
  });

  it("disagreement mutation (artifact side, authority): artifact records an authoritative epoch/attempt, a fresh Boundary A read resolves unactivated -- refuses", async () => {
    const homeDir = tempHome();
    const store = new MigrationManifestStore({ homeDir });
    manifestAtVerified(store, "gen-authority-artifact-wrong");
    writeRollbackAuthorityArtifact(homeDir, {
      version: 1,
      generationId: "gen-authority-artifact-wrong",
      operabilityFactState: "authoritatively-absent",
      operabilityFactValueSha256: null,
      authorityStatus: "authoritative",
      epochId: "epoch-mismatch",
      attemptId: "attempt-mismatch",
    });
    await expect(runRollback({
      homeDir, generationId: "gen-authority-artifact-wrong", canonicalPath: join(homeDir, "live.sqlite"),
      projectIdentity: identity, localProjectId: "local-1",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    }, {
      coordinator: coordinatorFor(homeDir),
      ...absentDeps(),
      recordSelectionBinding: () => undefined,
      recordWitnessBinding: () => undefined,
      openFencedSession: async () => { throw new Error("must not open a session: refusal happens before maintenance"); },
    })).rejects.toMatchObject({
      name: "RollbackOrchestrationError",
      reason: "unexpected-state",
      message: expect.stringContaining("freshly resolved authority is unactivated but the durable rollback-authority artifact"),
    });
  });

  it("disagreement mutation (live side, authority): artifact records unactivated, a fresh Boundary A read resolves an authoritative selection -- refuses", async () => {
    const homeDir = tempHome();
    const store = new MigrationManifestStore({ homeDir });
    manifestAtVerified(store, "gen-authority-live-wrong");
    writeRollbackAuthorityArtifact(homeDir, {
      version: 1,
      generationId: "gen-authority-live-wrong",
      operabilityFactState: "authoritatively-absent",
      operabilityFactValueSha256: null,
      authorityStatus: "unactivated",
      epochId: null,
      attemptId: null,
    });
    await expect(runRollback({
      homeDir, generationId: "gen-authority-live-wrong", canonicalPath: join(homeDir, "live.sqlite"),
      projectIdentity: identity, localProjectId: "local-1",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    }, {
      coordinator: coordinatorFor(homeDir),
      ...authoritativeDeps(fixtureActivationScenario()),
      recordSelectionBinding: () => undefined,
      recordWitnessBinding: () => undefined,
      resolveAuthoritativeContext: async () => { throw new Error("must not resolve authoritative context: refusal happens before this call"); },
      openFencedSession: async () => { throw new Error("must not open a session: refusal happens before maintenance"); },
    })).rejects.toMatchObject({
      name: "RollbackOrchestrationError",
      reason: "unexpected-state",
     message: expect.stringContaining("freshly resolved authority disagrees with the durable rollback-authority artifact"),
   });
 });

  // plan-v2 section 7: interruption "between install and config" must
  // resume to exactly one authoritative selection. Config/project-map
  // publication is not implemented on this branch (see this file's own
  // module doc and runPostPrepareSequence's step 11 comment), so the
  // nearest real boundary after install is the maintenance-selection
  // flip completing. A crash there leaves NO pending effect (publish-
  // rollback's begin is step 12, strictly after the flip completes), so
  // classifyMigrationRecovery routes a retry back through
  // continueAfterPrepareRollback -- the SAME resume path already
  // covered above, exercised here specifically in post-write mode so a
  // retry rebuilds/reinstalls the generation rather than skipping it.
  it("resumes after a crash between install and the maintenance-selection flip completing (post-write, plan-v2 section 7)", async () => {
    const homeDir = tempHome();
    const store = new MigrationManifestStore({ homeDir });
    manifestAtVerified(store, "gen-install-config");
    const canonicalPath = join(homeDir, "live.sqlite");
    const destinationIdentity = fixtureDestinationIdentity("d");
    const baseline = fixtureCanonicalDelta("install-config-baseline");
    const coordinator = coordinatorFor(homeDir);
    const realPrepareMaintenanceSelection = coordinator.prepareMaintenanceSelection.bind(coordinator);
    let prepareCalls = 0;
    coordinator.prepareMaintenanceSelection = (async (...args: Parameters<typeof realPrepareMaintenanceSelection>) => {
      prepareCalls += 1;
      if (prepareCalls === 1) throw new Error("simulated crash after install, before the maintenance-selection flip");
      return realPrepareMaintenanceSelection(...args);
    }) as typeof coordinator.prepareMaintenanceSelection;

    const deps: RunMigrationRollbackDependencies = {
      coordinator,
      ...authoritativeDeps(fixtureActivationScenario({
        destinationIdentity: destinationIdentity, censusVector: fixtureCensusVector("census-ic"), canonicalDeltaBaseline: baseline,
      })),
      recordSelectionBinding: () => undefined,
      recordWitnessBinding: () => undefined,
      openFencedSession: async () => fakeSession({
        observations: [{
          manifestDestinationWitnessSha256: storageWitness("postgresql", "4").identitySha256,
          destinationIdentity,
          postEpochDelta: fixtureCanonicalDelta("install-config-changed"),
          postEpochCensus: null,
        }],
        source: sqliteSourceStream,
      }),
    };

    await expect(runRollback({
      homeDir, generationId: "gen-install-config", canonicalPath,
      projectIdentity: identity, localProjectId: "local-ic",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    }, deps)).rejects.toThrow("simulated crash after install, before the maintenance-selection flip");
    expect(prepareCalls).toBe(1);

    // Install already happened before the simulated crash: the
    // canonical database is real, installed, verified content -- not
    // an empty file a naive resume might mint.
    expect(existsSync(canonicalPath)).toBe(true);
    const installed = new DatabaseSync(canonicalPath, { readOnly: true });
    try {
      const row = installed.prepare(
        "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name LIKE 'portable_archive_%'",
      ).get() as { n: number };
      expect(row.n).toBeGreaterThan(0);
    } finally {
      installed.close();
    }

    const midManifest = new MigrationManifestStore({ homeDir }).read("gen-install-config");
    expect(midManifest.phase).toBe("rolling-back");
    expect(midManifest.pendingEffect).toBeNull();
    expect(readBackendMaintenanceJournal(homeDir)?.phase).toBe("maintenance-held");

    const outcome = await runRollback({
      homeDir, generationId: "gen-install-config", canonicalPath,
      projectIdentity: identity, localProjectId: "local-ic",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    }, deps);

   expect(outcome.manifest.phase).toBe("rolled-back");
   expect(outcome.manifest.rollbackLineage.mode).toBe("post-write");
   expect(prepareCalls).toBe(2);
   expect(readBackendMaintenanceJournal(homeDir)?.phase).toBe("selection-completed");

    // The retry's build target must be a FRESH physical generation, not
    // a reuse of the crashed attempt's -- plan-v2 section 4: "crash
    // recovery creates a NEW generation under the already-sealed
    // prepare-rollback", the incomplete one "quarantined read-only at
    // 0400, never deleted". Both attempt directories must exist:
    // deriving the retry's ordinal from the durable filesystem state
    // must never overwrite, delete or otherwise touch the first
    // attempt's evidence.
    const buildRoot = join(homeDir, ".lcm", "migration-rollback-generations");
    const buildEntries = readdirSync(buildRoot).filter((name) => name.startsWith("gen-install-config-rb"));
    expect(buildEntries).toHaveLength(2);
    const firstAttempt = buildEntries.find((name) => name.endsWith("-1"));
    const secondAttempt = buildEntries.find((name) => name.endsWith("-2"));
    expect(firstAttempt).toBeDefined();
    expect(secondAttempt).toBeDefined();
    expect(existsSync(join(buildRoot, firstAttempt!, "witness.json"))).toBe(true);
    expect(existsSync(join(buildRoot, secondAttempt!, "witness.json"))).toBe(true);
  });

  // Red-first: the enumeration must REFUSE when the read fails, never
 // silently return ordinal 1 (which would collide with the existing
 // attempt's evidence). Proven by making the build root exist but be
 // unreadable by this process (wrong mode), then showing the retry
 // refuses with a distinguishable reason rather than quietly minting a
 // colliding build target.
  it("refuses rather than defaulting to ordinal 1 when the build-attempt enumeration cannot read the existing evidence", async () => {
    const homeDir = tempHome();
    const store = new MigrationManifestStore({ homeDir });
    manifestAtVerified(store, "gen-enum-refuse");
    const canonicalPath = join(homeDir, "live.sqlite");
    const destinationIdentity = fixtureDestinationIdentity("d");
    const baseline = fixtureCanonicalDelta("enum-refuse-baseline");
    const coordinator = coordinatorFor(homeDir);

    const buildRoot = join(homeDir, ".lcm", "migration-rollback-generations");
    mkdirSync(buildRoot, { mode: 0o700 });
    mkdirSync(join(buildRoot, "gen-enum-refuse-rb10-1"), { mode: 0o700 });
    chmodSync(buildRoot, 0o000);

    let observed: unknown;
    try {
      await runRollback({
        homeDir, generationId: "gen-enum-refuse", canonicalPath,
        projectIdentity: identity, localProjectId: "local-enum",
        sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
      }, {
        coordinator,
        ...authoritativeDeps(fixtureActivationScenario({
          destinationIdentity: destinationIdentity, censusVector: fixtureCensusVector("census-enum"), canonicalDeltaBaseline: baseline,
        })),
        recordSelectionBinding: () => undefined,
        recordWitnessBinding: () => undefined,
        openFencedSession: async () => fakeSession({
          observations: [{
            manifestDestinationWitnessSha256: storageWitness("postgresql", "4").identitySha256,
            destinationIdentity,
            postEpochDelta: fixtureCanonicalDelta("enum-refuse-changed"),
            postEpochCensus: null,
          }],
          source: sqliteSourceStream,
        }),
      });
    } catch (error) {
      observed = error;
    } finally {
      chmodSync(buildRoot, 0o700);
    }

    // Confirm this is genuinely the enumeration's own refusal, not an
    // unrelated failure with the same shape: match the EXACT wrapped
    // message highestRollbackGenerationBuildAttempt produces (never a
    // bare error-type check, which a different EACCES-raising path
    // nearby could satisfy just as well and prove nothing).
    expect(observed).toBeInstanceOf(Error);
    expect((observed as Error).message).toContain(
      "could not enumerate existing rollback generation build attempts",
    );

    // Breakable independently: the SAME scenario with the root left
    // readable (its correct 0o700 mode) proceeds past enumeration
    // instead of refusing -- proving THIS refusal is caused by the
    // unreadable root, not by something else in the fixture.
    const readableHomeDir = tempHome();
    const readableStore = new MigrationManifestStore({ homeDir: readableHomeDir });
    manifestAtVerified(readableStore, "gen-enum-control");
    const readableCoordinator = coordinatorFor(readableHomeDir);
    const readableOutcome = await runRollback({
      homeDir: readableHomeDir, generationId: "gen-enum-control", canonicalPath: join(readableHomeDir, "live.sqlite"),
      projectIdentity: identity, localProjectId: "local-enum-control",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    }, {
      coordinator: readableCoordinator,
      ...authoritativeDeps(fixtureActivationScenario({
        destinationIdentity: destinationIdentity, censusVector: fixtureCensusVector("census-enum-control"), canonicalDeltaBaseline: baseline,
      })),
      recordSelectionBinding: () => undefined,
      recordWitnessBinding: () => undefined,
      openFencedSession: async () => fakeSession({
        observations: [{
          manifestDestinationWitnessSha256: storageWitness("postgresql", "4").identitySha256,
          destinationIdentity,
          postEpochDelta: fixtureCanonicalDelta("enum-refuse-changed"),
          postEpochCensus: null,
        }],
        source: sqliteSourceStream,
      }),
    });
   expect(readableOutcome.manifest.phase).toBe("rolled-back");
 });
});

// donadiosolutions/lcm#1431, coordinator-seam-FROZEN.md section 17's
// crash window: "between the moment a selection completes and the
// moment its binding is durably written, selections is missing the
// binding that authority actually rests on." Section 17's obligation:
// a consumer concludes nothing from that absence while an unresolved
// publish effect exists for that generation, and recovery re-derives
// and rewrites the binding from the authoritative readback, which the
// writer's idempotency rule makes safe.
describe("donadiosolutions/lcm#1431: selection-completes-but-binding-not-yet-written", () => {
  it("the manifest reaches rolled-back durably even when recordSelectionBinding crashes, replay admission already routes to sqlite from the maintenance journal alone, and the same deterministic binding can be re-derived from durable state and rewritten idempotently", async () => {
    const homeDir = tempHome();
    const store = new MigrationManifestStore({ homeDir });
    manifestAtVerified(store, "gen-1431");
    const canonicalPath = join(homeDir, "live.sqlite");
    const destinationIdentity = fixtureDestinationIdentity("d");
    const baseline = fixtureCanonicalDelta("1431-baseline");
    const census = fixtureCensusVector("1431-census");
    const scenario1431 = fixtureActivationScenario({
      generationId: "gen-1431", destinationIdentity, censusVector: census, canonicalDeltaBaseline: baseline,
    });

    let attemptedBinding: unknown = null;
    let bindingCalls = 0;

    await expect(runRollback({
      homeDir, generationId: "gen-1431", canonicalPath,
      projectIdentity: identity, localProjectId: "local-1431",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    }, {
      coordinator: coordinatorFor(homeDir),
      ...authoritativeDeps(scenario1431),
      recordSelectionBinding: (input) => {
        bindingCalls += 1;
        attemptedBinding = input.binding;
        throw new Error("simulated crash: selection completed but the binding write never landed");
      },
      recordWitnessBinding: () => undefined,
      openFencedSession: async () => fakeSession({
        observations: [{
          manifestDestinationWitnessSha256: storageWitness("postgresql", "4").identitySha256,
          destinationIdentity, postEpochDelta: baseline, postEpochCensus: census,
        }],
        source: sqliteSourceStream,
      }),
    })).rejects.toThrow("simulated crash: selection completed but the binding write never landed");
    expect(bindingCalls).toBe(1);

    // The manifest completed publish-rollback and was durably persisted
    // BEFORE recordSelectionBinding ever ran (rollback.ts calls it last,
    // after publishManifest for the publish-rollback completion) -- so
    // the crash inside the binding writer does not roll the manifest
    // back. This is the absence section 17 requires a consumer not to
    // conclude "never published" from.
    const terminal = new MigrationManifestStore({ homeDir }).read("gen-1431");
    expect(terminal.phase).toBe("rolled-back");
    expect(terminal.pendingEffect).toBeNull();
    expect(terminal.rollbackLineage.mode).toBe("pre-write");

    // assertMigrationReplayAdmission -- the ACTUAL replay-admission
    // consumer this codebase has today -- keys on the maintenance
    // journal alone (selection-completed + terminalEvidenceSha256), not
    // on the selection-binding store, so it already routes correctly to
    // sqlite even though the binding write crashed. This is the
    // concrete claim rollback.ts's own step-11 comment makes; proven
    // here rather than asserted.
    const maintenance = readBackendMaintenanceJournal(homeDir);
    expect(maintenance?.phase).toBe("selection-completed");
    expect(maintenance?.targetBackend).toBe("sqlite");
    const admission = assertMigrationReplayAdmission({
      homeDir, generationId: "gen-1431", evidenceSha256: maintenance!.terminalEvidenceSha256!,
    });
    expect(admission).toEqual({ backend: "sqlite", disposition: "selected" });

    // Re-derive the SAME selection binding independently from durable
    // state left behind -- exactly what section 17 requires recovery to
    // do -- and prove it is byte-identical to what runPostPrepareSequence
    // actually attempted, which is what makes "rewrite it" safe per the
    // idempotency rule (contract section 17: accept a re-write of an
    // identical binding for the same generation and kind).
    const rollbackReportRef = terminal.reports.find((report) => report.kind === "rollback");
    expect(rollbackReportRef).toBeDefined();
    const rollbackReport = readRollbackReport(homeDir, "gen-1431", rollbackReportRef!.reportId);
    expect(rollbackReport).not.toBeNull();
    expect(rollbackReport!.epochId).toBe(scenario1431.epoch.epochId);
    expect(rollbackReport!.attemptId).toBe(scenario1431.attempt.attemptId);

    const rederivedBinding = {
      kind: "rollback" as const,
      epochId: rollbackReport!.epochId!,
      attemptId: rollbackReport!.attemptId!,
      manifestRevision: terminal.revision,
      witnessChecksumSha256: maintenance!.terminalEvidenceSha256!,
      publicationId: deriveRollbackPublicationId("gen-1431"),
    };
    expect(rederivedBinding).toEqual(attemptedBinding);

    // A recovery agent's rewrite with this re-derived value must be
    // ACCEPTED as an idempotent identical rewrite (never refused, never
    // treated as a conflict) -- proven here against a recorder that
    // distinguishes "first write" from "rewrite of the identical value"
    // the same way #625's real writer must, per contract section 17.
    const recovered: unknown[] = [];
    const recoveryRecorder: MigrationSelectionBindingRecorder = (input) => {
      const existing = recovered.find((entry) => (
        (entry as { kind: string; attemptId: string }).kind === input.binding.kind
      ));
      if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(input.binding)) {
        throw new Error("conflict: a different binding was already recorded for this generation and kind");
      }
      recovered.push(input.binding);
    };
    recoveryRecorder({ homeDir, generationId: "gen-1431", binding: rederivedBinding });
    expect(() => recoveryRecorder({ homeDir, generationId: "gen-1431", binding: rederivedBinding })).not.toThrow();
    expect(recovered).toHaveLength(2);
  });
});

// Plan-v3 section 1/3 and amendment A1: with no resolver overrides, the
// orchestration reads the real binding store and the real activation
// evidence store. Each refusal below corrupts exactly one of the three
// observations (evidence store, binding store, operability fact) and is
// paired with a control that leaves them all consistent.
describe("runMigrationRollback against the real binding and evidence stores", () => {
  const RUN = (homeDir: string, generationId: string) => ({
    homeDir, generationId, canonicalPath: join(homeDir, "live.sqlite"),
    projectIdentity: identity, localProjectId: "local-1",
    sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
  });
  const destinationIdentity = fixtureDestinationIdentity("d");
  const neverOpens = async (): Promise<RollbackFencedSession> => {
    throw new Error("must not open a session: refusal happens before maintenance");
  };
  const unchangedSession = (): Promise<RollbackFencedSession> => Promise.resolve(fakeSession({
    observations: [{
      manifestDestinationWitnessSha256: storageWitness("postgresql", "4").identitySha256,
      destinationIdentity,
      postEpochDelta: fixtureCanonicalDelta("real-baseline"),
      postEpochCensus: fixtureCensusVector("real-census"),
    }],
    source: sqliteSourceStream,
  }));

  /** Records one activation exactly as the ordering contract says an activation driver does. */
  function recordActivation(homeDir: string, generationId: string, published: boolean) {
    const scenario = fixtureActivationScenario({
      generationId, destinationIdentity,
      censusVector: fixtureCensusVector("real-census"),
      canonicalDeltaBaseline: fixtureCanonicalDelta("real-baseline"),
    });
    recordMigrationActivationEpoch({ homeDir, epoch: scenario.epoch });
    recordMigrationActivationAttempt({ homeDir, generationId, attempt: scenario.attempt });
    recordMigrationActivationWitness({ homeDir, generationId, witness: scenario.witness });
    recordMigrationWitnessBinding({ homeDir, generationId, binding: scenario.witnessBinding });
    if (published) recordMigrationSelectionBinding({ homeDir, generationId, binding: scenario.selection });
    return scenario;
  }

  const plantJunk = (directory: string): void => {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, "junk.txt"), "stray", { mode: 0o600 });
  };

  it("rolls back a published activation end to end with every default in place, recording the rollback bindings in the real store", async () => {
    const homeDir = tempHome();
    manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-real");
    const scenario = recordActivation(homeDir, "gen-real", true);

    const outcome = await runRollback(RUN(homeDir, "gen-real"), {
      coordinator: coordinatorFor(homeDir),
      openFencedSession: unchangedSession,
    });

    expect(outcome.manifest.phase).toBe("rolled-back");
    expect(outcome.manifest.rollbackLineage.mode).toBe("pre-write");
    expect(outcome.report).toMatchObject({
      eligibility: "pre-write", epochId: scenario.epoch.epochId, attemptId: scenario.attempt.attemptId,
    });
    const bindings = resolveMigrationWitnessBindings({ homeDir, generationId: "gen-real" });
    if (bindings.state !== "resolved") throw new Error("expected the real binding store to resolve");
    expect(bindings.selections.map((entry) => entry.kind).sort()).toEqual(["activation", "rollback"]);
    expect(bindings.witnesses.map((entry) => entry.kind).sort()).toEqual(["activation", "rollback"]);
    const rollbackSelection = bindings.selections.find((entry) => entry.kind === "rollback")!;
    expect(rollbackSelection).toMatchObject({
      epochId: scenario.epoch.epochId,
      attemptId: scenario.attempt.attemptId,
      publicationId: deriveRollbackPublicationId("gen-real"),
    });
  });

  it("rolls back a never-activated generation with every default in place, writing no binding", async () => {
    const homeDir = tempHome();
    manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-never");
    const outcome = await runRollback(RUN(homeDir, "gen-never"), {
      coordinator: coordinatorFor(homeDir),
      openFencedSession: async () => fakeSession({
        observations: [{
          manifestDestinationWitnessSha256: destinationIdentity.sealedWitnessSha256,
          destinationIdentity, postEpochDelta: fixtureCanonicalDelta("delta"), postEpochCensus: null,
        }],
        source: sqliteSourceStream,
      }),
    });
    expect(outcome.report!.eligibility).toBe("unactivated");
    expect(resolveMigrationWitnessBindings({ homeDir, generationId: "gen-never" }))
      .toEqual({ state: "authoritatively-absent" });
  });

  it("treats witnessed-but-unpublished as unactivated: an epoch and witness are stored, no selection, destination not operable", async () => {
    const homeDir = tempHome();
    manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-unpublished");
    recordActivation(homeDir, "gen-unpublished", false);
    const outcome = await runRollback(RUN(homeDir, "gen-unpublished"), {
      coordinator: coordinatorFor(homeDir),
      openFencedSession: async () => fakeSession({
        observations: [{
          manifestDestinationWitnessSha256: destinationIdentity.sealedWitnessSha256,
          destinationIdentity, postEpochDelta: fixtureCanonicalDelta("delta"), postEpochCensus: null,
        }],
        source: sqliteSourceStream,
      }),
    });
    expect(outcome.report!.eligibility).toBe("unactivated");
  });

  it("refuses a witnessed-but-unpublished generation once the destination is operable (published but unbound)", async () => {
    const homeDir = tempHome();
    manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-operable");
    recordActivation(homeDir, "gen-operable", false);
    await establishCompletedPostgresqlPublication(homeDir);
    await expect(runRollback(RUN(homeDir, "gen-operable"), {
      coordinator: coordinatorFor(homeDir), openFencedSession: neverOpens,
    })).rejects.toMatchObject({ reason: "not-eligible", message: expect.stringContaining("published-but-unbound") });
    expect(readBackendMaintenanceJournal(homeDir)).toBeNull();
  });

  it("refuses when only the evidence store is corrupted, before any maintenance", async () => {
    const homeDir = tempHome();
    manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-bad-evidence");
    recordActivation(homeDir, "gen-bad-evidence", true);
    plantJunk(migrationActivationEvidenceDirectory(homeDir, "gen-bad-evidence"));
    await expect(runRollback(RUN(homeDir, "gen-bad-evidence"), {
      coordinator: coordinatorFor(homeDir), openFencedSession: neverOpens,
    })).rejects.toMatchObject({ reason: "not-eligible", message: expect.stringContaining("activation-evidence:unresolvable") });
    expect(readBackendMaintenanceJournal(homeDir)).toBeNull();
  });

  it("refuses when only the binding store is corrupted, before any maintenance", async () => {
    const homeDir = tempHome();
    manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-bad-bindings");
    recordActivation(homeDir, "gen-bad-bindings", true);
    plantJunk(migrationGenerationBindingDirectory(homeDir, "gen-bad-bindings"));
    await expect(runRollback(RUN(homeDir, "gen-bad-bindings"), {
      coordinator: coordinatorFor(homeDir), openFencedSession: neverOpens,
    })).rejects.toMatchObject({ reason: "not-eligible", message: expect.stringContaining("witness-resolution:unresolvable") });
  });

  it("refuses a selection binding whose evidence records are gone (evidence store absent), never unactivated", async () => {
    const homeDir = tempHome();
    manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-no-evidence");
    const scenario = fixtureActivationScenario({ generationId: "gen-no-evidence" });
    recordMigrationWitnessBinding({ homeDir, generationId: "gen-no-evidence", binding: scenario.witnessBinding });
    recordMigrationSelectionBinding({ homeDir, generationId: "gen-no-evidence", binding: scenario.selection });
    await expect(runRollback(RUN(homeDir, "gen-no-evidence"), {
      coordinator: coordinatorFor(homeDir), openFencedSession: neverOpens,
    })).rejects.toMatchObject({ reason: "not-eligible", message: expect.stringContaining("binding exists without its evidence record") });
  });

  it("refuses an unactivated generation when only the evidence store is corrupted", async () => {
    const homeDir = tempHome();
    manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-unactivated-bad");
    plantJunk(migrationActivationEvidenceDirectory(homeDir, "gen-unactivated-bad"));
    await expect(runRollback(RUN(homeDir, "gen-unactivated-bad"), {
      coordinator: coordinatorFor(homeDir), openFencedSession: neverOpens,
    })).rejects.toMatchObject({ reason: "not-eligible", message: expect.stringContaining("activation-evidence:unresolvable") });
  });

  it("refuses to continue a prepared rollback when the evidence store was corrupted after the crash", async () => {
    const homeDir = tempHome();
    manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-continue-bad");
    recordActivation(homeDir, "gen-continue-bad", true);
    const coordinator = coordinatorFor(homeDir);
    const crashing = await unchangedSession();
    crashing.renew = async () => { throw new Error("simulated crash after step 8"); };
    await expect(runRollback(RUN(homeDir, "gen-continue-bad"), {
      coordinator, openFencedSession: async () => crashing,
    })).rejects.toThrow("simulated crash after step 8");

    plantJunk(migrationActivationEvidenceDirectory(homeDir, "gen-continue-bad"));
    await expect(runRollback(RUN(homeDir, "gen-continue-bad"), {
      coordinator, openFencedSession: neverOpens,
    })).rejects.toMatchObject({
      reason: "unexpected-state",
      message: expect.stringContaining("authority resolution now refuses: activation-evidence:unresolvable"),
    });
  });

  it("refuses when the authoritative context cannot be fetched for a selection the stores agree on", async () => {
    const homeDir = tempHome();
    manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-no-context");
    recordActivation(homeDir, "gen-no-context", true);
    await expect(runRollback(RUN(homeDir, "gen-no-context"), {
      coordinator: coordinatorFor(homeDir),
      resolveAuthoritativeContext: async () => null,
      openFencedSession: neverOpens,
    })).rejects.toMatchObject({ reason: "unexpected-state", message: expect.stringContaining("could not be fetched") });
  });

  it("refuses to continue a prepared rollback when the authoritative context can no longer be fetched", async () => {
    const homeDir = tempHome();
    manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-continue-no-context");
    recordActivation(homeDir, "gen-continue-no-context", true);
    const coordinator = coordinatorFor(homeDir);
    const crashing = await unchangedSession();
    crashing.renew = async () => { throw new Error("simulated crash after step 8"); };
    await expect(runRollback(RUN(homeDir, "gen-continue-no-context"), {
      coordinator, openFencedSession: async () => crashing,
    })).rejects.toThrow("simulated crash after step 8");
    await expect(runRollback(RUN(homeDir, "gen-continue-no-context"), {
      coordinator, resolveAuthoritativeContext: async () => null, openFencedSession: neverOpens,
    })).rejects.toMatchObject({ reason: "unexpected-state", message: expect.stringContaining("could not be fetched") });
  });
});


// Refusal, recovery and I/O paths of rollback.ts that the happy-path and
// real-store tests above do not reach. recoverPendingPublishRollback is
// deliberately not exercised here: plan-v3.1 amendment A9 rewrites it.
describe("rollback.ts refusal, recovery and I/O paths", () => {
  const RUN = (homeDir: string, generationId: string, extra: Record<string, unknown> = {}) => ({
    homeDir, generationId, canonicalPath: join(homeDir, "live.sqlite"),
    projectIdentity: identity, localProjectId: "local-1",
    sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    ...extra,
  });
  const destinationIdentity = fixtureDestinationIdentity("d");
  const baseline = fixtureCanonicalDelta("paths-baseline");
  const census = fixtureCensusVector("paths-census");
  const witnessSha = storageWitness("postgresql", "4").identitySha256;
  const neverOpens = async (): Promise<RollbackFencedSession> => {
    throw new Error("must not open a session");
  };
  const scenarioFor = (generationId: string) => fixtureActivationScenario({
    generationId, destinationIdentity, censusVector: census, canonicalDeltaBaseline: baseline,
  });
  const unchanged = { manifestDestinationWitnessSha256: witnessSha, destinationIdentity, postEpochDelta: baseline, postEpochCensus: census };
  const sessionOf = (...observations: Parameters<typeof fakeSession>[0]["observations"][number][]) => async () =>
    fakeSession({ observations, source: sqliteSourceStream });
  const unactivatedSession = sessionOf({
    manifestDestinationWitnessSha256: destinationIdentity.sealedWitnessSha256,
    destinationIdentity, postEpochDelta: fixtureCanonicalDelta("delta"), postEpochCensus: null,
  });

  function manifestAtActive(store: MigrationManifestStore, generationId: string): MigrationManifest {
    let m = manifestAtVerified(store, generationId);
    const step = (kind: string, completion: Record<string, unknown>) => {
      m = store.update(generationId, m.checksumSha256, (current) => beginMigrationEffect(current, {
        kind: kind as never, effectId: kind, inputSha256: "a".repeat(64), startedAt: capturedAt,
      }));
      m = store.update(generationId, m.checksumSha256, (current) => completeMigrationEffect(current, {
        effectId: kind, completedAt: capturedAt, ...completion,
      }));
    };
    step("prepare-activation", {});
    step("publish-activation", { report: { kind: "activation", reportId: "r-act", reportSha256: "b".repeat(64), createdAt: capturedAt } });
    return m;
  }

  it("rolls back from phase active (a settled manifest with no pending effect)", async () => {
    const homeDir = tempHome();
    const m = manifestAtActive(new MigrationManifestStore({ homeDir }), "gen-active");
    expect(m.phase).toBe("active");
    const outcome = await runRollback(RUN(homeDir, "gen-active"), {
      coordinator: coordinatorFor(homeDir),
      ...authoritativeDeps(scenarioFor("gen-active")),
      recordSelectionBinding: () => undefined, recordWitnessBinding: () => undefined,
      openFencedSession: sessionOf(unchanged),
    });
    expect(outcome.manifest.phase).toBe("rolled-back");
    expect(outcome.manifest.rollbackLineage.returnPhase).toBe("active");
  });

  describe("the operability fact", () => {
    it("records a present fact in the authority artifact when the destination is operable and a selection is bound", async () => {
      const homeDir = tempHome();
      manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-operable-bound");
      await establishCompletedPostgresqlPublication(homeDir);
      const live = await readBackendPublicationOperabilityFact({ homeDir });
      await runRollback(RUN(homeDir, "gen-operable-bound"), {
        coordinator: coordinatorFor(homeDir),
        ...authoritativeDeps(scenarioFor("gen-operable-bound")),
        recordSelectionBinding: () => undefined, recordWitnessBinding: () => undefined,
        openFencedSession: sessionOf(unchanged),
      });
      expect(readRollbackAuthorityArtifact(homeDir, "gen-operable-bound")).toMatchObject({
        operabilityFactState: "present",
        operabilityFactValueSha256: live.state === "present" ? live.valueSha256 : null,
        authorityStatus: "authoritative",
      });
    });

    it("continues a prepared rollback from a present fact recorded in the artifact while maintenance holds the live slot", async () => {
      const homeDir = tempHome();
      manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-operable-continue");
      await establishCompletedPostgresqlPublication(homeDir);
      const coordinator = coordinatorFor(homeDir);
      const deps = {
        ...authoritativeDeps(scenarioFor("gen-operable-continue")),
        recordSelectionBinding: () => undefined, recordWitnessBinding: () => undefined,
      };
      const crashing = fakeSession({ observations: [unchanged], source: sqliteSourceStream });
      crashing.renew = async () => { throw new Error("simulated crash after step 8"); };
      await expect(runRollback(RUN(homeDir, "gen-operable-continue"), {
        coordinator, ...deps, openFencedSession: async () => crashing,
      })).rejects.toThrow("simulated crash after step 8");
      const outcome = await runRollback(RUN(homeDir, "gen-operable-continue"), {
        coordinator, ...deps, openFencedSession: sessionOf(unchanged),
      });
      expect(outcome.manifest.phase).toBe("rolled-back");
    });

    it("refuses when maintenance holds the live slot and no durable artifact exists to recover the fact from", async () => {
      const homeDir = tempHome();
      manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-foreign-maintenance");
      await coordinatorFor(homeDir).enterMaintenance({
        publicationId: "some-other-publication", generationId: "some-other-generation",
        sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
        now: new Date(capturedAt),
      });
      await expect(runRollback(RUN(homeDir, "gen-foreign-maintenance"), {
        coordinator: coordinatorFor(homeDir), ...absentDeps(), openFencedSession: neverOpens,
      })).rejects.toMatchObject({
        reason: "not-eligible",
        message: expect.stringContaining("no durable rollback-authority artifact exists"),
      });
    });

    it("refuses on an unresolvable fact whose cause is not the expected maintenance hold (consumer lock contention)", async () => {
      const homeDir = tempHome();
      manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-lock");
      await withBackendPublicationConsumerLockAsync(homeDir, async () => {
        await expect(runRollback(RUN(homeDir, "gen-lock"), {
          coordinator: coordinatorFor(homeDir), ...absentDeps(), openFencedSession: neverOpens,
        })).rejects.toMatchObject({ reason: "not-eligible", message: expect.stringContaining("operability-fact:unresolvable") });
      });
    });

    it("accepts a live present fact that agrees with the artifact's recorded value, and refuses one that does not", async () => {
      const homeDir = tempHome();
      manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-fact-agree");
      await establishCompletedPostgresqlPublication(homeDir);
      const artifact = (valueSha256: string) => ({
        version: 1 as const, generationId: "gen-fact-agree", operabilityFactState: "present" as const,
        operabilityFactValueSha256: valueSha256, authorityStatus: "authoritative" as const,
        epochId: scenarioFor("gen-fact-agree").epoch.epochId, attemptId: scenarioFor("gen-fact-agree").attempt.attemptId,
      });
      const deps = {
        coordinator: coordinatorFor(homeDir), ...authoritativeDeps(scenarioFor("gen-fact-agree")),
        recordSelectionBinding: () => undefined, recordWitnessBinding: () => undefined,
      };
      writeRollbackAuthorityArtifact(homeDir, artifact("0".repeat(64)));
      await expect(runRollback(RUN(homeDir, "gen-fact-agree"), { ...deps, openFencedSession: neverOpens }))
        .rejects.toMatchObject({ reason: "not-eligible", message: expect.stringContaining("disagrees with the durable") });

      const agreeHome = tempHome();
      manifestAtVerified(new MigrationManifestStore({ homeDir: agreeHome }), "gen-fact-agree");
      await establishCompletedPostgresqlPublication(agreeHome);
      const agreeLive = await readBackendPublicationOperabilityFact({ homeDir: agreeHome });
      if (agreeLive.state !== "present") throw new Error("expected a present fact");
      writeRollbackAuthorityArtifact(agreeHome, artifact(agreeLive.valueSha256));
      const outcome = await runRollback(RUN(agreeHome, "gen-fact-agree"), {
        ...deps, coordinator: coordinatorFor(agreeHome), openFencedSession: sessionOf(unchanged),
      });
      expect(outcome.manifest.phase).toBe("rolled-back");
    });
  });

  describe("the authority artifact and the report store", () => {
    const body = (generationId: string, epochId: string | null) => ({
      version: 1 as const, generationId, operabilityFactState: "authoritatively-absent" as const,
      operabilityFactValueSha256: null, authorityStatus: epochId === null ? "unactivated" as const : "authoritative" as const,
      epochId, attemptId: epochId,
    });
    const artifactPath = (homeDir: string, generationId: string) =>
      join(homeDir, ".lcm", "migration-rollback-authority", deriveRollbackAuthorityArtifactId(generationId) + ".json");

    it("reuses an identical artifact and refuses a different one under the same generation", () => {
      const homeDir = tempHome();
      const first = writeRollbackAuthorityArtifact(homeDir, body("gen-artifact", null));
      expect(writeRollbackAuthorityArtifact(homeDir, body("gen-artifact", null))).toEqual(first);
      expect(() => writeRollbackAuthorityArtifact(homeDir, body("gen-artifact", "e".repeat(64)))).toThrow();
    });

    it("reports an artifact that cannot be read for a reason other than absence", () => {
      const homeDir = tempHome();
      mkdirSync(artifactPath(homeDir, "gen-artifact-dir"), { recursive: true, mode: 0o700 });
      expect(() => readRollbackAuthorityArtifact(homeDir, "gen-artifact-dir")).toThrow();
    });

    it("refuses an artifact whose checksum does not match its content", () => {
      const homeDir = tempHome();
      writeRollbackAuthorityArtifact(homeDir, body("gen-artifact-sum", null));
      const path = artifactPath(homeDir, "gen-artifact-sum");
      chmodSync(path, 0o600);
      writeFileSync(path, readFileSync(path, "utf8").replace("unactivated", "authoritative"), { mode: 0o400 });
      chmodSync(path, 0o400);
      expect(() => readRollbackAuthorityArtifact(homeDir, "gen-artifact-sum")).toThrow(/checksum/);
    });

    const reportBody = (reason: string | null) => ({
      version: 1 as const, reportId: "report-1", generationId: "gen-report", effectId: "effect-1",
      kind: "abandonment" as const, eligibility: null, mode: null, epochId: null, attemptId: null,
      sealedPublicationMaterialDigestSha256: null, reason,
    });
    const reportFile = (homeDir: string) => join(homeDir, ".lcm", "migration-reports", "gen-report", "report-1.json");

    it("returns null for a report that was never written", () => {
      expect(readRollbackReport(tempHome(), "gen-report", "report-1")).toBeNull();
    });

    it("reuses an identical report and refuses a different one under the same report id", () => {
      const homeDir = tempHome();
      const first = writeRollbackReport(homeDir, reportBody("one"));
      expect(writeRollbackReport(homeDir, reportBody("one"))).toEqual(first);
      expect(() => writeRollbackReport(homeDir, reportBody("two"))).toThrow();
    });

    it("reports a report that cannot be read for a reason other than absence", () => {
      const homeDir = tempHome();
      mkdirSync(reportFile(homeDir), { recursive: true, mode: 0o700 });
      expect(() => readRollbackReport(homeDir, "gen-report", "report-1")).toThrow();
    });

    it("refuses a report whose checksum does not match its content", () => {
      const homeDir = tempHome();
      writeRollbackReport(homeDir, reportBody("one"));
      chmodSync(reportFile(homeDir), 0o600);
      writeFileSync(reportFile(homeDir), readFileSync(reportFile(homeDir), "utf8").replace("one", "two"), { mode: 0o400 });
      chmodSync(reportFile(homeDir), 0o400);
      expect(() => readRollbackReport(homeDir, "gen-report", "report-1")).toThrow(/checksum/);
    });
  });

  describe("publishing a manifest successor", () => {
    afterEach(() => { vi.restoreAllMocks(); });

    it("converges when an update landed durably but reported failure, for a successor with and without a pending effect", async () => {
      const homeDir = tempHome();
      manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-landed");
      const real = MigrationManifestStore.prototype.update;
      let calls = 0;
      vi.spyOn(MigrationManifestStore.prototype, "update").mockImplementation(function (this: MigrationManifestStore, ...args: Parameters<typeof real>) {
        calls += 1;
        const result = real.apply(this, args);
        // The first two updates (begin prepare-rollback, complete it) land and then fail.
        if (calls <= 2) throw new Error("simulated failure after the update landed");
        return result;
      });
      const outcome = await runRollback(RUN(homeDir, "gen-landed"), {
        coordinator: coordinatorFor(homeDir), ...absentDeps(), openFencedSession: unactivatedSession,
      });
      expect(outcome.manifest.phase).toBe("rolled-back");
    });

    it("rethrows when an update failed and the manifest does not hold the successor", async () => {
      const homeDir = tempHome();
      manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-not-landed");
      vi.spyOn(MigrationManifestStore.prototype, "update").mockImplementation(() => {
        throw new Error("simulated failure before the update landed");
      });
      await expect(runRollback(RUN(homeDir, "gen-not-landed"), {
        coordinator: coordinatorFor(homeDir), ...absentDeps(), openFencedSession: unactivatedSession,
      })).rejects.toThrow("simulated failure before the update landed");
    });
  });

  it("compares maintenance rosters independently of order, adopting a held maintenance only when every field matches", async () => {
    const homeDir = tempHome();
    manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-roster");
    const second = "018f0b5d-1234-4abc-8def-1234567890ac";
    const rosterOf = (...ids: string[]) => ids.map((machineId) => ({ machineId, queueCutoff: null, evidenceSha256: "7".repeat(64) }));
    const coordinator = coordinatorFor(homeDir);
    await coordinator.enterMaintenance({
      publicationId: deriveRollbackPublicationId("gen-roster"), generationId: "gen-roster",
      sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64),
      roster: rosterOf(MACHINE_ID, second), now: new Date(capturedAt),
    });
    writeRollbackAuthorityArtifact(homeDir, {
      version: 1, generationId: "gen-roster", operabilityFactState: "authoritatively-absent",
      operabilityFactValueSha256: null, authorityStatus: "unactivated", epochId: null, attemptId: null,
    });
    // Same machines in the opposite order, plus a repeated id so every comparison outcome is reached: not the held roster.
    await expect(runRollback(RUN(homeDir, "gen-roster", { roster: rosterOf(second, MACHINE_ID, MACHINE_ID) }), {
      coordinator, ...absentDeps(), openFencedSession: neverOpens,
    })).rejects.toThrow();
    // The held roster in the opposite order is adopted.
    const outcome = await runRollback(RUN(homeDir, "gen-roster", { roster: rosterOf(second, MACHINE_ID) }), {
      coordinator, ...absentDeps(), openFencedSession: unactivatedSession,
    });
    expect(outcome.manifest.phase).toBe("rolled-back");
  });

  it("refuses to resume a pending prepare-rollback begun with a different input", async () => {
    const homeDir = tempHome();
    const store = new MigrationManifestStore({ homeDir });
    const verified = manifestAtVerified(store, "gen-wrong-pending");
    store.update("gen-wrong-pending", verified.checksumSha256, (c) => beginMigrationEffect(c, {
      kind: "prepare-rollback", effectId: "rollback-prepare-other", inputSha256: "9".repeat(64), startedAt: capturedAt,
    }));
    await expect(runRollback(RUN(homeDir, "gen-wrong-pending"), {
      coordinator: coordinatorFor(homeDir), ...absentDeps(), openFencedSession: unactivatedSession,
    })).rejects.toMatchObject({ reason: "unexpected-state" });
  });

  describe("the post-write build", () => {
    const postWrite = { ...unchanged, postEpochDelta: fixtureCanonicalDelta("paths-changed"), postEpochCensus: null };

    it("quarantines a failed build and refuses rather than installing it", async () => {
      const homeDir = tempHome();
      manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-quarantine");
      const failing = async (): Promise<PortableRecordStream> => {
        const real = await sqliteSourceStream();
        return {
          describe: () => real.describe(),
          readBatch: () => { throw new Error("simulated source failure"); },
          verify: (checkpoint) => real.verify(checkpoint),
          close: () => real.close(),
        };
      };
      await expect(runRollback(RUN(homeDir, "gen-quarantine"), {
        coordinator: coordinatorFor(homeDir), ...authoritativeDeps(scenarioFor("gen-quarantine")),
        recordSelectionBinding: () => undefined, recordWitnessBinding: () => undefined,
        openFencedSession: async () => fakeSession({ observations: [postWrite], source: failing }),
      })).rejects.toMatchObject({ reason: "unexpected-state", message: expect.stringContaining("was quarantined") });
      expect(existsSync(join(homeDir, "live.sqlite"))).toBe(false);
    });


    describe("build-to-revalidation equality (plan-v3.1 A6)", () => {
      const refuseDeps = (homeDir: string, generationId: string, session: RollbackFencedSession, recorded: unknown[]) => ({
        coordinator: coordinatorFor(homeDir), ...authoritativeDeps(scenarioFor(generationId)),
        recordSelectionBinding: (call: { binding: unknown }) => { recorded.push(call.binding); },
        recordWitnessBinding: (call: { binding: unknown }) => { recorded.push(call.binding); },
        openFencedSession: async () => session,
      });
      const expectNothingInstalledOrSelected = (homeDir: string, recorded: unknown[]) => {
        expect(existsSync(join(homeDir, "live.sqlite"))).toBe(false);
        expect(readBackendMaintenanceJournal(homeDir)?.phase).toBe("maintenance-held");
        expect(recorded).toEqual([]);
      };

      it("refuses an unfenced write between build and revalidation that leaves the mode at post-write, installing and selecting nothing", async () => {
        const homeDir = tempHome();
        manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-a6-delta");
        const recorded: unknown[] = [];
        // Step 4 and the export snapshot see one delta; step 10 sees another that is still not the baseline.
        const session = fakeSession({
          observations: [postWrite, { ...postWrite, postEpochDelta: fixtureCanonicalDelta("paths-changed-again") }],
          source: sqliteSourceStream,
          exportEvidence: { canonicalDelta: postWrite.postEpochDelta, censusVector: census },
        });
        await expect(runRollback(RUN(homeDir, "gen-a6-delta"), refuseDeps(homeDir, "gen-a6-delta", session, recorded)))
          .rejects.toMatchObject({ reason: "not-eligible", message: expect.stringContaining("canonical delta differs") });
        expectNothingInstalledOrSelected(homeDir, recorded);
      });

      it("refuses a census that differs from the export snapshot's even when the delta is identical", async () => {
        const homeDir = tempHome();
        manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-a6-census");
        const recorded: unknown[] = [];
        const session = fakeSession({
          observations: [postWrite], source: sqliteSourceStream,
          exportEvidence: { canonicalDelta: postWrite.postEpochDelta, censusVector: census },
          requiredCensus: fixtureCensusVector("a-different-census"),
        });
        await expect(runRollback(RUN(homeDir, "gen-a6-census"), refuseDeps(homeDir, "gen-a6-census", session, recorded)))
          .rejects.toMatchObject({ reason: "not-eligible", message: expect.stringContaining("census differs") });
        expectNothingInstalledOrSelected(homeDir, recorded);
      });

      it("refuses when the revalidation snapshot did not capture a census at all", async () => {
        const homeDir = tempHome();
        manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-a6-missing");
        const recorded: unknown[] = [];
        const session = fakeSession({
          observations: [postWrite], source: sqliteSourceStream,
          exportEvidence: { canonicalDelta: postWrite.postEpochDelta, censusVector: census },
        });
        const real = session.captureReadback.bind(session);
        let calls = 0;
        session.captureReadback = async (request) => {
          calls += 1;
          const observation = await real(request);
          return calls === 1 ? observation : { ...observation, postEpochCensus: null };
        };
        await expect(runRollback(RUN(homeDir, "gen-a6-missing"), refuseDeps(homeDir, "gen-a6-missing", session, recorded)))
          .rejects.toMatchObject({ reason: "not-eligible", message: expect.stringContaining("census differs") });
        expectNothingInstalledOrSelected(homeDir, recorded);
      });

      it("control: the same run completes when revalidation reproduces the export snapshot's delta and census", async () => {
        const homeDir = tempHome();
        manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-a6-control");
        const recorded: unknown[] = [];
        const session = fakeSession({
          observations: [postWrite], source: sqliteSourceStream,
          exportEvidence: { canonicalDelta: postWrite.postEpochDelta, censusVector: census },
          requiredCensus: census,
        });
        const outcome = await runRollback(RUN(homeDir, "gen-a6-control"), refuseDeps(homeDir, "gen-a6-control", session, recorded));
        expect(outcome.manifest.rollbackLineage.mode).toBe("post-write");
        expect(recorded).toHaveLength(2);
      });

      it("asks step 10 for the census only on a post-write rollback, and records the export evidence in the build's witness", async () => {
        const homeDir = tempHome();
        manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-a6-plumbing");
        const requests: Array<{ requireCensus?: boolean }> = [];
        const session = fakeSession({ observations: [postWrite], source: sqliteSourceStream });
        const real = session.captureReadback.bind(session);
        session.captureReadback = async (request) => { requests.push(request); return real(request); };
        const outcome = await runRollback(RUN(homeDir, "gen-a6-plumbing"), {
          coordinator: coordinatorFor(homeDir), ...authoritativeDeps(scenarioFor("gen-a6-plumbing")),
          recordSelectionBinding: () => undefined, recordWitnessBinding: () => undefined,
          openFencedSession: async () => session,
        });
        expect(outcome.manifest.rollbackLineage.mode).toBe("post-write");
        expect(requests.map((request) => request.requireCensus)).toEqual([undefined, true]);
        const buildRoot = join(homeDir, ".lcm", "migration-rollback-generations");
        const built = readdirSync(buildRoot).find((name) => name.startsWith("gen-a6-plumbing-rb"))!;
        const witness = JSON.parse(readFileSync(join(buildRoot, built, "witness.json"), "utf8")) as {
          exportEvidence: { canonicalDelta: unknown; censusVector: unknown } | null;
        };
        expect(witness.exportEvidence).toEqual({
          canonicalDelta: postWrite.postEpochDelta,
          censusVector: fixtureCensusVector("fake-export-census"),
        });

        const preHome = tempHome();
        manifestAtVerified(new MigrationManifestStore({ homeDir: preHome }), "gen-a6-pre");
        const preRequests: Array<{ requireCensus?: boolean }> = [];
        const preSession = fakeSession({ observations: [unchanged], source: sqliteSourceStream });
        const preReal = preSession.captureReadback.bind(preSession);
        preSession.captureReadback = async (request) => { preRequests.push(request); return preReal(request); };
        await runRollback(RUN(preHome, "gen-a6-pre"), {
          coordinator: coordinatorFor(preHome), ...authoritativeDeps(scenarioFor("gen-a6-pre")),
          recordSelectionBinding: () => undefined, recordWitnessBinding: () => undefined,
          openFencedSession: async () => preSession,
        });
        expect(preRequests.map((request) => request.requireCensus)).toEqual([undefined, false]);
      });
    });

    it("counts only this generation and revision's well-formed attempt directories, and refuses an oversized build root", async () => {
      const homeDir = tempHome();
      const store = new MigrationManifestStore({ homeDir });
      manifestAtVerified(store, "gen-enum");
      const buildRoot = join(homeDir, ".lcm", "migration-rollback-generations");
      mkdirSync(buildRoot, { mode: 0o700 });
      for (const name of ["unrelated", "gen-enum-rb10-notanumber", "gen-enum-rb10-99999999999999999999"]) {
        mkdirSync(join(buildRoot, name), { mode: 0o700 });
      }
      const deps = {
        coordinator: coordinatorFor(homeDir), ...authoritativeDeps(scenarioFor("gen-enum")),
        recordSelectionBinding: () => undefined, recordWitnessBinding: () => undefined,
        openFencedSession: async () => fakeSession({ observations: [postWrite], source: sqliteSourceStream }),
      };
      await expect(runRollback(RUN(homeDir, "gen-enum", { _maxBuildAttemptEntries: 2 }), deps))
        .rejects.toMatchObject({ reason: "unexpected-state", message: expect.stringContaining("more entries than") });
      const outcome = await runRollback(RUN(homeDir, "gen-enum"), deps);
      expect(outcome.manifest.rollbackLineage.mode).toBe("post-write");
    });
  });

  it("refuses with the revalidation's own reason when step 10 finds a different destination identity", async () => {
    const homeDir = tempHome();
    manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-revalidate");
    await expect(runRollback(RUN(homeDir, "gen-revalidate"), {
      coordinator: coordinatorFor(homeDir), ...authoritativeDeps(scenarioFor("gen-revalidate")),
      recordSelectionBinding: () => undefined, recordWitnessBinding: () => undefined,
      openFencedSession: sessionOf(unchanged, { ...unchanged, destinationIdentity: fixtureDestinationIdentity("swapped") }),
    })).rejects.toMatchObject({
      reason: "not-eligible",
      message: expect.stringContaining("destination identity does not match the authoritative epoch"),
    });
  });

  it("refuses at step 11 when the held maintenance journal has vanished from the live slot", async () => {
    const homeDir = tempHome();
    manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-journal-gone");
    const session = fakeSession({ observations: [unchanged], source: sqliteSourceStream });
    session.renew = async () => { unlinkSync(backendPublicationJournalPath(homeDir)); };
    await expect(runRollback(RUN(homeDir, "gen-journal-gone"), {
      coordinator: coordinatorFor(homeDir), ...authoritativeDeps(scenarioFor("gen-journal-gone")),
      recordSelectionBinding: () => undefined, recordWitnessBinding: () => undefined,
      openFencedSession: async () => session,
    })).rejects.toMatchObject({ reason: "unexpected-state", message: expect.stringContaining("unexpectedly absent") });
  });

  it("refuses to continue a prepared rollback when the destination identity changed after the crash", async () => {
    const homeDir = tempHome();
    manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-continue-refused");
    const coordinator = coordinatorFor(homeDir);
    const deps = {
      ...authoritativeDeps(scenarioFor("gen-continue-refused")),
      recordSelectionBinding: () => undefined, recordWitnessBinding: () => undefined,
    };
    const crashing = fakeSession({ observations: [unchanged], source: sqliteSourceStream });
    crashing.renew = async () => { throw new Error("simulated crash after step 8"); };
    await expect(runRollback(RUN(homeDir, "gen-continue-refused"), {
      coordinator, ...deps, openFencedSession: async () => crashing,
    })).rejects.toThrow("simulated crash after step 8");
    await expect(runRollback(RUN(homeDir, "gen-continue-refused"), {
      coordinator, ...deps,
      openFencedSession: sessionOf({ ...unchanged, destinationIdentity: fixtureDestinationIdentity("swapped") }),
    })).rejects.toMatchObject({ reason: "not-eligible", message: expect.stringContaining("destination identity") });
  });
});


describe("runMigrationRollback: only the covered project may be remotely bound (A14)", () => {
  const RUN = (homeDir: string, generationId: string, extra: Record<string, unknown> = {}) => ({
    homeDir, generationId, canonicalPath: join(homeDir, "live.sqlite"),
    projectIdentity: identity, localProjectId: "local-1",
    sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), roster: ROSTER,
    ...extra,
  });
  const remote = (suffix: string): string => "01990000-0000-7000-8000-0000000000" + suffix;
  const bound = (suffix: string) => ({ canonical: "/p-" + suffix, aliases: [], remoteProjectId: remote(suffix) });
  const localOnly = { canonical: "/local-only", aliases: [] };
  const destinationIdentity = fixtureDestinationIdentity("d");
  const unactivatedSession = async (): Promise<RollbackFencedSession> => fakeSession({
    observations: [{
      manifestDestinationWitnessSha256: destinationIdentity.sealedWitnessSha256,
      destinationIdentity, postEpochDelta: fixtureCanonicalDelta("delta"), postEpochCensus: null,
    }],
    source: sqliteSourceStream,
  });
  const neverOpens = async (): Promise<RollbackFencedSession> => {
    throw new Error("must not open a session: refusal happens before maintenance");
  };
  const deps = (homeDir: string, map: () => ReturnType<typeof coveredOnlyProjectMap>, open = neverOpens) => ({
    coordinator: coordinatorFor(homeDir),
    ...absentDeps(),
    readProjectMap: map,
    recordSelectionBinding: () => undefined,
    recordWitnessBinding: () => undefined,
    openFencedSession: open,
  });

  function expectNothingDurable(homeDir: string, generationId: string): void {
    expect(readBackendMaintenanceJournal(homeDir)).toBeNull();
    expect(readRollbackAuthorityArtifact(homeDir, generationId)).toBeNull();
    const manifest = new MigrationManifestStore({ homeDir }).read(generationId);
    expect(manifest.phase).toBe("verified");
    expect(manifest.pendingEffect).toBeNull();
  }

  it("refuses two remotely bound projects before any durable change", async () => {
    const homeDir = tempHome();
    manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-two");
    await expect(runMigrationRollback(RUN(homeDir, "gen-two"), deps(homeDir, () => ({
      "local-1": bound("01"), "other-hash": bound("02"),
    })))).rejects.toMatchObject({
      name: "RollbackOrchestrationError",
      reason: "not-eligible",
      message: expect.stringContaining("multiple-remote-projects"),
    });
    expectNothingDurable(homeDir, "gen-two");
  });

  it("is not blocked by a second, unbound (local-only) entry (positive control)", async () => {
    const homeDir = tempHome();
    manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-local-only");
    const outcome = await runMigrationRollback(RUN(homeDir, "gen-local-only", { projectIdentity: { scope: "shared", projectId: remote("01") } }),
      deps(homeDir, () => ({ "local-1": bound("01"), "other-hash": localOnly }), unactivatedSession));
    expect(outcome.manifest.phase).toBe("rolled-back");
  });

  it("refuses when the project map does not bind the covered project, even if no other project is bound", async () => {
    const homeDir = tempHome();
    manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-unbound");
    for (const map of [{ "local-1": localOnly }, {}, { "other-hash": bound("02") }]) {
      await expect(runMigrationRollback(RUN(homeDir, "gen-unbound"), deps(homeDir, () => map)))
        .rejects.toMatchObject({ reason: "not-eligible", message: expect.stringContaining("covered-project-unbound") });
    }
    expectNothingDurable(homeDir, "gen-unbound");
  });

  it("refuses when the map binds the covered project to a different PostgreSQL project than the rollback covers", async () => {
    const homeDir = tempHome();
    manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-mismatch");
    await expect(runMigrationRollback(
      RUN(homeDir, "gen-mismatch", { projectIdentity: { scope: "shared", projectId: remote("09") } }),
      deps(homeDir, () => ({ "local-1": bound("01") })),
    )).rejects.toMatchObject({ reason: "not-eligible", message: expect.stringContaining("covered-project-mismatch") });
    expectNothingDurable(homeDir, "gen-mismatch");
  });

  it("refuses when the project map cannot be read", async () => {
    const homeDir = tempHome();
    manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-unreadable");
    await expect(runMigrationRollback(RUN(homeDir, "gen-unreadable"), deps(homeDir, () => {
      throw new Error("simulated map failure");
    }))).rejects.toMatchObject({
      reason: "not-eligible",
      message: expect.stringMatching(/project-map-unreadable.*simulated map failure/su),
    });
    expectNothingDurable(homeDir, "gen-unreadable");
  });

  it("reads the real project map file: a corrupted map refuses and two bound entries refuse", async () => {
    const homeDir = tempHome();
    manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-real-map");
    const run = () => runMigrationRollback(RUN(homeDir, "gen-real-map", { localProjectId: "a".repeat(64) }), {
      coordinator: coordinatorFor(homeDir), ...absentDeps(),
      recordSelectionBinding: () => undefined, recordWitnessBinding: () => undefined, openFencedSession: neverOpens,
    });
    const hash = (character: string): string => character.repeat(64);
    clearProjectMapCache();
    writeFileSync(projectMapPath(homeDir), "{not json", { mode: 0o600 });
    await expect(run()).rejects.toMatchObject({ reason: "not-eligible", message: expect.stringContaining("project-map-unreadable") });
    clearProjectMapCache();
    writeFileSync(projectMapPath(homeDir), JSON.stringify({
      [hash("a")]: bound("01"), [hash("b")]: bound("02"),
    }), { mode: 0o600 });
    await expect(run()).rejects.toMatchObject({ reason: "not-eligible", message: expect.stringContaining("multiple-remote-projects") });
    expectNothingDurable(homeDir, "gen-real-map");
  });

  it("re-checks under the retained token and refuses before the selection flip when a second project became bound", async () => {
    const homeDir = tempHome();
    manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-recheck");
    let reads = 0;
    const tokens: unknown[] = [];
    await expect(runMigrationRollback(
      RUN(homeDir, "gen-recheck"),
      deps(homeDir, ((_home?: string, token?: unknown) => {
        reads += 1;
        tokens.push(token);
        return reads === 1 ? { "local-1": bound("01") } : { "local-1": bound("01"), "other-hash": bound("02") };
      }) as never, unactivatedSession),
    )).rejects.toMatchObject({ reason: "not-eligible", message: expect.stringContaining("multiple-remote-projects") });
    expect(reads).toBe(2);
    expect(tokens[0]).toBeUndefined();
    expect(tokens[1]).toBeDefined();
    // Maintenance is held, but the selection was never prepared: both projects stay on PostgreSQL.
    expect(readBackendMaintenanceJournal(homeDir)?.phase).toBe("maintenance-held");
    expect(readBackendMaintenanceJournal(homeDir)?.targetBackend ?? null).toBeNull();
  });
});


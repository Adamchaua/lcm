/**
 * The production activation against a real PostgreSQL 18 database (#625,
 * plan-v7.1 phase 4, plan-v7.2 decision B): runMigrationActivation over
 * createMigrationActivationDependencies, with nothing substituted. The
 * installation is a real SQLite home holding stored data for exactly one
 * project; the generation reaches "verified" and activation-eligible through
 * the same real authenticated copy (runSqliteMigrationCopy) and verification
 * (verifyMigrationGeneration) the migration-verification e2e proves, with the
 * real pre-publication project-map witness recorded in the report so S5 and
 * S16 recompute it rather than trust a placeholder.
 *
 * The activation then runs through every production boundary: the real
 * append barrier, the real lease on lcm.fenced_leases through the ordinary
 * runtime's publication guard, the real quiescence and coverage checks over
 * the home, the real target health, a real census over a fresh read-only
 * transfer snapshot, the real artifact, link, #626 evidence and binding
 * stores, the real coordinator over the production driver and the PostgreSQL
 * remote guard, and the real restart admission. The assertions read the
 * durable state back through the public readers (#626's
 * readMigrationActivationEvidence and resolveMigrationWitnessBindings
 * included), and a second call settles idempotently from that state.
 *
 * One refusal row is included: a second project with stored data makes the
 * single-project G8 verdict refuse "uncovered-projects" (#1544 owns the
 * multi-project cutover); with that project removed the same generation then
 * activates, proving the refusal left no effect behind.
 *
 * Role topology follows plan-v7.2 B1/B3: activation runs entirely under ONE
 * transfer-profile role, provisioned here under a per-run unique name with
 * the reviewed runtime grant scripts plus the transfer grant script (exactly
 * what portable-fixture.ts installs on lcm_test_runtime), and its settings
 * are passed as both transferSettings and ordinarySettings. Production
 * readiness admits exactly one grantee per database and the runtime and
 * transfer manifests are exclusive on one role, so this is the only grant
 * shape under which S0/S7 (transfer reads) and S2/S6/S15 (lease and health,
 * admitted through the transfer verifier since B2) all pass in one run. The
 * same exclusivity is why the harness's baseline USAGE grant to
 * lcm_test_runtime is revoked in this database: a second grantee on schema
 * lcm is an acl-shape refusal. The daemon's own runtime profile is NOT
 * proven by activation (docs/migration-cutover.md, "After activation");
 * the last assertions make that explicit. #1607 is the later improvement.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeAll, expect, it, vi } from "vitest";
import { assertHarnessReady, settings, withPostgreSqlTestDatabase, type PostgreSqlTestDatabase } from "./harness.js";
import { PostgreSqlRuntime } from "../../src/storage/postgresql/runtime.js";
import { verifyPostgreSqlTransferSchema } from "../../src/storage/postgresql/runtime-readiness.js";
import type { PostgreSqlConnectionSettings } from "../../src/storage/postgresql/contracts.js";
import { PostgreSqlIdentityRepository } from "../../src/storage/postgresql/identity-repository.js";
import {
  BackendPublicationCoordinator,
  readBackendMaintenanceJournal,
  readBackendPublicationJournal,
  withBackendPublicationAppendBarrierAsync,
  type BackendPublicationDriver,
} from "../../src/storage/backend-publication.js";
import type { StorageIdentityContext } from "../../src/storage/contracts.js";
import { closeLcmConnection } from "../../src/db/connection.js";
import { localProjectIdentity } from "../../src/daemon/project.js";
import { appendLocalHookEvents } from "../../src/hooks/local-enqueue.js";
import { readMachineIdentity } from "../../src/machine-identity.js";
import { clearProjectMapCache, projectMapPath } from "../../src/project-map.js";
import { configPath, projectsDir } from "../../src/runtime-paths.js";
import {
  createMigrationActivationDependencies,
  previewMigrationActivation,
  runMigrationActivation,
  type MigrationActivationInput,
} from "../../src/migration/activate-generation.js";
import { readActivationGenerationLink } from "../../src/migration/activation-artifact-store.js";
import { readMigrationActivationEvidence } from "../../src/migration/activation-evidence-store.js";
import { deriveActivationPublicationId } from "../../src/migration/activation-publication-id.js";
import { readMigrationActivationReport } from "../../src/migration/activation-report.js";
import { inspectSqliteMigrationCopy, runSqliteMigrationCopy } from "../../src/migration/batch-copy.js";
import { migrationCopyTargetGeneration } from "../../src/migration/copy-source.js";
import { resolveMigrationWitnessBindings } from "../../src/migration/generation-binding-store.js";
import {
  authenticateSqliteMigrationSource,
  authenticateSqliteMigrationSourceBytes,
  captureAuthenticatedSqliteMigrationSource,
  prepareSqliteMigrationEnrollment,
} from "../../src/migration/maintenance.js";
import { MigrationManifestStore } from "../../src/migration/manifest-store.js";
import { computeMigrationProjectMapWitnessSha256 } from "../../src/migration/project-map-witness.js";
import { beginMigrationEffect, completeMigrationEffect, createMigrationManifest } from "../../src/migration/protocol.js";
import { withMigrationQueueEvidence } from "../../src/migration/queue-evidence.js";
import { getMigrationReceiptEpoch, recordMigrationReceipt, type MigrationReceiptEnvelope } from "../../src/migration/receipts.js";
import { checkMigrationTargetHealth } from "../../src/migration/target-health.js";
import {
  captureDestinationIdentity,
  captureDestinationSchemaWitness,
  verifyMigrationGeneration,
} from "../../src/migration/verify-generation.js";
import { seedPortableSqlite } from "../storage/sqlite-portable-fixture.js";

beforeAll(assertHarnessReady);

const EXPECTED_OWNER = "lcm_test_migrator";
/** The activation role (transfer profile). Cluster-wide, so unique per run: a
 * parallel or stale run never shares or drops another run's role. */
const ACTIVATION_ROLE = "lcm_test_transfer_" + randomBytes(6).toString("hex");
const GENERATION_ID = "activation-e2e-1";
/** A port nothing in the runner listens on: the restart admission must find no daemon. */
const DAEMON_PORT = 47331;

type ProjectMapFile = Record<string, { canonical: string; aliases: string[]; remoteProjectId?: string }>;

function readProjectMapFile(homeDir: string): ProjectMapFile {
  return JSON.parse(readFileSync(projectMapPath(homeDir), "utf8")) as ProjectMapFile;
}

function readConfigBackend(homeDir: string): string {
  return (JSON.parse(readFileSync(configPath(homeDir), "utf8")) as { storage: { backend: string } }).storage.backend;
}

/** The reviewed runtime scripts plus the transfer script: the transfer profile
 * (POSTGRESQL_TRANSFER_PRIVILEGE_MANIFEST), as portable-fixture.ts installs it. */
const TRANSFER_PROFILE_GRANT_SCRIPTS = [
  "postgresql-runtime-readiness-grants.sql",
  "postgresql-runtime-identity-grants.sql",
  "postgresql-runtime-conversation-grants.sql",
  "postgresql-runtime-summary-context-grants.sql",
  "postgresql-runtime-memory-grants.sql",
  "postgresql-runtime-search-grants.sql",
  "postgresql-runtime-coordination-grants.sql",
  "postgresql-runtime-transcript-grants.sql",
  "postgresql-transfer-grants.sql",
] as const;

/**
 * The activation role, provisioned as an operator would provision the
 * canonical transfer role: a plain login role holding the complete reference
 * transfer profile. The harness's baseline "GRANT USAGE ON SCHEMA lcm TO
 * lcm_test_runtime" is revoked in this database so the activation role is the
 * schema's only non-owner grantee (see the module comment). Returns the
 * role's connection settings for the test database.
 */
async function provisionActivationRole(db: PostgreSqlTestDatabase): Promise<PostgreSqlConnectionSettings> {
  const password = randomBytes(18).toString("hex");
  const administrator = new PostgreSqlRuntime(settings(db.adminUrl));
  try {
    const run = (text: string, operation: string) => administrator.query({ text }, { domain: "factory", operation });
    await run(
      "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '" + ACTIVATION_ROLE + "') THEN "
        + "CREATE ROLE " + ACTIVATION_ROLE + " LOGIN; END IF; END $$",
      "createActivationRole",
    );
    await run("ALTER ROLE " + ACTIVATION_ROLE + " LOGIN PASSWORD '" + password + "'", "setActivationRolePassword");
    await run("GRANT CONNECT ON DATABASE \"" + db.name + "\" TO " + ACTIVATION_ROLE, "grantActivationRoleConnect");
    await run("REVOKE USAGE ON SCHEMA lcm FROM lcm_test_runtime", "revokeHarnessRuntimeBaseline");
    for (const script of TRANSFER_PROFILE_GRANT_SCRIPTS) {
      const sql = readFileSync(join(process.cwd(), "src/storage/postgresql/reference", script), "utf8")
        .split("\n").filter((line) => !line.startsWith("\\")).join("\n")
        .replaceAll(':"lcm_runtime_role"', '"' + ACTIVATION_ROLE + '"')
        .replaceAll(':"lcm_transfer_role"', '"' + ACTIVATION_ROLE + '"');
      await run(sql, "grantActivationRole");
    }
  } finally {
    await administrator.close();
  }
  const url = new URL(db.runtimeUrl);
  url.username = ACTIVATION_ROLE;
  url.password = password;
  return settings(url.toString());
}

/**
 * Remove the run's activation role before the harness drops the database: DROP
 * OWNED revokes its grants in this database and on the database itself, which
 * is what lets DROP ROLE succeed for a cluster-wide role.
 */
async function dropActivationRole(db: PostgreSqlTestDatabase): Promise<void> {
  const administrator = new PostgreSqlRuntime(settings(db.adminUrl));
  try {
    await administrator.query({ text: "DROP OWNED BY " + ACTIVATION_ROLE }, { domain: "factory", operation: "dropActivationRoleOwned" });
    await administrator.query({ text: "DROP ROLE " + ACTIVATION_ROLE }, { domain: "factory", operation: "dropActivationRole" });
  } finally {
    await administrator.close();
  }
}

type VerifiedInstallation = Readonly<{
  home: string;
  cwd: string;
  localProjectId: string;
  remoteProjectId: string;
  machineId: string;
  input: MigrationActivationInput;
}>;

/**
 * A real SQLite installation with one enrolled project, copied and verified
 * into the database exactly as the migration-verification e2e does it, with
 * the maintenance window held under the activation's own publication id and
 * the report carrying the real pre-publication project-map witness. Every
 * PostgreSQL access here is the activation role's (plan-v7.2 B1).
 */
async function prepareVerifiedInstallation(
  db: PostgreSqlTestDatabase,
  home: string,
  transfer: PostgreSqlConnectionSettings,
): Promise<VerifiedInstallation> {
  mkdirSync(join(home, ".lcm"), { mode: 0o700 });
  // The source config the activation republishes with backend postgresql: the
  // composer refuses an absent source config, and the published target must
  // validate as a postgresql config.
  writeFileSync(configPath(home), JSON.stringify({
    storage: { backend: "sqlite", postgresql: { migrationRole: EXPECTED_OWNER } },
    daemon: { port: DAEMON_PORT },
  }) + "\n", { mode: 0o600 });
  const cwd = join(home, "project");
  mkdirSync(cwd, { mode: 0o700 });
  const local = localProjectIdentity(cwd, home);
  const projectDir = join(projectsDir(home), local.id);
  mkdirSync(projectDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(projectDir, "meta.json"), JSON.stringify({ cwd }) + "\n", { mode: 0o600 });
  // The project-map entry the daemon registers for a project it serves: unbound
  // before activation (S5's pre-publication witness and the composer require an
  // entry that carries no remote binding yet).
  writeFileSync(projectMapPath(home), JSON.stringify({ [local.id]: { canonical: local.canonical, aliases: [] } }) + "\n", { mode: 0o600 });
  clearProjectMapCache();
  const enrolled = await prepareSqliteMigrationEnrollment({
    cwd, homeDir: home,
    targetConfig: {
      backend: "postgresql",
      postgresql: {
        url: transfer.url, caFile: transfer.caFile, poolMax: transfer.poolMax,
        connectionTimeoutMs: transfer.connectionTimeoutMs, idleTimeoutMs: transfer.idleTimeoutMs,
        statementTimeoutMs: transfer.statementTimeoutMs, snapshotIdleTimeoutMs: transfer.snapshotIdleTimeoutMs ?? 300_000,
        migrationRole: EXPECTED_OWNER,
      },
    },
  });
  const identityRuntime = new PostgreSqlRuntime(transfer);
  let remote: Awaited<ReturnType<PostgreSqlIdentityRepository["createProject"]>>;
  try {
    remote = await new PostgreSqlIdentityRepository(identityRuntime).createProject({
      machineId: enrolled.identity.machineId, displayName: "activation e2e target", path: cwd, normalizedPath: cwd,
    });
  } finally {
    await identityRuntime.close();
  }
  const expectedIdentity: StorageIdentityContext = {
    id: remote.projectId, remoteProjectId: remote.projectId, localProjectId: local.id,
    machineId: enrolled.identity.machineId, canonical: cwd, selectedPath: cwd,
  };
  const machine = readMachineIdentity(home)!;
  const seed = seedPortableSqlite(join(projectDir, "db.sqlite"), {
    projectIdentity: { scope: "shared", projectId: remote.projectId }, sourceLocalProjectId: local.id,
    identityFacts: {
      machines: [{ identityKey: machine.identityKey, machineId: machine.machineId }],
      aliases: [{ machineIdentityKey: machine.identityKey, path: cwd, normalizedPath: cwd }],
    },
  });
  if (Array.isArray(seed.capturedSidecars!.instructions)) {
    for (const file of seed.capturedSidecars!.instructions) rmSync(file.databasePath);
  }
  if ("databasePath" in seed.capturedSidecars!.events) rmSync(seed.capturedSidecars!.events.databasePath);
  await appendLocalHookEvents({
    cwd, sessionId: "retained", sourceHook: "SessionStart",
    events: ["applied", "no-effect", "retained"].map((data) => ({ type: "decision", category: "decision", data, priority: 1 })),
  });
  closeLcmConnection();
  const eventsPath = join(home, ".lcm", "events", local.id + ".db");
  const project = new DatabaseSync(join(projectDir, "db.sqlite"));
  const events = new DatabaseSync(eventsPath);
  try {
    const epoch = getMigrationReceiptEpoch(project, local.id, machine.machineId!)!;
    const envelopes = events.prepare(
      "SELECT event_uuid AS eventUuid, event_version AS eventVersion, machine_id AS machineId, "
        + "machine_sequence AS machineSequence, session_id AS sessionId, seq AS sessionSequence, "
        + "type, category, data, priority, source_hook AS sourceHook, created_at AS createdAt "
        + "FROM events ORDER BY machine_sequence",
    ).all() as unknown as MigrationReceiptEnvelope[];
    const memory = project.prepare("SELECT id FROM promoted ORDER BY id LIMIT 1").get() as { id: string };
    project.exec("BEGIN IMMEDIATE");
    for (const [index, envelope] of envelopes.slice(0, 2).entries()) {
      recordMigrationReceipt(project, {
        projectId: local.id, epochId: epoch.epochId, envelope,
        effectWitness: index === 0
          ? { version: 1, outcome: "applied", promotedMemoryId: memory.id }
          : { version: 1, outcome: "no-effect", reason: "unreinforced-pattern" },
        committedAt: "2026-09-14T03:00:00.000000Z",
      });
    }
    project.exec("COMMIT");
    events.exec("UPDATE events SET processed_at='2026-09-14T03:00:00.000Z' WHERE data IN ('applied','no-effect')");
  } finally {
    events.close();
    project.close();
  }
  // The maintenance window is held under the activation's own publication id
  // (deriveActivationPublicationId), the id the S2 lease and the S13 drive
  // carry; the local driver is never reached while the window is only held.
  const unavailable = async (): Promise<never> => { throw new Error("no publication"); };
  const driver: BackendPublicationDriver = {
    observeLocalState: unavailable, publishProjectMap: unavailable, publishConfig: unavailable,
    restoreConfig: unavailable, restoreProjectMap: unavailable,
  };
  const entered = await withBackendPublicationAppendBarrierAsync(home, async (token) => {
    const authority = authenticateSqliteMigrationSource(cwd, home, token);
    const expectedSourceBytes = await authenticateSqliteMigrationSourceBytes(authority, { homeDir: home, lockToken: token });
    // The witness S5 recomputes before compose and S16 reads back after the
    // publication: the real one, over the real map, read under the barrier
    // token exactly as the orchestrator reads it, never a placeholder.
    const projectMapWitnessSha256 = computeMigrationProjectMapWitnessSha256({
      homeDir: home, localProjectId: local.id, remoteProjectId: remote.projectId, mode: "pre-publication", publicationLockToken: token,
    });
    const held = await new BackendPublicationCoordinator({ homeDir: home, driver }).enterMaintenance({
      publicationId: deriveActivationPublicationId(GENERATION_ID), generationId: GENERATION_ID,
      sourceSelectionSha256: authority.sourceSelectionSha256, queueEvidenceSha256: expectedSourceBytes.checksumSha256,
      roster: [{ machineId: machine.machineId!, queueCutoff: "0000000000000000002", evidenceSha256: expectedSourceBytes.checksumSha256 }],
    }, token);
    return { authority, expectedSourceBytes, held, projectMapWitnessSha256 };
  });
  const snapshot = await captureAuthenticatedSqliteMigrationSource(entered.authority, {
    homeDir: home, generationId: entered.held.generationId, maintenanceChecksumSha256: entered.held.checksumSha256,
    expectedSourceBytes: entered.expectedSourceBytes,
  });
  const evidence = await withMigrationQueueEvidence(home, snapshot.artifact, entered.held, async (_reference, records) => [...records]);
  expect(evidence.map((record) => record.disposition)).toEqual(["represented", "represented", "retained"]);
  closeLcmConnection();
  const copyInput = {
    generationId: snapshot.artifact.generationId, homeDir: home, settings: transfer,
    expectedOwner: EXPECTED_OWNER, expectedIdentity, ownerProcessId: "activation-e2e-copy-owner",
    maxRecords: 500, maxBytes: 150994944,
  };
  expect(copyInput.generationId).toBe(GENERATION_ID);
  const witness = await inspectSqliteMigrationCopy({ ...copyInput, destinationCapturedAt: "2026-09-14T03:00:00.000Z" });
  const manifestStore = new MigrationManifestStore({ homeDir: home });
  let created = manifestStore.create(createMigrationManifest({
    generationId: GENERATION_ID, source: witness.source, destination: witness.destination,
    parentGenerationId: null, preservedSourceGenerationId: GENERATION_ID, createdAt: "2026-09-14T03:00:00.000Z",
  }));
  created = manifestStore.update(GENERATION_ID, created.checksumSha256, (current) => beginMigrationEffect(current, {
    kind: "verify-dry-run", effectId: "e2e-dryrun", inputSha256: "a".repeat(64), startedAt: current.updatedAt,
  }));
  manifestStore.update(GENERATION_ID, created.checksumSha256, (current) => completeMigrationEffect(current, {
    effectId: "e2e-dryrun", completedAt: current.updatedAt,
    report: { kind: "dry-run", reportId: "e2e-dryrun-verified", reportSha256: "b".repeat(64), createdAt: current.updatedAt },
  }));
  const copied = await runSqliteMigrationCopy(copyInput);
  expect(copied.phase).toBe("copied");
  const manifest = manifestStore.read(GENERATION_ID);
  const witnessRuntime = new PostgreSqlRuntime(transfer);
  let destinationMigrationsSha256: string;
  let expectedDestinationIdentitySha256: string;
  let expectedSystemIdentifier: string;
  try {
    const [schemaWitness, identity] = await Promise.all([
      captureDestinationSchemaWitness(witnessRuntime),
      captureDestinationIdentity(witnessRuntime, expectedIdentity.id),
    ]);
    destinationMigrationsSha256 = schemaWitness.migrationsSha256;
    expectedDestinationIdentitySha256 = identity.sealedWitnessSha256;
    expectedSystemIdentifier = identity.systemIdentifier;
  } finally {
    await witnessRuntime.close();
  }
  const scratchParent = mkdtempSync(join(tmpdir(), "lcm-activation-e2e-scratch-"));
  const verified = await verifyMigrationGeneration({
    generationId: GENERATION_ID,
    targetGenerationId: migrationCopyTargetGeneration(GENERATION_ID),
    homeDir: home, expectedIdentity, destinationSettings: transfer,
    expectedOwner: EXPECTED_OWNER, ownerProcessId: "activation-e2e-verify-owner",
    scratchParent, leaseTtlMs: 300000,
    manifestRevision: manifest.revision, manifestChecksumSha256: manifest.checksumSha256,
    destinationMigrationsSha256, expectedDestinationIdentitySha256, expectedSystemIdentifier,
    projectMapWitnessSha256: entered.projectMapWitnessSha256,
    queueClassificationWitness: {
      version: 1, queueCutoff: null, queueSetSha256: "a".repeat(64),
      receiptSetSha256: "a".repeat(64), epochChecksumSha256: "a".repeat(64),
    },
    sampleParameters: { version: 1, strideOrdinal: 97, sampleCount: 32, seedBasisSha256: "a".repeat(64) },
  });
  expect(verified.report.mismatches).toEqual([]);
  expect(verified.report.activationEligible).toBe(true);
  expect(manifestStore.read(GENERATION_ID)).toMatchObject({ phase: "verified", activationEligible: true, pendingEffect: null });
  expect(readBackendMaintenanceJournal(home)).toMatchObject({ phase: "maintenance-held", sourceBackend: "sqlite", generationId: GENERATION_ID });
  expect(readProjectMapFile(home)[local.id]!.remoteProjectId).toBeUndefined();
  return {
    home, cwd, localProjectId: local.id, remoteProjectId: remote.projectId, machineId: enrolled.identity.machineId,
    input: {
      homeDir: home, generationId: GENERATION_ID,
      // B1: the same transfer-role settings twice, exactly as #627 will pass them.
      transferSettings: transfer, ordinarySettings: transfer,
      expectedIdentity, expectedOwner: EXPECTED_OWNER,
    },
  };
}

it("activates a real verified SQLite copy through the production dependencies: refused while a second project holds data, then activated, published, evidenced and idempotent", async () => {
  await withPostgreSqlTestDatabase("migration-activation-e2e", async (db) => {
    const transfer = await provisionActivationRole(db);
    const home = mkdtempSync(join(tmpdir(), "migration-activation-e2e-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    try {
      const installation = await prepareVerifiedInstallation(db, home, transfer);
      const publicationId = deriveActivationPublicationId(GENERATION_ID);
      const deps = createMigrationActivationDependencies({ homeDir: home });

      const before = await previewMigrationActivation({ homeDir: home, generationId: GENERATION_ID });
      expect(before.predictive).toBe(false);
      expect(before.checks.find((check) => check.name === "resume-point")).toMatchObject({ status: "ok", detail: "fresh" });
      expect(before.checks.find((check) => check.name === "maintenance-journal")).toMatchObject({ status: "ok" });

      // A second project with stored data: G8's single-project verdict refuses
      // (#1544 owns the multi-project cutover). Nothing durable is touched.
      const otherHash = "f".repeat(64);
      mkdirSync(join(projectsDir(home), otherHash), { recursive: true, mode: 0o700 });
      writeFileSync(join(projectsDir(home), otherHash, "db.sqlite"), "sqlite", { mode: 0o600 });
      const map = readProjectMapFile(home);
      writeFileSync(projectMapPath(home), JSON.stringify({ ...map, [otherHash]: { canonical: join(home, "other"), aliases: [] } }) + "\n", { mode: 0o600 });
      clearProjectMapCache();
      const refused = await runMigrationActivation(installation.input, deps);
      expect(refused.status, JSON.stringify(refused)).toBe("refused");
      expect(refused).toMatchObject({ status: "refused", step: "S4", reason: "uncovered-projects", effectBegun: false });
      expect(new MigrationManifestStore({ homeDir: home }).read(GENERATION_ID).phase).toBe("verified");
      expect(readActivationGenerationLink({ homeDir: home, generationId: GENERATION_ID }).state).toBe("authoritatively-absent");
      expect(readMigrationActivationEvidence({ homeDir: home, generationId: GENERATION_ID })).toEqual({ state: "authoritatively-absent" });
      expect(readConfigBackend(home)).toBe("sqlite");
      rmSync(join(projectsDir(home), otherHash), { recursive: true });
      writeFileSync(projectMapPath(home), JSON.stringify(map) + "\n", { mode: 0o600 });
      clearProjectMapCache();

      const outcome = await runMigrationActivation(installation.input, deps);
      expect(outcome.status, JSON.stringify(outcome)).toBe("activated");
      expect(outcome).toMatchObject({
        status: "activated", resumedFrom: "fresh", successorFencingToken: null,
        identity: { generationId: GENERATION_ID, publicationId },
        restart: { status: "satisfied" },
      });
      if (outcome.status !== "activated") return;

      // The version-3 selection became the completed version-2 publication of postgresql.
      expect(readBackendMaintenanceJournal(home)).toBeNull();
      expect(readBackendPublicationJournal(home)).toMatchObject({
        phase: "completed", publicationId, sourceBackend: "sqlite", targetBackend: "postgresql",
      });
      expect(readConfigBackend(home)).toBe("postgresql");
      expect(readProjectMapFile(home)[installation.localProjectId]!.remoteProjectId).toBe(installation.remoteProjectId);
      const manifest = new MigrationManifestStore({ homeDir: home }).read(GENERATION_ID);
      expect(manifest).toMatchObject({ phase: "active", pendingEffect: null, revision: outcome.identity.manifestRevision });
      expect(manifest.reports.some((report) => report.kind === "activation" && report.reportSha256 === outcome.report.reportSha256)).toBe(true);

      // The activation report, stored and readable, names the stored evidence chain.
      const stored = readMigrationActivationReport({ homeDir: home, generationId: GENERATION_ID, reportSha256: outcome.report.reportSha256 });
      expect(stored.state).toBe("resolved");
      if (stored.state !== "resolved") return;
      expect(stored.report.body).toMatchObject({ generationId: GENERATION_ID, publicationId, manifestRevisionAtComplete: expect.any(Number) });

      // The generation link resolves to the sealed artifact under this publication.
      const link = readActivationGenerationLink({ homeDir: home, generationId: GENERATION_ID });
      expect(link).toMatchObject({ state: "resolved", link: { publicationId, identityDigest: stored.report.body.identityDigest } });

      // #626 evidence readback: one epoch, one attempt, one witness, and the
      // reader itself re-mints the witness from its stored pair (a witness
      // that does not reproduce makes the store unresolvable).
      const evidence = readMigrationActivationEvidence({ homeDir: home, generationId: GENERATION_ID });
      expect(evidence.state).toBe("resolved");
      if (evidence.state !== "resolved") return;
      expect(evidence.epochs).toHaveLength(1);
      expect(evidence.attempts).toHaveLength(1);
      expect(evidence.witnesses).toHaveLength(1);
      expect(evidence.epochs[0]!.epochId).toBe(stored.report.body.epochId);
      expect(evidence.attempts[0]).toMatchObject({ attemptId: stored.report.body.attemptId, epochId: stored.report.body.epochId });
      expect(evidence.witnesses[0]).toMatchObject({ kind: "activation", checksumSha256: stored.report.body.witnessChecksumSha256, attemptId: stored.report.body.attemptId });

      // #626 binding resolution: the activation's witness binding and selection binding.
      const bindings = resolveMigrationWitnessBindings({ homeDir: home, generationId: GENERATION_ID });
      expect(bindings).toMatchObject({
        state: "resolved",
        witnesses: [{ kind: "activation", witnessChecksumSha256: stored.report.body.witnessChecksumSha256 }],
        selections: [{ kind: "activation", publicationId, witnessChecksumSha256: stored.report.body.witnessChecksumSha256 }],
      });

      // The target is healthy under the published selection for the
      // activation role, admitted through the transfer verifier exactly as
      // S6/S15 admitted it (B2). The daemon's own runtime verifier refuses
      // that same role (the transfer extras are outside the runtime manifest):
      // a successful activation does not prove the daemon can start; the
      // operator's grant swap in docs/migration-cutover.md comes next.
      const runtime = new PostgreSqlRuntime(transfer);
      try {
        expect(await checkMigrationTargetHealth(
          { runtime, expectedOwner: EXPECTED_OWNER },
          { verifyRuntimeSchema: verifyPostgreSqlTransferSchema },
        )).toMatchObject({ status: "healthy", readiness: { runtimeRole: ACTIVATION_ROLE, expectedOwner: EXPECTED_OWNER } });
        expect(await checkMigrationTargetHealth({ runtime, expectedOwner: EXPECTED_OWNER }))
          .toMatchObject({ status: "unhealthy", reason: "schema-mismatch" });
      } finally {
        await runtime.close();
      }
      // The activation's fenced lease on the project was taken and released by the drive's release phase.
      const leases = await db.migrator.query<{ operation: string; released: boolean }>({
        text: "SELECT operation, released_at IS NOT NULL AS released FROM lcm.fenced_leases "
          + "WHERE project_id = $1 AND operation LIKE 'backend-publication:postgresql:%'",
        values: [installation.remoteProjectId],
      }, { domain: "factory", operation: "activationIntegration" });
      expect(leases.rows.length).toBeGreaterThanOrEqual(1);
      expect(leases.rows.every((row) => row.released)).toBe(true);

      // A second call settles from durable state: same report, nothing re-driven.
      const settled = await runMigrationActivation(installation.input, deps);
      expect(settled).toMatchObject({ status: "activated", resumedFrom: "settled-active", identity: outcome.identity, report: outcome.report });
      const after = await previewMigrationActivation({ homeDir: home, generationId: GENERATION_ID });
      expect(after.checks.find((check) => check.name === "resume-point")).toMatchObject({ status: "ok", detail: "settled-active" });
      expect(after.checks.find((check) => check.name === "publication-journal")).toMatchObject({ status: "ok", detail: expect.stringContaining("(this generation)") });
    } finally {
      closeLcmConnection();
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
      await dropActivationRole(db);
    }
  });
}, 240_000);


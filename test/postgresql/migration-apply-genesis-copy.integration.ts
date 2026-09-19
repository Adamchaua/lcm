import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, expect, it } from "vitest";
import { assertHarnessReady, settings, withPostgreSqlTestDatabase } from "./harness.js";
import { grantPortablePostgreSql } from "./portable-fixture.js";
import {
  prepareSqliteMigrationEnrollment,
  authenticateSqliteMigrationSource,
  authenticateSqliteMigrationSourceBytes,
  captureAuthenticatedSqliteMigrationSource,
} from "../../src/migration/maintenance.js";
import {
  BackendPublicationCoordinator,
  backendPublicationCanonicalSha256,
  withBackendPublicationAppendBarrierAsync,
  readBackendMaintenanceJournal,
  type BackendPublicationDriver,
} from "../../src/storage/backend-publication.js";
import { PostgreSqlIdentityRepository } from "../../src/storage/postgresql/identity-repository.js";
import { localProjectIdentity } from "../../src/daemon/project.js";
import { MigrationManifestStore } from "../../src/migration/manifest-store.js";
import { classifyMigrationRecovery } from "../../src/migration/protocol.js";
import { performMigrationApplyGenesisAndCopy } from "../../src/migration/apply-genesis-copy.js";
import type { PostgreSqlTestDatabase } from "./harness.js";

beforeAll(assertHarnessReady);

/**
 * Builds a real, authenticated, held-and-captured SQLite generation against
 * a real PostgreSQL target database, mirroring
 * migration-copy.integration.ts's assembled fixture exactly — the only
 * mocked boundary is the remote *machine* identity session, never anything
 * this file's own claims depend on.
 */
async function preparedGeneration(db: PostgreSqlTestDatabase) {
  await grantPortablePostgreSql(db, { transfer: true });
  const home = mkdtempSync(join(tmpdir(), "migration-apply-genesis-copy-"));
  const cwd = join(home, "project");
  mkdirSync(cwd, { mode: 0o700 });
  const local = localProjectIdentity(cwd, home);
  const projectDir = join(home, ".lcm", "projects", local.id);
  mkdirSync(projectDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(home, ".lcm", "events"), { mode: 0o700 });
  writeFileSync(join(projectDir, "meta.json"), `${JSON.stringify({ cwd })}\n`, { mode: 0o600 });
  const enrolled = await prepareSqliteMigrationEnrollment({
    cwd, homeDir: home,
    targetConfig: { backend: "postgresql", postgresql: { ...settings(db.runtimeUrl), migrationRole: "lcm_test_migrator" } },
  });
  const remote = await new PostgreSqlIdentityRepository(db.runtime).createProject({
    machineId: enrolled.identity.machineId, displayName: "apply genesis copy target", path: cwd, normalizedPath: cwd,
  });
  const expectedIdentity = {
    id: remote.projectId, remoteProjectId: remote.projectId, localProjectId: local.id,
    machineId: enrolled.identity.machineId, canonical: cwd, selectedPath: cwd,
  };
  // expectedIdentity is the copy step's own caller-supplied target, matched
  // against openMigrationCopySource's comparison -- it is deliberately not
  // written into the local project map, whose remoteProjectId field is a
  // different fact entirely (multi-machine scope) that capture itself
  // requires to stay "local" (captureAuthenticatedSqliteMigrationSource
  // refuses a non-local scope on the absent-generation path).

  const unavailable = async (): Promise<never> => { throw new Error("v2 driver must not run for maintenance"); };
  const driver: BackendPublicationDriver = {
    observeLocalState: unavailable, publishProjectMap: unavailable, publishConfig: unavailable,
    restoreConfig: unavailable, restoreProjectMap: unavailable,
  };
  const entered = await withBackendPublicationAppendBarrierAsync(home, async (token) => {
    const authority = authenticateSqliteMigrationSource(cwd, home, token);
    const expectedSourceBytes = await authenticateSqliteMigrationSourceBytes(authority, { homeDir: home, lockToken: token });
    const held = await new BackendPublicationCoordinator({ homeDir: home, driver }).enterMaintenance({
      publicationId: "apply-genesis-copy.1", generationId: "apply-genesis-copy.1",
      sourceSelectionSha256: authority.sourceSelectionSha256, queueEvidenceSha256: expectedSourceBytes.checksumSha256,
      roster: [{ machineId: enrolled.identity.machineId, queueCutoff: "0000000000000000002", evidenceSha256: expectedSourceBytes.checksumSha256 }],
    }, token);
    return { authority, expectedSourceBytes, held };
  });
  const snapshot = await captureAuthenticatedSqliteMigrationSource(entered.authority, {
    homeDir: home, generationId: entered.held.generationId,
    maintenanceChecksumSha256: entered.held.checksumSha256, expectedSourceBytes: entered.expectedSourceBytes,
  });
  const heldAfterCapture = readBackendMaintenanceJournal(home)!;
  return {
    home, cwd, expectedIdentity, generationId: snapshot.artifact.generationId,
    maintenanceChecksumSha256: heldAfterCapture.checksumSha256, projectDir,
  };
}

it("mints a manifest from a real PostgreSQL probe and drives a real copy to completion for a freshly captured generation", async () => {
  await withPostgreSqlTestDatabase("apply-genesis-copy-target", async (db) => {
    const prepared = await preparedGeneration(db);
    try {
      const store = new MigrationManifestStore({ homeDir: prepared.home });
      expect(store.probeManifestPresence(prepared.generationId)).toEqual({ status: "absent" });

      const outcome = await performMigrationApplyGenesisAndCopy({
        homeDir: prepared.home, generationId: prepared.generationId,
        maintenanceChecksumSha256: prepared.maintenanceChecksumSha256,
        settings: settings(db.runtimeUrl), expectedOwner: "lcm_test_migrator", expectedIdentity: prepared.expectedIdentity,
        ownerProcessId: "apply-genesis-copy-owner", maxRecords: 1, maxBytes: 150994944,
      });

      expect(outcome.status).toBe("copied");
      if (outcome.status !== "copied") throw new Error("unreachable");
      expect(outcome.result.phase).toBe("copied");

      // Positive control: genesis really did create a real, durable
      // manifest — not just a claim in the returned summary.
      const manifest = store.read(prepared.generationId);
      expect(manifest.phase).toBe("copied");
      expect(manifest.reports.some((report) => report.kind === "dry-run")).toBe(true);
      expect(classifyMigrationRecovery(manifest)).toEqual({ action: "ready" });

      // Idempotence: re-applying genesis-and-copy against an already-copied
      // generation does not re-create the manifest or re-run genesis; it
      // observes the manifest already present and returns the same result.
      const second = await performMigrationApplyGenesisAndCopy({
        homeDir: prepared.home, generationId: prepared.generationId,
        maintenanceChecksumSha256: prepared.maintenanceChecksumSha256,
        settings: settings(db.runtimeUrl), expectedOwner: "lcm_test_migrator", expectedIdentity: prepared.expectedIdentity,
        ownerProcessId: "apply-genesis-copy-owner", maxRecords: 1, maxBytes: 150994944,
      });
      expect(second).toEqual(outcome);
    } finally {
      rmSync(prepared.home, { recursive: true, force: true });
    }
  });
}, 120000);

it("refuses capture-incomplete before ever touching PostgreSQL when the carried generationId's snapshot is not complete (section 4.7, enforced in the code path)", async () => {
  const home = mkdtempSync(join(tmpdir(), "migration-apply-genesis-copy-incomplete-"));
  try {
    const unreachableSettings = {
      url: "postgresql://unused:unused@127.0.0.1:1/unused",
      caFile: join(home, "does-not-exist.crt"),
      poolMax: 1, connectionTimeoutMs: 100, idleTimeoutMs: 100, statementTimeoutMs: 100,
    };
    const outcome = await performMigrationApplyGenesisAndCopy({
      homeDir: home, generationId: "never-captured-generation",
      maintenanceChecksumSha256: "a".repeat(64), settings: unreachableSettings,
      expectedOwner: "lcm_test_migrator",
      expectedIdentity: { id: "id", remoteProjectId: "id", localProjectId: "local", machineId: "018f0b5d-1234-4abc-8def-1234567890ab", canonical: "/unused", selectedPath: "/unused" },
      ownerProcessId: "owner", maxRecords: 1, maxBytes: 1024,
    });
    // Red-first proof this is capture-before-genesis and not merely a
    // connection failure: unreachableSettings would fail loudly and
    // differently (a network/TLS error, not this typed refusal) if
    // anything below the snapshot check ever ran.
    expect(outcome).toEqual({ status: "refuse", reason: "capture-incomplete", evidence: "snapshot-absent" });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

it("carries the caller-supplied maintenanceChecksumSha256 into the dry-run effect rather than re-deriving it from the live journal (section 4.9 exposure 2, red-first: a deliberately wrong carried value still lands, unchanged, in the durable manifest, which a re-read implementation could not produce)", async () => {
  await withPostgreSqlTestDatabase("apply-genesis-copy-cas", async (db) => {
    const prepared = await preparedGeneration(db);
    try {
      // The real, live journal checksum, read only for this test's own
      // verification -- never passed to the function under test.
      const liveChecksum = readBackendMaintenanceJournal(prepared.home)!.checksumSha256;
      expect(liveChecksum).toBe(prepared.maintenanceChecksumSha256);

      // A deliberately wrong carried value: it does not match the live
      // journal at all. Nothing in the copy machinery compares this
      // parameter against the journal (reauthenticateHeld compares the
      // *artifact's own embedded* checksum, sealed at capture time, never
      // this caller-supplied one), so if genesis carries it through rather
      // than re-reading the journal for itself, the operation still
      // succeeds and the wrong value shows up, unchanged, in the durable
      // effect it records.
      const wrongChecksum = "f".repeat(64);
      expect(wrongChecksum).not.toBe(liveChecksum);

      const outcome = await performMigrationApplyGenesisAndCopy({
        homeDir: prepared.home, generationId: prepared.generationId,
        maintenanceChecksumSha256: wrongChecksum,
        settings: settings(db.runtimeUrl), expectedOwner: "lcm_test_migrator", expectedIdentity: prepared.expectedIdentity,
        ownerProcessId: "apply-genesis-copy-cas-owner", maxRecords: 1, maxBytes: 150994944,
      });
      expect(outcome.status).toBe("copied");

      const store = new MigrationManifestStore({ homeDir: prepared.home });
      const manifest = store.read(prepared.generationId);
      const dryRunReport = manifest.reports.find((report) => report.kind === "dry-run");
      expect(dryRunReport).toBeDefined();

      // The recorded report's reportSha256 is exactly what genesis's own
      // documented computation produces from the *wrong, carried* value.
      // A re-read implementation would have used liveChecksum instead and
      // produced a different, non-matching hash here -- this is the exact
      // form the defect would take, not a hypothetical.
      const expectedFromCarriedWrongValue = backendPublicationCanonicalSha256({
        kind: "migration-apply-dry-run-effect", generationId: prepared.generationId, maintenanceChecksumSha256: wrongChecksum,
      });
      const expectedFromLiveReread = backendPublicationCanonicalSha256({
        kind: "migration-apply-dry-run-effect", generationId: prepared.generationId, maintenanceChecksumSha256: liveChecksum,
      });
      expect(expectedFromCarriedWrongValue).not.toBe(expectedFromLiveReread);
      expect(dryRunReport!.reportId).toBe(expectedFromCarriedWrongValue);
      expect(dryRunReport!.reportId).not.toBe(expectedFromLiveReread);
    } finally {
      rmSync(prepared.home, { recursive: true, force: true });
    }
  });
}, 120000);

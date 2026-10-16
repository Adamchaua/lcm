import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, expect, it, vi } from "vitest";
import { assertHarnessReady, settings, withPostgreSqlTestDatabase, type PostgreSqlTestDatabase } from "./harness.js";
import { grantPortablePostgreSql } from "./portable-fixture.js";
import { prepareSqliteMigrationEnrollment } from "../../src/migration/maintenance.js";
import { PostgreSqlIdentityRepository } from "../../src/storage/postgresql/identity-repository.js";
import { resolveProjectIdentity, clearProjectMapCache, normalizeProjectPath } from "../../src/project-map.js";
import { configPath } from "../../src/runtime-paths.js";
import { resolveMigrationPreflight } from "../../src/migration/cli-preflight.js";
import { performMigrationApply } from "../../src/migration/cli-apply.js";
import { MigrationManifestStore } from "../../src/migration/manifest-store.js";
import { classifyMigrationRecovery } from "../../src/migration/protocol.js";
import { closeLcmConnection } from "../../src/db/connection.js";

beforeAll(assertHarnessReady);

/**
 * The one composition-level proof the owner required: `cli-apply.ts`'s
 * full orchestration -- preflight (target resolution, reachability,
 * section 4.10's real destination-identity resolution against
 * PostgreSQL, base identity, occupancy-probed candidate resolution), the
 * section 9 confirmation fence, capture through the hold, and manifest
 * genesis and copy -- run assembled, against real PostgreSQL, with only
 * the daemon-presence classifier seamed (the single dependency that needs
 * a live daemon process this test does not start). Every other piece
 * already has its own dedicated real-PostgreSQL proof
 * (target-reachability.integration.ts, migration-copy.integration.ts,
 * migration-apply-genesis-copy.integration.ts, target-identity.test.ts's
 * mocked unit proof); this file exists because per-piece proofs cannot
 * show the assembled path still works end to end, which is exactly the
 * shape of defect this item is built to catch.
 *
 * **No `setRemoteProjectBinding` anywhere in this fixture, deliberately.**
 * Section 4.10 requires the local project map to stay unbound through
 * capture, genesis and copy -- preflight resolves (and, on first use,
 * mints) the destination project id directly against PostgreSQL itself,
 * for real, in this test. That is the mechanism under test; pre-linking
 * the project here would both defeat the point and make capture refuse
 * `multi-machine-installation` (`maintenance.ts:126-190`).
 */
async function preparedApplyTarget(
  db: PostgreSqlTestDatabase,
): Promise<{ home: string; cwd: string; pgSettings: ReturnType<typeof settings> }> {
  await grantPortablePostgreSql(db, { transfer: true });
  const home = mkdtempSync(join(tmpdir(), "cli-apply-roundtrip-"));
  const cwd = join(home, "project");
  mkdirSync(cwd, { mode: 0o700 });
  mkdirSync(join(home, ".lcm"), { mode: 0o700 });

  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  const local = resolveProjectIdentity(cwd);
  vi.unstubAllEnvs();

  const projectDir = join(home, ".lcm", "projects", local.id);
  mkdirSync(projectDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(home, ".lcm", "events"), { mode: 0o700 });
  writeFileSync(join(projectDir, "meta.json"), `${JSON.stringify({ cwd })}\n`, { mode: 0o600 });

  const pgSettings = settings(db.runtimeUrl);
  await prepareSqliteMigrationEnrollment({
    cwd, homeDir: home,
    targetConfig: { backend: "postgresql", postgresql: { ...pgSettings, migrationRole: "lcm_test_migrator" } },
  });

  // The real config.json a migration command reads for real, per the
  // root's ruling that target-config.ts resolves storage.postgresql
  // independent of the active storage.backend (still "sqlite" here,
  // proving that independence rather than assuming it). `url`/`caFile`
  // are deliberately NOT written here -- config.json's ordinary
  // (non-migration) load path validates storage.postgresql with
  // allowRuntimeSecrets=false and refuses a stored secret there by
  // design (confirmed by a real ConfigValidationError the first time
  // this fixture wrote them in), so a real operator supplies those two
  // through LCM_POSTGRES_URL / LCM_POSTGRES_CA_FILE instead, exactly as
  // this fixture does below.
  writeFileSync(configPath(home), `${JSON.stringify({
    storage: {
      backend: "sqlite",
      postgresql: {
        migrationRole: "lcm_test_migrator",
        poolMax: pgSettings.poolMax,
        connectionTimeoutMs: pgSettings.connectionTimeoutMs,
        idleTimeoutMs: pgSettings.idleTimeoutMs,
        statementTimeoutMs: pgSettings.statementTimeoutMs,
      },
    },
  })}\n`, { mode: 0o600 });

  return { home, cwd, pgSettings };
}

function presentPresence() {
  return { status: "present" as const, storageBackend: "sqlite", pid: 1, daemonInstanceId: "cli-apply-roundtrip" };
}

it(
  "drives a real end-to-end apply -- preflight (including real destination-identity resolution/minting against PostgreSQL), confirmation fence, capture, manifest genesis and copy -- against real PostgreSQL, with only the daemon presence classifier seamed, and proves the local project map stays unbound throughout",
  async () => {
    await withPostgreSqlTestDatabase("cli-apply-roundtrip", async (db) => {
      const { home, cwd, pgSettings } = await preparedApplyTarget(db);
      try {
        // `plan`'s own real preflight: target config, reachability,
        // destination-identity resolution against real PostgreSQL, base
        // identity, and occupancy-probed candidate resolution all run for
        // real. Only presence is seamed, matching the owner's exact scope
        // for this test. resolveProjectIdentity (used inside preflight's
        // identity step) reads the LCM home directory from the process
        // environment like every other production caller of it, so it is
        // stubbed to this fixture's own temp home for the duration of
        // this one call.
        vi.stubEnv("HOME", home);
        vi.stubEnv("USERPROFILE", home);
        vi.stubEnv("LCM_POSTGRES_URL", pgSettings.url);
        vi.stubEnv("LCM_POSTGRES_CA_FILE", pgSettings.caFile);
        let planPreflight;
        try {
          planPreflight = await resolveMigrationPreflight({
            cwd, homeDir: home,
            _operationsForTesting: { classifyPresence: async () => presentPresence() },
          });
        } finally {
          vi.unstubAllEnvs();
        }
        expect(planPreflight.status).toBe("ready");
        if (planPreflight.status !== "ready") throw new Error("unreachable");
        expect(planPreflight.candidate.disposition).toBe("fresh");
        expect(planPreflight.presence).toEqual(presentPresence());
        expect(planPreflight.expectedIdentity.id).toBe(planPreflight.expectedIdentity.remoteProjectId);

        // Positive control: the destination project genuinely exists in
        // PostgreSQL now, at exactly the (machine_id, normalized_path) key
        // section 4.10 specifies -- not merely claimed in the returned
        // identity object.
        vi.stubEnv("HOME", home);
        vi.stubEnv("USERPROFILE", home);
        const local = resolveProjectIdentity(cwd);
        vi.unstubAllEnvs();
        const remoteRepository = new PostgreSqlIdentityRepository(db.runtime);
        const bound = await remoteRepository.resolveProject(
          planPreflight.expectedIdentity.machineId, normalizeProjectPath(local.canonical),
        );
        expect(bound?.projectId).toBe(planPreflight.expectedIdentity.id);

        // Section 4.10's own requirement, proven rather than assumed: the
        // local project map never received a remoteProjectId binding.
        vi.stubEnv("HOME", home);
        vi.stubEnv("USERPROFILE", home);
        clearProjectMapCache();
        const stillUnbound = resolveProjectIdentity(cwd);
        vi.unstubAllEnvs();
        expect(stillUnbound.remoteProjectId).toBeUndefined();

        // `apply --confirm-generation <id>`: the id plan would have printed,
        // re-supplied to apply's own confirmation fence.
        const result = await performMigrationApply({
          cwd, homeDir: home,
          confirmGenerationId: planPreflight.candidate.generationId,
          _preflight: async () => planPreflight,
        });

        expect(result).toEqual({
          status: "ok", generationId: planPreflight.candidate.generationId, applied: true, phase: "copied",
          daemonPresence: presentPresence(),
        });

        // Positive control: genesis and copy really happened, not just a
        // claim in the returned summary -- read the durable manifest back.
        const store = new MigrationManifestStore({ homeDir: home });
        const manifest = store.read(planPreflight.candidate.generationId);
        expect(manifest.phase).toBe("copied");
        expect(manifest.reports.some((report) => report.kind === "dry-run")).toBe(true);
        expect(classifyMigrationRecovery(manifest)).toEqual({ action: "ready" });

        // Not re-checked here after copy: the maintenance hold this
        // candidate leaves in place after a successful apply (abort/resume
        // are out of scope) fences ordinary consumer reads, including
        // resolveProjectIdentity's own withBackendPublicationConsumerLock
        // -- confirmed by a real BackendPublicationJournalError the first
        // time this test tried it. The two checks earlier in this test
        // (the real PostgreSQL row and the still-unbound local map) are
        // the observations available before the hold fences them.

        // Idempotent re-apply: the same operator command (the same
        // plan-derived preflight and the same confirmed token) re-invoked
        // against the now-terminal generation returns the identical
        // outcome rather than re-driving capture, genesis or copy a
        // second time.
        const second = await performMigrationApply({
          cwd, homeDir: home,
          confirmGenerationId: planPreflight.candidate.generationId,
          _preflight: async () => planPreflight,
        });
        expect(second).toEqual(result);
      } finally {
        closeLcmConnection();
        rmSync(home, { recursive: true, force: true });
      }
    });
  },
  180000,
);

import { defineConfig } from "vitest/config";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";

const POSTGRESQL_RUN_ID_PATTERN = /^[0-9a-f]{32}$/u;
const CENSUS_COST_TEST = "test/postgresql/migration-verification-census-cost.integration.ts";

export function postgresqlVitestCacheDir(
  environment: NodeJS.ProcessEnv = process.env,
  processId = process.pid,
): string {
  const runId = environment.LCM_TEST_POSTGRES_RUN_ID;
  const namespace = runId && POSTGRESQL_RUN_ID_PATTERN.test(runId)
    ? runId
    : `process-${processId}`;
  return join(tmpdir(), "vitest-lcm-postgresql-cache", namespace);
}

export function createPostgresqlVitestConfiguration(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  cpuCount: () => number = availableParallelism,
) {
  // PostgreSQL integration tests also run from local agent worktrees. Keep their
  // fork pool within the local allocation; CI sizes the pool from the runner.
  const maxWorkers = environment.CI === "true" || environment.CI === "1" ? Math.max(1, cpuCount()) : 1;
  const forkProbe = environment.LCM_TEST_POSTGRES_FORK_PROBE === "true";
  // The census-cost measurement is opt-in: it is a long-running measurement,
  // not a correctness check, so only the dedicated script includes it.
  const censusCost = !forkProbe && environment.LCM_TEST_POSTGRES_CENSUS_COST === "true";
  return {
    cacheDir: postgresqlVitestCacheDir(environment),
    test: {
      pool: "forks",
      globalSetup: ["test/setup/runtime-home-global.ts"],
      setupFiles: ["test/setup/isolate-runtime-home.ts"],
      include: forkProbe
        ? ["test/postgresql/fixtures/persistent-worker.integration.ts"]
        : censusCost
          ? [CENSUS_COST_TEST]
          : ["test/postgresql/**/*.integration.ts"],
      exclude: forkProbe || censusCost
        ? []
        : [
          "test/postgresql/fixtures/persistent-worker.integration.ts",
          CENSUS_COST_TEST,
          ...(environment.LCM_TEST_POSTGRES_INNER_CI === "true"
            ? ["test/postgresql/signal.integration.ts"]
            : []),
        ],
      fileParallelism: true,
      maxWorkers,
      testTimeout: 30_000,
      hookTimeout: 30_000,
    },
  };
}

export default defineConfig(createPostgresqlVitestConfiguration());

import { resolveMigrationPreflight, type MigrationPreflightResult } from "./cli-preflight.js";

/**
 * The `plan` command's CLI orchestration (section 3): entirely
 * non-mutating. Runs the shared preflight and reports its result --
 * candidate generation id, disposition, and the positively-established
 * daemon presence -- without ever taking the hold, capturing, or writing
 * anything. Section 9's genesis repair depends on this: `apply
 * --confirm-generation <id>` must be able to compare against exactly the
 * id `plan` printed, which is why this function calls the same
 * `resolveMigrationPreflight` `apply`'s own preflight uses rather than a
 * second implementation of the same resolution.
 */

export type MigrationPlanOutcome =
  | Readonly<{
    status: "ok";
    generationId: string;
    disposition: string;
    daemonStorageBackend: string;
  }>
  | Readonly<{ status: "refuse"; reason: string; evidence?: string }>;

export async function performMigrationPlan(input: Readonly<{
  cwd: string;
  homeDir: string;
  /**
   * @internal Test-only escape hatch to reuse resolveMigrationPreflight's
   * own injection seam without duplicating its composition here.
   */
  _preflight?: () => Promise<MigrationPreflightResult>;
}>): Promise<MigrationPlanOutcome> {
  const runPreflight = input._preflight ?? (() => resolveMigrationPreflight({ cwd: input.cwd, homeDir: input.homeDir }));
  const preflight = await runPreflight();
  if (preflight.status === "refuse") {
    return preflight;
  }
  return {
    status: "ok",
    generationId: preflight.candidate.generationId,
    disposition: preflight.candidate.disposition,
    daemonStorageBackend: preflight.presence.storageBackend,
  };
}

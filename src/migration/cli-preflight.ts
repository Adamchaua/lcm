import { configPath } from "../runtime-paths.js";
import { localProjectIdentity } from "../daemon/project.js";
import {
  resolveStorageIdentityContext,
  StorageIdentityConfigurationError,
} from "../storage/identity-context.js";
import type { StorageIdentityContext } from "../storage/contracts.js";
import type { ResolvedPostgreSqlConfig } from "../daemon/config.js";
import { resolveMigrationTargetConfig } from "./target-config.js";
import { classifyMigrationDaemonPresence, type MigrationDaemonPresence } from "./daemon-presence.js";
import { verifyMigrationTargetReachability } from "./target-reachability.js";
import {
  computeMigrationGenerationBase,
  nonSecretPostgreSqlTargetCoordinates,
  MigrationIdentityError,
} from "./generation-identity.js";
import {
  resolveMigrationApplyCandidate,
  type MigrationApplyCandidateResolution,
} from "./candidate.js";

/**
 * The shared preflight both `plan` and `apply` compose identically (section
 * 3: `plan` "owns" preconditions, target reachability, roster, daemon
 * presence, and computing the candidate generation id -- exactly this
 * function's job). Built as one shared function specifically so the two
 * commands cannot silently diverge in composition order: `plan`'s preview
 * and `apply`'s real precondition check must reach the same generation id
 * from the same live state for the section 9 confirmation fence to guard
 * anything (see `candidate.ts`'s own agreement tests, which this function
 * calls the same `resolveMigrationApplyCandidate` those tests hold to that
 * standard).
 *
 * **Never collapses a three-valued primitive into a boolean at this call
 * site.** `classifyMigrationDaemonPresence`'s three outcomes are handled as
 * three distinct branches below, not `if (present) ... else refuse`:
 * `unresolvable` refuses exit 5 (evidence could not be established) and
 * `authoritatively-absent` refuses exit 2 (a real, different fact -- no
 * daemon is running, and the operator has a real action: start one) rather
 * than being folded into the same case as `unresolvable`.
 */

export type MigrationPreflightResult =
  | Readonly<{
    status: "ready";
    targetConfig: ResolvedPostgreSqlConfig;
    presence: Extract<MigrationDaemonPresence, { status: "present" }>;
    candidate: Extract<MigrationApplyCandidateResolution, { status: "candidate" }>;
    expectedIdentity: StorageIdentityContext;
    base: string;
  }>
  | Readonly<{ status: "refuse"; reason: string; evidence?: string }>;

export type MigrationPreflightOperations = Readonly<{
  resolveTargetConfig: typeof resolveMigrationTargetConfig;
  classifyPresence: typeof classifyMigrationDaemonPresence;
  verifyReachability: typeof verifyMigrationTargetReachability;
  resolveIdentity: typeof resolveStorageIdentityContext;
  resolveCandidate: typeof resolveMigrationApplyCandidate;
  resolveTargetCoordinates: typeof nonSecretPostgreSqlTargetCoordinates;
  computeBase: typeof computeMigrationGenerationBase;
}>;

export async function resolveMigrationPreflight(input: Readonly<{
  cwd: string;
  homeDir: string;
  /**
   * @internal Deterministic failure-injection seam for tests only, matching
   * the `_operationsForTesting` convention used elsewhere in
   * `src/migration/`. Each of the five composed steps can be overridden
   * independently so a test can prove this function refuses at exactly the
   * step it claims to, without needing a real PostgreSQL connection or a
   * real daemon for every branch.
   */
  _operationsForTesting?: Partial<MigrationPreflightOperations>;
}>): Promise<MigrationPreflightResult> {
  const resolveTargetConfig = input._operationsForTesting?.resolveTargetConfig ?? resolveMigrationTargetConfig;
  const classifyPresence = input._operationsForTesting?.classifyPresence ?? classifyMigrationDaemonPresence;
  const verifyReachability = input._operationsForTesting?.verifyReachability ?? verifyMigrationTargetReachability;
  const resolveIdentity = input._operationsForTesting?.resolveIdentity ?? resolveStorageIdentityContext;
  const resolveCandidate = input._operationsForTesting?.resolveCandidate ?? resolveMigrationApplyCandidate;
  const resolveTargetCoordinates = input._operationsForTesting?.resolveTargetCoordinates ?? nonSecretPostgreSqlTargetCoordinates;
  const computeBase = input._operationsForTesting?.computeBase ?? computeMigrationGenerationBase;

  // 1. Target config: storage.postgresql (plus LCM_POSTGRES_* fallbacks),
  // independent of the active backend, per the root's ruling.
  const targetResolution = resolveTargetConfig(configPath(input.homeDir));
  if (targetResolution.status === "refuse") {
    return { status: "refuse", reason: targetResolution.reason, evidence: targetResolution.evidence };
  }

  // 2. Daemon presence: three-valued, never collapsed.
  const presence = await classifyPresence({ homeDir: input.homeDir });
  if (presence.status === "unresolvable") {
    return { status: "refuse", reason: "daemon-presence-unresolvable", evidence: presence.evidence };
  }
  if (presence.status === "authoritatively-absent") {
    // A real, different fact from "unresolvable": we positively know no
    // daemon is running, and the operator has a real action (start one).
    return { status: "refuse", reason: "daemon-not-running" };
  }

  // 3. Target reachability: a real connection, TLS and role verified.
  const verification = await verifyReachability({
    settings: targetResolution.config.postgresql,
    expectedOwner: targetResolution.config.postgresql.migrationRole,
  });
  if (verification.status === "refuse") {
    return { status: "refuse", reason: verification.reason, evidence: verification.evidence };
  }

  // 4. This project's PostgreSQL identity binding (section 4.4/4.9's
  // ownership plumbing): reuses resolveStorageIdentityContext verbatim
  // rather than re-deriving expectedIdentity's fields.
  const local = localProjectIdentity(input.cwd, input.homeDir);
  let expectedIdentity: StorageIdentityContext;
  try {
    expectedIdentity = resolveIdentity(
      targetResolution.config,
      local,
      input.homeDir,
      input.cwd,
    );
  } catch (error) {
    if (error instanceof StorageIdentityConfigurationError) {
      return { status: "refuse", reason: "unbound-postgresql-project" };
    }
    throw error;
  }

  // 5. The stable narrow base identity (section 4.1).
  const targetCoordinates = resolveTargetCoordinates(targetResolution.config.postgresql.url);
  let base: string;
  try {
    base = computeBase({
      physicalProjectId: local.id,
      canonicalPath: local.canonical,
      target: targetCoordinates,
    });
  } catch (error) {
    if (error instanceof MigrationIdentityError) {
      return { status: "refuse", reason: `generation-${error.reason}`, evidence: error.evidence ?? undefined };
    }
    throw error;
  }

  // 6. The candidate generation id preview (section 9's genesis repair).
  const candidate = await resolveCandidate({ cwd: input.cwd, homeDir: input.homeDir, base });
  if (candidate.status === "refuse") {
    return candidate;
  }

  return { status: "ready", targetConfig: targetResolution.config, presence, candidate, expectedIdentity, base };
}

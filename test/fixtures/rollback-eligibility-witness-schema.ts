/**
 * Test-only reference implementation of witness-schema-FROZEN-v2.md section 9
 * (`classifyRollbackMode`) and small builders for the section 2-6 shapes it
 * and #626's rollback-eligibility.ts consume.
 *
 * This is deliberately NOT production code and is never imported by
 * anything under src/. #626's implementer was told explicitly not to create
 * src/migration/activation-witness.ts, copy it, or stub its behavior in
 * production; this file exists so tests of the *consumer* boundary
 * (RollbackModeClassifier in rollback-eligibility.ts) can inject a
 * faithful, independently-written implementation of the frozen algorithm
 * rather than a fixture whose shape happens to match whatever the
 * production code under test expects.
 */

import { createHash } from "node:crypto";
import { PORTABLE_RECORD_DOMAIN_ORDER } from "../../src/storage/portable-record.js";
import type {
  MigrationCanonicalDeltaShape,
  MigrationCensusVectorShape,
  MigrationDestinationIdentityShape,
  MigrationSchemaWitnessShape,
  MigrationSelectionBinding,
  MigrationWitnessBinding,
  MigrationWitnessResolution,
  OperabilityFactResolution,
  RollbackModeClassification,
  RollbackModeClassifier,
} from "../../src/migration/rollback-eligibility.js";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** A canonical delta with one deterministic value per domain, easy to mutate. */
export function fixtureCanonicalDelta(seed: string): MigrationCanonicalDeltaShape {
  return {
    version: 1,
    domains: PORTABLE_RECORD_DOMAIN_ORDER.map((domain) => ({
      domain,
      recordCount: 10,
      terminalIdentitySha256: sha256(`${seed}:${domain}:terminal`),
    })),
  };
}

/** A census vector with one deterministic value per domain, easy to mutate. */
export function fixtureCensusVector(seed: string): MigrationCensusVectorShape {
  return {
    version: 1,
    domains: PORTABLE_RECORD_DOMAIN_ORDER.map((domain) => ({
      domain,
      recordCount: 10,
      prefixSha256: sha256(`${seed}:${domain}:prefix`),
    })),
    contentSha256: sha256(`${seed}:content`),
  };
}

/** Mutates exactly one domain's record count in an otherwise identical delta. */
export function driftCanonicalDelta(
  delta: MigrationCanonicalDeltaShape,
  domainIndex: number,
): MigrationCanonicalDeltaShape {
  return {
    ...delta,
    domains: delta.domains.map((entry, index) => (
      index === domainIndex ? { ...entry, recordCount: entry.recordCount + 1 } : entry
    )),
  };
}

/** Mutates exactly one domain's content digest in an otherwise identical census. */
export function driftCensusVector(
  census: MigrationCensusVectorShape,
  domainIndex: number,
): MigrationCensusVectorShape {
  return {
    ...census,
    domains: census.domains.map((entry, index) => (
      index === domainIndex ? { ...entry, prefixSha256: sha256(`${entry.prefixSha256}:drift`) } : entry
    )),
    contentSha256: sha256(`${census.contentSha256}:drift`),
  };
}

export function fixtureDestinationIdentity(seed: string): MigrationDestinationIdentityShape {
  return {
    version: 1,
    sealedWitnessSha256: sha256(`${seed}:sealed-witness`),
    systemIdentifier: `${seed}-system-identifier`,
  };
}

export function fixtureSchemaWitness(seed: string): MigrationSchemaWitnessShape {
  return {
    version: 1,
    migrationsSha256: sha256(`${seed}:migrations`),
    searchConfigurationSha256: sha256(`${seed}:search-config`),
    collationSha256: sha256(`${seed}:collation`),
    sequenceStateSha256: sha256(`${seed}:sequence-state`),
  };
}

function sameCanonicalDelta(left: MigrationCanonicalDeltaShape, right: MigrationCanonicalDeltaShape): boolean {
  if (left.domains.length !== right.domains.length) return false;
  return left.domains.every((entry, index) => {
    const other = right.domains[index]!;
    return entry.domain === other.domain
      && entry.recordCount === other.recordCount
      && entry.terminalIdentitySha256 === other.terminalIdentitySha256;
  });
}

function sameCensusVector(left: MigrationCensusVectorShape, right: MigrationCensusVectorShape): boolean {
  if (left.contentSha256 !== right.contentSha256) return false;
  if (left.domains.length !== right.domains.length) return false;
  return left.domains.every((entry, index) => {
    const other = right.domains[index]!;
    return entry.domain === other.domain
      && entry.recordCount === other.recordCount
      && entry.prefixSha256 === other.prefixSha256;
  });
}

/**
 * A faithful, independently-written implementation of
 * witness-schema-FROZEN-v2.md section 9:
 *
 * 1. Delta differs from the baseline -> post-write (a changed count or
 *    terminal identity is canonical evidence).
 * 2. Delta equals the baseline -> inconclusive; the only legal successor is
 *    the census.
 * 3. With a census supplied: equality -> pre-write; inequality -> post-write.
 * 4. Delta equal and no census supplied -> refuse. Never default.
 */
export const referenceClassifyRollbackMode: RollbackModeClassifier = (input): RollbackModeClassification => {
  if (!sameCanonicalDelta(input.postEpochDelta, input.canonicalDeltaBaseline)) {
    return { mode: "post-write" };
  }
  if (input.postEpochCensus === null) {
    return { mode: "refused", reason: "canonical delta is unchanged and no census was supplied" };
  }
  if (sameCensusVector(input.postEpochCensus, input.censusVector)) {
    return { mode: "pre-write" };
  }
  return { mode: "post-write" };
};

/** A resolution with exactly one activation selection at the given identifiers. */
export function fixtureResolvedWithActivationSelection(input: Readonly<{
  epochId: string;
  attemptId: string;
  manifestRevision: number;
  witnessChecksumSha256: string;
  publicationId: string;
}>): MigrationWitnessResolution {
  const witness: MigrationWitnessBinding = {
    kind: "activation",
    epochId: input.epochId,
    attemptId: input.attemptId,
    manifestRevision: input.manifestRevision,
    witnessChecksumSha256: input.witnessChecksumSha256,
  };
  const selection: MigrationSelectionBinding = { ...witness, publicationId: input.publicationId };
  return { state: "resolved", witnesses: [witness], selections: [selection] };
}

/**
 * The "witnessed but unpublished" state: a witness was persisted (an
 * ordinary crash can happen here) but its selection was never prepared, so
 * `selections` is empty. Reachable by ordinary operation, not a pathology.
 */
export function fixtureWitnessedButUnpublished(input: Readonly<{
  epochId: string;
  attemptId: string;
  manifestRevision: number;
  witnessChecksumSha256: string;
}>): MigrationWitnessResolution {
  return {
    state: "resolved",
    witnesses: [{ kind: "activation", ...input }],
    selections: [],
  };
}

export const fixtureAuthoritativelyAbsent: MigrationWitnessResolution = { state: "authoritatively-absent" };

export function fixtureUnresolvable(reason: string): MigrationWitnessResolution {
  return { state: "unresolvable", reason };
}

// ---------------------------------------------------------------------------
// Operability-fact fixtures, coordinator-seam-FROZEN.md v6 section 16.
// Boundary C: #626 owns the production reader, so these are plain builders
// for the already-resolved value -- not a mock of the production I/O path,
// which is exercised for real in test/migration/backend-publication-operability.test.ts.
// ---------------------------------------------------------------------------

export function fixtureOperabilityPresent(valueSha256 = "e".repeat(64)): OperabilityFactResolution {
  return { state: "present", valueSha256 };
}

export const fixtureOperabilityAbsent: OperabilityFactResolution = { state: "authoritatively-absent" };

export function fixtureOperabilityUnresolvable(reason: string): OperabilityFactResolution {
  return { state: "unresolvable", reason };
}

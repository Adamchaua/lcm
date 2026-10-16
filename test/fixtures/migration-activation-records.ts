/**
 * Test builders for the activation records rollback consumes. Every record is
 * minted by activation-witness.ts's own create* functions, so identities and
 * checksums are the production derivations; nothing here re-implements them.
 */

import { createHash } from "node:crypto";
import { PORTABLE_RECORD_DOMAIN_ORDER } from "../../src/storage/portable-record.js";
import {
  createMigrationActivationAttempt,
  createMigrationActivationEpoch,
  createMigrationActivationWitness,
  createMigrationQuiescenceFence,
  type MigrationActivationAttempt,
  type MigrationActivationEpoch,
  type MigrationActivationWitness,
  type MigrationCanonicalDelta,
  type MigrationCensusVector,
  type MigrationDestinationIdentity,
  type MigrationSchemaWitness,
} from "../../src/migration/activation-witness.js";

export function fixtureSha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** A canonical delta with one deterministic value per domain, easy to mutate. */
export function fixtureCanonicalDelta(seed: string): MigrationCanonicalDelta {
  return {
    version: 1,
    domains: PORTABLE_RECORD_DOMAIN_ORDER.map((domain) => ({
      domain,
      recordCount: 10,
      terminalIdentitySha256: fixtureSha(seed + ":" + domain + ":terminal"),
    })),
  };
}

/** A census vector with one deterministic value per domain, easy to mutate. */
export function fixtureCensusVector(seed: string): MigrationCensusVector {
  return {
    version: 1,
    domains: PORTABLE_RECORD_DOMAIN_ORDER.map((domain) => ({
      domain,
      recordCount: 10,
      prefixSha256: fixtureSha(seed + ":" + domain + ":prefix"),
    })),
    contentSha256: fixtureSha(seed + ":content"),
  };
}

/** Mutates exactly one domain's record count in an otherwise identical delta. */
export function driftCanonicalDelta(delta: MigrationCanonicalDelta, domainIndex: number): MigrationCanonicalDelta {
  return {
    ...delta,
    domains: delta.domains.map((entry, index) => (
      index === domainIndex ? { ...entry, recordCount: entry.recordCount + 1 } : entry
    )),
  };
}

/** Mutates exactly one domain's content digest in an otherwise identical census. */
export function driftCensusVector(census: MigrationCensusVector, domainIndex: number): MigrationCensusVector {
  return {
    ...census,
    domains: census.domains.map((entry, index) => (
      index === domainIndex ? { ...entry, prefixSha256: fixtureSha(entry.prefixSha256 + ":drift") } : entry
    )),
    contentSha256: fixtureSha(census.contentSha256 + ":drift"),
  };
}

export function fixtureDestinationIdentity(seed: string): MigrationDestinationIdentity {
  return {
    version: 1,
    sealedWitnessSha256: fixtureSha(seed + ":sealed-witness"),
    systemIdentifier: "7" + String(seed.length),
  };
}

export function fixtureSchemaWitness(seed: string): MigrationSchemaWitness {
  return {
    version: 1,
    migrationsSha256: fixtureSha(seed + ":migrations"),
    searchConfigurationSha256: fixtureSha(seed + ":search-config"),
    collationSha256: fixtureSha(seed + ":collation"),
    sequenceStateSha256: fixtureSha(seed + ":sequence-state"),
  };
}

export type FixtureEpochInput = Readonly<{
  generationId: string;
  seed?: string;
  manifestRevision?: number;
  destinationIdentity?: MigrationDestinationIdentity;
  censusVector?: MigrationCensusVector;
  schemaWitness?: MigrationSchemaWitness;
}>;

export function fixtureEpoch(input: FixtureEpochInput): MigrationActivationEpoch {
  const seed = input.seed ?? "epoch";
  return createMigrationActivationEpoch({
    generationId: input.generationId,
    manifestRevision: input.manifestRevision ?? 1,
    manifestChecksumSha256: fixtureSha(seed + ":manifest"),
    verificationReportId: "report-" + seed,
    verificationReportSha256: fixtureSha(seed + ":report"),
    projectMapWitnessSha256: fixtureSha(seed + ":project-map"),
    queueClassificationWitnessSha256: fixtureSha(seed + ":queue"),
    destinationIdentity: input.destinationIdentity ?? fixtureDestinationIdentity(seed),
    censusVector: input.censusVector ?? fixtureCensusVector(seed + ":census"),
    schemaWitness: input.schemaWitness ?? fixtureSchemaWitness(seed),
  });
}

export type FixtureAttemptInput = Readonly<{
  epoch: MigrationActivationEpoch;
  seed?: string;
  canonicalDeltaBaseline?: MigrationCanonicalDelta;
  activationRecomputedCensus?: MigrationCensusVector;
}>;

export function fixtureAttempt(input: FixtureAttemptInput): MigrationActivationAttempt {
  const seed = input.seed ?? "attempt";
  return createMigrationActivationAttempt({
    epochId: input.epoch.epochId,
    selectionAuthority: {
      version: 1,
      resourceType: "postgresql-destination",
      resourceKey: "destination-" + seed,
      fencingToken: "1",
      ownerProcessId: "process-" + seed,
    },
    canonicalDeltaBaseline: input.canonicalDeltaBaseline ?? fixtureCanonicalDelta(seed + ":baseline"),
    activationRecomputedCensus: input.activationRecomputedCensus ?? input.epoch.censusVector,
    intraActivationWatermark: null,
    quiescenceFence: createMigrationQuiescenceFence({ kind: "test-quiescence", payload: { seed } }),
  });
}

export function fixtureActivationWitness(
  epoch: MigrationActivationEpoch,
  attempt: MigrationActivationAttempt,
): MigrationActivationWitness {
  return createMigrationActivationWitness({
    kind: "activation", epoch, attempt, postEpochDelta: null, postEpochCensus: null, rollbackMode: null,
  });
}

export function fixtureRollbackWitness(input: Readonly<{
  epoch: MigrationActivationEpoch;
  attempt: MigrationActivationAttempt;
  postEpochDelta: MigrationCanonicalDelta;
  postEpochCensus: MigrationCensusVector | null;
  rollbackMode: "pre-write" | "post-write";
}>): MigrationActivationWitness {
  return createMigrationActivationWitness({ kind: "rollback", ...input });
}


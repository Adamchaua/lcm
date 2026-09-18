/**
 * Tests for src/migration/rollback-eligibility.ts.
 *
 * Per the epic's standing rule (plan-v2 section 0 for item #626): every
 * check here names the two independent observations it compares, and each
 * side is deliberately corrupted at least once elsewhere in this file so
 * the corresponding assertion is proven breakable, not merely passing.
 */

import { describe, expect, it, vi } from "vitest";
import {
  evaluateRollbackEligibility,
  resolveActivationAuthority,
  type MigrationSelectionBinding,
  type RollbackAuthoritativeContext,
  type RollbackEligibilityObservation,
} from "../../src/migration/rollback-eligibility.js";
import { PORTABLE_RECORD_SCHEMA_SHA256 } from "../../src/storage/portable-record.js";
import {
  driftCanonicalDelta,
  driftCensusVector,
  fixtureAuthoritativelyAbsent,
  fixtureCanonicalDelta,
  fixtureCensusVector,
  fixtureDestinationIdentity,
  fixtureResolvedWithActivationSelection,
  fixtureSchemaWitness,
  fixtureUnresolvable,
  fixtureWitnessedButUnpublished,
  referenceClassifyRollbackMode,
} from "../fixtures/rollback-eligibility-witness-schema.js";

describe("resolveActivationAuthority", () => {
  it("resolves to authoritative when an activation selection binding exists", () => {
    const resolution = fixtureResolvedWithActivationSelection({
      epochId: "epoch-1",
      attemptId: "attempt-1",
      manifestRevision: 3,
      witnessChecksumSha256: "a".repeat(64),
      publicationId: "publication-1",
    });
    const authority = resolveActivationAuthority(resolution);
    expect(authority).toEqual({
      status: "authoritative",
      selection: {
        kind: "activation",
        epochId: "epoch-1",
        attemptId: "attempt-1",
        manifestRevision: 3,
        witnessChecksumSha256: "a".repeat(64),
        publicationId: "publication-1",
      },
    });
  });

  it("resolves to unactivated when the only selection binding is kind rollback, not activation", () => {
    // Breaks the previous test's premise on its own axis: same shape, kind
    // flipped. If the filter in resolveActivationAuthority ever stopped
    // checking kind, this would wrongly resolve to authoritative.
    const resolution = {
      state: "resolved" as const,
      witnesses: [],
      selections: [{
        kind: "rollback" as const,
        epochId: "epoch-1",
        attemptId: "attempt-1",
        manifestRevision: 3,
        witnessChecksumSha256: "a".repeat(64),
        publicationId: "publication-1",
      }],
    };
    expect(resolveActivationAuthority(resolution)).toEqual({ status: "unactivated" });
  });

  it("resolves to unactivated for the witnessed-but-unpublished state", () => {
    const resolution = fixtureWitnessedButUnpublished({
      epochId: "epoch-2",
      attemptId: "attempt-2",
      manifestRevision: 1,
      witnessChecksumSha256: "b".repeat(64),
    });
    expect(resolution.state).toBe("resolved");
    expect((resolution as { witnesses: unknown[] }).witnesses).toHaveLength(1);
    expect(resolveActivationAuthority(resolution)).toEqual({ status: "unactivated" });
  });

  it("resolves to unactivated for authoritative absence, and to refused for unresolvability -- proving the two are not collapsed", () => {
    expect(resolveActivationAuthority(fixtureAuthoritativelyAbsent)).toEqual({ status: "unactivated" });
    const unresolvable = resolveActivationAuthority(fixtureUnresolvable("artifact directory read failed"));
    expect(unresolvable.status).toBe("refused");
    // Substituting one state for the other must change the answer. If a
    // caller ever collapsed "authoritatively-absent" into "unresolvable"
    // (or vice versa) this equality would start failing in one direction.
    expect(resolveActivationAuthority(fixtureAuthoritativelyAbsent))
      .not.toEqual(resolveActivationAuthority(fixtureUnresolvable("artifact directory read failed")));
  });

  it("refuses when the resolution is unresolvable, carrying the reason", () => {
    expect(resolveActivationAuthority(fixtureUnresolvable("home directory could not be opened"))).toEqual({
      status: "refused",
      reason: "activation authority is unresolvable: home directory could not be opened",
    });
  });

  it("takes the last activation-kind selection when more than one is present", () => {
    const older: MigrationSelectionBinding = {
      kind: "activation",
      epochId: "epoch-older",
      attemptId: "attempt-older",
      manifestRevision: 1,
      witnessChecksumSha256: "c".repeat(64),
      publicationId: "publication-older",
    };
    const newer: MigrationSelectionBinding = {
      kind: "activation",
      epochId: "epoch-newer",
      attemptId: "attempt-newer",
      manifestRevision: 5,
      witnessChecksumSha256: "d".repeat(64),
      publicationId: "publication-newer",
    };
    const resolution = { state: "resolved" as const, witnesses: [], selections: [older, newer] };
    expect(resolveActivationAuthority(resolution)).toEqual({ status: "authoritative", selection: newer });
  });
});

function observation(overrides: Partial<RollbackEligibilityObservation> = {}): RollbackEligibilityObservation {
  const identity = fixtureDestinationIdentity("dest");
  return {
    observedPortableRecordSchemaSha256: "will be overridden by callers that need a real match",
    destinationIdentity: identity,
    postEpochDelta: fixtureCanonicalDelta("delta"),
    postEpochCensus: null,
    manifestDestinationWitnessSha256: identity.sealedWitnessSha256,
    ...overrides,
  };
}

describe("evaluateRollbackEligibility: unactivated branch", () => {
  it("passes through a refused authority verbatim, without invoking the classifier", () => {
    const classifier = vi.fn(referenceClassifyRollbackMode);
    const decision = evaluateRollbackEligibility({
      authority: { status: "refused", reason: "activation authority is unresolvable: home directory could not be opened" },
      authoritativeContext: null,
      observation: observation(),
      classifyRollbackMode: classifier,
    });
    expect(decision).toEqual({
      eligibility: "refused",
      reason: "activation authority is unresolvable: home directory could not be opened",
    });
    expect(classifier).not.toHaveBeenCalled();
  });

  it("returns unactivated pre-write when the destination identity matches the manifest's sealed witness", () => {
    const decision = evaluateRollbackEligibility({
      authority: { status: "unactivated" },
      authoritativeContext: null,
      observation: observation(),
      classifyRollbackMode: referenceClassifyRollbackMode,
    });
    expect(decision).toEqual({ eligibility: "unactivated", mode: "pre-write" });
  });

  it("refuses when the destination identity does not match the manifest's sealed witness", () => {
    // Breakable independently of the previous test: same authority, same
    // classifier, only the comparand on one side changed.
    const decision = evaluateRollbackEligibility({
      authority: { status: "unactivated" },
      authoritativeContext: null,
      observation: observation({ manifestDestinationWitnessSha256: "0".repeat(64) }),
      classifyRollbackMode: referenceClassifyRollbackMode,
    });
    expect(decision).toEqual({
      eligibility: "refused",
      reason: "destination identity does not match the manifest's sealed witness",
    });
  });
});

function authoritativeContext(overrides: Partial<{
  destinationIdentity: RollbackAuthoritativeContext["epoch"]["destinationIdentity"];
  censusVector: RollbackAuthoritativeContext["epoch"]["censusVector"];
  schemaWitness: RollbackAuthoritativeContext["epoch"]["schemaWitness"];
  canonicalDeltaBaseline: RollbackAuthoritativeContext["attempt"]["canonicalDeltaBaseline"];
}> = {}): RollbackAuthoritativeContext {
  return {
    epoch: {
      destinationIdentity: overrides.destinationIdentity ?? fixtureDestinationIdentity("dest"),
      censusVector: overrides.censusVector ?? fixtureCensusVector("census"),
      schemaWitness: overrides.schemaWitness ?? fixtureSchemaWitness("schema"),
    },
    attempt: {
      canonicalDeltaBaseline: overrides.canonicalDeltaBaseline ?? fixtureCanonicalDelta("delta"),
    },
  };
}

describe("evaluateRollbackEligibility: authoritative branch", () => {
  const AUTHORITY = {
    status: "authoritative" as const,
    selection: {
      kind: "activation" as const,
      epochId: "epoch-1",
      attemptId: "attempt-1",
      manifestRevision: 1,
      witnessChecksumSha256: "a".repeat(64),
      publicationId: "publication-1",
    },
  };

  it("refuses when the authoritative context is missing, without invoking the classifier", () => {
    const classifier = vi.fn(referenceClassifyRollbackMode);
    const decision = evaluateRollbackEligibility({
      authority: AUTHORITY,
      authoritativeContext: null,
      observation: observation(),
      classifyRollbackMode: classifier,
    });
    expect(decision.eligibility).toBe("refused");
    expect(classifier).not.toHaveBeenCalled();
  });

  it("refuses on identity mismatch before the classifier is ever consulted", () => {
    // The classifier is spied so this test can prove the identity gate
    // short-circuits it, not merely that the final answer happens to be
    // "refused" for some other reason. If the gate were removed, the
    // classifier would run and could wrongly grant pre-write.
    const context = authoritativeContext({ destinationIdentity: fixtureDestinationIdentity("other-dest") });
    const classifier = vi.fn(referenceClassifyRollbackMode);
    const decision = evaluateRollbackEligibility({
      authority: AUTHORITY,
      authoritativeContext: context,
      observation: observation(),
      classifyRollbackMode: classifier,
    });
    expect(decision).toEqual({
      eligibility: "refused",
      reason: "destination identity does not match the authoritative epoch",
    });
    expect(classifier).not.toHaveBeenCalled();
  });

  it("proceeds to the classifier and grants pre-write when identity matches and the delta is unchanged with a matching census", () => {
    const delta = fixtureCanonicalDelta("shared-delta");
    const census = fixtureCensusVector("shared-census");
    const context = authoritativeContext({ canonicalDeltaBaseline: delta, censusVector: census });
    const decision = evaluateRollbackEligibility({
      authority: AUTHORITY,
      authoritativeContext: context,
      observation: observation({
        observedPortableRecordSchemaSha256: PORTABLE_RECORD_SCHEMA_SHA256,
        postEpochDelta: delta,
        postEpochCensus: census,
      }),
      classifyRollbackMode: referenceClassifyRollbackMode,
    });
    expect(decision).toEqual({ eligibility: "pre-write", mode: "pre-write" });
  });

  it("grants post-write when the delta has drifted from the baseline -- breakable by removing the drift", () => {
    const delta = fixtureCanonicalDelta("shared-delta-2");
    const context = authoritativeContext({ canonicalDeltaBaseline: delta });
    const decision = evaluateRollbackEligibility({
      authority: AUTHORITY,
      authoritativeContext: context,
      observation: observation({ postEpochDelta: driftCanonicalDelta(delta, 0), postEpochCensus: null }),
      classifyRollbackMode: referenceClassifyRollbackMode,
    });
    expect(decision).toEqual({ eligibility: "post-write", mode: "post-write" });
  });

  it("grants post-write when the delta is unchanged but the census has drifted -- breakable by removing the drift", () => {
    const delta = fixtureCanonicalDelta("shared-delta-3");
    const census = fixtureCensusVector("shared-census-3");
    const context = authoritativeContext({ canonicalDeltaBaseline: delta, censusVector: census });
    const decision = evaluateRollbackEligibility({
      authority: AUTHORITY,
      authoritativeContext: context,
      observation: observation({
        observedPortableRecordSchemaSha256: PORTABLE_RECORD_SCHEMA_SHA256,
        postEpochDelta: delta,
        postEpochCensus: driftCensusVector(census, 0),
      }),
      classifyRollbackMode: referenceClassifyRollbackMode,
    });
    expect(decision).toEqual({ eligibility: "post-write", mode: "post-write" });
  });

  it("refuses rather than defaulting when the delta is unchanged and no census was supplied", () => {
    const delta = fixtureCanonicalDelta("shared-delta-4");
    const context = authoritativeContext({ canonicalDeltaBaseline: delta });
    const decision = evaluateRollbackEligibility({
      authority: AUTHORITY,
      authoritativeContext: context,
      observation: observation({ postEpochDelta: delta, postEpochCensus: null }),
      classifyRollbackMode: referenceClassifyRollbackMode,
    });
    expect(decision).toEqual({
      eligibility: "refused",
      reason: "canonical delta is unchanged and no census was supplied",
    });
  });

  it("refuses on schema-incomparable census with a distinct reason, never falling through to post-write", () => {
    const delta = fixtureCanonicalDelta("shared-delta-5");
    const census = fixtureCensusVector("shared-census-5");
    const context = authoritativeContext({ canonicalDeltaBaseline: delta, censusVector: census });
    const decision = evaluateRollbackEligibility({
      authority: AUTHORITY,
      authoritativeContext: context,
      observation: observation({
        observedPortableRecordSchemaSha256: "0".repeat(64),
        postEpochDelta: delta,
        postEpochCensus: census,
      }),
      classifyRollbackMode: referenceClassifyRollbackMode,
    });
    expect(decision).toEqual({
      eligibility: "refused",
      reason: "observed census schema is not comparable to the frozen portable record schema",
    });
  });

  it("matches the schema check on a real match -- proving the previous refusal is the schema comparison, not something else", () => {
    const delta = fixtureCanonicalDelta("shared-delta-6");
    const census = fixtureCensusVector("shared-census-6");
    const context = authoritativeContext({ canonicalDeltaBaseline: delta, censusVector: census });
    const decision = evaluateRollbackEligibility({
      authority: AUTHORITY,
      authoritativeContext: context,
      observation: observation({
        observedPortableRecordSchemaSha256: PORTABLE_RECORD_SCHEMA_SHA256,
        postEpochDelta: delta,
        postEpochCensus: census,
      }),
      classifyRollbackMode: referenceClassifyRollbackMode,
    });
    expect(decision).toEqual({ eligibility: "pre-write", mode: "pre-write" });
  });
});

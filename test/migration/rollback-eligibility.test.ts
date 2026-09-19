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
  fixtureOperabilityAbsent,
  fixtureOperabilityPresent,
  fixtureOperabilityUnresolvable,
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
    const authority = resolveActivationAuthority({ resolution, operabilityFact: fixtureOperabilityAbsent });
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

  it("resolves to authoritative when a binding exists even though the destination is currently operable -- the operability fact is irrelevant once a binding is published", () => {
    // Same premise as the previous test with the operability fact flipped
    // to "present". Row 3 of section 15's table: any activation binding
    // present wins regardless of the operability fact's state. If the
    // implementation ever started consulting the operability fact before
    // checking for a binding, this would wrongly refuse.
    const resolution = fixtureResolvedWithActivationSelection({
      epochId: "epoch-1",
      attemptId: "attempt-1",
      manifestRevision: 3,
      witnessChecksumSha256: "a".repeat(64),
      publicationId: "publication-1",
    });
    const authority = resolveActivationAuthority({ resolution, operabilityFact: fixtureOperabilityPresent() });
    expect(authority.status).toBe("authoritative");
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
    expect(resolveActivationAuthority({ resolution, operabilityFact: fixtureOperabilityAbsent }))
      .toEqual({ status: "unactivated" });
  });

  it("resolves to unactivated for the witnessed-but-unpublished state when the destination is not yet operable", () => {
    const resolution = fixtureWitnessedButUnpublished({
      epochId: "epoch-2",
      attemptId: "attempt-2",
      manifestRevision: 1,
      witnessChecksumSha256: "b".repeat(64),
    });
    expect(resolution.state).toBe("resolved");
    expect((resolution as { witnesses: unknown[] }).witnesses).toHaveLength(1);
    expect(resolveActivationAuthority({ resolution, operabilityFact: fixtureOperabilityAbsent }))
      .toEqual({ status: "unactivated" });
  });

  it("resolves to unactivated for authoritative absence, and to refused for unresolvability -- proving the two are not collapsed", () => {
    expect(resolveActivationAuthority({ resolution: fixtureAuthoritativelyAbsent, operabilityFact: fixtureOperabilityAbsent }))
      .toEqual({ status: "unactivated" });
    const unresolvable = resolveActivationAuthority({
      resolution: fixtureUnresolvable("artifact directory read failed"),
      operabilityFact: fixtureOperabilityAbsent,
    });
    expect(unresolvable.status).toBe("refused");
    // Substituting one state for the other must change the answer. If a
    // caller ever collapsed "authoritatively-absent" into "unresolvable"
    // (or vice versa) this equality would start failing in one direction.
    expect(resolveActivationAuthority({ resolution: fixtureAuthoritativelyAbsent, operabilityFact: fixtureOperabilityAbsent }))
      .not.toEqual(resolveActivationAuthority({
        resolution: fixtureUnresolvable("artifact directory read failed"),
        operabilityFact: fixtureOperabilityAbsent,
      }));
  });

  it("refuses when the witness resolution is unresolvable, carrying which resolver and reason", () => {
    expect(resolveActivationAuthority({
      resolution: fixtureUnresolvable("home directory could not be opened"),
      operabilityFact: fixtureOperabilityAbsent,
    })).toEqual({
      status: "refused",
      reason: "witness-resolution:unresolvable: home directory could not be opened",
    });
  });

  it("refuses when the operability fact is unresolvable, carrying which resolver and reason -- even though the witness resolution is cleanly resolved", () => {
    // Breakable independently of the previous test: witness resolution is
    // healthy here (authoritatively-absent, not itself unresolvable); only
    // the operability fact is unresolvable. This proves the operability
    // resolver's own unresolvable branch is checked, not merely that some
    // unresolvable field anywhere produces a refusal.
    expect(resolveActivationAuthority({
      resolution: fixtureAuthoritativelyAbsent,
      operabilityFact: fixtureOperabilityUnresolvable("lock contention"),
    })).toEqual({
      status: "refused",
      reason: "operability-fact:unresolvable: lock contention",
    });
  });

  it("refuses when the operability fact is unresolvable even though an activation binding exists -- row 4 overrides row 3", () => {
    // The table's row 4 ("unresolvable | any") takes precedence over row 3
    // ("binding present -> normal classification") regardless of the
    // binding's presence. Breakable by reordering the checks: if the
    // binding-present branch ran first, this would wrongly resolve to
    // authoritative instead of refusing.
    const resolution = fixtureResolvedWithActivationSelection({
      epochId: "epoch-1",
      attemptId: "attempt-1",
      manifestRevision: 3,
      witnessChecksumSha256: "a".repeat(64),
      publicationId: "publication-1",
    });
    expect(resolveActivationAuthority({
      resolution,
      operabilityFact: fixtureOperabilityUnresolvable("unsafe storage"),
    })).toEqual({
      status: "refused",
      reason: "operability-fact:unresolvable: unsafe storage",
    });
  });

  it("refuses as published-but-unbound, never unactivated, when the destination is operable but no binding exists -- section 15's core repair", () => {
    // This is the exact destructive-direction defect section 15 exists to
    // close: version 4 would have answered "unactivated" here (empty
    // selections), licensing a pre-write reversal that discards committed
    // writes the destination already has. Paired with the next test, which
    // flips only the operability fact and gets "unactivated" instead --
    // proving this branch is the operability fact, not the resolution shape
    // (which is identical, "witnessed but unpublished", in both tests).
    const resolution = fixtureWitnessedButUnpublished({
      epochId: "epoch-3",
      attemptId: "attempt-3",
      manifestRevision: 2,
      witnessChecksumSha256: "f".repeat(64),
    });
    const decision = resolveActivationAuthority({ resolution, operabilityFact: fixtureOperabilityPresent() });
    expect(decision.status).toBe("refused");
    expect(decision).not.toEqual({ status: "unactivated" });
    expect((decision as { reason: string }).reason).toContain("published-but-unbound");
  });

  it("resolves to unactivated on the identical resolution shape when the operability fact is authoritatively absent instead of present", () => {
    const resolution = fixtureWitnessedButUnpublished({
      epochId: "epoch-3",
      attemptId: "attempt-3",
      manifestRevision: 2,
      witnessChecksumSha256: "f".repeat(64),
    });
    expect(resolveActivationAuthority({ resolution, operabilityFact: fixtureOperabilityAbsent }))
      .toEqual({ status: "unactivated" });
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
    expect(resolveActivationAuthority({ resolution, operabilityFact: fixtureOperabilityAbsent }))
      .toEqual({ status: "authoritative", selection: newer });
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

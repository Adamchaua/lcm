/**
 * Pure rollback-eligibility decision logic for item #626.
 *
 * BOUNDARY NOTE (read before touching this file). Two couplings in this
 * module are deliberately left as required dependency-injected parameters
 * rather than imports, because the modules that own them do not exist on
 * `main` yet:
 *
 *  - `classifyRollbackMode` is owned by #624's `src/migration/activation-witness.ts`.
 *  - the witness/selection resolution consumed by {@link resolveActivationAuthority}
 *    is produced by #625's implementation of `resolveMigrationWitnessBindings`
 *    (coordinator-seam-FROZEN.md v4 section 14).
 *
 * Neither dependency has a default or fallback implementation anywhere in
 * this file. There is nothing here that could silently satisfy a production
 * caller with wrong behavior if the real implementation is never wired in --
 * every caller, test or production, must supply an actual function. That is
 * what keeps this from type-checking as a production wrapper around either
 * missing module. Once #624 and #625 land, replace the local type mirrors
 * below with imports from their real modules and delete this note.
 *
 * This module performs no I/O. Every input is data the caller already
 * fetched (a live readback, a resolved witness/selection index, or a fully
 * resolved epoch/attempt record). Resolving *which* artifact to fetch by ID
 * is this module's job (see {@link resolveActivationAuthority}); actually
 * fetching bytes from disk is not.
 */

import { PORTABLE_RECORD_SCHEMA_SHA256, type PortableDomain } from "../storage/portable-record.js";

// ---------------------------------------------------------------------------
// Local mirrors of witness-schema-FROZEN-v2.md (sections 2-6, unchanged by
// v3) and witness-schema-FROZEN-v3.md (sections 7, 11). These are NOT a
// second implementation of activation-witness.ts: nothing here computes a
// checksum, derives an identity, or performs the classification those
// sections assign to that module. They exist only so this file's exported
// function signatures type-check without importing a module #626 must not
// create.
// ---------------------------------------------------------------------------

/** Mirrors witness-schema-FROZEN-v2.md section 2. */
export type MigrationSelectionAuthorityShape = Readonly<{
  version: 1;
  resourceType: string;
  resourceKey: string;
  fencingToken: string;
  ownerProcessId: string;
}>;

/** Mirrors witness-schema-FROZEN-v2.md section 3. */
export type MigrationDestinationIdentityShape = Readonly<{
  version: 1;
  sealedWitnessSha256: string;
  systemIdentifier: string;
}>;

/** Mirrors witness-schema-FROZEN-v2.md section 4. */
export type MigrationCanonicalDeltaShape = Readonly<{
  version: 1;
  domains: readonly Readonly<{ domain: PortableDomain; recordCount: number; terminalIdentitySha256: string }>[];
}>;

/** Mirrors witness-schema-FROZEN-v2.md section 5. */
export type MigrationCensusVectorShape = Readonly<{
  version: 1;
  domains: readonly Readonly<{ domain: PortableDomain; recordCount: number; prefixSha256: string }>[];
  contentSha256: string;
}>;

/** Mirrors witness-schema-FROZEN-v2.md section 6. */
export type MigrationSchemaWitnessShape = Readonly<{
  version: 1;
  migrationsSha256: string;
  searchConfigurationSha256: string;
  collationSha256: string;
  sequenceStateSha256: string;
}>;

/**
 * Mirrors witness-schema-FROZEN-v3.md section 7. Every field is a
 * deterministic function of the accepted #624 report and the selected
 * manifest -- no attempt-time observation, no fencing token, no live
 * capture. `destinationIdentity`, `censusVector` and `schemaWitness` live
 * here; `canonicalDeltaBaseline`, `selectionAuthority` and
 * `quiescenceFence` were moved out to the attempt record (section 11).
 */
export type MigrationActivationEpochShape = Readonly<{
  version: 1;
  epochId: string;
  generationId: string;
  manifestRevision: number;
  manifestChecksumSha256: string;
  destinationIdentity: MigrationDestinationIdentityShape;
  censusVector: MigrationCensusVectorShape;
  schemaWitness: MigrationSchemaWitnessShape;
}>;

/**
 * Mirrors witness-schema-FROZEN-v3.md section 11. One immutable record per
 * activation attempt; its identity is allowed to differ between attempts.
 * `canonicalDeltaBaseline` and `activationRecomputedCensus` are captured
 * live in the fenced activation transaction.
 */
export type MigrationActivationAttemptShape = Readonly<{
  version: 1;
  attemptId: string;
  epochId: string;
  selectionAuthority: MigrationSelectionAuthorityShape;
  canonicalDeltaBaseline: MigrationCanonicalDeltaShape;
  activationRecomputedCensus: MigrationCensusVectorShape;
}>;

// ---------------------------------------------------------------------------
// coordinator-seam-FROZEN.md v4 section 14, verbatim.
// ---------------------------------------------------------------------------

export type MigrationWitnessBinding = Readonly<{
  kind: "activation" | "rollback";
  epochId: string;
  attemptId: string;
  manifestRevision: number;
  witnessChecksumSha256: string;
}>;

export type MigrationSelectionBinding = Readonly<{
  kind: "activation" | "rollback";
  epochId: string;
  attemptId: string;
  manifestRevision: number;
  witnessChecksumSha256: string;
  publicationId: string;
}>;

export type MigrationWitnessResolution =
  | Readonly<{
      state: "resolved";
      witnesses: readonly MigrationWitnessBinding[];
      selections: readonly MigrationSelectionBinding[];
    }>
  | Readonly<{ state: "authoritatively-absent" }>
  | Readonly<{ state: "unresolvable"; reason: string }>;

/**
 * Boundary A. #625 owns the implementation (`resolveMigrationWitnessBindings`).
 * The `authoritatively-absent` branch must be produced only by a positively
 * authenticated read finding nothing; `unresolvable` is for every other
 * failure to read authoritatively. This module never collapses the two --
 * see {@link resolveActivationAuthority}, which branches on `state`
 * explicitly rather than treating a missing/thrown value as either.
 */
export type MigrationWitnessResolver = (
  input: Readonly<{ homeDir: string; generationId: string }>,
) => MigrationWitnessResolution;

/**
 * Boundary B. Mirrors witness-schema-FROZEN-v2.md section 9's signature
 * exactly. #624 owns the implementation. Refuses (never defaults) when the
 * delta is equal and no census is supplied.
 */
export type RollbackModeClassification =
  | Readonly<{ mode: "pre-write" }>
  | Readonly<{ mode: "post-write" }>
  | Readonly<{ mode: "refused"; reason: string }>;

export type RollbackModeClassifier = (
  input: Readonly<{
    postEpochDelta: MigrationCanonicalDeltaShape;
    canonicalDeltaBaseline: MigrationCanonicalDeltaShape;
    postEpochCensus: MigrationCensusVectorShape | null;
    censusVector: MigrationCensusVectorShape;
  }>,
) => RollbackModeClassification;

// ---------------------------------------------------------------------------
// Section 12 (epoch absence, one direction only) as amended by section 14
// (witnesses/selections split). Pure: takes an already-resolved
// MigrationWitnessResolution, never performs the read itself.
// ---------------------------------------------------------------------------

export type ActivationAuthority =
  | Readonly<{ status: "unactivated" }>
  | Readonly<{ status: "authoritative"; selection: MigrationSelectionBinding }>
  | Readonly<{ status: "refused"; reason: string }>;

/**
 * Decides activation authority per coordinator-seam-FROZEN.md v4 section 14:
 * `unactivated` iff no selection binding of kind `activation` appears
 * anywhere in `selections`. This is a positively published fact, never an
 * inference from witness presence, epoch presence, or any journal phase.
 *
 * `authoritatively-absent` and `unresolvable` are never collapsed: absence
 * resolves to `unactivated` (no selection was ever published, so nothing to
 * discard), while an unresolvable read refuses outright. Substituting one
 * for the other must change this function's answer, and it does, by
 * construction of the branch below.
 */
export function resolveActivationAuthority(
  resolution: MigrationWitnessResolution,
): ActivationAuthority {
  if (resolution.state === "unresolvable") {
    return { status: "refused", reason: `activation authority is unresolvable: ${resolution.reason}` };
  }
  if (resolution.state === "authoritatively-absent") {
    return { status: "unactivated" };
  }
  // state === "resolved". A non-empty "witnesses" array with an empty
  // "selections" array is the reachable "witnessed but unpublished" state
  // (an ordinary crash between persisting a witness and preparing its
  // selection) and resolves to "unactivated" here for the same reason as
  // authoritative absence: no selection was ever published.
  const activationSelections = resolution.selections.filter((selection) => selection.kind === "activation");
  if (activationSelections.length === 0) return { status: "unactivated" };
  const authoritative = activationSelections[activationSelections.length - 1]!;
  return { status: "authoritative", selection: authoritative };
}

// ---------------------------------------------------------------------------
// Full eligibility decision. Combines the authority resolution above with
// the identity gate, schema-bound census comparability, and the injected
// classifier, in the order plan-v2 section 1 mandates: identity first and
// separately (refusing before any durable change), then the delta (which
// may only ever conclude change), then the census (the only witness that
// may conclude cleanliness).
// ---------------------------------------------------------------------------

/**
 * The authoritative epoch and attempt records named by
 * {@link ActivationAuthority}'s `selection` when its status is
 * `"authoritative"`. Fetching these by `epochId`/`attemptId` from whatever
 * artifact store #624/#625 end up providing is the caller's job (rollback.ts);
 * this module only consumes the result.
 */
export type RollbackAuthoritativeContext = Readonly<{
  epoch: Pick<MigrationActivationEpochShape, "destinationIdentity" | "censusVector" | "schemaWitness">;
  attempt: Pick<MigrationActivationAttemptShape, "canonicalDeltaBaseline">;
}>;

/** A single dedicated-snapshot readback, per plan-v2 section 5 step 4/10. */
export type RollbackEligibilityObservation = Readonly<{
  /** The schema this observation's census was computed under. */
  observedPortableRecordSchemaSha256: string;
  /** Fresh destination identity read in the same dedicated snapshot. */
  destinationIdentity: MigrationDestinationIdentityShape;
  /** Fresh canonical delta read in the same dedicated snapshot. */
  postEpochDelta: MigrationCanonicalDeltaShape;
  /** Fresh census, present only when the delta was found equal to the baseline. */
  postEpochCensus: MigrationCensusVectorShape | null;
  /**
   * The manifest's own sealed destination witness (the five-field formula
   * `readPostgreSqlPortableWitness` seals, per witness-schema-FROZEN-v2.md
   * section 3). This is the only comparand available in the `unactivated`
   * case, per plan-v2 section 5 step 5.
   */
  manifestDestinationWitnessSha256: string;
}>;

export type RollbackEligibilityDecision =
  | Readonly<{ eligibility: "unactivated"; mode: "pre-write" }>
  | Readonly<{ eligibility: "pre-write"; mode: "pre-write" }>
  | Readonly<{ eligibility: "post-write"; mode: "post-write" }>
  | Readonly<{ eligibility: "refused"; reason: string }>;

function sameDestinationIdentity(
  left: MigrationDestinationIdentityShape,
  right: MigrationDestinationIdentityShape,
): boolean {
  return left.sealedWitnessSha256 === right.sealedWitnessSha256
    && left.systemIdentifier === right.systemIdentifier;
}

export function evaluateRollbackEligibility(input: Readonly<{
  authority: ActivationAuthority;
  /** Required exactly when `authority.status === "authoritative"`. */
  authoritativeContext: RollbackAuthoritativeContext | null;
  observation: RollbackEligibilityObservation;
  classifyRollbackMode: RollbackModeClassifier;
}>): RollbackEligibilityDecision {
  const { authority, authoritativeContext, observation, classifyRollbackMode } = input;

  if (authority.status === "refused") {
    return { eligibility: "refused", reason: authority.reason };
  }

  if (authority.status === "unactivated") {
    // No epoch to compare against; the only available comparand is the
    // manifest's own sealed destination witness. Sufficient for
    // "unactivated" and insufficient for any other eligibility, per
    // plan-v2 section 5 step 5.
    if (observation.manifestDestinationWitnessSha256 !== observation.destinationIdentity.sealedWitnessSha256) {
      return { eligibility: "refused", reason: "destination identity does not match the manifest's sealed witness" };
    }
    return { eligibility: "unactivated", mode: "pre-write" };
  }

  // authority.status === "authoritative"
  if (authoritativeContext === null) {
    return {
      eligibility: "refused",
      reason: "authoritative attempt resolved but its epoch/attempt record was not supplied",
    };
  }

  // Identity gate first and separately, refusing before any durable change
  // and before the classifier is ever consulted.
  if (!sameDestinationIdentity(authoritativeContext.epoch.destinationIdentity, observation.destinationIdentity)) {
    return { eligibility: "refused", reason: "destination identity does not match the authoritative epoch" };
  }

  // Census comparability is schema-bound: compare the schema first and
  // refuse with a distinct reason rather than falling to post-write, since
  // a new-schema destination is not proof of a write.
  if (
    observation.postEpochCensus !== null
    && observation.observedPortableRecordSchemaSha256 !== PORTABLE_RECORD_SCHEMA_SHA256
  ) {
    return { eligibility: "refused", reason: "observed census schema is not comparable to the frozen portable record schema" };
  }

  const classification = classifyRollbackMode({
    postEpochDelta: observation.postEpochDelta,
    canonicalDeltaBaseline: authoritativeContext.attempt.canonicalDeltaBaseline,
    postEpochCensus: observation.postEpochCensus,
    censusVector: authoritativeContext.epoch.censusVector,
  });

  if (classification.mode === "refused") return { eligibility: "refused", reason: classification.reason };
  if (classification.mode === "pre-write") return { eligibility: "pre-write", mode: "pre-write" };
  return { eligibility: "post-write", mode: "post-write" };
}


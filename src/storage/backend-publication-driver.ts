import {
  applyBackendPublicationConfigFile,
} from "../config-manager.js";
import {
  applyBackendPublicationProjectMapFile,
} from "../project-map.js";
import {
  BackendPublicationCoordinator,
  captureBackendPublicationState,
  type BackendPublicationDriver,
  type BackendPublicationFenceRecord,
  type BackendPublicationObserver,
  type BackendPublicationRemoteContext,
} from "./backend-publication.js";

/**
 * Production adapter over the three optional remote-guard hooks a {@link
 * BackendPublicationDriver} may implement. Both current Epic #92 consumers
 * (#625 activation, #626 rollback) settled on delegation as the production
 * answer, shaped as an IDEMPOTENT SAME-TUPLE ADOPT: both consumers acquire
 * their PostgreSQL advisory lease before the coordinator is ever involved,
 * so {@link acquireRemoteGuard} is always reached with the lease already
 * existing and already owned by the caller. A production implementation
 * therefore adopts the existing tuple idempotently; it does not acquire a
 * fresh one.
 *
 * This module does not implement this interface. The module it would
 * delegate to (#625's activation-lease module) does not exist at the base
 * this driver was built against, and the exact adoption semantics are an
 * open joint question between #625 and #626. Defining the interface here,
 * ungrounded in an implementation, keeps that shape the obvious one for the
 * next author to satisfy rather than leaving it to be rediscovered.
 *
 * Two properties the provider must honour, load-bearing enough to repeat
 * here rather than leave to be rediscovered by reading the coordinator:
 *
 * - The coordinator's own release phase ({@link
 *   BackendPublicationCoordinator}'s internal `#releaseAll`) frees the
 *   fence on the completed path. A provider must not release it again
 *   after handoff back to its caller.
 * - Expiry is not release. The coordinator's release path requires an
 *   UNEXPIRED row before it will call {@link releaseRemoteGuard} — an
 *   expired fence is reacquired and only the successor is released. A
 *   provider whose own lease has expired by the time the coordinator asks
 *   it to release must take the fence over (acquire a fresh row) before
 *   releasing it, not attempt to release the expired one directly.
 */
export interface BackendPublicationRemoteGuardProvider {
  acquireRemoteGuard(
    input: BackendPublicationRemoteContext,
  ): Promise<BackendPublicationFenceRecord>;
  readRemoteGuard(
    input: BackendPublicationRemoteContext,
    operation: "acquire" | "release",
  ): Promise<BackendPublicationFenceRecord | null>;
  releaseRemoteGuard(
    input: BackendPublicationRemoteContext
      & Readonly<{ fence: BackendPublicationFenceRecord }>,
  ): Promise<void>;
}

/**
 * An EXPLICIT, no-default choice of remote-guard behaviour for a produced
 * driver or coordinator.
 *
 * There is no default because absence is not inert. When a driver leaves
 * `acquireRemoteGuard` or `readRemoteGuard` undefined, the coordinator's
 * internal `#acquireAll` transitions the journal straight to the
 * `"guarded"` phase (backend-publication.ts, around line 3975) without
 * ever contacting a remote fence. That does not disable the remote path —
 * it makes the coordinator DURABLY RECORD a positive result that the
 * publication is guarded, in the journal, while nothing guarded it, at a
 * moment when a real PostgreSQL fence row may already exist and may be held
 * by someone else. A journal entry that was never compared to anything is
 * not evidence, and recording it as though it were is the family of defect
 * this Epic keeps finding in new shapes.
 *
 * `{ mode: "absent", acknowledged: true }` therefore does not mean "no
 * remote backend is involved". It means: the caller explicitly acknowledges
 * that the resulting journal will record the publication as guarded without
 * a guard ever having run. A caller cannot reach this path by omitting a
 * choice; it has to name it, and the `acknowledged: true` field exists so
 * that naming it is not itself accidental (a stray `{ mode: "absent" }`
 * literal without the sibling field is not the same shape and is refused).
 *
 * `{ mode: "delegated", provider }` wires all three remote-guard hooks to
 * the caller-supplied {@link BackendPublicationRemoteGuardProvider}.
 */
export type BackendPublicationRemoteGuardChoice =
  | Readonly<{ mode: "absent"; acknowledged: true }>
  | Readonly<{ mode: "delegated"; provider: BackendPublicationRemoteGuardProvider }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertRemoteGuardChoice(
  remoteGuard: unknown,
): asserts remoteGuard is BackendPublicationRemoteGuardChoice {
  if (!isRecord(remoteGuard)) {
    throw new TypeError(
      "backend publication remote guard choice must be an explicit object with a \"mode\" field",
    );
  }
  const mode = remoteGuard.mode;
  if (mode === "absent") {
    if (remoteGuard.acknowledged !== true) {
      throw new TypeError(
        "backend publication remote guard absence must set acknowledged: true; "
          + "omitting the remote guard is not a valid way to reach this path",
      );
    }
    return;
  }
  if (mode === "delegated") {
    const provider = remoteGuard.provider;
    if (!isRecord(provider)) {
      throw new TypeError(
        "backend publication remote guard delegation requires a provider object",
      );
    }
    for (const method of ["acquireRemoteGuard", "readRemoteGuard", "releaseRemoteGuard"] as const) {
      if (typeof provider[method] !== "function") {
        throw new TypeError(
          `backend publication remote guard provider is missing required method: ${method}`,
        );
      }
    }
    return;
  }
  throw new TypeError(
    `backend publication remote guard choice must have mode "absent" or "delegated", received: ${JSON.stringify(mode)}`,
  );
}

export type CreateBackendPublicationDriverOptions = Readonly<{
  remoteGuard: BackendPublicationRemoteGuardChoice;
}>;

/**
 * Build the ONE production {@link BackendPublicationDriver}.
 *
 * Every file-mutation method below binds to an existing, merged, permit-
 * gated production implementation; none of them write bytes themselves.
 * `retainCompletedMaterial` and `cleanupAbortedMaterial` are DELIBERATELY
 * ABSENT from the returned driver — see the module-level note below rather
 * than "completing" the interface by adding no-op implementations.
 *
 * RETENTION AND CLEANUP, WHY BOTH HOOKS ARE ABSENT:
 *
 * When a driver leaves `cleanupAbortedMaterial` undefined, the coordinator
 * performs its OWN deletion of the retained material file on the abort
 * path (backend-publication.ts's internal `#cleanupMaterial`): a bounded,
 * permission- and single-link-checked, digest-verified
 * `consumeBoundedRegularFile` against the sealed `recoveryReference`. A
 * driver-supplied no-op `cleanupAbortedMaterial` does not run in ADDITION
 * to that deletion; the coordinator's internal implementation checks
 * whether the hook is defined and, if so, calls it and RETURNS WITHOUT
 * EVER RUNNING ITS OWN DELETION. A no-op hook therefore leaks the material
 * file on every abort. Because `prepare()` seals new material with
 * `requireAbsent: true`, that leaked file then refuses a later publication
 * that reuses the same publication id. Leave the hook undefined so the
 * coordinator's own, strictly more thorough deletion runs.
 *
 * `retainCompletedMaterial` is only ever invoked from the completed path,
 * and that same internal `#cleanupMaterial` deletion is reached ONLY from
 * the abort path. Nothing deletes the material file when a publication
 * completes. Retention is therefore already a property of the coordinator's
 * behaviour on the completed path, independent of whether this hook is
 * defined. A hook that re-authenticates what the coordinator's own
 * `#materialContext` authenticated moments earlier would add no new
 * evidence; it is exactly the "a check that is never compared" shape this
 * Epic keeps finding. Leave it undefined and prove retention with a test
 * that drives a real publication to completion and reads the file back.
 */
export function createBackendPublicationDriver(
  options: CreateBackendPublicationDriverOptions,
): BackendPublicationDriver {
  assertRemoteGuardChoice(options.remoteGuard);

  const driver: BackendPublicationDriver = {
    async observeLocalState(input) {
      return captureBackendPublicationState(input.homeDir);
    },
    async publishConfig(input) {
      return applyBackendPublicationConfigFile(input);
    },
    async restoreConfig(input) {
      return applyBackendPublicationConfigFile(input);
    },
    async publishProjectMap(input) {
      return applyBackendPublicationProjectMapFile(input);
    },
    async restoreProjectMap(input) {
      return applyBackendPublicationProjectMapFile(input);
    },
    // retainCompletedMaterial and cleanupAbortedMaterial are deliberately
    // omitted; see the doc comment above.
  };

  if (options.remoteGuard.mode === "delegated") {
    const provider = options.remoteGuard.provider;
    return {
      ...driver,
      acquireRemoteGuard: (input) => provider.acquireRemoteGuard(input),
      readRemoteGuard: (input, operation) => provider.readRemoteGuard(input, operation),
      releaseRemoteGuard: (input) => provider.releaseRemoteGuard(input),
    };
  }
  return driver;
}

export type CreateBackendPublicationCoordinatorOptions = Readonly<{
  homeDir?: string;
  observer?: BackendPublicationObserver;
  remoteGuard: BackendPublicationRemoteGuardChoice;
}>;

/**
 * The ONE production construction site for {@link
 * BackendPublicationCoordinator}, wiring it over the driver returned by
 * {@link createBackendPublicationDriver}. Both #625 (migration activation)
 * and #626 (migration rollback) construct their coordinator through this
 * factory rather than constructing one directly.
 */
export function createBackendPublicationCoordinator(
  options: CreateBackendPublicationCoordinatorOptions,
): BackendPublicationCoordinator {
  const driver = createBackendPublicationDriver({ remoteGuard: options.remoteGuard });
  return new BackendPublicationCoordinator({
    homeDir: options.homeDir,
    driver,
    observer: options.observer,
  });
}

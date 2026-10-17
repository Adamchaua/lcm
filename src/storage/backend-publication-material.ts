import { dirname } from "node:path";
import { parseStoredConfig } from "../daemon/config.js";
import { normalizeUuidV7 } from "../machine-identity.js";
import { parseProjectMap, projectMapPath, type ProjectMap } from "../project-map.js";
import { configPath } from "../runtime-paths.js";
import type { StorageBackendName } from "./contracts.js";
import {
  captureBackendPublicationFileWitness,
  readRetainedCompletedBackendPublicationEvidence,
  withBackendPublicationReadRoot,
  type BackendPublicationFileSnapshot,
  type BackendPublicationJournal,
  type BackendPublicationRecoveryFile,
  type BackendPublicationRecoveryMaterial,
} from "./backend-publication.js";

const EVIDENCE_SHA256_SHAPE_PATTERN = /^[0-9a-f]{64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function describeError(error: unknown): string {
  // String(error) on an Error instance already includes its name and
  // message (e.g. "BackendPublicationJournalError: ..."), so this needs
  // no branch on the thrown value's type to stay informative.
  return String(error);
}

function assertStorageBackendName(value: unknown): asserts value is StorageBackendName {
  if (value !== "sqlite" && value !== "postgresql") {
    throw new TypeError(
      `backend publication targetBackend must be "sqlite" or "postgresql", received: ${JSON.stringify(value)}`,
    );
  }
}

function recoveryFileFromSnapshot(
  snapshot: BackendPublicationFileSnapshot,
): BackendPublicationRecoveryFile {
  if (snapshot.witness.presence === "absent") {
    return { presence: "absent" };
  }
  const witness = snapshot.witness;
  return {
    presence: "present",
    // captureBackendPublicationFileWitness only returns a null content
    // alongside an absent witness (handled by the branch above), so a
    // present witness always carries real string content here.
    content: Buffer.from(snapshot.content as string, "utf-8"),
    mode: witness.mode,
    uid: witness.uid,
    gid: witness.gid,
    nlink: witness.nlink,
    dev: witness.dev,
    ino: witness.ino,
    parentDev: witness.parentDev,
    parentIno: witness.parentIno,
  };
}

export type CaptureBackendPublicationSourceMaterialInput = Readonly<{
  homeDir?: string;
}>;

export type BackendPublicationSourceMaterial = Readonly<{
  config: BackendPublicationRecoveryFile;
  projectMap: BackendPublicationRecoveryFile;
}>;

/**
 * Read the LIVE `config.json` and `map.json` under the LCM home as the
 * ONLY source of source material for a composed publication. This is always
 * read from disk; it is never supplied by a caller, so a caller cannot
 * substitute stale or invented source bytes for the live installation
 * state.
 */
export function captureBackendPublicationSourceMaterial(
  input: CaptureBackendPublicationSourceMaterialInput = {},
): BackendPublicationSourceMaterial {
  return withBackendPublicationReadRoot(input.homeDir, (assertReadRoot) => {
    const guarded = <T>(read: () => T): T => {
      assertReadRoot();
      const value = read();
      assertReadRoot();
      return value;
    };
    const configFilePath = configPath(input.homeDir);
    const mapFilePath = projectMapPath(input.homeDir);
    const config = guarded(() =>
      captureBackendPublicationFileWitness(configFilePath, dirname(configFilePath)));
    const projectMap = guarded(() =>
      captureBackendPublicationFileWitness(mapFilePath, dirname(mapFilePath)));
    return {
      config: recoveryFileFromSnapshot(config),
      projectMap: recoveryFileFromSnapshot(projectMap),
    };
  });
}

export type BackendPublicationProjectBinding = Readonly<{
  localProjectId: string;
  remoteProjectId: string;
  evidenceSha256: string;
}>;

function validateBindingShape(
  binding: BackendPublicationProjectBinding,
): BackendPublicationProjectBinding {
  if (
    typeof binding.localProjectId !== "string"
    || binding.localProjectId.length === 0
    || binding.localProjectId.length > 256
  ) {
    throw new TypeError(
      "backend publication binding localProjectId must be a non-empty string of at most 256 characters",
    );
  }
  // project-map.ts:1943-1946 (setRemoteProjectBinding) and
  // src/doctor/doctor.ts:494 both reject a project-map remoteProjectId that
  // fails normalizeUuidV7. backend-publication.ts's own project validation
  // (validateInput, backend-publication.ts) is generic over
  // backends and accepts any non-empty string. Composing a value for the
  // project map means meeting the map's stricter rule, not the publication
  // layer's more permissive one: a target that satisfies only the
  // permissive rule would publish cleanly and then leave the installation
  // failing its own `lcm doctor` health check.
  const normalizedRemoteProjectId = typeof binding.remoteProjectId === "string"
    ? normalizeUuidV7(binding.remoteProjectId)
    : null;
  if (normalizedRemoteProjectId === null) {
    throw new TypeError(
      `backend publication binding remoteProjectId must be a PostgreSQL UUIDv7: ${String(binding.remoteProjectId)}`,
    );
  }
  if (
    typeof binding.evidenceSha256 !== "string"
    || !EVIDENCE_SHA256_SHAPE_PATTERN.test(binding.evidenceSha256)
  ) {
    // evidenceSha256's definition is settled: it is bindingSha256 from
    // bindMigrationCopySource (src/migration/copy-source.ts:134). It is
    // an INPUT here, not something this module reads, because the
    // readback artifact that would carry it durably is on an unmerged
    // branch at the base this was built against — the follow-on here is
    // wiring once that artifact merges, not an open decision. This
    // validates SHAPE only (64 lowercase hex, matching HASH_PATTERN's
    // convention in backend-publication.ts) and never mints or
    // recomputes the digest, and deliberately does not import anything
    // from src/migration/.
    throw new TypeError(
      "backend publication binding evidenceSha256 must be 64 lowercase hex characters",
    );
  }
  return {
    localProjectId: binding.localProjectId,
    remoteProjectId: normalizedRemoteProjectId,
    evidenceSha256: binding.evidenceSha256,
  };
}

function validateBindings(
  bindings: readonly BackendPublicationProjectBinding[],
): readonly BackendPublicationProjectBinding[] {
  if (bindings.length === 0) {
    throw new TypeError("backend publication bindings must name at least one project");
  }
  const validated = bindings.map(validateBindingShape);
  const seenLocal = new Set<string>();
  const seenRemote = new Set<string>();
  for (const binding of validated) {
    if (seenLocal.has(binding.localProjectId)) {
      throw new TypeError(
        `backend publication bindings must not repeat localProjectId: ${binding.localProjectId}`,
      );
    }
    if (seenRemote.has(binding.remoteProjectId)) {
      throw new TypeError(
        `backend publication bindings must not repeat remoteProjectId: ${binding.remoteProjectId}`,
      );
    }
    seenLocal.add(binding.localProjectId);
    seenRemote.add(binding.remoteProjectId);
  }
  return validated;
}

type ComposedTargetConfig = Readonly<{
  file: BackendPublicationRecoveryFile;
  sourceBackend: StorageBackendName;
}>;

function composeTargetConfigFile(
  source: BackendPublicationRecoveryFile,
  targetBackend: StorageBackendName,
): ComposedTargetConfig {
  if (source.presence === "absent") {
    // BackendPublicationRecoveryFile's present arm requires an owner-only
    // mode (assertWitnessShape's isOwnerOnlyFileMode check, enforced via
    // the journal witness), and applyBackendPublicationConfigFile
    // (config-manager.ts) writes the target file with
    // `finalMode: recoveryFile.mode` taken verbatim from this material —
    // there is no mode to carry forward from an absent source. Minting one
    // would mean creating a config file from nothing, which is not a
    // backend selection change; refuse instead.
    throw new RangeError(
      "backend publication cannot compose a target config: the source config is absent",
    );
  }
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(source.content);
  const parsed: unknown = JSON.parse(decoded);
  if (!isRecord(parsed)) {
    throw new TypeError("backend publication source config is not a JSON object");
  }
  if (parsed.storage !== undefined && !isRecord(parsed.storage)) {
    // Replacing a present non-object value would silently drop it from the
    // published target config.
    throw new TypeError("backend publication source config storage is not a JSON object");
  }
  const storage = parsed.storage ?? {};
  // The same rule as config-manager.ts's configBackend: the source backend
  // is postgresql only when the live config selects it explicitly.
  const sourceBackend: StorageBackendName = storage.backend === "postgresql"
    ? "postgresql"
    : "sqlite";
  if (sourceBackend === targetBackend) {
    throw new RangeError(
      `backend publication source backend and target backend must differ: ${targetBackend}`,
    );
  }
  const targetParsed = {
    ...parsed,
    storage: { ...storage, backend: targetBackend },
  };
  const serialized = `${JSON.stringify(targetParsed, null, 2)}
`;
  try {
    // The config writer validates the stored config at phase
    // config-publishing, after the project map is published. Run the same
    // validator here so an unwritable target is refused before prepare().
    parseStoredConfig(serialized);
  } catch (error) {
    throw new Error(
      `backend publication target config is invalid for ${targetBackend}: ${String(error)}`,
      { cause: error },
    );
  }
  return {
    sourceBackend,
    file: {
      presence: "present",
      content: Buffer.from(serialized, "utf-8"),
      mode: source.mode,
      uid: source.uid,
      gid: source.gid,
      nlink: source.nlink,
      dev: source.dev,
      ino: source.ino,
      parentDev: source.parentDev,
      parentIno: source.parentIno,
    },
  };
}

function parseSourceProjectMap(
  source: Extract<BackendPublicationRecoveryFile, { presence: "present" }>,
): ProjectMap {
  // The project map's own parser is the only authority on what a valid map
  // is: key shape, absolute paths and UUIDv7 remote bindings.
  return parseProjectMap(new TextDecoder("utf-8", { fatal: true }).decode(source.content));
}

function composeTargetProjectMapFile(
  source: BackendPublicationRecoveryFile,
  targetBackend: StorageBackendName,
  bindings: readonly BackendPublicationProjectBinding[],
): BackendPublicationRecoveryFile {
  if (source.presence === "absent") {
    // Bindings are never empty, and every binding names a project that must
    // exist in the live map; with no map there is nothing to bind or unbind,
    // and no file mode to mint a map with.
    throw new RangeError(
      "backend publication cannot compose a target project map: the source project map is absent",
    );
  }
  const sourceMapObject = parseSourceProjectMap(source);

  const missing = bindings.filter(
    (binding) => !Object.prototype.hasOwnProperty.call(sourceMapObject, binding.localProjectId),
  );
  if (missing.length > 0) {
    throw new RangeError(
      `backend publication binding names a project absent from the live map: ${missing
        .map((binding) => binding.localProjectId)
        .join(", ")}`,
    );
  }

  const targetMapObject: ProjectMap = {};
  for (const [hash, entry] of Object.entries(sourceMapObject)) {
    targetMapObject[hash] = { ...entry, aliases: [...entry.aliases] };
  }
  for (const binding of bindings) {
    // project-map.ts (resolveProjectIdentityUnlocked) indexes the live map
    // directly with a project's `id`, and src/cli-storage.ts treats that
    // same `id` and a publication record's `localProjectId` as one value.
    // That coupling is real in merged code but unenforced by
    // backend-publication.ts itself (validateInput only requires a
    // non-empty, <=256-character, array-unique string), so the refusals
    // here are load-bearing rather than defensive.
    const entry = targetMapObject[binding.localProjectId]!;
    const owner = Object.entries(sourceMapObject).find(
      ([hash, other]) => hash !== binding.localProjectId
        && other.remoteProjectId === binding.remoteProjectId,
    );
    if (owner !== undefined) {
      throw new RangeError(
        `backend publication binding remote project ${binding.remoteProjectId} is already owned by project map entry ${owner[0]}`,
      );
    }
    if (targetBackend === "postgresql") {
      if (entry.remoteProjectId !== undefined) {
        throw new RangeError(
          `backend publication binding project ${binding.localProjectId} is already bound to a remote project`,
        );
      }
      entry.remoteProjectId = binding.remoteProjectId;
    } else {
      if (entry.remoteProjectId !== binding.remoteProjectId) {
        throw new RangeError(
          `backend publication binding project ${binding.localProjectId} is not bound to remote project ${binding.remoteProjectId}`,
        );
      }
      delete entry.remoteProjectId;
    }
  }

  const serialized = `${JSON.stringify(targetMapObject, null, 2)}
`;
  return {
    presence: "present",
    content: Buffer.from(serialized, "utf-8"),
    mode: source.mode,
    uid: source.uid,
    gid: source.gid,
    nlink: source.nlink,
    dev: source.dev,
    ino: source.ino,
    parentDev: source.parentDev,
    parentIno: source.parentIno,
  };
}

export type ComposeBackendPublicationMaterialInput = Readonly<{
  homeDir?: string;
  targetBackend: StorageBackendName;
  bindings: readonly BackendPublicationProjectBinding[];
}>;

export type ComposeBackendPublicationMaterialResult = Readonly<{
  sourceBackend: StorageBackendName;
  targetBackend: StorageBackendName;
  material: BackendPublicationRecoveryMaterial;
  projects: readonly BackendPublicationProjectBinding[];
}>;

/**
 * Derive a publication's `material` and `projects` from ONE input
 * (`bindings`) in one place. The result is directly the input of
 * `BackendPublicationCoordinator.prepare()` and of the migration activation
 * artifact: `sourceBackend` comes from the live config (postgresql only when
 * it selects postgresql), `targetBackend` is the input, and equal backends
 * are refused.
 *
 * The enforced invariant is: the set of project-map entries whose remote
 * binding differs between the live map and the composed target map equals
 * `bindings` equals `projects`. To hold it, the live map is parsed with the
 * project map's own rules; `bindings` must be non-empty, with no repeated
 * project or remote; and each binding must name an existing map entry that
 * changes in the direction of the target:
 *
 * - postgresql target: the entry is currently unbound and becomes bound to
 *   the stated remote;
 * - sqlite target: the entry is currently bound to exactly the stated remote
 *   and becomes unbound.
 *
 * `bindings` must be non-empty. That is a limit of this composer, which
 * exists to bind or unbind projects: `prepare()` itself still accepts a
 * publication with no projects.
 *
 * A stated remote that a different map entry already holds is refused in
 * both directions. Every entry that is not listed is carried through
 * unchanged apart from the project map's own normalization. Its existing
 * remote binding, if any, is not part of this publication and is not fenced
 * by it.
 */
export function composeBackendPublicationMaterial(
  input: ComposeBackendPublicationMaterialInput,
): ComposeBackendPublicationMaterialResult {
  assertStorageBackendName(input.targetBackend);
  const bindings = validateBindings(input.bindings);
  const source = captureBackendPublicationSourceMaterial({ homeDir: input.homeDir });
  const targetConfig = composeTargetConfigFile(source.config, input.targetBackend);
  const targetProjectMap = composeTargetProjectMapFile(source.projectMap, input.targetBackend, bindings);
  return {
    sourceBackend: targetConfig.sourceBackend,
    targetBackend: input.targetBackend,
    material: {
      source: { config: source.config, projectMap: source.projectMap },
      target: { config: targetConfig.file, projectMap: targetProjectMap },
    },
    projects: bindings,
  };
}

export type RetainedBackendPublicationMaterialResult =
  | Readonly<{
    status: "present";
    journal: BackendPublicationJournal;
    material: BackendPublicationRecoveryMaterial;
  }>
  | Readonly<{ status: "authoritatively-absent" }>
  | Readonly<{ status: "unresolvable"; reason: string }>;

export type ReadRetainedBackendPublicationMaterialInput = Readonly<{
  homeDir?: string;
}>;

/**
 * Read the retained material for #626's rollback target, THREE-VALUED:
 *
 * - the journal read fails -> `unresolvable`, with the reason. That
 *   includes a publication directory that exists without a journal (empty,
 *   history-only or leftover material): the consumer read refuses it as
 *   incomplete evidence, and it is never a statement that nothing was
 *   published
 * - the publication directory is confirmed absent, or the journal is not at
 *   phase `completed` -> `authoritatively-absent`
 * - the journal is `completed` and the material read throws (including
 *   ENOENT) -> `unresolvable`, NOT absent. A completed journal asserts a
 *   `recoveryReference`; a missing or unauthenticatable file under that
 *   assertion is an inconsistent store, and concluding "absent" there
 *   would license a reversal with nothing to reverse to.
 * - the journal is `completed`, passes the terminal-evidence checks (a
 *   recovery reference, no active remote fence, published hashes equal to
 *   the intended hashes), its material authenticates, and a re-read of the
 *   journal after the material read still has the same checksum ->
 *   `present`, carrying BOTH the material and the journal. A journal that
 *   changed or disappeared during the read is `unresolvable`. The reader
 *   takes no lock, so `present` does not claim that the journal is still
 *   live when the function returns. This function
 *   does not filter on `targetBackend`: that check belongs to the
 *   consumer (contract section 16), which has more information than this
 *   reader does about what it is eligible to roll back.
 *
 * Read this BEFORE the consumer's own `prepare()`. The completed journal
 * stays in the live slot only until the next `prepare()` archives it, and
 * this reader looks at the live slot only, never at `history/`. After a new
 * `prepare()` the previous publication is no longer reachable through it.
 *
 * Mechanism: the coordinator does not delete the material file on the
 * completed path (only the abort path consumes it), and the completed
 * journal stays in the live slot until the next `prepare()` archives it.
 * So the completed journal's `publicationId`/`recoveryReference` are read
 * from the live slot, and the retained material is read through those.
 */
export function readRetainedBackendPublicationMaterial(
  input: ReadRetainedBackendPublicationMaterialInput = {},
): RetainedBackendPublicationMaterialResult {
  try {
    const evidence = readRetainedCompletedBackendPublicationEvidence(input.homeDir);
    if (evidence === null) return { status: "authoritatively-absent" };
    return { status: "present", journal: evidence.journal, material: evidence.material };
  } catch (error) {
    return { status: "unresolvable", reason: describeError(error) };
  }
}

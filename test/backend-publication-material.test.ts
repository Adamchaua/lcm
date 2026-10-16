import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureBackendPublicationSourceMaterial,
  composeBackendPublicationMaterial,
  readRetainedBackendPublicationMaterial,
  type BackendPublicationProjectBinding,
} from "../src/storage/backend-publication-material.js";
import {
  backendPublicationDirectory,
  backendPublicationJournalPath,
  readAuthenticatedBackendPublicationMaterial,
  readBackendPublicationJournal,
  type BackendPublicationJournal,
  type BackendPublicationRecoveryMaterial,
} from "../src/storage/backend-publication.js";
import { createBackendPublicationCoordinator } from "../src/storage/backend-publication-driver.js";
import { createInMemoryRemoteGuardProvider } from "./storage/backend-publication-guard-double.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "lcm-backend-publication-material-"));
  mkdirSync(join(home, ".lcm"), { mode: 0o700 });
  roots.push(home);
  return home;
}

function writeConfig(home: string, content: unknown): void {
  writeFileSync(join(home, ".lcm", "config.json"), `${JSON.stringify(content, null, 2)}
`, { mode: 0o600 });
}

function writeMap(home: string, content: unknown): void {
  writeFileSync(join(home, ".lcm", "map.json"), `${JSON.stringify(content, null, 2)}
`, { mode: 0o600 });
}

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const REMOTE_ID_A = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9020";
const REMOTE_ID_B = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9021";
const EVIDENCE_A = "a".repeat(64);

function binding(overrides: Partial<BackendPublicationProjectBinding> = {}): BackendPublicationProjectBinding {
  return {
    localProjectId: HASH_A,
    remoteProjectId: REMOTE_ID_A,
    evidenceSha256: EVIDENCE_A,
    ...overrides,
  };
}

function sampleMap(): Record<string, unknown> {
  return {
    [HASH_A]: { canonical: "/repos/one", aliases: [] },
    [HASH_B]: { canonical: "/repos/two", aliases: ["/repos/two-alias"] },
  };
}

type Composed = ReturnType<typeof composeBackendPublicationMaterial>;

function mapFromFile(file: Composed["material"]["source"]["projectMap"]): Record<string, { remoteProjectId?: string }> {
  if (file.presence !== "present") throw new Error("expected a present project map");
  return JSON.parse(Buffer.from(file.content).toString("utf-8"));
}

function targetProjectMap(result: Composed): Record<string, { remoteProjectId?: string }> {
  return mapFromFile(result.material.target.projectMap);
}

/** Keys whose remote binding differs between the source and target maps. */
function changedBindingKeys(result: Composed): string[] {
  const source = mapFromFile(result.material.source.projectMap);
  const target = targetProjectMap(result);
  return Object.keys({ ...source, ...target })
    .filter((key) => source[key]?.remoteProjectId !== target[key]?.remoteProjectId)
    .sort();
}

describe("captureBackendPublicationSourceMaterial", () => {
  it("captures present config and project map content and identity", () => {
    const home = makeHome();
    writeConfig(home, { storage: { backend: "sqlite" }, extra: "kept" });
    writeMap(home, sampleMap());
    const source = captureBackendPublicationSourceMaterial({ homeDir: home });
    expect(source.config.presence).toBe("present");
    expect(source.projectMap.presence).toBe("present");
    if (source.config.presence === "present") {
      expect(JSON.parse(Buffer.from(source.config.content).toString("utf-8"))).toEqual({
        storage: { backend: "sqlite" },
        extra: "kept",
      });
      expect(source.config.mode).toBe(0o600);
    }
  });

  it("reports absent config and project map when neither file exists", () => {
    const home = makeHome();
    const source = captureBackendPublicationSourceMaterial({ homeDir: home });
    expect(source.config.presence).toBe("absent");
    expect(source.projectMap.presence).toBe("absent");
  });
});

describe("composeBackendPublicationMaterial", () => {
  it("composes a postgresql target: sets storage.backend and binds remoteProjectId", () => {
    const home = makeHome();
    writeConfig(home, { storage: { backend: "sqlite" }, keep: { nested: true } });
    writeMap(home, sampleMap());
    const result = composeBackendPublicationMaterial({
      homeDir: home,
      targetBackend: "postgresql",
      bindings: [binding()],
    });
    expect(result.material.target.config.presence).toBe("present");
    if (result.material.target.config.presence === "present") {
      const targetConfig = JSON.parse(Buffer.from(result.material.target.config.content).toString("utf-8"));
      expect(targetConfig.storage.backend).toBe("postgresql");
      // Non-perturbation: an unrelated top-level key survives untouched.
      expect(targetConfig.keep).toEqual({ nested: true });
    }
    expect(result.material.target.projectMap.presence).toBe("present");
    if (result.material.target.projectMap.presence === "present") {
      const targetMap = JSON.parse(Buffer.from(result.material.target.projectMap.content).toString("utf-8"));
      expect(targetMap[HASH_A].remoteProjectId).toBe(REMOTE_ID_A);
      // Non-perturbation: the unbound entry is untouched.
      expect(targetMap[HASH_B]).toEqual({ canonical: "/repos/two", aliases: ["/repos/two-alias"] });
      expect(targetMap[HASH_A].canonical).toBe("/repos/one");
    }
    expect(result.projects).toEqual([binding()]);
  });

  it("composes a sqlite target: removes remoteProjectId for bound projects", () => {
    const home = makeHome();
    writeConfig(home, { storage: { backend: "postgresql" } });
    writeMap(home, {
      [HASH_A]: { canonical: "/repos/one", aliases: [], remoteProjectId: REMOTE_ID_A },
      [HASH_B]: { canonical: "/repos/two", aliases: [] },
    });
    const result = composeBackendPublicationMaterial({
      homeDir: home,
      targetBackend: "sqlite",
      bindings: [binding()],
    });
    if (result.material.target.config.presence === "present") {
      const targetConfig = JSON.parse(Buffer.from(result.material.target.config.content).toString("utf-8"));
      expect(targetConfig.storage.backend).toBe("sqlite");
    }
    if (result.material.target.projectMap.presence === "present") {
      const targetMap = JSON.parse(Buffer.from(result.material.target.projectMap.content).toString("utf-8"));
      expect("remoteProjectId" in targetMap[HASH_A]).toBe(false);
    }
  });

  it("is byte-identical when re-composed from the same on-disk inputs", () => {
    const home = makeHome();
    writeConfig(home, { storage: { backend: "sqlite" } });
    writeMap(home, sampleMap());
    const first = composeBackendPublicationMaterial({
      homeDir: home,
      targetBackend: "postgresql",
      bindings: [binding()],
    });
    const second = composeBackendPublicationMaterial({
      homeDir: home,
      targetBackend: "postgresql",
      bindings: [binding()],
    });
    const firstConfig = first.material.target.config;
    const secondConfig = second.material.target.config;
    const firstMap = first.material.target.projectMap;
    const secondMap = second.material.target.projectMap;
    expect(firstConfig.presence).toBe("present");
    expect(secondConfig.presence).toBe("present");
    expect(firstMap.presence).toBe("present");
    expect(secondMap.presence).toBe("present");
    if (
      firstConfig.presence === "present" && secondConfig.presence === "present"
      && firstMap.presence === "present" && secondMap.presence === "present"
    ) {
      expect(Buffer.from(firstConfig.content).equals(Buffer.from(secondConfig.content))).toBe(true);
      expect(Buffer.from(firstMap.content).equals(Buffer.from(secondMap.content))).toBe(true);
    }
  });

  it("refuses an absent source project map: there is nothing to bind or unbind", () => {
    const home = makeHome();
    writeConfig(home, { storage: { backend: "sqlite" } });
    expect(() =>
      composeBackendPublicationMaterial({
        homeDir: home,
        targetBackend: "postgresql",
        bindings: [binding()],
      }),
    ).toThrow(/source project map is absent/);
  });

  it("changes exactly the bound projects' remote bindings, across several bindings", () => {
    const home = makeHome();
    writeConfig(home, { storage: { backend: "sqlite" } });
    writeMap(home, sampleMap());
    const bindings = [
      binding({ localProjectId: HASH_A, remoteProjectId: REMOTE_ID_A }),
      binding({ localProjectId: HASH_B, remoteProjectId: REMOTE_ID_B }),
    ];
    const result = composeBackendPublicationMaterial({
      homeDir: home,
      targetBackend: "postgresql",
      bindings,
    });
    expect(changedBindingKeys(result)).toEqual(result.projects.map((entry) => entry.localProjectId).sort());
    const targetMap = targetProjectMap(result);
    for (const projectBinding of result.projects) {
      expect(targetMap[projectBinding.localProjectId].remoteProjectId).toBe(projectBinding.remoteProjectId);
    }
  });

  it("refuses an absent source config rather than mint a config from nothing", () => {
    const home = makeHome();
    writeMap(home, sampleMap());
    expect(() =>
      composeBackendPublicationMaterial({ homeDir: home, targetBackend: "postgresql", bindings: [binding()] }),
    ).toThrow(/source config is absent/);
  });

  it("refuses a binding naming a project absent from the live map", () => {
    const home = makeHome();
    writeConfig(home, { storage: { backend: "sqlite" } });
    writeMap(home, sampleMap());
    expect(() =>
      composeBackendPublicationMaterial({
        homeDir: home,
        targetBackend: "postgresql",
        bindings: [binding({ localProjectId: "c".repeat(64) })],
      }),
    ).toThrow(/absent from the live map/);
  });

  it("tight positive control: the same binding with a key present in the live map succeeds", () => {
    // Isolates the guard above: identical fixture and targetBackend, only
    // localProjectId changes from an absent key (HASH_C, not in
    // sampleMap()) to a present one (HASH_A).
    const home = makeHome();
    writeConfig(home, { storage: { backend: "sqlite" } });
    writeMap(home, sampleMap());
    expect(() =>
      composeBackendPublicationMaterial({
        homeDir: home,
        targetBackend: "postgresql",
        bindings: [binding({ localProjectId: HASH_A })],
      }),
    ).not.toThrow();
  });

  it("refuses a binding whose evidenceSha256 is not 64 lowercase hex", () => {
    const home = makeHome();
    writeConfig(home, { storage: { backend: "sqlite" } });
    writeMap(home, sampleMap());
    expect(() =>
      composeBackendPublicationMaterial({
        homeDir: home,
        targetBackend: "postgresql",
        bindings: [binding({ evidenceSha256: "A".repeat(64) })],
      }),
    ).toThrow(/evidenceSha256/);
  });

  it("refuses a binding whose remoteProjectId is not a PostgreSQL UUIDv7", () => {
    // src/doctor/doctor.ts:494 independently rejects a project-map
    // remoteProjectId that fails normalizeUuidV7; a composer that let this
    // through would publish a map that passes backend-publication.ts's
    // generic string check and then fails `lcm doctor`.
    const home = makeHome();
    writeConfig(home, { storage: { backend: "sqlite" } });
    writeMap(home, sampleMap());
    expect(() =>
      composeBackendPublicationMaterial({
        homeDir: home,
        targetBackend: "postgresql",
        bindings: [binding({ remoteProjectId: "not-a-uuid" })],
      }),
    ).toThrow(/UUIDv7/);
  });

  it("refuses a binding whose remoteProjectId is not even a string", () => {
    const home = makeHome();
    writeConfig(home, { storage: { backend: "sqlite" } });
    writeMap(home, sampleMap());
    expect(() =>
      composeBackendPublicationMaterial({
        homeDir: home,
        targetBackend: "postgresql",
        bindings: [binding({ remoteProjectId: 12345 as any })],
      }),
    ).toThrow(/UUIDv7/);
  });

  it("tight positive control: the same binding with a real UUIDv7 remoteProjectId succeeds", () => {
    // Isolates both remoteProjectId guards above: identical fixture and
    // targetBackend, only remoteProjectId changes from an invalid value to
    // REMOTE_ID_A, a real UUIDv7.
    const home = makeHome();
    writeConfig(home, { storage: { backend: "sqlite" } });
    writeMap(home, sampleMap());
    expect(() =>
      composeBackendPublicationMaterial({
        homeDir: home,
        targetBackend: "postgresql",
        bindings: [binding({ remoteProjectId: REMOTE_ID_A })],
      }),
    ).not.toThrow();
  });

  it("composes a target config that mints storage from scratch when the source config has none", () => {
    const home = makeHome();
    writeConfig(home, { unrelated: true });
    writeMap(home, sampleMap());
    const result = composeBackendPublicationMaterial({
      homeDir: home,
      targetBackend: "postgresql",
      bindings: [binding()],
    });
    expect(result.material.target.config.presence).toBe("present");
    if (result.material.target.config.presence === "present") {
      const targetConfig = JSON.parse(Buffer.from(result.material.target.config.content).toString("utf-8"));
      expect(targetConfig.storage).toEqual({ backend: "postgresql" });
      expect(targetConfig.unrelated).toBe(true);
    }
  });

  it("refuses duplicate localProjectId bindings", () => {
    const home = makeHome();
    writeConfig(home, { storage: { backend: "sqlite" } });
    writeMap(home, sampleMap());
    expect(() =>
      composeBackendPublicationMaterial({
        homeDir: home,
        targetBackend: "postgresql",
        bindings: [binding(), binding({ remoteProjectId: REMOTE_ID_B })],
      }),
    ).toThrow(/must not repeat localProjectId/);
  });

  it("refuses an invalid localProjectId shape", () => {
    const home = makeHome();
    writeConfig(home, { storage: { backend: "sqlite" } });
    writeMap(home, sampleMap());
    expect(() =>
      composeBackendPublicationMaterial({
        homeDir: home,
        targetBackend: "postgresql",
        bindings: [binding({ localProjectId: "" })],
      }),
    ).toThrow(/localProjectId/);
  });

  it("refuses a targetBackend outside the known storage backends", () => {
    const home = makeHome();
    writeConfig(home, { storage: { backend: "sqlite" } });
    expect(() =>
      composeBackendPublicationMaterial({
        homeDir: home,
        targetBackend: "mysql" as any,
        bindings: [],
      }),
    ).toThrow(/targetBackend/);
  });

  it("refuses a source config whose storage value is present but not an object", () => {
    for (const storage of ["sqlite", null, 5, ["postgresql"]]) {
      const home = makeHome();
      writeConfig(home, { storage });
      writeMap(home, sampleMap());
      expect(() =>
        composeBackendPublicationMaterial({ homeDir: home, targetBackend: "postgresql", bindings: [binding()] }),
      ).toThrow(/storage is not a JSON object/);
    }
  });

  it("refuses a non-object source config", () => {
    const home = makeHome();
    writeFileSync(join(home, ".lcm", "config.json"), "[]\n", { mode: 0o600 });
    expect(() =>
      composeBackendPublicationMaterial({ homeDir: home, targetBackend: "sqlite", bindings: [binding()] }),
    ).toThrow(/JSON object/);
  });

  it("refuses a non-object source project map entry", () => {
    const home = makeHome();
    writeConfig(home, { storage: { backend: "sqlite" } });
    writeFileSync(join(home, ".lcm", "map.json"), JSON.stringify({ [HASH_A]: "not-an-object" }), { mode: 0o600 });
    expect(() =>
      composeBackendPublicationMaterial({ homeDir: home, targetBackend: "postgresql", bindings: [binding()] }),
    ).toThrow(/map entry .* must be an object/);
  });

  it("refuses a source project map whose top level is not an object", () => {
    const home = makeHome();
    writeConfig(home, { storage: { backend: "sqlite" } });
    writeFileSync(join(home, ".lcm", "map.json"), "[]\n", { mode: 0o600 });
    expect(() =>
      composeBackendPublicationMaterial({ homeDir: home, targetBackend: "postgresql", bindings: [binding()] }),
    ).toThrow(/map\.json must be an object/);
  });
});

describe("composeBackendPublicationMaterial: source backend and project-map rules", () => {
  it("returns the backends it derived: sourceBackend from the live config, targetBackend from the input", () => {
    const home = makeHome();
    writeConfig(home, { storage: { backend: "sqlite" } });
    writeMap(home, sampleMap());
    const activation = composeBackendPublicationMaterial({
      homeDir: home,
      targetBackend: "postgresql",
      bindings: [binding()],
    });
    expect(activation.sourceBackend).toBe("sqlite");
    expect(activation.targetBackend).toBe("postgresql");
    // The backend comes from the very bytes the publication can restore.
    expect(activation.material.source.config.presence).toBe("present");
    if (activation.material.source.config.presence === "present") {
      const captured = JSON.parse(Buffer.from(activation.material.source.config.content).toString("utf-8"));
      expect(captured.storage.backend).toBe(activation.sourceBackend);
    }

    writeConfig(home, { storage: { backend: "postgresql" } });
    writeMap(home, { [HASH_A]: { canonical: "/repos/one", aliases: [], remoteProjectId: REMOTE_ID_A } });
    const rollback = composeBackendPublicationMaterial({
      homeDir: home,
      targetBackend: "sqlite",
      bindings: [binding()],
    });
    expect(rollback.sourceBackend).toBe("postgresql");
    expect(rollback.targetBackend).toBe("sqlite");
  });

  it("derives a sqlite source backend from a config with no storage selection", () => {
    const home = makeHome();
    writeConfig(home, { unrelated: true });
    writeMap(home, sampleMap());
    const result = composeBackendPublicationMaterial({
      homeDir: home,
      targetBackend: "postgresql",
      bindings: [binding()],
    });
    expect(result.sourceBackend).toBe("sqlite");
  });

  it("refuses a target backend equal to the live config's backend", () => {
    const home = makeHome();
    writeConfig(home, { storage: { backend: "postgresql" } });
    writeMap(home, { [HASH_A]: { canonical: "/repos/one", aliases: [], remoteProjectId: REMOTE_ID_A } });
    expect(() =>
      composeBackendPublicationMaterial({
        homeDir: home,
        targetBackend: "postgresql",
        bindings: [binding()],
      }),
    ).toThrow(/source backend and target backend must differ/);
  });

  it("refuses a source project map entry key that is not a project hash", () => {
    const home = makeHome();
    writeConfig(home, { storage: { backend: "sqlite" } });
    writeMap(home, { "not-a-hash": { canonical: "/repos/one", aliases: [] } });
    expect(() =>
      composeBackendPublicationMaterial({
        homeDir: home,
        targetBackend: "postgresql",
        bindings: [binding()],
      }),
    ).toThrow(/64-character lowercase sha256 hash/);
  });

  it("refuses a __proto__ map key instead of dropping it", () => {
    const home = makeHome();
    writeConfig(home, { storage: { backend: "sqlite" } });
    writeFileSync(
      join(home, ".lcm", "map.json"),
      '{"__proto__": {"canonical": "/repos/one", "aliases": []}}\n',
      { mode: 0o600 },
    );
    expect(() =>
      composeBackendPublicationMaterial({
        homeDir: home,
        targetBackend: "postgresql",
        bindings: [binding({ localProjectId: "__proto__" })],
      }),
    ).toThrow(/64-character lowercase sha256 hash/);
  });

  it("refuses a source project map entry whose canonical path is not absolute", () => {
    const home = makeHome();
    writeConfig(home, { storage: { backend: "sqlite" } });
    writeMap(home, { [HASH_A]: { canonical: "repos/one", aliases: [] } });
    expect(() =>
      composeBackendPublicationMaterial({
        homeDir: home,
        targetBackend: "postgresql",
        bindings: [binding()],
      }),
    ).toThrow(/canonical must be an absolute path/);
  });

  it("refuses a source project map entry whose existing remoteProjectId is not a UUIDv7", () => {
    const home = makeHome();
    writeConfig(home, { storage: { backend: "sqlite" } });
    writeMap(home, {
      [HASH_A]: { canonical: "/repos/one", aliases: [] },
      [HASH_B]: { canonical: "/repos/two", aliases: [], remoteProjectId: "not-a-uuid" },
    });
    expect(() =>
      composeBackendPublicationMaterial({
        homeDir: home,
        targetBackend: "postgresql",
        bindings: [binding()],
      }),
    ).toThrow(/remoteProjectId must be a PostgreSQL UUIDv7/);
  });

  it("rejects a malformed project map as JSON syntax, not as an empty map", () => {
    const home = makeHome();
    writeConfig(home, { storage: { backend: "sqlite" } });
    writeFileSync(join(home, ".lcm", "map.json"), "{", { mode: 0o600 });
    expect(() =>
      composeBackendPublicationMaterial({
        homeDir: home,
        targetBackend: "postgresql",
        bindings: [binding()],
      }),
    ).toThrow(expect.objectContaining({ name: "InvalidProjectMapError" }));
  });
});

describe("composeBackendPublicationMaterial: bindings change exactly the listed projects", () => {
  function compose(
    targetBackend: "sqlite" | "postgresql",
    sourceMap: Record<string, unknown>,
    bindings: readonly BackendPublicationProjectBinding[],
  ): Composed {
    const home = makeHome();
    writeConfig(home, { storage: { backend: targetBackend === "postgresql" ? "sqlite" : "postgresql" } });
    writeMap(home, sourceMap);
    return composeBackendPublicationMaterial({ homeDir: home, targetBackend, bindings });
  }

  const bound = (hash: string, remote: string, canonical: string) => ({
    [hash]: { canonical, aliases: [], remoteProjectId: remote },
  });

  it("refuses an empty binding list", () => {
    expect(() => compose("postgresql", sampleMap(), [])).toThrow(/at least one project/);
  });

  it("refuses bindings that repeat a remoteProjectId", () => {
    expect(() =>
      compose("postgresql", sampleMap(), [
        binding({ localProjectId: HASH_A }),
        binding({ localProjectId: HASH_B }),
      ]),
    ).toThrow(/must not repeat remoteProjectId/);
  });

  it("refuses to bind a project that is already bound to the same remote", () => {
    expect(() =>
      compose("postgresql", bound(HASH_A, REMOTE_ID_A, "/repos/one"), [binding()]),
    ).toThrow(/already bound to a remote project/);
  });

  it("refuses to bind a project that is already bound to a different remote", () => {
    expect(() =>
      compose("postgresql", bound(HASH_A, REMOTE_ID_B, "/repos/one"), [binding()]),
    ).toThrow(/already bound to a remote project/);
  });

  it("refuses a remote project that another map entry already owns", () => {
    expect(() =>
      compose("postgresql", { ...sampleMap(), ...bound(HASH_B, REMOTE_ID_A, "/repos/two") }, [binding()]),
    ).toThrow(/already owned by project map entry/);
  });

  it("refuses to unbind a project that is not bound", () => {
    expect(() => compose("sqlite", sampleMap(), [binding()])).toThrow(
      /is not bound to remote project/,
    );
  });

  it("refuses to unbind a project bound to a different remote than the one stated", () => {
    expect(() =>
      compose("sqlite", bound(HASH_A, REMOTE_ID_B, "/repos/one"), [binding()]),
    ).toThrow(/is not bound to remote project/);
  });

  it("refuses to unbind a remote that another map entry also holds", () => {
    expect(() =>
      compose("sqlite", {
        ...bound(HASH_A, REMOTE_ID_A, "/repos/one"),
        ...bound(HASH_B, REMOTE_ID_A, "/repos/two"),
      }, [binding()]),
    ).toThrow(/already owned by project map entry/);
  });

  it("binds only the listed project and leaves a different project's existing binding untouched", () => {
    const result = compose(
      "postgresql",
      { ...sampleMap(), ...bound(HASH_B, REMOTE_ID_B, "/repos/two") },
      [binding()],
    );
    expect(changedBindingKeys(result)).toEqual([HASH_A]);
    expect(targetProjectMap(result)[HASH_A].remoteProjectId).toBe(REMOTE_ID_A);
    expect(targetProjectMap(result)[HASH_B].remoteProjectId).toBe(REMOTE_ID_B);
    expect(result.projects.map((entry) => entry.localProjectId)).toEqual([HASH_A]);
  });

  it("unbinds only the listed project and leaves a different project's remote binding in place", () => {
    const result = compose(
      "sqlite",
      { ...bound(HASH_A, REMOTE_ID_A, "/repos/one"), ...bound(HASH_B, REMOTE_ID_B, "/repos/two") },
      [binding()],
    );
    expect(changedBindingKeys(result)).toEqual([HASH_A]);
    expect(targetProjectMap(result)[HASH_A].remoteProjectId).toBeUndefined();
    expect(targetProjectMap(result)[HASH_B].remoteProjectId).toBe(REMOTE_ID_B);
  });

  it("carries a non-listed entry through map normalization unchanged otherwise", () => {
    const result = compose(
      "postgresql",
      {
        ...sampleMap(),
        [HASH_B]: {
          canonical: "/repos/two",
          aliases: ["/repos/two-alias"],
          remoteProjectId: REMOTE_ID_B.toUpperCase(),
        },
      },
      [binding()],
    );
    expect(targetProjectMap(result)[HASH_B]).toEqual({
      canonical: "/repos/two",
      aliases: ["/repos/two-alias"],
      remoteProjectId: REMOTE_ID_B,
    });
  });
});

describe("readRetainedBackendPublicationMaterial", () => {
  function preparedCoordinator(home: string) {
    return createBackendPublicationCoordinator({
      homeDir: home,
      remoteGuard: { mode: "delegated", provider: createInMemoryRemoteGuardProvider() },
    });
  }

  it("is authoritatively-absent when there is no journal at all", () => {
    const home = makeHome();
    const result = readRetainedBackendPublicationMaterial({ homeDir: home });
    expect(result.status).toBe("authoritatively-absent");
  });

  it("is authoritatively-absent when the journal exists but is not completed", async () => {
    const home = makeHome();
    writeConfig(home, { storage: { backend: "sqlite" } });
    writeMap(home, sampleMap());
    const composed = composeBackendPublicationMaterial({
      homeDir: home,
      targetBackend: "postgresql",
      bindings: [binding()],
    });
    const coordinator = preparedCoordinator(home);
    await coordinator.prepare({
      publicationId: "pub-prepared-only",
      sourceBackend: "sqlite",
      targetBackend: "postgresql",
      material: composed.material,
      projects: composed.projects,
    });
    const result = readRetainedBackendPublicationMaterial({ homeDir: home });
    expect(result.status).toBe("authoritatively-absent");
  });

  it("is present with both journal and material once a publication completes (retention positive control)", async () => {
    const home = makeHome();
    writeConfig(home, { storage: { backend: "sqlite" } });
    writeMap(home, sampleMap());
    const composed = composeBackendPublicationMaterial({
      homeDir: home,
      targetBackend: "postgresql",
      bindings: [binding()],
    });
    const coordinator = preparedCoordinator(home);
    await coordinator.prepare({
      publicationId: "pub-completed",
      sourceBackend: "sqlite",
      targetBackend: "postgresql",
      material: composed.material,
      projects: composed.projects,
    });
    const completed = await coordinator.resume();
    expect(completed.phase).toBe("completed");
    const result = readRetainedBackendPublicationMaterial({ homeDir: home });
    expect(result.status).toBe("present");
    if (result.status === "present") {
      expect(result.journal.publicationId).toBe("pub-completed");
      expect(result.material.source.config.presence).toBe("present");
    }
  });

  it("is unresolvable, not absent, when the journal is completed but the retained material file is gone", async () => {
    const home = makeHome();
    writeConfig(home, { storage: { backend: "sqlite" } });
    writeMap(home, sampleMap());
    const composed = composeBackendPublicationMaterial({
      homeDir: home,
      targetBackend: "postgresql",
      bindings: [binding()],
    });
    const coordinator = preparedCoordinator(home);
    await coordinator.prepare({
      publicationId: "pub-material-gone",
      sourceBackend: "sqlite",
      targetBackend: "postgresql",
      material: composed.material,
      projects: composed.projects,
    });
    await coordinator.resume();
    const journal = readBackendPublicationJournal(home);
    expect(journal?.phase).toBe("completed");
    unlinkSync(join(backendPublicationDirectory(home), "pub-material-gone.material"));
    const result = readRetainedBackendPublicationMaterial({ homeDir: home });
    expect(result.status).toBe("unresolvable");
    if (result.status === "unresolvable") {
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  it("is unresolvable, not absent, when the publication directory exists without a journal", () => {
    const home = makeHome();
    mkdirSync(backendPublicationDirectory(home), { recursive: true, mode: 0o700 });
    const result = readRetainedBackendPublicationMaterial({ homeDir: home });
    expect(result.status).toBe("unresolvable");
    if (result.status === "unresolvable") {
      expect(result.reason).toMatch(/evidence is incomplete/);
    }
  });

  it("is unresolvable, not absent, when retained material remains but the journal is gone", async () => {
    const home = makeHome();
    writeConfig(home, { storage: { backend: "sqlite" } });
    writeMap(home, sampleMap());
    const composed = composeBackendPublicationMaterial({
      homeDir: home,
      targetBackend: "postgresql",
      bindings: [binding()],
    });
    const coordinator = preparedCoordinator(home);
    await coordinator.prepare({
      publicationId: "pub-journal-gone",
      sourceBackend: composed.sourceBackend,
      targetBackend: composed.targetBackend,
      material: composed.material,
      projects: composed.projects,
    });
    await coordinator.resume();
    unlinkSync(backendPublicationJournalPath(home));
    const result = readRetainedBackendPublicationMaterial({ homeDir: home });
    expect(result.status).toBe("unresolvable");
    if (result.status === "unresolvable") {
      expect(result.reason).toMatch(/evidence is incomplete/);
    }
  });

  it("is unresolvable when the live journal slot itself cannot be read", () => {
    const home = makeHome();
    mkdirSync(backendPublicationDirectory(home), { recursive: true, mode: 0o700 });
    writeFileSync(backendPublicationJournalPath(home), "not valid json", { mode: 0o600 });
    const result = readRetainedBackendPublicationMaterial({ homeDir: home });
    expect(result.status).toBe("unresolvable");
  });
});

describe("readAuthenticatedBackendPublicationMaterial null recoveryReference refusal", () => {
  it("refuses a journal whose recoveryReference is null rather than silently skip the digest check", async () => {
    const home = makeHome();
    writeConfig(home, { storage: { backend: "sqlite" } });
    writeMap(home, sampleMap());
    const composed = composeBackendPublicationMaterial({
      homeDir: home,
      targetBackend: "postgresql",
      bindings: [binding()],
    });
    const coordinator = createBackendPublicationCoordinator({
      homeDir: home,
      remoteGuard: { mode: "delegated", provider: createInMemoryRemoteGuardProvider() },
    });
    const prepared = await coordinator.prepare({
      publicationId: "pub-null-reference",
      sourceBackend: "sqlite",
      targetBackend: "postgresql",
      material: composed.material,
      projects: composed.projects,
    });
    const withNullReference: BackendPublicationJournal = { ...prepared, recoveryReference: null };
    expect(() => readAuthenticatedBackendPublicationMaterial(withNullReference, home)).toThrow(
      /no recovery reference/,
    );
  });

  it("authenticates successfully as a positive control when the reference is not null", async () => {
    const home = makeHome();
    writeConfig(home, { storage: { backend: "sqlite" } });
    writeMap(home, sampleMap());
    const composed = composeBackendPublicationMaterial({
      homeDir: home,
      targetBackend: "postgresql",
      bindings: [binding()],
    });
    const coordinator = createBackendPublicationCoordinator({
      homeDir: home,
      remoteGuard: { mode: "delegated", provider: createInMemoryRemoteGuardProvider() },
    });
    const prepared = await coordinator.prepare({
      publicationId: "pub-real-reference",
      sourceBackend: "sqlite",
      targetBackend: "postgresql",
      material: composed.material,
      projects: composed.projects,
    });
    const material: BackendPublicationRecoveryMaterial = readAuthenticatedBackendPublicationMaterial(
      prepared,
      home,
    );
    expect(material.source.config.presence).toBe("present");
  });

  it("refuses when the backend publication directory itself is missing", async () => {
    const home = makeHome();
    writeConfig(home, { storage: { backend: "sqlite" } });
    writeMap(home, sampleMap());
    const composed = composeBackendPublicationMaterial({
      homeDir: home,
      targetBackend: "postgresql",
      bindings: [binding()],
    });
    const coordinator = createBackendPublicationCoordinator({
      homeDir: home,
      remoteGuard: { mode: "delegated", provider: createInMemoryRemoteGuardProvider() },
    });
    const prepared = await coordinator.prepare({
      publicationId: "pub-missing-directory",
      sourceBackend: "sqlite",
      targetBackend: "postgresql",
      material: composed.material,
      projects: composed.projects,
    });
    // A separate, never-prepared home has no backend-publication directory
    // at all, even though this journal carries a real, non-null reference.
    const emptyHome = makeHome();
    expect(() => readAuthenticatedBackendPublicationMaterial(prepared, emptyHome)).toThrow(
      /backend publication directory is missing/,
    );
  });
});

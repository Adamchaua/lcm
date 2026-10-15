import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgreSqlStorageOperationError } from "../../src/storage/postgresql/errors.js";
import type { ActivationLeasePublicationGuard } from "../../src/migration/activation-lease.js";
import {
  ActivationArtifactIdentityMismatchError,
  ActivationArtifactPresenceUnresolvableError,
  publishActivationArtifact,
  type ActivationArtifactRecoveryMaterial,
} from "../../src/migration/activation-artifact-store.js";
import {
  driveActivationPublication,
  type ActivationPublicationCoordinator,
  type ActivationPublicationInput,
} from "../../src/migration/activation-publication.js";
import {
  BackendPublicationCoordinator,
  backendPublicationHistoryDirectory,
  backendPublicationJournalPath,
  backendPublicationMaterialWitness,
  readBackendMaintenanceJournal,
  readBackendPublicationJournal,
  withBackendPublicationConsumerLockAsync,
  type BackendMaintenanceJournal,
  type BackendPublicationDriver,
  type BackendPublicationFenceRecord,
  type BackendPublicationJournal,
  type BackendPublicationLockToken,
  type BackendPublicationRecoveryFile,
} from "../../src/storage/backend-publication.js";

const PUBLICATION_ID = "publication-a";
const TARGET = "postgresql" as const;
const EVIDENCE_A = "a".repeat(64);
const EVIDENCE_B = "b".repeat(64);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempHome(): string {
  const value = mkdtempSync(join(tmpdir(), "lcm-activation-publication-"));
  roots.push(value);
  return value;
}

function absentFile(): BackendPublicationRecoveryFile {
  return { presence: "absent" };
}

function artifactMaterial(
  overrides: Partial<ActivationArtifactRecoveryMaterial> = {},
): ActivationArtifactRecoveryMaterial {
  return {
    version: 1,
    publicationId: PUBLICATION_ID,
    source: { config: absentFile(), projectMap: absentFile() },
    target: { config: absentFile(), projectMap: absentFile() },
    projects: [
      { localProjectId: "local-a", remoteProjectId: "remote-a", evidenceSha256: EVIDENCE_A },
    ],
    ...overrides,
  };
}

function absentWitness() {
  return {
    presence: "absent" as const,
    rawSha256: null,
    semanticSha256: null,
    byteLength: 0 as const,
    mode: null,
    uid: null,
    gid: null,
    nlink: null,
    dev: null,
    ino: null,
    parentDev: null,
    parentIno: null,
  };
}

function baseJournal(overrides: Partial<BackendPublicationJournal> = {}): BackendPublicationJournal {
  return {
    version: 2,
    publicationId: PUBLICATION_ID,
    sourceBackend: "sqlite",
    targetBackend: TARGET,
    phase: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    expectedConfigSha256: "c".repeat(64),
    expectedProjectMapSha256: "d".repeat(64),
    intendedConfigSha256: "c".repeat(64),
    intendedProjectMapSha256: "d".repeat(64),
    publishedConfigSha256: "c".repeat(64),
    publishedProjectMapSha256: "d".repeat(64),
    recoveryReference: null,
    sourceState: { config: absentWitness(), projectMap: absentWitness() },
    targetState: { config: absentWitness(), projectMap: absentWitness() },
    projects: [],
    checksumSha256: "e".repeat(64),
    ...overrides,
  };
}

type FenceMode = "satisfied" | "absent" | "unresolvable";

function fakeGuard(responses: Record<string, FenceMode>): ActivationLeasePublicationGuard {
  const unexpected = (name: string) => vi.fn(async () => { throw new Error("unexpected call to " + name); });
  return {
    acquire: unexpected("acquire"),
    renew: unexpected("renew"),
    release: unexpected("release"),
    read: vi.fn(async (input: { projectId: string; targetBackend: string; evidenceSha256: string }) => {
      const mode = responses[input.projectId] ?? "absent";
      if (mode === "unresolvable") {
        throw new PostgreSqlStorageOperationError(
          "STORAGE_OPERATION_FAILED",
          { domain: "coordination", operation: "readBackendPublication", projectId: input.projectId },
          "42501",
          false,
        );
      }
      if (mode === "absent") return null;
      return {
        projectId: input.projectId,
        machineId: "machine-a",
        publicationId: PUBLICATION_ID,
        targetBackend: input.targetBackend,
        evidenceSha256: input.evidenceSha256,
        fencingToken: 1n,
        acquiredAt: "2026-01-01T00:00:00.000Z",
        renewedAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2026-01-01T01:00:00.000Z",
        releasedAt: null,
        databaseExpired: false,
      };
    }),
  };
}

function fakeCoordinator(
  overrides: Partial<ActivationPublicationCoordinator> = {},
): ActivationPublicationCoordinator {
  const unexpected = (name: string) => vi.fn(async () => { throw new Error("unexpected call to " + name); });
  return {
    recoverPending: overrides.recoverPending ?? unexpected("recoverPending"),
    prepare: overrides.prepare ?? unexpected("prepare"),
    resume: overrides.resume ?? unexpected("resume"),
  };
}

function baseInput(overrides: Partial<ActivationPublicationInput> = {}): ActivationPublicationInput {
  return {
    homeDir: tempHome(),
    lockToken: {} as BackendPublicationLockToken,
    publicationId: PUBLICATION_ID,
    sourceBackend: "sqlite",
    targetBackend: TARGET,
    identityDigest: "f".repeat(64),
    projects: [
      { localProjectId: "local-a", remoteProjectId: "remote-a", evidenceSha256: EVIDENCE_A },
    ],
    ...overrides,
  };
}
describe("driveActivationPublication", () => {
  it("asserts fences for every project and refuses with fence-unresolvable when one is unresolvable", async () => {
    const guard = fakeGuard({ "remote-a": "unresolvable" });
    const coordinator = fakeCoordinator();
    const result = await driveActivationPublication(guard, coordinator, baseInput());
    expect(result.status).toBe("fence-unresolvable");
    expect(result.journal).toBeNull();
    expect(result.fenceChecks).toHaveLength(1);
    expect(result.fenceChecks[0]!.assertion.status).toBe("unresolvable");
    expect(coordinator.recoverPending).not.toHaveBeenCalled();
  });

  it("refuses with fence-unsatisfied when a covered project's lease is absent", async () => {
    const guard = fakeGuard({ "remote-a": "absent" });
    const coordinator = fakeCoordinator();
    const result = await driveActivationPublication(guard, coordinator, baseInput());
    expect(result.status).toBe("fence-unsatisfied");
    expect(result.fenceChecks[0]!.assertion.status).toBe("unsatisfied");
    expect(coordinator.recoverPending).not.toHaveBeenCalled();
  });

  it("prioritizes fence-unresolvable over fence-unsatisfied across multiple projects", async () => {
    const guard = fakeGuard({ "remote-a": "absent", "remote-b": "unresolvable" });
    const coordinator = fakeCoordinator();
    const input = baseInput({
      projects: [
        { localProjectId: "local-a", remoteProjectId: "remote-a", evidenceSha256: EVIDENCE_A },
        { localProjectId: "local-b", remoteProjectId: "remote-b", evidenceSha256: EVIDENCE_B },
      ],
    });
    const result = await driveActivationPublication(guard, coordinator, input);
    expect(result.status).toBe("fence-unresolvable");
    expect(result.fenceChecks).toHaveLength(2);
  });

  it("handles zero covered projects without asserting any fence", async () => {
    const guard = fakeGuard({});
    const journal = baseJournal({ phase: "completed" });
    const coordinator = fakeCoordinator({ recoverPending: vi.fn(async () => journal) });
    const result = await driveActivationPublication(guard, coordinator, baseInput({ projects: [] }), {
      readPublicationJournal: () => journal,
    });
    expect(result.status).toBe("completed");
    expect(result.fenceChecks).toEqual([]);
    expect(guard.read).not.toHaveBeenCalled();
  });

  it("reports completed when recoverPending drives this exact publicationId to completed", async () => {
    const guard = fakeGuard({ "remote-a": "satisfied" });
    const journal = baseJournal({ phase: "completed", publicationId: PUBLICATION_ID });
    const recoverPending = vi.fn(async () => journal);
    const coordinator = fakeCoordinator({ recoverPending });
    const input = baseInput();
    const result = await driveActivationPublication(guard, coordinator, input, {
      readPublicationJournal: () => baseJournal({ phase: "guarded" }),
    });
    expect(result).toMatchObject({ status: "completed", journal });
    expect(recoverPending).toHaveBeenCalledWith({ disposition: "resume" }, input.lockToken);
  });

  it("reports aborted when recoverPending drives this exact publicationId to aborted", async () => {
    const guard = fakeGuard({ "remote-a": "satisfied" });
    const journal = baseJournal({ phase: "aborted", publicationId: PUBLICATION_ID });
    const coordinator = fakeCoordinator({ recoverPending: vi.fn(async () => journal) });
    const result = await driveActivationPublication(guard, coordinator, baseInput(), {
      readPublicationJournal: () => baseJournal({ phase: "aborting" }),
    });
    expect(result).toMatchObject({ status: "aborted", journal });
  });

  it("reports publication-collision when a different, still in-flight generation occupies the journal", async () => {
    const guard = fakeGuard({ "remote-a": "satisfied" });
    const journal = baseJournal({ publicationId: "other-publication", phase: "guarded" });
    const coordinator = fakeCoordinator({ recoverPending: vi.fn(async () => journal) });
    const result = await driveActivationPublication(guard, coordinator, baseInput(), {
      readPublicationJournal: () => journal,
    });
    expect(result.status).toBe("publication-collision");
    expect(result.journal).toEqual(journal);
    expect(coordinator.recoverPending).not.toHaveBeenCalled();
    expect(coordinator.prepare).not.toHaveBeenCalled();
    expect(coordinator.resume).not.toHaveBeenCalled();
  });

  it("treats a stale completed journal from an unrelated generation as absent and proceeds to a fresh prepare", async () => {
    const guard = fakeGuard({ "remote-a": "satisfied" });
    const stale = baseJournal({ publicationId: "other-publication", phase: "completed" });
    const prepared = baseJournal({ phase: "prepared" });
    const resumed = baseJournal({ phase: "completed" });
    const prepare = vi.fn(async () => prepared);
    const resume = vi.fn(async () => resumed);
    const coordinator = fakeCoordinator({
      prepare,
      resume,
    });
    const artifact = artifactMaterial();
    const result = await driveActivationPublication(
      guard,
      coordinator,
      baseInput(),
      { readArtifact: () => artifact, readPublicationJournal: () => stale },
    );
    expect(result).toMatchObject({ status: "completed", journal: resumed });
    expect(prepare).toHaveBeenCalled();
  });

  it("treats a stale aborted journal from an unrelated generation as absent and proceeds to a fresh prepare", async () => {
    const guard = fakeGuard({ "remote-a": "satisfied" });
    const stale = baseJournal({ publicationId: "other-publication", phase: "aborted" });
    const resumed = baseJournal({ phase: "completed" });
    const coordinator = fakeCoordinator({
      prepare: vi.fn(async () => baseJournal({ phase: "prepared" })),
      resume: vi.fn(async () => resumed),
    });
    const artifact = artifactMaterial();
    const result = await driveActivationPublication(
      guard,
      coordinator,
      baseInput(),
      { readArtifact: () => artifact, readPublicationJournal: () => stale },
    );
    expect(result).toMatchObject({ status: "completed", journal: resumed });
  });

  it("reports artifact-unresolvable when the artifact presence read cannot be completed", async () => {
    const guard = fakeGuard({ "remote-a": "satisfied" });
    const coordinator = fakeCoordinator({ recoverPending: vi.fn(async () => null) });
    const readArtifact = () => {
      throw new ActivationArtifactPresenceUnresolvableError("cannot determine presence");
    };
    const result = await driveActivationPublication(guard, coordinator, baseInput(), { readArtifact });
    expect(result.status).toBe("artifact-unresolvable");
    expect(coordinator.prepare).not.toHaveBeenCalled();
  });

  it("rethrows an unrecognized artifact read error unchanged", async () => {
    const guard = fakeGuard({ "remote-a": "satisfied" });
    const coordinator = fakeCoordinator({ recoverPending: vi.fn(async () => null) });
    const boom = new Error("boom");
    const readArtifact = () => { throw boom; };
    await expect(
      driveActivationPublication(guard, coordinator, baseInput(), { readArtifact }),
    ).rejects.toThrow(boom);
  });

  it("reports artifact-missing when no artifact is durably persisted at the identity digest", async () => {
    const guard = fakeGuard({ "remote-a": "satisfied" });
    const coordinator = fakeCoordinator({ recoverPending: vi.fn(async () => null) });
    const result = await driveActivationPublication(
      guard,
      coordinator,
      baseInput(),
      { readArtifact: () => null },
    );
    expect(result.status).toBe("artifact-missing");
  });

  it("reports artifact-identity-mismatch when the artifact's publicationId differs from the caller's", async () => {
    const guard = fakeGuard({ "remote-a": "satisfied" });
    const coordinator = fakeCoordinator({ recoverPending: vi.fn(async () => null) });
    const artifact = artifactMaterial({ publicationId: "different-publication" });
    const result = await driveActivationPublication(
      guard,
      coordinator,
      baseInput(),
      { readArtifact: () => artifact },
    );
    expect(result.status).toBe("artifact-identity-mismatch");
    expect(coordinator.prepare).not.toHaveBeenCalled();
  });

  it("reports artifact-identity-mismatch when the artifact covers a different number of projects", async () => {
    const guard = fakeGuard({ "remote-a": "satisfied" });
    const coordinator = fakeCoordinator({ recoverPending: vi.fn(async () => null) });
    const artifact = artifactMaterial({ projects: [] });
    const result = await driveActivationPublication(
      guard,
      coordinator,
      baseInput(),
      { readArtifact: () => artifact },
    );
    expect(result.status).toBe("artifact-identity-mismatch");
  });

  it("reports artifact-identity-mismatch when the artifact covers a differing project identity", async () => {
    const guard = fakeGuard({ "remote-a": "satisfied" });
    const coordinator = fakeCoordinator({ recoverPending: vi.fn(async () => null) });
    const artifact = artifactMaterial({
      projects: [
        { localProjectId: "local-a", remoteProjectId: "remote-a", evidenceSha256: EVIDENCE_B },
      ],
    });
    const result = await driveActivationPublication(
      guard,
      coordinator,
      baseInput(),
      { readArtifact: () => artifact },
    );
    expect(result.status).toBe("artifact-identity-mismatch");
  });

  it("prepares and resumes a fresh publication from the persisted artifact, retaining one lock token throughout", async () => {
    const guard = fakeGuard({ "remote-a": "satisfied" });
    const artifact = artifactMaterial();
    const prepared = baseJournal({ phase: "prepared" });
    const resumed = baseJournal({ phase: "completed" });
    const recoverPending = vi.fn(async () => null);
    const prepare = vi.fn(async () => prepared);
    const resume = vi.fn(async () => resumed);
    const coordinator = fakeCoordinator({ recoverPending, prepare, resume });
    const input = baseInput();
    const result = await driveActivationPublication(
      guard,
      coordinator,
      input,
      { readArtifact: () => artifact },
    );
    expect(result).toMatchObject({ status: "completed", journal: resumed });
    expect(recoverPending).not.toHaveBeenCalled();
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        publicationId: artifact.publicationId,
        sourceBackend: input.sourceBackend,
        targetBackend: input.targetBackend,
        material: { source: artifact.source, target: artifact.target },
        projects: artifact.projects,
      }),
      input.lockToken,
    );
    expect(resume).toHaveBeenCalledWith(input.lockToken);
  });

  it("reports aborted when a fresh dispatch resumes into an aborted phase", async () => {
    const guard = fakeGuard({ "remote-a": "satisfied" });
    const artifact = artifactMaterial();
    const resumed = baseJournal({ phase: "aborted" });
    const coordinator = fakeCoordinator({
      recoverPending: vi.fn(async () => null),
      prepare: vi.fn(async () => baseJournal({ phase: "prepared" })),
      resume: vi.fn(async () => resumed),
    });
    const result = await driveActivationPublication(
      guard,
      coordinator,
      baseInput(),
      { readArtifact: () => artifact },
    );
    expect(result).toMatchObject({ status: "aborted", journal: resumed });
  });

  it("uses readActivationArtifact by default and reports artifact-missing for an empty home", async () => {
    const guard = fakeGuard({ "remote-a": "satisfied" });
    const coordinator = fakeCoordinator({ recoverPending: vi.fn(async () => null) });
    const result = await driveActivationPublication(guard, coordinator, baseInput());
    expect(result.status).toBe("artifact-missing");
  });
});

describe("driveActivationPublication: journal gate (#1443)", () => {
  const MACHINE = "018f0b5d-1234-7abc-8def-1234567890ab";

  function maintenanceJournal(phase: BackendMaintenanceJournal["phase"]): BackendMaintenanceJournal {
    return {
      version: 3,
      publicationId: "migration-generation-1",
      sourceBackend: "sqlite",
      targetBackend: null,
      phase,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      generationId: "generation-1",
      sourceSelectionSha256: EVIDENCE_A,
      queueEvidenceSha256: EVIDENCE_B,
      roster: [],
      selectedGenerationId: null,
      terminalEvidenceSha256: null,
      abortEvidenceSha256: null,
      checksumSha256: "9".repeat(64),
    };
  }

  /** A faithful coordinator double: recoverPending records that it ran and
   * drives any journal it is given to completed, as #resumeUnlocked does. A
   * double that returned the journal unchanged would pass on the broken base. */
  function drivingCoordinator(journal: BackendPublicationJournal | null) {
    const recoverPending = vi.fn(async () => (journal === null ? null : { ...journal, phase: "completed" as const }));
    return fakeCoordinator({ recoverPending });
  }

  function realHome(): string {
    const value = mkdtempSync(join(tmpdir(), "lcm-activation-publication-real-"));
    mkdirSync(join(value, ".lcm"), { mode: 0o700 });
    roots.push(value);
    return value;
  }

  function realCoordinatorFor(homeDir: string) {
    const material = artifactMaterial();
    const state = backendPublicationMaterialWitness({ source: material.source, target: material.target });
    const targetState = backendPublicationMaterialWitness({ source: material.target, target: material.target });
    let observed = state;
    const fences = new Map<string, BackendPublicationFenceRecord>();
    const driver: BackendPublicationDriver = {
      observeLocalState: async () => observed,
      publishProjectMap: async ({ permit }) => {
        permit.assertActive();
        observed = { ...observed, projectMap: targetState.projectMap };
        return targetState.projectMap;
      },
      publishConfig: async ({ permit }) => {
        permit.assertActive();
        observed = { ...observed, config: targetState.config };
        return targetState.config;
      },
      restoreConfig: async () => state.config,
      restoreProjectMap: async () => state.projectMap,
      acquireRemoteGuard: async ({ journal, project }) => {
        const fence: BackendPublicationFenceRecord = {
          projectId: project.remoteProjectId,
          machineId: MACHINE,
          publicationId: journal.publicationId,
          targetBackend: journal.targetBackend,
          evidenceSha256: project.evidenceSha256,
          fencingToken: "1",
          acquiredAt: "2026-09-19T00:00:00.000Z",
          renewedAt: "2026-09-19T00:00:00.000Z",
          expiresAt: "2999-09-19T00:00:00.000Z",
          releasedAt: null,
          databaseExpired: false,
        };
        fences.set(project.remoteProjectId, fence);
        return fence;
      },
      readRemoteGuard: async ({ project }) => fences.get(project.remoteProjectId) ?? null,
      releaseRemoteGuard: async ({ project, fence }) => {
        fences.set(project.remoteProjectId, { ...fence, releasedAt: "2026-09-19T00:01:00.000Z" });
      },
    };
    return new BackendPublicationCoordinator({ homeDir, driver });
  }

  function spyOn(real: BackendPublicationCoordinator) {
    return {
      recoverPending: vi.fn((options, token) => real.recoverPending(options, token)),
      prepare: vi.fn((input, token) => real.prepare(input, token)),
      resume: vi.fn((token) => real.resume(token)),
    } satisfies ActivationPublicationCoordinator;
  }

  async function holdMaintenance(homeDir: string): Promise<BackendMaintenanceJournal> {
    return realCoordinatorFor(homeDir).enterMaintenance({
      publicationId: "migration-generation-1",
      generationId: "generation-1",
      sourceSelectionSha256: EVIDENCE_A,
      queueEvidenceSha256: EVIDENCE_B,
      roster: [{ machineId: MACHINE, queueCutoff: "0000000000000000012", evidenceSha256: EVIDENCE_A }],
      now: new Date("2026-09-19T00:00:00.000Z"),
    });
  }

  it.each([
    ["localProjectId", { localProjectId: "local-a", remoteProjectId: "remote-b", evidenceSha256: EVIDENCE_B }],
    ["remoteProjectId", { localProjectId: "local-b", remoteProjectId: "remote-a", evidenceSha256: EVIDENCE_B }],
    ["both ids with differing evidence", { localProjectId: "local-a", remoteProjectId: "remote-a", evidenceSha256: EVIDENCE_B }],
  ])("refuses duplicate-publication-input for a repeated %s before any I/O", async (_label, second) => {
    const guard = fakeGuard({ "remote-a": "satisfied", "remote-b": "satisfied" });
    const coordinator = fakeCoordinator();
    const readMaintenanceJournal = vi.fn(() => null);
    const readPublicationJournal = vi.fn(() => null);
    const readArtifact = vi.fn(() => null);
    const input = baseInput({
      projects: [
        { localProjectId: "local-a", remoteProjectId: "remote-a", evidenceSha256: EVIDENCE_A },
        second,
      ],
    });
    const result = await driveActivationPublication(guard, coordinator, input, {
      readMaintenanceJournal,
      readPublicationJournal,
      readArtifact,
    });
    expect(result).toMatchObject({ status: "duplicate-publication-input", journal: null, fenceChecks: [] });
    expect(guard.read).not.toHaveBeenCalled();
    expect(readMaintenanceJournal).not.toHaveBeenCalled();
    expect(readPublicationJournal).not.toHaveBeenCalled();
    expect(readArtifact).not.toHaveBeenCalled();
    expect(coordinator.recoverPending).not.toHaveBeenCalled();
  });

  it("refuses duplicate inputs even when an earlier completed publication exists for this id", async () => {
    const guard = fakeGuard({ "remote-a": "satisfied" });
    const coordinator = drivingCoordinator(baseJournal({ phase: "completed" }));
    const duplicate = { localProjectId: "local-a", remoteProjectId: "remote-a", evidenceSha256: EVIDENCE_A };
    const result = await driveActivationPublication(
      guard,
      coordinator,
      baseInput({ projects: [duplicate, duplicate] }),
      { readPublicationJournal: () => baseJournal({ phase: "completed" }) },
    );
    expect(result.status).toBe("duplicate-publication-input");
    expect(coordinator.recoverPending).not.toHaveBeenCalled();
  });

  it("reports publication-unresolvable, never absent, when the maintenance journal peek throws", async () => {
    const guard = fakeGuard({ "remote-a": "satisfied" });
    const coordinator = fakeCoordinator();
    const result = await driveActivationPublication(guard, coordinator, baseInput(), {
      readMaintenanceJournal: () => { throw new Error("unsafe storage"); },
    });
    expect(result).toMatchObject({ status: "publication-unresolvable", journal: null, fenceChecks: [] });
    expect(result.detail).toContain("unsafe storage");
    expect(guard.read).not.toHaveBeenCalled();
    expect(coordinator.recoverPending).not.toHaveBeenCalled();
    expect(coordinator.prepare).not.toHaveBeenCalled();
  });

  it("reports publication-unresolvable when the version-2 journal peek throws", async () => {
    const guard = fakeGuard({ "remote-a": "satisfied" });
    const coordinator = fakeCoordinator();
    const result = await driveActivationPublication(guard, coordinator, baseInput(), {
      readPublicationJournal: () => { throw new Error("checksum mismatch"); },
    });
    expect(result).toMatchObject({ status: "publication-unresolvable", journal: null, fenceChecks: [] });
    expect(coordinator.recoverPending).not.toHaveBeenCalled();
    expect(guard.read).not.toHaveBeenCalled();
  });

  it.each(["maintenance-entering", "maintenance-held", "selection-prepared"] as const)(
    "refuses with maintenance-in-flight for a version-3 journal in phase %s, without any coordinator call",
    async (phase) => {
      const guard = fakeGuard({ "remote-a": "satisfied" });
      const coordinator = fakeCoordinator();
      const readPublicationJournal = vi.fn(() => null);
      const result = await driveActivationPublication(guard, coordinator, baseInput(), {
        readMaintenanceJournal: () => maintenanceJournal(phase),
        readPublicationJournal,
      });
      expect(result).toMatchObject({ status: "maintenance-in-flight", journal: null, fenceChecks: [] });
      expect(result.detail).toContain(phase);
      expect(guard.read).not.toHaveBeenCalled();
      expect(readPublicationJournal).not.toHaveBeenCalled();
      expect(coordinator.recoverPending).not.toHaveBeenCalled();
      expect(coordinator.prepare).not.toHaveBeenCalled();
    },
  );

  it("refuses a real held version-3 journal through the default peek and leaves its bytes unchanged", async () => {
    const homeDir = realHome();
    await holdMaintenance(homeDir);
    const journalPath = backendPublicationJournalPath(homeDir);
    const before = readFileSync(journalPath, "utf8");
    const coordinator = fakeCoordinator();
    const result = await driveActivationPublication(
      fakeGuard({ "remote-a": "satisfied" }),
      coordinator,
      baseInput({ homeDir }),
    );
    expect(result).toMatchObject({ status: "maintenance-in-flight", journal: null, fenceChecks: [] });
    expect(readFileSync(journalPath, "utf8")).toBe(before);
    expect(coordinator.recoverPending).not.toHaveBeenCalled();
  });

  it("prepares and resumes a fresh publication over a real terminal selection-completed version-3 journal", async () => {
    const homeDir = realHome();
    const held = await holdMaintenance(homeDir);
    const real = realCoordinatorFor(homeDir);
    const prepared = await real.prepareMaintenanceSelection({
      expectedChecksumSha256: held.checksumSha256,
      generationId: "generation-1",
      targetBackend: "postgresql",
      terminalEvidenceSha256: EVIDENCE_B,
    });
    await real.completeMaintenanceSelection({
      expectedChecksumSha256: prepared.checksumSha256,
      generationId: "generation-1",
      terminalEvidenceSha256: EVIDENCE_B,
    });
    expect(readBackendMaintenanceJournal(homeDir)?.phase).toBe("selection-completed");
    const artifact = artifactMaterial();
    const published = publishActivationArtifact({ homeDir, material: artifact });
    const coordinator = spyOn(real);
    const result = await withBackendPublicationConsumerLockAsync(homeDir, (lockToken) =>
      driveActivationPublication(
        fakeGuard({ "remote-a": "satisfied" }),
        coordinator,
        baseInput({ homeDir, lockToken, identityDigest: published.identityDigest }),
      ));
    expect(result.status).toBe("completed");
    expect(result.journal?.publicationId).toBe(PUBLICATION_ID);
    expect(result.fenceChecks).toHaveLength(1);
    expect(coordinator.recoverPending).not.toHaveBeenCalled();
    expect(coordinator.prepare).toHaveBeenCalledTimes(1);
    expect(coordinator.resume).toHaveBeenCalledTimes(1);
    expect(readBackendMaintenanceJournal(homeDir)).toBeNull();
    expect(readBackendPublicationJournal(homeDir)?.phase).toBe("completed");
    expect(readdirSync(backendPublicationHistoryDirectory(homeDir)).length).toBeGreaterThanOrEqual(1);
  });

  it("treats a terminal maintenance-aborted version-3 journal as the same fresh dispatch, with leases asserted", async () => {
    const guard = fakeGuard({ "remote-a": "satisfied" });
    const prepare = vi.fn(async () => baseJournal({ phase: "prepared" }));
    const resume = vi.fn(async () => baseJournal({ phase: "completed" }));
    const coordinator = fakeCoordinator({ prepare, resume });
    const result = await driveActivationPublication(guard, coordinator, baseInput(), {
      readMaintenanceJournal: () => maintenanceJournal("maintenance-aborted"),
      readPublicationJournal: () => { throw new Error("must not be read after a terminal version-3 journal"); },
      readArtifact: () => artifactMaterial(),
    });
    expect(result.status).toBe("completed");
    expect(guard.read).toHaveBeenCalledTimes(1);
    expect(coordinator.recoverPending).not.toHaveBeenCalled();
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it("does not drive an unrelated in-flight version-2 journal: collision without recoverPending", async () => {
    const guard = fakeGuard({ "remote-a": "satisfied" });
    const unrelated = baseJournal({ publicationId: "other-publication", phase: "guarded" });
    const coordinator = drivingCoordinator(unrelated);
    const result = await driveActivationPublication(guard, coordinator, baseInput(), {
      readPublicationJournal: () => unrelated,
    });
    expect(result).toMatchObject({ status: "publication-collision", journal: unrelated, fenceChecks: [] });
    expect(guard.read).not.toHaveBeenCalled();
    expect(coordinator.recoverPending).not.toHaveBeenCalled();
    expect(coordinator.prepare).not.toHaveBeenCalled();
  });

  it("treats an unrelated terminal version-2 journal as a fresh dispatch without recoverPending", async () => {
    const guard = fakeGuard({ "remote-a": "satisfied" });
    const stale = baseJournal({ publicationId: "other-publication", phase: "aborted" });
    const coordinator = fakeCoordinator({
      prepare: vi.fn(async () => baseJournal({ phase: "prepared" })),
      resume: vi.fn(async () => baseJournal({ phase: "completed" })),
    });
    const result = await driveActivationPublication(guard, coordinator, baseInput(), {
      readPublicationJournal: () => stale,
      readArtifact: () => artifactMaterial(),
    });
    expect(result.status).toBe("completed");
    expect(guard.read).toHaveBeenCalledTimes(1);
    expect(coordinator.recoverPending).not.toHaveBeenCalled();
  });

  it.each(["completed", "aborted"] as const)(
    "returns the %s result for a terminal journal of this publication without asserting leases",
    async (phase) => {
      const guard = fakeGuard({});
      const terminal = baseJournal({ phase });
      const coordinator = fakeCoordinator({ recoverPending: vi.fn(async () => terminal) });
      const input = baseInput();
      const result = await driveActivationPublication(guard, coordinator, input, {
        readPublicationJournal: () => terminal,
      });
      expect(result).toMatchObject({ status: phase, journal: terminal, fenceChecks: [] });
      expect(guard.read).not.toHaveBeenCalled();
      expect(coordinator.recoverPending).toHaveBeenCalledWith({ disposition: "resume" }, input.lockToken);
    },
  );

  it("resumes a non-terminal journal of this publication under the retained token after asserting leases", async () => {
    const guard = fakeGuard({ "remote-a": "satisfied" });
    const inFlight = baseJournal({ phase: "guarded" });
    const driven = baseJournal({ phase: "completed" });
    const recoverPending = vi.fn(async () => driven);
    const coordinator = fakeCoordinator({ recoverPending });
    const input = baseInput();
    const result = await driveActivationPublication(guard, coordinator, input, {
      readPublicationJournal: () => inFlight,
    });
    expect(result).toMatchObject({ status: "completed", journal: driven });
    expect(result.fenceChecks).toHaveLength(1);
    expect(recoverPending).toHaveBeenCalledWith({ disposition: "resume" }, input.lockToken);
  });

  it("refuses a non-terminal journal of this publication when its lease is not satisfied", async () => {
    const guard = fakeGuard({ "remote-a": "absent" });
    const coordinator = fakeCoordinator();
    const result = await driveActivationPublication(guard, coordinator, baseInput(), {
      readPublicationJournal: () => baseJournal({ phase: "guarded" }),
    });
    expect(result.status).toBe("fence-unsatisfied");
    expect(coordinator.recoverPending).not.toHaveBeenCalled();
  });

  it("reports a collision when recoverPending finds a different in-flight journal than the peek showed", async () => {
    const guard = fakeGuard({ "remote-a": "satisfied" });
    const raced = baseJournal({ publicationId: "raced-publication", phase: "guarded" });
    const coordinator = fakeCoordinator({ recoverPending: vi.fn(async () => raced) });
    const result = await driveActivationPublication(guard, coordinator, baseInput(), {
      readPublicationJournal: () => baseJournal({ phase: "guarded" }),
    });
    expect(result).toMatchObject({ status: "publication-collision", journal: raced });
  });

  it("falls through to a fresh dispatch when the journal vanished between the peek and recoverPending", async () => {
    const guard = fakeGuard({ "remote-a": "satisfied" });
    const coordinator = fakeCoordinator({
      recoverPending: vi.fn(async () => null),
      prepare: vi.fn(async () => baseJournal({ phase: "prepared" })),
      resume: vi.fn(async () => baseJournal({ phase: "completed" })),
    });
    const result = await driveActivationPublication(guard, coordinator, baseInput(), {
      readPublicationJournal: () => baseJournal({ phase: "guarded" }),
      readArtifact: () => artifactMaterial(),
    });
    expect(result.status).toBe("completed");
    expect(coordinator.prepare).toHaveBeenCalledTimes(1);
  });

  it("maps an artifact identity digest mismatch from the reader to artifact-identity-mismatch", async () => {
    const guard = fakeGuard({ "remote-a": "satisfied" });
    const coordinator = fakeCoordinator();
    const result = await driveActivationPublication(guard, coordinator, baseInput(), {
      readArtifact: () => { throw new ActivationArtifactIdentityMismatchError("digest does not match"); },
    });
    expect(result).toMatchObject({ status: "artifact-identity-mismatch", journal: null });
    expect(result.detail).toContain("digest does not match");
    expect(coordinator.prepare).not.toHaveBeenCalled();
  });
});


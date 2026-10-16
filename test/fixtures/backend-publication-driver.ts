import {
  backendPublicationMaterialWitness,
  type BackendPublicationDriver,
  type BackendPublicationFenceRecord,
  type BackendPublicationRecoveryFile,
  type BackendPublicationRecoveryMaterial,
} from "../../src/storage/backend-publication.js";

/** An in-memory publication driver and material for driving a REAL BackendPublicationCoordinator without PostgreSQL. */
const capturedAt = "2026-09-06T00:00:00.000Z";

export function publicationRecoveryFile(content: string): BackendPublicationRecoveryFile {
  return {
    presence: "present",
    content: Buffer.from(content),
    mode: 0o600,
    uid: typeof process.getuid === "function" ? process.getuid() : 0,
    gid: typeof process.getgid === "function" ? process.getgid() : 0,
    nlink: "1",
    dev: "1",
    ino: "2",
    parentDev: "3",
    parentIno: "4",
  };
}

export function publicationMaterial(): BackendPublicationRecoveryMaterial {
  return {
    source: {
      config: publicationRecoveryFile('{"backend":"sqlite"}'),
      projectMap: publicationRecoveryFile('{"projects":[]}'),
    },
    target: {
      config: publicationRecoveryFile('{"backend":"postgresql"}'),
      projectMap: publicationRecoveryFile('{"projects":["remote"]}'),
    },
  };
}

export function workingPublicationDriver(materialInput: BackendPublicationRecoveryMaterial): BackendPublicationDriver {
  let state = backendPublicationMaterialWitness(materialInput);
  const targetState = backendPublicationMaterialWitness({ source: materialInput.target, target: materialInput.target });
  const fences = new Map<string, BackendPublicationFenceRecord>();
  return {
    acquireRemoteGuard: async ({ journal, project }) => {
      const fence: BackendPublicationFenceRecord = {
        projectId: project.remoteProjectId,
        machineId: "machine-1",
        publicationId: journal.publicationId,
        targetBackend: journal.targetBackend,
        evidenceSha256: project.evidenceSha256,
        fencingToken: "1",
        acquiredAt: capturedAt,
        renewedAt: capturedAt,
        expiresAt: "2999-08-06T12:00:00.000Z",
        releasedAt: null,
        databaseExpired: false,
      };
      fences.set(project.remoteProjectId, fence);
      return fence;
    },
    readRemoteGuard: async ({ project }) => fences.get(project.remoteProjectId) ?? null,
    releaseRemoteGuard: async ({ project, fence }) => {
      fences.set(project.remoteProjectId, { ...fence, releasedAt: capturedAt });
    },
    observeLocalState: async () => state,
    publishProjectMap: async ({ permit }) => {
      permit.assertActive();
      state = { ...state, projectMap: targetState.projectMap };
      return targetState.projectMap;
    },
    publishConfig: async ({ permit }) => {
      permit.assertActive();
      state = { ...state, config: targetState.config };
      return targetState.config;
    },
    restoreConfig: async ({ permit }) => {
      permit.assertActive();
      return targetState.config;
    },
    restoreProjectMap: async ({ permit }) => {
      permit.assertActive();
      return targetState.projectMap;
    },
  };
}

import type { BackendPublicationRemoteGuardProvider } from "../../src/storage/backend-publication-driver.js";
import type { BackendPublicationFenceRecord } from "../../src/storage/backend-publication.js";

/**
 * In-memory remote guard provider for tests that need the coordinator's
 * remote-guard path without a PostgreSQL fence table. One instance holds the
 * fence state for every coordinator it is wired into, so a second coordinator
 * built over the same instance observes the first one's fences.
 */
export function createInMemoryRemoteGuardProvider(): BackendPublicationRemoteGuardProvider {
  const fences = new Map<string, BackendPublicationFenceRecord>();
  return {
    async acquireRemoteGuard({ journal, project }) {
      const existing = fences.get(project.remoteProjectId);
      const fence: BackendPublicationFenceRecord = {
        projectId: project.remoteProjectId,
        machineId: "machine-1",
        publicationId: journal.publicationId,
        targetBackend: journal.targetBackend,
        evidenceSha256: project.evidenceSha256,
        fencingToken: String(existing === undefined ? 1 : BigInt(existing.fencingToken) + 1n),
        acquiredAt: "2026-08-06T12:00:00.000Z",
        renewedAt: "2026-08-06T12:00:00.000Z",
        expiresAt: "2999-08-06T12:00:00.000Z",
        releasedAt: null,
        databaseExpired: false,
      };
      fences.set(project.remoteProjectId, fence);
      return fence;
    },
    async readRemoteGuard({ project }) {
      return fences.get(project.remoteProjectId) ?? null;
    },
    async releaseRemoteGuard({ project, fence }) {
      fences.set(project.remoteProjectId, { ...fence, releasedAt: "2026-08-06T12:01:00.000Z" });
    },
  };
}

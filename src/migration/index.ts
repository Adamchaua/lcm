export * from "./manifest-store.js";
export * from "./protocol.js";
export {
  assertMigrationReplayAdmission,
  authenticateSqliteMigrationSource,
  authenticateSqliteMigrationSourceBytes,
  captureAuthenticatedSqliteMigrationSource,
  classifyImmutableSqliteSnapshot,
  dryRunAuthenticatedSqliteMigrationSource,
  inspectImmutableSqliteSnapshot,
  prepareSqliteMigrationEnrollment,
} from "./maintenance.js";
export type {
  SqliteMigrationEnrollmentDependencies,
  SqliteMigrationEnrollmentInput,
  SqliteMigrationEnrollmentResult,
} from "./maintenance.js";
export { SqliteSnapshotError } from "./sqlite-snapshot.js";
export type {
  AuthenticatedSqliteSnapshotAuthority,
  SqliteSnapshotArtifactRoleWitness,
  SqliteSnapshotArtifactWitness,
  SqliteSnapshotClassification,
  SqliteSnapshotDirectoryIdentity,
  SqliteSnapshotDryRun,
  SqliteSnapshotErrorReason,
  SqliteSnapshotFileIdentity,
  SqliteSnapshotPrivateFileWitness,
  SqliteSnapshotRole,
  SqliteSnapshotSourceByteWitness,
  SqliteSnapshotSourceRoleWitness,
} from "./sqlite-snapshot.js";

export { inspectAuthenticatedSqliteMigrationSnapshot } from "./queue-evidence.js";
export type { AuthenticatedSqliteMigrationSnapshot, MigrationReceiptReference } from "./queue-evidence.js";
export { runSqliteMigrationCopy, inspectSqliteMigrationCopy, MigrationCopyError } from './batch-copy.js';
export type { SqliteMigrationCopyInput, MigrationCopyBoundary, MigrationCopyTestingDependencies } from './batch-copy.js';

export {
  readBackendPublicationOperabilityFact,
  deriveRollbackPublicationId,
  deriveRollbackPrepareInputSha256,
  deriveRollbackReportId,
  writeRollbackReport,
  readRollbackReport,
  runMigrationRollback,
  RollbackOrchestrationError,
} from "./rollback.js";
export type {
  MigrationSelectionBindingRecorder,
  MigrationWitnessBindingRecorder,
  RollbackAuthoritativeContextResolver,
  RollbackFencedSession,
  OpenRollbackFencedSession,
  RollbackReportBody,
  ComputeRollbackTerminalEvidenceInput,
  RollbackTerminalEvidenceComputer,
  RunMigrationRollbackDependencies,
  RunMigrationRollbackInput,
  RunMigrationRollbackOutcome,
  RollbackOrchestrationErrorReason,
} from "./rollback.js";

import { describe, expect, it, onTestFinished, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadDaemonConfig } from "../../src/daemon/config.js";
import { readMachineIdentity } from "../../src/machine-identity.js";
import {
  SQLiteLocalHookOutboxFactory,
  type LocalHookOutboxRepository,
} from "../../src/storage/local-hook-outbox.js";
import {
  PassiveEventReplicationWorker,
  type PassiveEventReplicationDependencies,
} from "../../src/daemon/passive-event-replication.js";
import {
  applyReplicatedPassiveEvent,
  createPassiveEventReplicationPass,
  buildReplicationModules,
  loadReplicationModules,
  ReplicationBindingChangedError,
  type PassiveEventReplicationImports,
  type PassiveEventReplicationModules,
} from "../../src/daemon/passive-event-replication-pass.js";
import {
  BackendPublicationAppendBarrierTimeoutError,
  BackendPublicationJournalError,
  withBackendPublicationConsumerLockAsync,
} from "../../src/storage/backend-publication.js";
import { PrivateMutationLockContentionError } from "../../src/private-mutation-lock.js";

type Modules = PassiveEventReplicationModules;

/** The sidecar the sweep scanned; the pass opens exactly this path. */
const SIDECAR = "/events/project.db";

const PENDING_IDENTITY_KEY = `machine:${"7".repeat(64)}`;
const REGISTERED_IDENTITY = {
  version: 1,
  identityKey: `machine:${"a".repeat(64)}`,
  machineId: "machine-uuid",
  displayName: "registered-host",
};

/**
 * A real LCM home under the vitest-isolated home directory. The identity gate
 * is then exercised through the shipped reader against a real machine.json
 * state rather than a stand-in that only mimics its failures.
 */
function identityHome(machineJson?: string): string {
  const home = mkdtempSync(join(homedir(), "lcm-replication-identity-"));
  const lcmHome = join(home, ".lcm");
  mkdirSync(lcmHome, { recursive: true });
  chmodSync(lcmHome, 0o700);
  if (machineJson !== undefined) {
    const path = join(lcmHome, "machine.json");
    writeFileSync(path, machineJson, { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  return home;
}

/** Bind the shipped machine-identity reader to one real home. */
function identitySeam(home: string) {
  return {
    readMachineIdentity: () => readMachineIdentity(home),
  };
}

/**
 * The factory keeps every repository it opens until it is closed, so the only
 * honest measure of "the sweep leaks nothing" is its own retained set.
 */
function retainedRepositories(factory: SQLiteLocalHookOutboxFactory): number {
  return (factory as unknown as { repositories: ReadonlySet<unknown> }).repositories.size;
}

function sqliteConfig() {
  return loadDaemonConfig("/nonexistent", { daemon: { port: 0 }, llm: { provider: "disabled" } });
}

function postgresConfig() {
  const config = sqliteConfig();
  return {
    ...config,
    storage: {
      backend: "postgresql",
      postgresql: { url: "postgresql://example.test/lcm" },
    },
  } as unknown as ReturnType<typeof sqliteConfig>;
}

function modules(overrides: Partial<Modules> = {}): { modules: Modules; runtime: { health: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }; factory: { openExisting: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } } {
  const runtime = {
    health: vi.fn().mockResolvedValue({ status: "healthy" }),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const factory = {
    openExisting: vi.fn().mockImplementation(async () => ({
      close: vi.fn().mockResolvedValue(undefined),
    })),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return {
    runtime,
    factory,
    modules: {
      ensureWorktreeProjectReconciled: vi.fn(),
      resolveProjectIdentity: vi.fn().mockReturnValue({ remoteProjectId: "project-uuid" }),
      readMachineIdentity: vi.fn().mockReturnValue(REGISTERED_IDENTITY),
      resolveExistingProjectIdentity: vi.fn().mockReturnValue({ remoteProjectId: "project-uuid" }),
      createRuntime: vi.fn().mockReturnValue(runtime),
      createOutboxFactory: vi.fn().mockReturnValue(factory),
      createRepository: vi.fn().mockReturnValue({}),
      createWorker: (
        dependencies: PassiveEventReplicationDependencies,
        processId: string,
      ) => new PassiveEventReplicationWorker(dependencies, { processId }),
      ...overrides,
    } as unknown as Modules,
  };
}

const summary = {
  leaseAcquired: true,
  uploaded: 3,
  applied: 2,
  retried: 1,
  quarantined: 0,
  acknowledged: 2,
  pruned: 1,
};

describe("passive-event replication pass", () => {
  it("documents the applied transition as the terminal remote outcome", async () => {
    // No remote-side effect is intended: the applied inbox row is terminal.
    await expect(applyReplicatedPassiveEvent()).resolves.toBeUndefined();
  });

  it("binds imported namespaces to the seams the pass calls", () => {
    const PostgreSqlRuntime = vi.fn();
    const SQLiteLocalHookOutboxFactory = vi.fn();
    const PostgreSqlPassiveEventRepository = vi.fn();
    const Worker = vi.fn();
    const imported = {
      projectMap: { resolveProjectIdentity: vi.fn(), resolveExistingProjectIdentity: vi.fn() },
      reconciliation: { ensureWorktreeProjectReconciled: vi.fn() },
      identity: { readMachineIdentity: vi.fn() },
      replication: { PassiveEventReplicationWorker: Worker },
      runtime: { PostgreSqlRuntime },
      outbox: { SQLiteLocalHookOutboxFactory },
      repository: { PostgreSqlPassiveEventRepository },
    } as unknown as PassiveEventReplicationImports;

    const bound = buildReplicationModules(imported);
    expect(bound.resolveProjectIdentity).toBe(imported.projectMap.resolveProjectIdentity);
    expect(bound.ensureWorktreeProjectReconciled)
      .toBe(imported.reconciliation.ensureWorktreeProjectReconciled);
    expect(bound.readMachineIdentity).toBe(imported.identity.readMachineIdentity);
    expect(bound.resolveExistingProjectIdentity)
      .toBe(imported.projectMap.resolveExistingProjectIdentity);

    const settings = { url: "postgresql://example.test/lcm" } as never;
    expect(bound.createRuntime(settings)).toBeInstanceOf(PostgreSqlRuntime);
    expect(PostgreSqlRuntime).toHaveBeenCalledWith(settings);
    expect(bound.createOutboxFactory()).toBeInstanceOf(SQLiteLocalHookOutboxFactory);

    const executor = {} as never;
    expect(bound.createRepository(executor, "project-uuid", "machine-uuid"))
      .toBeInstanceOf(PostgreSqlPassiveEventRepository);
    expect(PostgreSqlPassiveEventRepository)
      .toHaveBeenCalledWith(executor, "project-uuid", "machine-uuid");

    const dependencies = {} as unknown as PassiveEventReplicationDependencies;
    expect(bound.createWorker(dependencies, "lcm-daemon:bound")).toBeInstanceOf(Worker);
    expect(Worker).toHaveBeenCalledWith(dependencies, { processId: "lcm-daemon:bound" });
  });

  it("loads the real PostgreSQL namespaces on demand", async () => {
    // Only a replicating daemon ever reaches this import.
    const loaded = await loadReplicationModules();
    expect(typeof loaded.resolveProjectIdentity).toBe("function");
    expect(typeof loaded.ensureWorktreeProjectReconciled).toBe("function");
    expect(typeof loaded.readMachineIdentity).toBe("function");
    expect(typeof loaded.resolveExistingProjectIdentity).toBe("function");
    expect(typeof loaded.createRuntime).toBe("function");
    expect(typeof loaded.createRepository).toBe("function");
    expect(typeof loaded.createWorker).toBe("function");
    const factory = loaded.createOutboxFactory();
    try {
      expect(factory).toBeDefined();
    } finally {
      await factory.close();
    }
  });

  it("skips a SQLite daemon without loading any PostgreSQL module", async () => {
    const loadModules = vi.fn();
    const pass = createPassiveEventReplicationPass(sqliteConfig(), {
      processId: "lcm-daemon:test",
      loadModules,
    });
    await expect(pass.run("/proj", undefined, SIDECAR)).resolves.toBeNull();
    expect(loadModules).not.toHaveBeenCalled();
    await expect(pass.close()).resolves.toBeUndefined();
  });

  it("reports a module load failure and skips", async () => {
    const failure = new Error("module load failed");
    const onError = vi.fn();
    const pass = createPassiveEventReplicationPass(postgresConfig(), {
      processId: "lcm-daemon:test",
      loadModules: vi.fn().mockRejectedValue(failure),
      onError,
    });
    await expect(pass.run("/proj", undefined, SIDECAR)).resolves.toBeNull();
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it("falls back to the hook error log when no reporter is supplied", async () => {
    const pass = createPassiveEventReplicationPass(postgresConfig(), {
      processId: "lcm-daemon:test",
      loadModules: vi.fn().mockRejectedValue(new Error("module load failed")),
    });
    // The default reporter must contain its own failures like the injected one.
    await expect(pass.run("/proj", undefined, SIDECAR)).resolves.toBeNull();
  });

  // A daemon that has never run `lcm machine register` is unconfigured, not
  // broken. Reporting it turns every sidecar of every five-minute sweep into
  // a diagnostic that never stops arriving and that no operator asked for.
  it("skips a machine that has never been registered without reporting", async () => {
    const harness = modules(identitySeam(identityHome()));
    const onError = vi.fn();
    const pass = createPassiveEventReplicationPass(postgresConfig(), {
      processId: "lcm-daemon:test",
      loadModules: async () => harness.modules,
      onError,
    });
    await expect(pass.run("/proj", undefined, SIDECAR)).resolves.toBeNull();
    expect(onError).not.toHaveBeenCalled();
    expect(harness.modules.ensureWorktreeProjectReconciled).not.toHaveBeenCalled();
    expect(harness.modules.createRuntime).not.toHaveBeenCalled();
  });

  it("skips a half-finished machine registration without reporting", async () => {
    const pending = `${JSON.stringify({
      version: 1,
      identityKey: PENDING_IDENTITY_KEY,
      machineId: null,
      displayName: "pending-host",
    }, null, 2)}\n`;
    const harness = modules(identitySeam(identityHome(pending)));
    const onError = vi.fn();
    const pass = createPassiveEventReplicationPass(postgresConfig(), {
      processId: "lcm-daemon:test",
      loadModules: async () => harness.modules,
      onError,
    });
    await expect(pass.run("/proj", undefined, SIDECAR)).resolves.toBeNull();
    expect(onError).not.toHaveBeenCalled();
    expect(harness.modules.ensureWorktreeProjectReconciled).not.toHaveBeenCalled();
    expect(harness.modules.createRuntime).not.toHaveBeenCalled();
  });

  // An unreadable machine.json is a fault rather than a configuration state,
  // so the quiet skip above must not be a blanket silence over every
  // MachineIdentityFileError.
  it("reports an unreadable machine identity instead of skipping it quietly", async () => {
    const harness = modules(identitySeam(identityHome("{ not json\n")));
    const onError = vi.fn();
    const pass = createPassiveEventReplicationPass(postgresConfig(), {
      processId: "lcm-daemon:test",
      loadModules: async () => harness.modules,
      onError,
    });
    await expect(pass.run("/proj", undefined, SIDECAR)).resolves.toBeNull();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      name: "MachineIdentityFileError",
      message: expect.stringContaining("machine.json contains invalid JSON"),
    }));
    expect(harness.modules.createRuntime).not.toHaveBeenCalled();
  });

  // Gate 1 can only keep PostgreSQL out of a SQLite daemon's process if the
  // worker is reached through the dynamically loaded bundle.
  it("constructs its worker through the dynamically loaded modules", async () => {
    const runOnce = vi.fn().mockResolvedValue(summary);
    const createWorker = vi.fn().mockReturnValue({ runOnce });
    const harness = modules({ createWorker } as unknown as Partial<Modules>);
    const pass = createPassiveEventReplicationPass(postgresConfig(), {
      processId: "lcm-daemon:bundle",
      loadModules: async () => harness.modules,
    });
    await expect(pass.run("/proj", undefined, SIDECAR)).resolves.toEqual(summary);
    expect(createWorker).toHaveBeenCalledWith(
      expect.objectContaining({ applyEvent: applyReplicatedPassiveEvent }),
      "lcm-daemon:bundle",
    );
  });

  it("keeps PostgreSQL storage out of its own static module graph", async () => {
    const repositoryModule = "../../src/storage/postgresql/passive-event-repository.js";
    vi.resetModules();
    vi.doMock(repositoryModule, () => {
      throw new Error("the pass statically imported the PostgreSQL passive-event repository");
    });
    try {
      const reloaded = await import("../../src/daemon/passive-event-replication-pass.js");
      expect(typeof reloaded.createPassiveEventReplicationPass).toBe("function");
    } finally {
      vi.doUnmock(repositoryModule);
      vi.resetModules();
    }
  });

  it("skips an unbound project quietly without opening a connection", async () => {
    const harness = modules({
      resolveProjectIdentity: vi.fn().mockReturnValue({ remoteProjectId: null }),
    });
    const onError = vi.fn();
    const pass = createPassiveEventReplicationPass(postgresConfig(), {
      processId: "lcm-daemon:test",
      loadModules: async () => harness.modules,
      onError,
    });
    await expect(pass.run("/proj", undefined, SIDECAR)).resolves.toBeNull();
    // Reconciliation runs first so a linked worktree resolves canonically.
    expect(harness.modules.ensureWorktreeProjectReconciled).toHaveBeenCalledWith("/proj");
    expect(harness.modules.createRuntime).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("treats an absent remote project id as unbound", async () => {
    const harness = modules({ resolveProjectIdentity: vi.fn().mockReturnValue({}) });
    const pass = createPassiveEventReplicationPass(postgresConfig(), {
      processId: "lcm-daemon:test",
      loadModules: async () => harness.modules,
    });
    await expect(pass.run("/proj", undefined, SIDECAR)).resolves.toBeNull();
    expect(harness.modules.createRuntime).not.toHaveBeenCalled();
  });

  it("refuses to claim a lease against unhealthy storage", async () => {
    const failure = new Error("connection refused");
    const harness = modules();
    harness.runtime.health.mockResolvedValue({ status: "unavailable", error: failure });
    const onError = vi.fn();
    const pass = createPassiveEventReplicationPass(postgresConfig(), {
      processId: "lcm-daemon:test",
      loadModules: async () => harness.modules,
      onError,
    });
    await expect(pass.run("/proj", undefined, SIDECAR)).resolves.toBeNull();
    expect(onError).toHaveBeenCalledWith(failure);
    expect(harness.factory.openExisting).not.toHaveBeenCalled();
  });

  it("reports unhealthy storage that offers no error", async () => {
    const harness = modules();
    harness.runtime.health.mockResolvedValue({ status: "unavailable" });
    const onError = vi.fn();
    const pass = createPassiveEventReplicationPass(postgresConfig(), {
      processId: "lcm-daemon:test",
      loadModules: async () => harness.modules,
      onError,
    });
    await expect(pass.run("/proj", undefined, SIDECAR)).resolves.toBeNull();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: "PostgreSQL passive-event storage is unavailable",
    }));
  });

  it("drains a bound project and reuses its runtime across passes", async () => {
    const harness = modules();
    const runOnce = vi.fn().mockResolvedValue(summary);
    const createWorker = vi.fn().mockReturnValue({ runOnce });
    const pass = createPassiveEventReplicationPass(postgresConfig(), {
      processId: "lcm-daemon:instance",
      loadModules: async () => harness.modules,
      createWorker,
    });
    const signal = new AbortController().signal;

    await expect(pass.run("/proj", signal, SIDECAR)).resolves.toEqual(summary);
    await expect(pass.run("/proj", signal, SIDECAR)).resolves.toEqual(summary);

    // One connection and one outbox factory serve every pass.
    expect(harness.modules.createRuntime).toHaveBeenCalledTimes(1);
    expect(harness.modules.createOutboxFactory).toHaveBeenCalledTimes(1);
    expect(runOnce).toHaveBeenCalledWith(signal);
    expect(createWorker).toHaveBeenCalledWith(
      expect.objectContaining({ applyEvent: applyReplicatedPassiveEvent }),
      "lcm-daemon:instance",
    );
    expect(harness.modules.createRepository).toHaveBeenCalledWith(
      harness.runtime,
      "project-uuid",
      "machine-uuid",
    );

    await pass.close();
    expect(harness.runtime.close).toHaveBeenCalledTimes(1);
    expect(harness.factory.close).toHaveBeenCalledTimes(1);
  });

  it("builds a real worker when no factory is injected", async () => {
    const local = {};
    const remote = { acquireDrainLease: vi.fn().mockResolvedValue(null) };
    const harness = modules({ createRepository: vi.fn().mockReturnValue(remote) });
    harness.factory.openExisting.mockResolvedValue(local);
    const pass = createPassiveEventReplicationPass(postgresConfig(), {
      processId: "lcm-daemon:real",
      loadModules: async () => harness.modules,
    });

    // No lease is available, so the shipped worker returns an empty summary.
    await expect(pass.run("/proj", undefined, SIDECAR)).resolves.toMatchObject({
      leaseAcquired: false,
      uploaded: 0,
      pruned: 0,
    });
    expect(remote.acquireDrainLease).toHaveBeenCalledWith("lcm-daemon:real", 30_000, undefined);
  });

  it("reports a drain failure and skips the project", async () => {
    const failure = new Error("outbox is locked");
    const harness = modules();
    harness.factory.openExisting.mockRejectedValue(failure);
    const onError = vi.fn();
    const pass = createPassiveEventReplicationPass(postgresConfig(), {
      processId: "lcm-daemon:test",
      loadModules: async () => harness.modules,
      onError,
    });
    await expect(pass.run("/proj", undefined, SIDECAR)).resolves.toBeNull();
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it("never lets a failing diagnostic displace replication work", async () => {
    const harness = modules({ resolveProjectIdentity: vi.fn(() => { throw new Error("boom"); }) });
    const pass = createPassiveEventReplicationPass(postgresConfig(), {
      processId: "lcm-daemon:test",
      loadModules: async () => harness.modules,
      onError: () => { throw new Error("diagnostic failed"); },
    });
    await expect(pass.run("/proj", undefined, SIDECAR)).resolves.toBeNull();
  });

  it("closes without a session and reports a failing close", async () => {
    const idle = createPassiveEventReplicationPass(postgresConfig(), { processId: "lcm-daemon:test" });
    await expect(idle.close()).resolves.toBeUndefined();

    const failure = new Error("close failed");
    const harness = modules();
    harness.runtime.close.mockRejectedValue(failure);
    const onError = vi.fn();
    const pass = createPassiveEventReplicationPass(postgresConfig(), {
      processId: "lcm-daemon:test",
      loadModules: async () => harness.modules,
      onError,
      createWorker: () => ({ runOnce: vi.fn().mockResolvedValue(summary) }),
    });
    await pass.run("/proj", undefined, SIDECAR);
    await expect(pass.close()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(failure);

    // A closed pass reopens cleanly rather than reusing a dead connection.
    await pass.run("/proj", undefined, SIDECAR);
    expect(harness.modules.createRuntime).toHaveBeenCalledTimes(2);
  });

  // The five-minute sweep opens one outbox per project per pass. The factory
  // registers each repository and only drops it when that repository closes,
  // so a pass that returns without closing grows the daemon's SQLite
  // connection set forever — the same unbounded-growth defect #1383 exists
  // to remove.
  it("admits each worker phase separately and releases between phases", async () => {
    // The pass owns the admission the worker phases run under: the lock
    // file must be present during every phase and absent between them, so
    // hook appends can proceed while the sweep is still running.
    const home = mkdtempSync(join(tmpdir(), "lcm-replication-admission-"));
    mkdirSync(join(home, ".lcm"), { recursive: true });
    writeFileSync(join(home, ".lcm", "config.json"), "{}\n", { mode: 0o600 });
    try {
      const lockPath = join(home, ".lcm.backend-publication.lock");
      const fencingToken = 7n;
      const observed: Record<string, boolean> = {};
      const probe = (name: string) => { observed[name] = existsSync(lockPath); };
      const harness = modules();
      harness.factory.openExisting.mockResolvedValue({
        claimDeliveries: vi.fn().mockImplementation(async () => { probe("upload"); return []; }),
        listAwaitingRemote: vi.fn().mockImplementation(async () => { probe("reconcile"); return []; }),
        listAcknowledgedForRemotePrune: vi.fn().mockImplementation(async () => { probe("prune"); return []; }),
        close: vi.fn().mockResolvedValue(undefined),
      });
      harness.modules.createRepository = vi.fn().mockReturnValue({
        machineId: "machine-uuid",
        acquireDrainLease: vi.fn().mockImplementation(async () => {
          probe("acquire");
          return { fencingToken };
        }),
        renewDrainLease: vi.fn().mockResolvedValue({ fencingToken }),
        claimEvents: vi.fn().mockImplementation(async () => { probe("claim"); return []; }),
        releaseDrainLease: vi.fn().mockImplementation(async () => { probe("release"); }),
      });
      const pass = createPassiveEventReplicationPass(postgresConfig(), {
        processId: "lcm-daemon:phased",
        loadModules: async () => harness.modules,
        withPublicationAdmission: async operation =>
          withBackendPublicationConsumerLockAsync(home, token => operation(token)),
        publicationHome: home,
      });

      await expect(pass.run("/proj", undefined, SIDECAR)).resolves.toMatchObject({ leaseAcquired: true });
      // Every remote and local phase ran admitted, including the lease
      // acquisition; only the cleanup release ran outside all admissions.
      expect(observed).toMatchObject({
        acquire: true,
        upload: true,
        claim: true,
        reconcile: true,
        prune: true,
        release: false,
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("threads its phase admission through a custom worker construction", async () => {
    // A custom createWorker receives the same dependencies object the
    // loaded fallback would, so the phase admission reaches it either way
    // (the fallback side runs end to end in the admission test above).
    const home = mkdtempSync(join(tmpdir(), "lcm-replication-threading-"));
    mkdirSync(join(home, ".lcm"), { recursive: true });
    writeFileSync(join(home, ".lcm", "config.json"), "{}\n", { mode: 0o600 });
    try {
      const lockPath = join(home, ".lcm.backend-publication.lock");
      const harness = modules();
      let heldDuringPhase: boolean | null = null;
      const pass = createPassiveEventReplicationPass(postgresConfig(), {
        processId: "lcm-daemon:threading",
        loadModules: async () => harness.modules,
        withPublicationAdmission: async operation =>
          withBackendPublicationConsumerLockAsync(home, token => operation(token)),
        publicationHome: home,
        createWorker: (dependencies: PassiveEventReplicationDependencies) => ({
          runOnce: async () => {
            await dependencies.admitPhase?.(async () => {
              heldDuringPhase = existsSync(lockPath);
            });
            return summary;
          },
        }),
      });
      await expect(pass.run("/proj", undefined, SIDECAR)).resolves.toEqual(summary);
      expect(heldDuringPhase).toBe(true);
      await pass.close();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rethrows publication admission and barrier failures instead of reporting them", async () => {
    // A frozen-backend refusal must reach the processor halting logic, and
    // barrier contention must reach its per-project log: neither may be
    // downgraded to a quiet reported skip.
    const mismatch = new BackendPublicationJournalError("backend-mismatch", "publication moved on");
    const barrierTimeout = new BackendPublicationAppendBarrierTimeoutError(
      new PrivateMutationLockContentionError("busy"),
    );
    for (const failure of [mismatch, barrierTimeout]) {
      const harness = modules();
      const onError = vi.fn();
      const pass = createPassiveEventReplicationPass(postgresConfig(), {
        processId: "lcm-daemon:rethrow",
        loadModules: async () => harness.modules,
        onError,
        createWorker: () => ({ runOnce: vi.fn().mockRejectedValue(failure) }),
      });
      await expect(pass.run("/proj", undefined, SIDECAR)).rejects.toBe(failure);
      expect(onError).not.toHaveBeenCalledWith(failure);
      await pass.close();
    }
  });

  it("retains no sidecar outbox once its pass has finished", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lcm-replication-outbox-"));
    const factory = new SQLiteLocalHookOutboxFactory();
    const opened: LocalHookOutboxRepository[] = [];
    const harness = modules({ createOutboxFactory: () => factory });
    // The pass only opens sidecars that already exist.
    const sidecars = new Map<string, string>();
    for (const cwd of ["/alpha", "/beta"]) {
      const path = join(directory, `${cwd.replaceAll("/", "_")}.db`);
      sidecars.set(cwd, path);
      await (await factory.open(path)).close();
    }
    const pass = createPassiveEventReplicationPass(postgresConfig(), {
      processId: "lcm-daemon:test",
      loadModules: async () => harness.modules,
      createWorker: dependencies => {
        opened.push(dependencies.local);
        return { runOnce: async () => summary };
      },
    });

    try {
      for (let sweep = 0; sweep < 3; sweep += 1) {
        await expect(pass.run("/alpha", undefined, sidecars.get("/alpha")!)).resolves.toEqual(summary);
        await expect(pass.run("/beta", undefined, sidecars.get("/beta")!)).resolves.toEqual(summary);
      }

      // Six real repositories were opened, and none of them is still held.
      expect(opened).toHaveLength(6);
      expect(new Set(opened).size).toBe(6);
      expect(retainedRepositories(factory)).toBe(0);
      for (const repository of opened) {
        await expect(repository.getUnprocessed()).rejects
          .toMatchObject({ code: "STORAGE_CLOSED" });
      }
    } finally {
      await pass.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reports a failing outbox close without losing the pass result", async () => {
    const failure = new Error("outbox close failed");
    const harness = modules();
    harness.factory.openExisting.mockResolvedValue({
      close: vi.fn().mockRejectedValue(failure),
    });
    const onError = vi.fn();
    const pass = createPassiveEventReplicationPass(postgresConfig(), {
      processId: "lcm-daemon:test",
      loadModules: async () => harness.modules,
      onError,
      createWorker: () => ({ runOnce: vi.fn().mockResolvedValue(summary) }),
    });

    await expect(pass.run("/proj", undefined, SIDECAR)).resolves.toEqual(summary);
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it("opens exactly the scanned sidecar the sweep passed in", async () => {
    // #1488: the pass used to derive eventsDbPath(cwd) and could open or
    // create a different sidecar than the one the sweep scanned.
    const harness = modules();
    const createWorker = vi.fn().mockReturnValue({ runOnce: vi.fn().mockResolvedValue(summary) });
    const pass = createPassiveEventReplicationPass(postgresConfig(), {
      processId: "lcm-daemon:sidecar",
      loadModules: async () => harness.modules,
      createWorker,
    });
    await expect(pass.run("/proj", undefined, "/events/legacy-key.db")).resolves.toEqual(summary);
    expect(harness.factory.openExisting).toHaveBeenCalledTimes(1);
    expect(harness.factory.openExisting).toHaveBeenCalledWith("/events/legacy-key.db");
    await pass.close();
  });

  it("skips quietly when the scanned sidecar can no longer be opened", async () => {
    const harness = modules();
    harness.factory.openExisting.mockResolvedValue(null);
    const onError = vi.fn();
    const createWorker = vi.fn();
    const pass = createPassiveEventReplicationPass(postgresConfig(), {
      processId: "lcm-daemon:missing",
      loadModules: async () => harness.modules,
      onError,
      createWorker,
    });
    await expect(pass.run("/proj", undefined, SIDECAR)).resolves.toBeNull();
    expect(createWorker).not.toHaveBeenCalled();
    expect(harness.modules.createRepository).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    await pass.close();
  });

  it("never creates a sidecar for a missing events database", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lcm-replication-missing-"));
    const missing = join(directory, "absent", "events.db");
    const factory = new SQLiteLocalHookOutboxFactory();
    const harness = modules({ createOutboxFactory: () => factory });
    const createWorker = vi.fn();
    const pass = createPassiveEventReplicationPass(postgresConfig(), {
      processId: "lcm-daemon:absent",
      loadModules: async () => harness.modules,
      createWorker,
    });
    try {
      await expect(pass.run("/proj", undefined, missing)).resolves.toBeNull();
      expect(createWorker).not.toHaveBeenCalled();
      expect(existsSync(join(directory, "absent"))).toBe(false);
      expect(retainedRepositories(factory)).toBe(0);
    } finally {
      await pass.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("hands the shutdown signal to the health check and stops when it aborts", async () => {
    // #1477: the signal used to be dropped, so shutdown waited out the
    // connection or statement timeout. The fake settles unavailable on abort,
    // as the real runtime does, and can always be released by the test.
    const harness = modules();
    let seen: AbortSignal | undefined;
    let entered!: () => void;
    const hasEntered = new Promise<void>(resolve => { entered = resolve; });
    let release: () => void = () => undefined;
    harness.runtime.health.mockImplementation((signal?: AbortSignal) => new Promise(resolve => {
      seen = signal;
      release = () => resolve({ status: "unavailable" });
      signal?.addEventListener("abort", release, { once: true });
      entered();
    }));
    const onError = vi.fn();
    const createWorker = vi.fn();
    const pass = createPassiveEventReplicationPass(postgresConfig(), {
      processId: "lcm-daemon:shutdown",
      loadModules: async () => harness.modules,
      onError,
      createWorker,
    });
    const controller = new AbortController();
    const running = pass.run("/proj", controller.signal, SIDECAR);
    try {
      await hasEntered;
      expect(seen).toBe(controller.signal);
      controller.abort();
      await expect(running).resolves.toBeNull();
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({
        message: "PostgreSQL passive-event storage is unavailable",
      }));
      expect(harness.factory.openExisting).not.toHaveBeenCalled();
      expect(createWorker).not.toHaveBeenCalled();
    } finally {
      release();
      await running.catch(() => undefined);
      await pass.close();
    }
  }, 10_000);

  describe("outbox close failures", () => {
    /** A fake repository whose close rejects once per supplied failure. */
    function localWithCloseFailures(...failures: unknown[]) {
      const close = vi.fn();
      for (const failure of failures) close.mockRejectedValueOnce(failure);
      close.mockResolvedValue(undefined);
      return { close };
    }

    function closePass(harness: ReturnType<typeof modules>, onError = vi.fn()) {
      const createWorker = vi.fn().mockReturnValue({ runOnce: vi.fn().mockResolvedValue(summary) });
      return {
        onError,
        createWorker,
        pass: createPassiveEventReplicationPass(postgresConfig(), {
          processId: "lcm-daemon:close",
          loadModules: async () => harness.modules,
          onError,
          createWorker,
        }),
      };
    }

    it("retries a failed close before it opens that sidecar again", async () => {
      const failure = new Error("close contended");
      const first = localWithCloseFailures(failure);
      const second = localWithCloseFailures();
      const harness = modules();
      harness.factory.openExisting.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
      const { pass, onError } = closePass(harness);

      await expect(pass.run("/proj", undefined, SIDECAR)).resolves.toEqual(summary);
      expect(onError).toHaveBeenCalledWith(failure);
      expect(first.close).toHaveBeenCalledTimes(1);
      expect(harness.factory.openExisting).toHaveBeenCalledTimes(1);

      await expect(pass.run("/proj", undefined, SIDECAR)).resolves.toEqual(summary);
      // The held repository was closed before the second open.
      expect(first.close).toHaveBeenCalledTimes(2);
      expect(first.close.mock.invocationCallOrder[1])
        .toBeLessThan(harness.factory.openExisting.mock.invocationCallOrder[1]);
      expect(harness.factory.openExisting).toHaveBeenCalledTimes(2);
      expect(second.close).toHaveBeenCalledTimes(1);

      // Nothing is held any longer, so the next pass does not retry anything.
      await expect(pass.run("/proj", undefined, SIDECAR)).resolves.toEqual(summary);
      expect(first.close).toHaveBeenCalledTimes(2);
      expect(harness.factory.openExisting).toHaveBeenCalledTimes(3);
      await pass.close();
    });

    it("keeps at most one outstanding repository per sidecar while close keeps failing", async () => {
      const failure = new Error("close contended");
      const stuck = localWithCloseFailures(failure, failure, failure, failure, failure);
      const harness = modules();
      harness.factory.openExisting.mockResolvedValue(stuck);
      const { pass, onError, createWorker } = closePass(harness);

      await expect(pass.run("/proj", undefined, SIDECAR)).resolves.toEqual(summary);
      for (let sweep = 0; sweep < 4; sweep += 1) {
        // The retry fails again: reported, project skipped, nothing reopened.
        await expect(pass.run("/proj", undefined, SIDECAR)).resolves.toBeNull();
      }
      expect(harness.factory.openExisting).toHaveBeenCalledTimes(1);
      expect(createWorker).toHaveBeenCalledTimes(1);
      expect(stuck.close).toHaveBeenCalledTimes(5);
      expect(onError).toHaveBeenCalledTimes(5);
      await pass.close();
    });

    it("keeps one retained repository per sidecar path", async () => {
      const failure = new Error("close contended");
      const alpha = localWithCloseFailures(failure);
      const beta = localWithCloseFailures(failure);
      const harness = modules();
      harness.factory.openExisting.mockImplementation(async (path: string) => (
        path === "/events/alpha.db" ? alpha : beta
      ));
      const { pass } = closePass(harness);
      await pass.run("/alpha", undefined, "/events/alpha.db");
      await pass.run("/beta", undefined, "/events/beta.db");
      // Each path retries only its own held repository.
      await pass.run("/alpha", undefined, "/events/alpha.db");
      expect(alpha.close).toHaveBeenCalledTimes(3);
      expect(beta.close).toHaveBeenCalledTimes(1);
      await pass.close();
    });

    it("skips the sidecar when the retried close succeeds but it can no longer be opened", async () => {
      const held = localWithCloseFailures(new Error("close contended"));
      const harness = modules();
      harness.factory.openExisting.mockResolvedValueOnce(held).mockResolvedValueOnce(null);
      const { pass, createWorker } = closePass(harness);
      await pass.run("/proj", undefined, SIDECAR);
      await expect(pass.run("/proj", undefined, SIDECAR)).resolves.toBeNull();
      expect(held.close).toHaveBeenCalledTimes(2);
      expect(createWorker).toHaveBeenCalledTimes(1);
      await pass.close();
    });

    it("reports a failed retry of any kind instead of rethrowing it", async () => {
      const barrier = new BackendPublicationAppendBarrierTimeoutError(
        new PrivateMutationLockContentionError("busy"),
      );
      const journal = new BackendPublicationJournalError("backend-mismatch", "publication moved on");
      for (const retryFailure of [barrier, journal]) {
        const held = localWithCloseFailures(new Error("close contended"), retryFailure);
        const harness = modules();
        harness.factory.openExisting.mockResolvedValue(held);
        const { pass, onError, createWorker } = closePass(harness);

        await pass.run("/proj", undefined, SIDECAR);
        await expect(pass.run("/proj", undefined, SIDECAR)).resolves.toBeNull();
        expect(onError).toHaveBeenCalledWith(retryFailure);
        expect(createWorker).toHaveBeenCalledTimes(1);
        expect(harness.factory.openExisting).toHaveBeenCalledTimes(1);

        // A later retry succeeds and the sidecar replicates again.
        await expect(pass.run("/proj", undefined, SIDECAR)).resolves.toEqual(summary);
        expect(createWorker).toHaveBeenCalledTimes(2);
        await pass.close();
      }
    });

    it("keeps its factory for a later close and opens nothing meanwhile", async () => {
      // Real factory and repositories: the registered count is the proof.
      const directory = mkdtempSync(join(tmpdir(), "lcm-replication-close-"));
      const sidecar = join(directory, "events.db");
      const factories: SQLiteLocalHookOutboxFactory[] = [];
      const failures: Error[] = [];
      const harness = modules({
        createOutboxFactory: () => {
          const real = new SQLiteLocalHookOutboxFactory();
          factories.push(real);
          const factoryFailure = new Error("factory close failed");
          failures.push(factoryFailure);
          const close = vi.fn()
            .mockRejectedValueOnce(factoryFailure)
            .mockImplementation(() => real.close());
          return {
            close,
            openExisting: async (path: string) => {
              const repository = await real.openExisting(path);
              if (repository === null) return null;
              // The first close fails without releasing anything.
              const closeFailure = new Error("repository close failed");
              failures.push(closeFailure);
              const closeOnce = vi.fn()
                .mockRejectedValueOnce(closeFailure)
                .mockImplementation(() => repository.close());
              return { close: closeOnce } as unknown as LocalHookOutboxRepository;
            },
          };
        },
      });
      await (await new SQLiteLocalHookOutboxFactory().open(sidecar)).close();
      const { pass, onError, createWorker } = closePass(harness);
      try {
        await expect(pass.run("/proj", undefined, sidecar)).resolves.toEqual(summary);
        expect(retainedRepositories(factories[0])).toBe(1);

        // The factory refuses to close once: it and its repository are kept.
        await expect(pass.close()).resolves.toBeUndefined();
        expect(onError).toHaveBeenCalledWith(failures[0]);
        expect(retainedRepositories(factories[0])).toBe(1);

        // A pass in that window opens nothing, so no second database is held.
        await expect(pass.run("/proj", undefined, sidecar)).resolves.toBeNull();
        expect(factories).toHaveLength(1);
        expect(retainedRepositories(factories[0])).toBe(1);
        expect(createWorker).toHaveBeenCalledTimes(1);

        // The retry closes the factory, and with it every registered repository.
        await expect(pass.close()).resolves.toBeUndefined();
        expect(retainedRepositories(factories[0])).toBe(0);

        // The pass is usable again through a fresh factory.
        await expect(pass.run("/proj", undefined, sidecar)).resolves.toEqual(summary);
        expect(factories).toHaveLength(2);
        expect(createWorker).toHaveBeenCalledTimes(2);
      } finally {
        await pass.close();
        for (const factory of factories) await factory.close();
        rmSync(directory, { recursive: true, force: true });
      }
    });
  });

  describe("project binding during a pass", () => {
    const BOUND = { remoteProjectId: "project-a" };
    const REBOUND = { remoteProjectId: "project-b" };
    type Binding = { readonly remoteProjectId?: string | null } | null;

    const LOCAL_EVENT = {
      event_uuid: "event-1",
      event_version: 1,
      machine_id: "machine-uuid",
      machine_sequence: "7",
      type: "choice",
      session_id: "session",
      seq: 1,
      category: "decision",
      data: "SQLite",
      priority: 1,
      source_hook: "PostToolUse",
      prev_event_id: null,
      created_at: "2026-07-29 12:00:00",
      delivery_attempts: 1,
    };

    function remoteEvent(status: "pending" | "applied") {
      return {
        inboxId: 41n,
        machineId: "machine-uuid",
        eventId: "event-1",
        eventVersion: 1,
        machineSequence: 7n,
        eventType: "choice",
        payload: {
          sessionId: "session",
          sessionSequence: 1,
          category: "decision",
          data: "SQLite",
          priority: 1,
          sourceHook: "PostToolUse",
          previousEventId: null,
          createdAt: "2026-07-29 12:00:00",
        },
        status,
      };
    }

    function publicationHome(): string {
      const home = mkdtempSync(join(tmpdir(), "lcm-replication-binding-"));
      mkdirSync(join(home, ".lcm"), { recursive: true });
      writeFileSync(join(home, ".lcm", "config.json"), "{}\n", { mode: 0o600 });
      onTestFinished(() => { rmSync(home, { recursive: true, force: true }); });
      return home;
    }

    /**
     * The shipped worker runs against fake repositories. The binding the
     * pass re-reads is the bound one for `goodChecks` admissions and then
     * becomes `after`, as if an operator relinked the project mid-pass.
     * With `row` the local outbox holds one pending event: the first
     * claim hands it out, and once it is marked replicated it awaits the
     * remote project's applied state.
     */
    function relinkHarness(
      goodChecks: number,
      after: Binding = REBOUND,
      options: { readonly claims?: unknown[]; readonly row?: boolean } = {},
    ) {
      const fencingToken = 7n;
      const state: { current: Binding } = { current: BOUND };
      let checks = 0;
      const resolveExistingProjectIdentity = vi.fn((_cwd: string, _token?: unknown) => {
        checks += 1;
        if (checks > goodChecks) state.current = after;
        return state.current;
      });
      const local = {
        claimDeliveries: vi.fn().mockResolvedValueOnce(options.row === true ? [LOCAL_EVENT] : []).mockResolvedValue([]),
        listAwaitingRemote: vi.fn(async () =>
          options.row === true && local.markReplicated.mock.calls.length > 0 ? [LOCAL_EVENT] : []),
        listAcknowledgedForRemotePrune: vi.fn().mockResolvedValue([]),
        markReplicated: vi.fn().mockResolvedValue(true),
        markAcknowledged: vi.fn().mockResolvedValue(true),
        close: vi.fn().mockResolvedValue(undefined),
      };
      const remote = {
        machineId: "machine-uuid",
        acquireDrainLease: vi.fn().mockResolvedValue({ fencingToken }),
        renewDrainLease: vi.fn().mockResolvedValue({ fencingToken }),
        claimEvents: vi.fn().mockResolvedValue(options.claims ?? []),
        completeApplied: vi.fn(),
        insertEvents: vi.fn().mockResolvedValue([remoteEvent("pending")]),
        readEvents: vi.fn().mockResolvedValue([remoteEvent("applied")]),
        releaseDrainLease: vi.fn().mockResolvedValue(undefined),
      };
      const harness = modules({
        resolveProjectIdentity: vi.fn(() => state.current ?? { remoteProjectId: null }),
        resolveExistingProjectIdentity,
        createRepository: vi.fn().mockReturnValue(remote),
      });
      harness.factory.openExisting.mockResolvedValue(local);
      return { harness, local, remote, resolveExistingProjectIdentity, fencingToken };
    }

    function admittedPass(
      harness: ReturnType<typeof modules>,
      home: string,
      onError = vi.fn(),
      tokens: unknown[] = [],
    ) {
      return createPassiveEventReplicationPass(postgresConfig(), {
        processId: "lcm-daemon:binding",
        loadModules: async () => harness.modules,
        onError,
        withPublicationAdmission: async operation =>
          withBackendPublicationConsumerLockAsync(home, token => {
            tokens.push(token);
            return operation(token);
          }),
        publicationHome: home,
      });
    }

    function expectReportedOnce(
      fixture: ReturnType<typeof relinkHarness>,
      onError: ReturnType<typeof vi.fn>,
    ): void {
      const { remote, fencingToken } = fixture;
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(expect.any(ReplicationBindingChangedError));
      expect(onError.mock.calls[0][0]).toMatchObject({
        name: "ReplicationBindingChangedError",
        message: expect.stringContaining("/proj"),
      });
      // The pass finishes its phases, so its lease is released exactly once.
      expect(remote.releaseDrainLease).toHaveBeenCalledTimes(1);
      expect(remote.releaseDrainLease).toHaveBeenCalledWith("lcm-daemon:binding", fencingToken, undefined);
    }

    it("uploads no new row to the old project when the project is relinked at the lease", async () => {
      const home = publicationHome();
      const fixture = relinkHarness(0, REBOUND, { row: true });
      const onError = vi.fn();
      const tokens: unknown[] = [];
      const pass = admittedPass(fixture.harness, home, onError, tokens);

      // The worker's own result comes back; the pass is not abandoned.
      await expect(pass.run("/proj", undefined, SIDECAR)).resolves.toMatchObject({
        leaseAcquired: true,
        uploaded: 0,
      });
      // The stale project is never offered the pending row, and the row
      // stays pending in the local outbox for the new binding.
      expect(fixture.local.claimDeliveries).not.toHaveBeenCalled();
      expect(fixture.remote.insertEvents).not.toHaveBeenCalled();
      expect(fixture.local.markReplicated).not.toHaveBeenCalled();
      // Everything that completes work already in the old project still runs.
      expect(fixture.remote.renewDrainLease).toHaveBeenCalledTimes(1);
      expect(fixture.remote.claimEvents).toHaveBeenCalledTimes(1);
      expect(fixture.local.listAwaitingRemote).toHaveBeenCalledTimes(1);
      expect(fixture.local.listAcknowledgedForRemotePrune).toHaveBeenCalledTimes(1);
      expectReportedOnce(fixture, onError);

      // The binding was read once, under the token the lease admission
      // granted, and never again after it changed.
      expect(tokens).toHaveLength(6);
      expect(fixture.resolveExistingProjectIdentity.mock.calls).toEqual([["/proj", tokens[0]]]);
      await pass.close();
    });

    it("completes the rows it already uploaded when the project is relinked after the upload", async () => {
      const home = publicationHome();
      const fixture = relinkHarness(2, REBOUND, { row: true });
      const onError = vi.fn();
      const tokens: unknown[] = [];
      const pass = admittedPass(fixture.harness, home, onError, tokens);

      await expect(pass.run("/proj", undefined, SIDECAR)).resolves.toMatchObject({
        leaseAcquired: true,
        uploaded: 1,
        acknowledged: 1,
      });
      // The pass bound its repository to the old project once and uploaded there.
      expect(fixture.harness.modules.createRepository).toHaveBeenCalledTimes(1);
      expect(fixture.harness.modules.createRepository).toHaveBeenCalledWith(
        fixture.harness.runtime,
        "project-a",
        "machine-uuid",
      );
      expect(fixture.remote.insertEvents).toHaveBeenCalledTimes(1);
      expect(fixture.local.markReplicated).toHaveBeenCalledWith("event-1", "lcm-daemon:binding:local", 41n);
      // The relink lands at the next admission, yet the uploaded row is
      // still reconciled against the project that holds it.
      expect(fixture.remote.readEvents).toHaveBeenCalledTimes(1);
      expect(fixture.local.markAcknowledged).toHaveBeenCalledWith("event-1", 41n);
      expect(fixture.local.listAcknowledgedForRemotePrune).toHaveBeenCalledTimes(1);
      expectReportedOnce(fixture, onError);

      expect(fixture.resolveExistingProjectIdentity.mock.calls).toEqual([
        ["/proj", tokens[0]],
        ["/proj", tokens[1]],
        ["/proj", tokens[2]],
      ]);
      await pass.close();
    });

    it("completes uploaded rows when the project becomes unbound or loses its identity", async () => {
      for (const after of [null, {}, { remoteProjectId: null }] as Binding[]) {
        const home = publicationHome();
        const fixture = relinkHarness(2, after, { row: true });
        const onError = vi.fn();
        const pass = admittedPass(fixture.harness, home, onError);
        await expect(pass.run("/proj", undefined, SIDECAR)).resolves.toMatchObject({
          uploaded: 1,
          acknowledged: 1,
        });
        expect(fixture.local.markAcknowledged).toHaveBeenCalledWith("event-1", 41n);
        expectReportedOnce(fixture, onError);
        await pass.close();
      }
    });

    it("still applies the claims it fetched when the project is relinked before applying them", async () => {
      const home = publicationHome();
      // Checks: lease, upload, renew, claim fetch; the relink lands at the
      // first claim's own admission.
      const claim = { eventId: "event-1", eventVersion: 1, machineId: "machine-uuid" };
      const fixture = relinkHarness(4, REBOUND, { claims: [claim] });
      const onError = vi.fn();
      const pass = admittedPass(fixture.harness, home, onError);
      await expect(pass.run("/proj", undefined, SIDECAR)).resolves.toMatchObject({ applied: 1 });
      expect(fixture.remote.completeApplied).toHaveBeenCalledTimes(1);
      expect(fixture.resolveExistingProjectIdentity).toHaveBeenCalledTimes(5);
      expectReportedOnce(fixture, onError);
      await pass.close();
    });

    it("checks the binding best effort when no publication admission is supplied", async () => {
      const fixture = relinkHarness(1, REBOUND, { row: true });
      const onError = vi.fn();
      const pass = createPassiveEventReplicationPass(postgresConfig(), {
        processId: "lcm-daemon:binding",
        loadModules: async () => fixture.harness.modules,
        onError,
      });
      await expect(pass.run("/proj", undefined, SIDECAR)).resolves.toMatchObject({
        leaseAcquired: true,
        uploaded: 0,
      });
      expect(fixture.local.claimDeliveries).not.toHaveBeenCalled();
      expect(fixture.remote.insertEvents).not.toHaveBeenCalled();
      expect(fixture.resolveExistingProjectIdentity).toHaveBeenCalledTimes(2);
      expect(fixture.resolveExistingProjectIdentity).toHaveBeenCalledWith("/proj", undefined);
      expectReportedOnce(fixture, onError);
      await pass.close();
    });

    it("uploads the pending rows to the new binding on the next run", async () => {
      const home = publicationHome();
      const fixture = relinkHarness(1, REBOUND, { row: true });
      const onError = vi.fn();
      const pass = admittedPass(fixture.harness, home, onError);
      await expect(pass.run("/proj", undefined, SIDECAR)).resolves.toMatchObject({ uploaded: 0 });
      expect(fixture.harness.modules.createRepository).toHaveBeenLastCalledWith(
        fixture.harness.runtime,
        "project-a",
        "machine-uuid",
      );
      expect(fixture.remote.insertEvents).not.toHaveBeenCalled();

      // The binding now resolves to project B at gate 3 and at every phase.
      await expect(pass.run("/proj", undefined, SIDECAR)).resolves.toMatchObject({ uploaded: 1 });
      expect(fixture.harness.modules.createRepository).toHaveBeenLastCalledWith(
        fixture.harness.runtime,
        "project-b",
        "machine-uuid",
      );
      expect(fixture.local.claimDeliveries).toHaveBeenCalledTimes(1);
      expect(fixture.remote.insertEvents).toHaveBeenCalledTimes(1);
      expect(fixture.local.markReplicated).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledTimes(1);
      await pass.close();
    });

    it("hands the worker the real outbox with only the new-row claim withheld after a relink", async () => {
      const home = publicationHome();
      const fixture = relinkHarness(0);
      const real = {
        token: "real-outbox",
        marker: "kept",
        claimDeliveries: vi.fn().mockResolvedValue(["claimed"]),
        listAwaitingRemote(this: { token: string }) { return Promise.resolve([this.token]); },
        close: vi.fn().mockResolvedValue(undefined),
      };
      fixture.harness.factory.openExisting.mockResolvedValue(real);
      const seen: unknown[] = [];
      const onError = vi.fn();
      const pass = createPassiveEventReplicationPass(postgresConfig(), {
        processId: "lcm-daemon:binding",
        loadModules: async () => fixture.harness.modules,
        onError,
        withPublicationAdmission: async operation =>
          withBackendPublicationConsumerLockAsync(home, token => operation(token)),
        publicationHome: home,
        createWorker: dependencies => ({
          runOnce: async () => {
            const local = dependencies.local as unknown as typeof real;
            // Before the binding is checked, the claim reaches the repository.
            seen.push(await local.claimDeliveries());
            await dependencies.admitPhase!(async () => undefined);
            // After the relink the claim resolves empty without a database call.
            seen.push(await local.claimDeliveries());
            seen.push(await local.listAwaitingRemote());
            seen.push(local.marker);
            return summary;
          },
        }),
      });
      await expect(pass.run("/proj", undefined, SIDECAR)).resolves.toBe(summary);
      expect(seen).toEqual([["claimed"], [], ["real-outbox"], "kept"]);
      expect(real.claimDeliveries).toHaveBeenCalledTimes(1);
      // The pass closes the real repository, not the wrapper.
      expect(real.close).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledTimes(1);
      await pass.close();
    });

    it("runs every phase while the binding holds", async () => {
      const home = publicationHome();
      const fixture = relinkHarness(Number.MAX_SAFE_INTEGER, REBOUND, { row: true });
      const onError = vi.fn();
      const pass = admittedPass(fixture.harness, home, onError);
      await expect(pass.run("/proj", undefined, SIDECAR)).resolves.toMatchObject({
        leaseAcquired: true,
        uploaded: 1,
      });
      expect(fixture.local.claimDeliveries).toHaveBeenCalledTimes(1);
      expect(fixture.local.listAcknowledgedForRemotePrune).toHaveBeenCalledTimes(1);
      expect(onError).not.toHaveBeenCalled();
      await pass.close();
    });
  });
});

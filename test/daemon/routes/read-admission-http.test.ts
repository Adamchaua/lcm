import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDaemon,
  sendJson,
  type DaemonInstance,
  type DaemonOptions,
  type RouteExecutionContext,
} from "../../../src/daemon/server.js";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { clearProjectMapCache } from "../../../src/project-map.js";
import { PrivateMutationLockContentionError } from "../../../src/private-mutation-lock.js";
import { withBackendPublicationConsumerLockAsync } from "../../../src/storage/backend-publication.js";
import { makeStagedPostgreSqlStorageFactory } from "./mock-storage-factory.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("read admission test did not settle")), 5_000);
    })]);
  } finally { clearTimeout(timer); }
}

afterEach(() => vi.restoreAllMocks());

type Probe = (
  context: RouteExecutionContext,
  request: { aborted: () => void },
) => Promise<unknown>;

type Fixture = {
  home: string;
  daemon: DaemonInstance;
  /** Run a probe inside a registered "read" route; resolves with its outcome. */
  probe: (probe: Probe, signal?: AbortSignal) => Promise<{ outcome: unknown; contextSeen: RouteExecutionContext }>;
  waitForCancellation: () => Promise<void>;
  /** Hold one background publication phase; the optional follow-up is requested on release. */
  holdBackground: (options?: {
    releaseOnShutdown?: boolean;
    followUp?: (admission: Parameters<NonNullable<DaemonOptions["_scanForTranscripts"]>>[0]) => Promise<unknown>;
  }) => Promise<{ release: () => void; done: Promise<void> }>;
  events: string[];
};

async function withDaemon(
  options: { postgresql: boolean; readAdmissionWaitMs?: number; daemonOptions?: DaemonOptions },
  operation: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "lcm-read-admission-"));
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  clearProjectMapCache();
  const root = join(home, ".lcm");
  mkdirSync(root, { mode: 0o700 });
  chmodSync(root, 0o700);
  const configPath = join(root, "config.json");
  writeFileSync(configPath, "{}\n", { mode: 0o600 });
  const caPath = join(home, "postgres-ca.pem");
  writeFileSync(caPath, "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n", { mode: 0o600 });
  let runScan!: () => Promise<void>;
  let scanOperation: NonNullable<DaemonOptions["_scanForTranscripts"]> = async () => undefined;
  const cancellation = { current: deferred() };
  const events: string[] = [];
  const releases: (() => void)[] = [];
  const scans: Promise<void>[] = [];
  let daemon: DaemonInstance | undefined;
  const realSetInterval = globalThis.setInterval;
  vi.spyOn(globalThis, "setInterval").mockImplementation(((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (delay === 600_000 && typeof callback === "function") runScan = () => Promise.resolve(callback(...args));
    return realSetInterval(callback, delay, ...args);
  }) as typeof setInterval);
  try {
    const config = options.postgresql
      ? loadDaemonConfig("/nonexistent", {
        storage: { backend: "postgresql" },
        daemon: { port: 0, idleTimeoutMs: 0 },
        summarizer: { mock: true },
      }, {
        LCM_POSTGRES_URL: "postgresql://user:secret@db.example.test/lcm",
        LCM_POSTGRES_CA_FILE: caPath,
        LCM_POSTGRES_MIGRATION_ROLE: "lcm_test_migrator",
      })
      : loadDaemonConfig(configPath, { daemon: { port: 0, idleTimeoutMs: 0 }, summarizer: { mock: true } });
    daemon = await createDaemon(config, {
      publicationConfigPath: configPath,
      _assertBackendPublication: () => undefined,
      ...(options.postgresql
        ? { _createStorageBackendFactory: async () => makeStagedPostgreSqlStorageFactory() }
        : {}),
      ...(options.readAdmissionWaitMs === undefined ? {} : { _readAdmissionWaitMs: options.readAdmissionWaitMs }),
      _scanForTranscripts: (admission, signal) => scanOperation(admission, signal),
      _onRequestLifecycle: event => { if (event === "cancelled") cancellation.current.resolve(); },
      ...options.daemonOptions,
    });
    const activeDaemon = daemon;
    let activeProbe!: Probe;
    let observed: { outcome: unknown; contextSeen: RouteExecutionContext } | undefined;
    activeDaemon.registerRoute("POST", "/probe", async (req, res, _body, context) => {
      const contextSeen = context ?? {};
      let outcome: unknown;
      try {
        outcome = { value: await activeProbe(contextSeen, { aborted: () => { req.emit("aborted"); } }) };
      } catch (error) {
        outcome = { error };
      }
      observed = { outcome, contextSeen };
      sendJson(res, 200, { done: true });
    }, "read");
    await operation({
      home, daemon: activeDaemon, events,
      probe: async (probe, signal) => {
        activeProbe = probe;
        observed = undefined;
        await fetch("http://127.0.0.1:" + activeDaemon.address().port + "/probe", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal,
        }).catch(() => undefined);
        // An aborted client never receives a body; wait for the handler to record its outcome.
        for (let attempt = 0; observed === undefined && attempt < 500; attempt += 1) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        if (observed === undefined) throw new Error("probe handler did not finish");
        return observed;
      },
      waitForCancellation: () => bounded(cancellation.current.promise).then(() => { cancellation.current = deferred(); }),
      holdBackground: async (hold = {}) => {
        const entered = deferred();
        const release = deferred();
        releases.push(release.resolve);
        scanOperation = async (admission, signal) => {
          await admission(async () => {
            if (hold.releaseOnShutdown) signal?.addEventListener("abort", release.resolve, { once: true });
            events.push("bg-held");
            entered.resolve();
            await release.promise;
          });
          if (hold.followUp) await hold.followUp(admission);
        };
        const done = runScan();
        scans.push(done);
        await bounded(entered.promise);
        return { release: release.resolve, done };
      },
    });
  } finally {
    for (const release of releases) release();
    await Promise.allSettled(scans);
    await daemon?.stop();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    clearProjectMapCache();
    rmSync(home, { recursive: true, force: true });
  }
}

function isContention(error: unknown): boolean {
  return error instanceof PrivateMutationLockContentionError;
}

describe("daemon PostgreSQL read admission", () => {
  it("offers the bounded read admission only to PostgreSQL read routes", async () => {
    await withDaemon({ postgresql: true }, async ({ probe }) => {
      const { outcome, contextSeen } = await probe(async () => "ran");
      expect(outcome).toEqual({ value: "ran" });
      expect(contextSeen.withReadAdmission).toBeTypeOf("function");
      expect(contextSeen.withPublicationAdmission).toBeUndefined();
      expect(contextSeen.publicationLockToken).toBeUndefined();
    });
  });

  it("does not offer the read admission on SQLite", async () => {
    await withDaemon({ postgresql: false }, async ({ probe }) => {
      const { outcome, contextSeen } = await probe(async () => "ran");
      expect(outcome).toEqual({ value: "ran" });
      expect(contextSeen.withReadAdmission).toBeUndefined();
    });
  });

  it("runs an uncontended admitted prefix with a publication token", async () => {
    await withDaemon({ postgresql: true }, async ({ probe }) => {
      const { outcome } = await probe(context => context.withReadAdmission!(async token => typeof token));
      expect(outcome).toEqual({ value: "object" });
    });
  });

  it("waits behind a background phase and runs before the next background phase", async () => {
    await withDaemon({ postgresql: true, readAdmissionWaitMs: 30_000 }, async ({ probe, holdBackground, events }) => {
      const hold = await holdBackground({
        // Requested only after the held phase releases: the queued read is already ahead of it.
        followUp: admission => admission(async () => { events.push("bg-next"); }),
      });
      const queued = deferred();
      const read = probe(async context => {
        const admitted = context.withReadAdmission!(async () => { events.push("read-prefix"); return "read"; });
        queued.resolve();
        return admitted;
      });
      await bounded(queued.promise);
      expect(events).toEqual(["bg-held"]);
      hold.release();
      expect((await bounded(read)).outcome).toEqual({ value: "read" });
      await hold.done;
      expect(events).toEqual(["bg-held", "read-prefix", "bg-next"]);
    });
  });

  it("returns contention when the turn is not granted in time, keeping the request signal and queue usable", async () => {
    await withDaemon({ postgresql: true, readAdmissionWaitMs: 25 }, async ({ probe, holdBackground }) => {
      const hold = await holdBackground();
      const { outcome } = await probe(async context => {
        try {
          await context.withReadAdmission!(async () => "must not run");
        } catch (error) {
          return { error, aborted: context.signal?.aborted };
        }
        return "unexpected";
      });
      const result = (outcome as { value: { error: Error; aborted: boolean } }).value;
      expect(isContention(result.error)).toBe(true);
      expect(result.error.message).toBe("daemon publication work is in progress; retry the read");
      expect(result.aborted).toBe(false);
      hold.release();
      await hold.done;
      const { outcome: later } = await probe(context => context.withReadAdmission!(async () => "usable"));
      expect(later).toEqual({ value: "usable" });
    });
  });

  it("does not cancel a prefix that entered before the deadline", async () => {
    await withDaemon({ postgresql: true, readAdmissionWaitMs: 20 }, async ({ probe }) => {
      const { outcome } = await probe(context => context.withReadAdmission!(async () => {
        await new Promise(resolve => setTimeout(resolve, 120));
        return "finished after the budget";
      }));
      expect(outcome).toEqual({ value: "finished after the budget" });
    });
  });

  it("leaves a failure after entry unchanged even when it lands past the deadline", async () => {
    await withDaemon({ postgresql: true, readAdmissionWaitMs: 20 }, async ({ probe }) => {
      const failure = new Error("prefix failed after entry");
      const { outcome } = await probe(context => context.withReadAdmission!(async () => {
        await new Promise(resolve => setTimeout(resolve, 120));
        throw failure;
      }));
      expect((outcome as { error: unknown }).error).toBe(failure);
    });
  });

  it("fails immediately when another holder owns the lock once the turn is granted", async () => {
    await withDaemon({ postgresql: true, readAdmissionWaitMs: 30_000 }, async ({ home, probe }) => {
      await withBackendPublicationConsumerLockAsync(home, async () => {
        const started = Date.now();
        const { outcome } = await probe(async context => {
          try {
            await context.withReadAdmission!(async () => "must not run");
          } catch (error) {
            return error;
          }
          return "unexpected";
        });
        const error = (outcome as { value: Error }).value;
        expect(isContention(error)).toBe(true);
        expect(error.message).not.toBe("daemon publication work is in progress; retry the read");
        expect(Date.now() - started).toBeLessThan(5_000);
      });
    });
  });

  it("reports a client abort while queued as an abort, not as contention", async () => {
    await withDaemon({ postgresql: true, readAdmissionWaitMs: 30_000 }, async ({ probe, holdBackground, waitForCancellation }) => {
      const hold = await holdBackground();
      const controller = new AbortController();
      const queued = deferred();
      const read = probe(async context => {
        const admitted = context.withReadAdmission!(async () => "must not run");
        queued.resolve();
        return admitted;
      }, controller.signal);
      await bounded(queued.promise);
      controller.abort();
      await waitForCancellation();
      const { outcome } = await bounded(read);
      const error = (outcome as { error: Error }).error;
      expect(error.name).toBe("AbortError");
      expect(isContention(error)).toBe(false);
      hold.release();
      await hold.done;
    });
  });

  it("aborts a queued read when the daemon shuts down", async () => {
    await withDaemon({ postgresql: true, readAdmissionWaitMs: 30_000 }, async ({ daemon, probe, holdBackground }) => {
      await holdBackground({ releaseOnShutdown: true });
      const queued = deferred();
      const read = probe(async context => {
        const admitted = context.withReadAdmission!(async () => "must not run");
        queued.resolve();
        return admitted;
      });
      await bounded(queued.promise);
      await bounded(daemon.stop());
      const { outcome } = await bounded(read);
      const error = (outcome as { error: Error }).error;
      expect(error.name).toBe("AbortError");
      expect(isContention(error)).toBe(false);
    });
  });

  it("lets a client abort win when it lands after the deadline fired but before the rejection is observed", async () => {
    const budget = 7_777;
    const deadlines: Array<() => void> = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (delay === budget && typeof callback === "function") deadlines.push(() => callback(...args));
      return realSetTimeout(callback, delay, ...args);
    }) as typeof setTimeout);
    await withDaemon({ postgresql: true, readAdmissionWaitMs: budget }, async ({ probe, holdBackground }) => {
      const hold = await holdBackground();
      const queued = deferred();
      let abortRequest!: () => void;
      const read = probe(async (context, request) => {
        abortRequest = request.aborted;
        const admitted = context.withReadAdmission!(async () => "must not run").catch((error: unknown) => ({
          error,
          aborted: context.signal?.aborted,
        }));
        queued.resolve();
        return admitted;
      });
      await bounded(queued.promise);
      expect(deadlines).toHaveLength(1);
      // Same task: the deadline fires first, then the client goes away.
      deadlines[0]!();
      abortRequest();
      const result = (await bounded(read)).outcome as { value: { error: Error; aborted: boolean } };
      expect(result.value.error.name).toBe("AbortError");
      expect(isContention(result.value.error)).toBe(false);
      expect(result.value.aborted).toBe(true);
      hold.release();
      await hold.done;
    });
  });
});

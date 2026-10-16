import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PrivateMutationLockContentionError,
  withPrivateMutationLockAsync,
} from "../../src/private-mutation-lock.js";
import { migrateLegacyHomeIfNeeded } from "../../src/runtime-paths.js";
import { LocalHookDurabilityTimeoutError } from "../../src/hooks/local-enqueue.js";

// Real publication-lock contention through the real CLI, hook dispatch,
// config load and publication fences. Only process boundaries are replaced:
// stdin, process.exit, and anything that could reach a daemon.
const state = vi.hoisted(() => ({
  exit: vi.fn((code?: number): never => { throw new Error(`exit:${code}`); }),
  ensureDaemon: vi.fn(),
  daemonClientCalls: vi.fn(),
}));

const fakeStdin = vi.hoisted(() => ({
  isTTY: false,
  destroy: vi.fn(),
  on: vi.fn(),
}));

vi.mock("node:process", async importOriginal => ({
  ...(await importOriginal<typeof import("node:process")>()),
  exit: state.exit,
  stdin: fakeStdin,
}));

vi.mock("../../src/daemon/lifecycle.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../../src/daemon/lifecycle.js")>()),
  ensureDaemon: state.ensureDaemon,
}));

vi.mock("../../src/daemon/client.js", () => ({
  DaemonClient: class {
    constructor() {
      return new Proxy({}, {
        get: (_target, property) => (...args: unknown[]) => {
          state.daemonClientCalls(String(property), ...args);
          throw new Error("hook contention test must not contact a daemon");
        },
      });
    }
  },
}));

const originalEnv = { ...process.env };
const ENV_KEYS = [
  "HOME", "USERPROFILE", "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
  "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "LCM_CLIENT",
] as const;

let home: string;
let lockPath: string;

function feedStdin(payload: string): void {
  fakeStdin.isTTY = false;
  fakeStdin.on.mockImplementation((event: string, callback: (chunk?: Buffer) => void) => {
    if (event === "data") queueMicrotask(() => callback(Buffer.from(payload)));
    if (event === "end") queueMicrotask(() => callback());
    return fakeStdin;
  });
}

async function runWithPayload(args: string[], payload: string): Promise<Error | undefined> {
  feedStdin(payload);
  const { runCli } = await import("../../bin/lcm.js");
  try {
    await runCli(["node", "lcm", ...args]);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

async function withHeldPublicationLock<T>(run: () => Promise<T>): Promise<T> {
  let release!: () => void;
  let acquired!: () => void;
  const lockAcquired = new Promise<void>(resolve => { acquired = resolve; });
  const lockReleased = new Promise<void>(resolve => { release = resolve; });
  const holder = withPrivateMutationLockAsync(lockPath, "test backend publication", async () => {
    acquired();
    await lockReleased;
  });
  try {
    await lockAcquired;
    return await run();
  } finally {
    release();
    await holder;
  }
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "lcm-hook-contention-")));
  for (const dir of [".lcm", ".config", ".local-share", ".cache", ".state", "run", "tmp"]) {
    mkdirSync(join(home, dir), { mode: 0o700 });
  }
  const environment: Record<(typeof ENV_KEYS)[number], string> = {
    HOME: home,
    USERPROFILE: home,
    TMPDIR: join(home, "tmp"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local-share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".state"),
    XDG_RUNTIME_DIR: join(home, "run"),
    LCM_CLIENT: "codex",
  };
  for (const key of ENV_KEYS) vi.stubEnv(key, environment[key]);
  lockPath = join(home, ".lcm.backend-publication.lock");
  state.exit.mockClear();
  state.ensureDaemon.mockReset();
  state.ensureDaemon.mockImplementation(() => {
    throw new Error("hook contention test must not ensure a daemon");
  });
  state.daemonClientCalls.mockReset();
  fakeStdin.destroy.mockReset();
  fakeStdin.on.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  rmSync(home, { recursive: true });
});

describe("hook entrypoints under live publication-lock contention", () => {
  it("holds a lock that the legacy-root migration preflight cannot pass", async () => {
    await withHeldPublicationLock(async () => {
      expect(() => migrateLegacyHomeIfNeeded(home)).toThrow(PrivateMutationLockContentionError);
    });
  });

  const bestEffortCases: ReadonlyArray<readonly [string, string[], string]> = [
    ["session-snapshot with an empty payload (Stop / PreCompact)", ["session-snapshot", "--client", "codex"], "{}"],
    [
      "session-snapshot with a session",
      ["session-snapshot", "--client", "codex"],
      JSON.stringify({ session_id: "s-snapshot", cwd: "/work", transcript_path: "/work/t.jsonl" }),
    ],
    ["restore with an empty payload (SessionStart)", ["restore", "--client", "codex"], "{}"],
    ["restore with a session", ["restore", "--client", "codex"], JSON.stringify({ session_id: "s-restore", cwd: "/work" })],
    ["session-end with an empty payload (SessionEnd)", ["session-end", "--client", "codex"], "{}"],
    ["session-end with a session", ["session-end", "--client", "codex"], JSON.stringify({ session_id: "s-end", cwd: "/work" })],
    ["user-prompt with an empty payload (UserPromptSubmit)", ["user-prompt", "--client", "codex"], "{}"],
    ["user-prompt with a prompt and no session", ["user-prompt", "--client", "codex"], JSON.stringify({ prompt: "hello" })],
    ["compact --hook with an empty payload (PreCompact)", ["compact", "--hook", "--client", "codex"], "{}"],
  ];

  it.each(bestEffortCases)("exits 0 for %s", async (_name, args, payload) => {
    await withHeldPublicationLock(async () => {
      const failure = await runWithPayload(args, payload);

      expect(failure?.message).toBe("exit:0");
    });
    expect(state.ensureDaemon).not.toHaveBeenCalled();
    expect(state.daemonClientCalls).not.toHaveBeenCalled();
  });

  it("keeps UserPromptSubmit's durable enqueue retry-required when its append barrier stays busy", async () => {
    await withHeldPublicationLock(async () => {
      const failure = await runWithPayload(
        ["user-prompt", "--client", "codex"],
        JSON.stringify({ session_id: "s-prompt", cwd: "/work", prompt: "please fix the bug" }),
      );

      expect(failure).toBeInstanceOf(LocalHookDurabilityTimeoutError);
    });
    expect(state.ensureDaemon).not.toHaveBeenCalled();
    expect(state.daemonClientCalls).not.toHaveBeenCalled();
  }, 20_000);

  it("keeps the preflight for bare compact, which rejects with the contention error", async () => {
    await withHeldPublicationLock(async () => {
      fakeStdin.isTTY = true;
      const { runCli } = await import("../../bin/lcm.js");

      await expect(runCli(["node", "lcm", "compact", "--dry-run"]))
        .rejects.toBeInstanceOf(PrivateMutationLockContentionError);
    });
    expect(state.ensureDaemon).not.toHaveBeenCalled();
  });

  it("completes a hook once the lock is released", async () => {
    await withHeldPublicationLock(async () => {
      expect((await runWithPayload(["session-snapshot", "--client", "codex"], "{}"))?.message).toBe("exit:0");
    });

    expect((await runWithPayload(["session-snapshot", "--client", "codex"], "{}"))?.message).toBe("exit:0");
    expect(existsSync(lockPath)).toBe(false);
    expect(state.ensureDaemon).not.toHaveBeenCalled();
  });
});

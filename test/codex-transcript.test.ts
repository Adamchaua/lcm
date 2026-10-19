import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, renameSync, writeFileSync, mkdirSync, rmSync, symlinkSync, utimesSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import {
  LCM_RESTORATION_MARKER,
  readLiveCodexRestoration,
  scanLiveCodexRestoration,
  parseCodexTranscript,
  extractCodexSessionCwd,
  extractCodexSessionMeta,
  findCodexSessionFiles,
  findAllCodexTranscripts,
  type CodexSessionFile,
} from "../src/codex-transcript.js";

// Test seam: runs a callback just before the module under test resolves a
// path, so a race between its open and its containment check is deterministic.
const fsSeam = vi.hoisted(() => ({ beforeRealpath: undefined as ((path: string) => void) | undefined }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const realpathSync = ((path: string, options?: never) => {
    fsSeam.beforeRealpath?.(String(path));
    return actual.realpathSync(path, options);
  }) as typeof actual.realpathSync;
  realpathSync.native = actual.realpathSync.native;
  return { ...actual, realpathSync };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function makeTmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "lcm-codex-test-"));
  dirs.push(d);
  return d;
}

function makeSessionLine(role: "user" | "assistant", text: string): string {
  const contentType = role === "user" ? "input_text" : "output_text";
  return JSON.stringify({
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role,
      content: [{ type: contentType, text }],
    },
  });
}

function makeSessionMeta(id: string, cwd: string): string {
  return JSON.stringify({
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "session_meta",
    payload: { id, cwd, cli_version: "0.100.0", model_provider: "openai" },
  });
}

function makeEventLine(eventType: string): string {
  return JSON.stringify({
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "event_msg",
    payload: { type: eventType },
  });
}

// ---------------------------------------------------------------------------
// parseCodexTranscript
// ---------------------------------------------------------------------------

describe("parseCodexTranscript", () => {
  it("returns empty array for nonexistent file", () => {
    expect(parseCodexTranscript("/nonexistent/path/session.jsonl")).toEqual([]);
  });

  it("parses user message with input_text block", () => {
    const dir = makeTmpDir();
    const file = join(dir, "session.jsonl");
    writeFileSync(file, makeSessionLine("user", "What is the capital of France?") + "\n");

    const msgs = parseCodexTranscript(file);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].content).toBe("What is the capital of France?");
    expect(msgs[0].tokenCount).toBeGreaterThan(0);
  });

  it("parses assistant message with output_text block", () => {
    const dir = makeTmpDir();
    const file = join(dir, "session.jsonl");
    writeFileSync(file, makeSessionLine("assistant", "Paris is the capital of France.") + "\n");

    const msgs = parseCodexTranscript(file);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("assistant");
    expect(msgs[0].content).toBe("Paris is the capital of France.");
  });

  it("skips session_meta and event_msg lines", () => {
    const dir = makeTmpDir();
    const file = join(dir, "session.jsonl");
    const content = [
      makeSessionMeta("abc-123", "/some/path"),
      makeEventLine("task_started"),
      makeSessionLine("user", "Hello"),
      makeEventLine("task_completed"),
    ].join("\n");
    writeFileSync(file, content + "\n");

    const msgs = parseCodexTranscript(file);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("user");
  });

  it("skips response_item lines with non-user/assistant roles (developer, system)", () => {
    const dir = makeTmpDir();
    const file = join(dir, "session.jsonl");
    const devLine = JSON.stringify({
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "Some system instruction" }],
      },
    });
    writeFileSync(file, devLine + "\n" + makeSessionLine("user", "Hello") + "\n");

    const msgs = parseCodexTranscript(file);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("user");
  });

  it("skips lines with empty content after extraction", () => {
    const dir = makeTmpDir();
    const file = join(dir, "session.jsonl");
    const emptyLine = JSON.stringify({
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "response_item",
      payload: { type: "message", role: "user", content: [] },
    });
    writeFileSync(file, emptyLine + "\n");

    expect(parseCodexTranscript(file)).toHaveLength(0);
  });

  it("skips malformed JSON lines without throwing", () => {
    const dir = makeTmpDir();
    const file = join(dir, "session.jsonl");
    writeFileSync(file, "not-json\n" + makeSessionLine("user", "Valid") + "\n");

    const msgs = parseCodexTranscript(file);
    expect(msgs).toHaveLength(1);
  });

  it("handles string content (non-array) in response_item payload", () => {
    const dir = makeTmpDir();
    const file = join(dir, "session.jsonl");
    const line = JSON.stringify({
      type: "response_item",
      payload: { type: "message", role: "user", content: "Plain string content" },
    });
    writeFileSync(file, line + "\n");

    const msgs = parseCodexTranscript(file);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe("Plain string content");
  });

  it("handles malformed payload and every supported content-block shape", () => {
    const dir = makeTmpDir();
    const file = join(dir, "session.jsonl");
    writeFileSync(file, [
      JSON.stringify({ type: "response_item" }),
      JSON.stringify({ type: "response_item", payload: { type: "message" } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user" } }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [
            { type: "input_text" },
            { type: "output_text", text: "output" },
            { type: "text", text: "plain" },
            { type: "text", text: 42 },
            { type: "unknown", text: "ignored" },
          ],
        },
      }),
    ].join("\n"));

    expect(parseCodexTranscript(file).map((message) => message.content)).toEqual(["output\nplain"]);
  });

  it("parses a full conversation (multiple turns)", () => {
    const dir = makeTmpDir();
    const file = join(dir, "session.jsonl");
    const content = [
      makeSessionMeta("sess-1", "/workspace"),
      makeSessionLine("user", "Fix the bug"),
      makeSessionLine("assistant", "I found the issue on line 42."),
      makeEventLine("tool_call"),
      makeSessionLine("user", "Great, thanks!"),
      makeSessionLine("assistant", "You're welcome."),
    ].join("\n");
    writeFileSync(file, content + "\n");

    const msgs = parseCodexTranscript(file);
    expect(msgs).toHaveLength(4);
    expect(msgs.map(m => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });
});

// ---------------------------------------------------------------------------
// extractCodexSessionCwd
// ---------------------------------------------------------------------------

describe("extractCodexSessionCwd", () => {
  it("returns undefined for nonexistent file", () => {
    expect(extractCodexSessionCwd("/nonexistent/path.jsonl")).toBeUndefined();
  });

  it("extracts cwd from session_meta line", () => {
    const dir = makeTmpDir();
    const file = join(dir, "session.jsonl");
    writeFileSync(
      file,
      makeSessionMeta("abc-123", "/Users/pedro/Developer/myproject") + "\n",
    );

    expect(extractCodexSessionCwd(file)).toBe("/Users/pedro/Developer/myproject");
  });

  it("returns undefined when no session_meta line is present", () => {
    const dir = makeTmpDir();
    const file = join(dir, "session.jsonl");
    writeFileSync(file, makeSessionLine("user", "Hello") + "\n");

    expect(extractCodexSessionCwd(file)).toBeUndefined();
  });

  it("returns first session_meta cwd when multiple are present", () => {
    const dir = makeTmpDir();
    const file = join(dir, "session.jsonl");
    writeFileSync(
      file,
      [
        makeSessionMeta("sess-1", "/first/path"),
        makeSessionMeta("sess-2", "/second/path"),
      ].join("\n") + "\n",
    );

    expect(extractCodexSessionCwd(file)).toBe("/first/path");
  });

  it("skips blank, malformed, and incomplete session metadata", () => {
    const dir = makeTmpDir();
    const file = join(dir, "session.jsonl");
    writeFileSync(file, [
      "",
      "not-json",
      JSON.stringify({ type: "session_meta" }),
      JSON.stringify({ type: "session_meta", payload: { cwd: "" } }),
      JSON.stringify({ type: "session_meta", payload: { cwd: 42 } }),
    ].join("\n"));
    expect(extractCodexSessionCwd(file)).toBeUndefined();
  });

  it("extracts bounded thread and Git metadata without reading the conversation", () => {
    const dir = makeTmpDir();
    const file = join(dir, "session.jsonl");
    writeFileSync(file, `${JSON.stringify({
      type: "session_meta",
      payload: {
        id: "thread",
        cwd: "/workspace",
        git: {
          repository_url: "https://example.invalid/repository.git",
          commit_hash: "abc123",
          branch: "feature",
        },
      },
    })}\n${"x".repeat(300 * 1024)}`);
    expect(extractCodexSessionMeta(file)).toEqual({
      threadId: "thread",
      cwd: "/workspace",
      repositoryUrl: "https://example.invalid/repository.git",
      commit: "abc123",
      branch: "feature",
    });
  });

  it("rejects unsafe leaves and empty or invalid metadata fields", () => {
    const dir = makeTmpDir();
    const target = join(dir, "target.jsonl");
    writeFileSync(target, "{}\n");
    symlinkSync(target, join(dir, "linked.jsonl"));
    mkdirSync(join(dir, "directory.jsonl"));
    expect(extractCodexSessionMeta(join(dir, "linked.jsonl"))).toBeUndefined();
    expect(extractCodexSessionMeta(join(dir, "directory.jsonl"))).toBeUndefined();

    const invalid = join(dir, "invalid.jsonl");
    writeFileSync(invalid, [
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: "",
          cwd: 42,
          git: { repository_url: "", commit_hash: 1, branch: "" },
        },
      }),
    ].join("\n"));
    expect(extractCodexSessionMeta(invalid)).toBeUndefined();

    const nullPayload = join(dir, "null.jsonl");
    writeFileSync(nullPayload, JSON.stringify({ type: "session_meta", payload: null }));
    expect(extractCodexSessionMeta(nullPayload)).toBeUndefined();

    const late = join(dir, "late.jsonl");
    writeFileSync(late, `${" ".repeat(256 * 1024)}\n${makeSessionMeta("late", "/late")}`);
    expect(extractCodexSessionMeta(late)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// findCodexSessionFiles
// ---------------------------------------------------------------------------

describe("findCodexSessionFiles", () => {
  it("returns empty array for nonexistent directory", () => {
    expect(findCodexSessionFiles("/nonexistent")).toEqual([]);
  });

  it("discovers flat .jsonl files", () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, "session-abc.jsonl"), "");
    writeFileSync(join(dir, "session-def.jsonl"), "");
    writeFileSync(join(dir, "readme.txt"), "");

    const files = findCodexSessionFiles(dir);
    const ids = files.map(f => f.sessionId).sort();
    expect(ids).toEqual(["session-abc", "session-def"]);
  });

  it("discovers nested layout: <dir>/<id>/<id>.jsonl", () => {
    const dir = makeTmpDir();
    const sessionDir = join(dir, "session-xyz");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "session-xyz.jsonl"), "");

    const files = findCodexSessionFiles(dir);
    expect(files).toHaveLength(1);
    expect(files[0].sessionId).toBe("session-xyz");
    expect(files[0].path).toBe(join(sessionDir, "session-xyz.jsonl"));
  });

  it("ignores symlinks, missing nested transcripts, and nested non-files", () => {
    const dir = makeTmpDir();
    const target = join(dir, "target.jsonl");
    writeFileSync(target, "");
    symlinkSync(target, join(dir, "linked.jsonl"));
    mkdirSync(join(dir, "missing"));
    mkdirSync(join(dir, "nested-dir"));
    mkdirSync(join(dir, "nested-dir", "nested-dir.jsonl"));
    mkdirSync(join(dir, "nested-link"));
    symlinkSync(target, join(dir, "nested-link", "nested-link.jsonl"));

    expect(findCodexSessionFiles(dir).map((file) => file.sessionId)).toEqual(["target"]);
  });

  it("returns files sorted by mtime ascending", async () => {
    const dir = makeTmpDir();
    const older = join(dir, "old-session.jsonl");
    const newer = join(dir, "new-session.jsonl");
    writeFileSync(newer, "");
    writeFileSync(older, "");
    const oldTime = new Date(Date.now() - 10_000);
    utimesSync(older, oldTime, oldTime);

    const files = findCodexSessionFiles(dir);
    expect(files.map(f => f.sessionId)).toEqual(["old-session", "new-session"]);
  });

  it("uses session IDs as a deterministic tie-breaker for equal mtimes", (): void => {
    const dir = makeTmpDir();
    const alpha = join(dir, "alpha-session.jsonl");
    const beta = join(dir, "beta-session.jsonl");
    writeFileSync(beta, "");
    writeFileSync(alpha, "");
    const sameTime = new Date("2026-01-01T00:00:00.000Z");
    utimesSync(alpha, sameTime, sameTime);
    utimesSync(beta, sameTime, sameTime);

    expect(findCodexSessionFiles(dir).map((file: CodexSessionFile): string => file.sessionId)).toEqual([
      "alpha-session",
      "beta-session",
    ]);
  });
});

// ---------------------------------------------------------------------------
// findAllCodexTranscripts
// ---------------------------------------------------------------------------

describe("findAllCodexTranscripts", () => {
  it("returns empty array when codexDir has no sessions", () => {
    const dir = makeTmpDir();
    expect(findAllCodexTranscripts(dir)).toEqual([]);
  });

  it("uses the default Codex home when no directory is supplied", () => {
    const sessionsRoot = join(homedir(), ".codex", "sessions");
    mkdirSync(sessionsRoot, { recursive: true });
    const sessionDir = mkdtempSync(join(sessionsRoot, "coverage-default-"));
    dirs.push(sessionDir);
    const sessionId = basename(sessionDir);
    writeFileSync(join(sessionDir, `${sessionId}.jsonl`), "");

    expect(findAllCodexTranscripts().map((file) => file.sessionId)).toContain(sessionId);
  });

  it("collects from archived_sessions/ (flat) and sessions/ (nested)", () => {
    const codexDir = makeTmpDir();

    // archived_sessions flat layout
    const archived = join(codexDir, "archived_sessions");
    mkdirSync(archived, { recursive: true });
    writeFileSync(join(archived, "rollout-session-1.jsonl"), "");

    // sessions nested layout
    const sessions = join(codexDir, "sessions");
    const sessionDir = join(sessions, "session-2");
    mkdirSync(sessionDir, { recursive: true });
    const activeSession = join(sessionDir, "session-2.jsonl");
    writeFileSync(activeSession, "");

    const sameTime = new Date("2026-01-01T00:00:00.000Z");
    utimesSync(join(archived, "rollout-session-1.jsonl"), sameTime, sameTime);
    utimesSync(activeSession, sameTime, sameTime);

    const files = findAllCodexTranscripts(codexDir);
    const ids = files.map((file: CodexSessionFile): string => file.sessionId);
    expect(ids).toEqual(["rollout-session-1", "session-2"]);
  });

  it("deduplicates sessions present in both archived_sessions and sessions/", () => {
    const codexDir = makeTmpDir();

    const archived = join(codexDir, "archived_sessions");
    mkdirSync(archived, { recursive: true });
    writeFileSync(join(archived, "dup-session.jsonl"), "archived");

    const sessions = join(codexDir, "sessions");
    const sessionDir = join(sessions, "dup-session");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "dup-session.jsonl"), "active");

    const files = findAllCodexTranscripts(codexDir);
    const matches = files.filter(f => f.sessionId === "dup-session");
    expect(matches).toHaveLength(1);
    // archived_sessions is added first, so it wins
    expect(matches[0].path).toBe(join(archived, "dup-session.jsonl"));
  });

  it("collects active date-partitioned rollout transcripts without traversing symlinks", () => {
    const codexDir = makeTmpDir();
    const day = join(codexDir, "sessions", "2026", "07", "25");
    mkdirSync(day, { recursive: true });
    const rollout = "rollout-2026-07-25T10-00-00-thread.jsonl";
    writeFileSync(join(day, rollout), "");
    writeFileSync(join(day, "not-a-rollout.jsonl"), "");
    mkdirSync(join(day, "rollout-directory.jsonl"));
    mkdirSync(join(codexDir, "sessions", "2026", "invalid-month"));
    const outside = join(codexDir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "rollout-outside.jsonl"), "");
    symlinkSync(outside, join(codexDir, "sessions", "2026", "07", "26"));

    expect(findAllCodexTranscripts(codexDir).map((file) => file.sessionId))
      .toContain(rollout.slice(0, -".jsonl".length));
    expect(findAllCodexTranscripts(codexDir).map((file) => file.sessionId))
      .not.toContain("rollout-outside");
  });

  it("deduplicates an archived transcript that overlaps an active rollout", () => {
    const codexDir = makeTmpDir();
    const sessionId = "rollout-2026-07-25T10-00-00-duplicate";
    const archived = join(codexDir, "archived_sessions");
    const day = join(codexDir, "sessions", "2026", "07", "25");
    mkdirSync(archived, { recursive: true });
    mkdirSync(day, { recursive: true });
    writeFileSync(join(archived, `${sessionId}.jsonl`), "archived");
    writeFileSync(join(day, `${sessionId}.jsonl`), "active");

    const matches = findAllCodexTranscripts(codexDir)
      .filter((file) => file.sessionId === sessionId);
    expect(matches).toEqual([expect.objectContaining({
      path: join(archived, `${sessionId}.jsonl`),
    })]);
  });

  it("sorts collected transcripts by distinct modification times", () => {
    const codexDir = makeTmpDir();
    const archived = join(codexDir, "archived_sessions");
    mkdirSync(archived, { recursive: true });
    const newer = join(archived, "newer.jsonl");
    const older = join(archived, "older.jsonl");
    writeFileSync(newer, "");
    writeFileSync(older, "");
    const oldTime = new Date(Date.now() - 10_000);
    utimesSync(older, oldTime, oldTime);
    expect(findAllCodexTranscripts(codexDir).map((file) => file.sessionId)).toEqual(["older", "newer"]);
  });
});

// ---------------------------------------------------------------------------
// LCM restoration proof
// ---------------------------------------------------------------------------

function developerLine(text: string | Array<{ type: string; text: string }>): string {
  return JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      role: "developer",
      content: text,
    },
  });
}

const blockText = `${LCM_RESTORATION_MARKER}\nrestored memory`;
const block = developerLine([{ type: "input_text", text: blockText }]);
const compacted = JSON.stringify({ type: "compacted", payload: { message: "", replacement_history: [] } });
const rolledBack = JSON.stringify({ type: "event_msg", payload: { type: "thread_rolled_back", num_turns: 1 } });
const scan = (lines: string[]) => scanLiveCodexRestoration(lines.join("\n"));

describe("scanLiveCodexRestoration", () => {
  it("proves a marked developer block and ignores blank lines", () => {
    expect(scan([makeSessionMeta("t", "/p"), "", block, ""])).toBe(true);
    expect(scan([makeSessionMeta("t", "/p")])).toBe(false);
    expect(scan([])).toBe(false);
  });

  it("accepts leading whitespace and joined text blocks", () => {
    expect(scan([developerLine([{ type: "input_text", text: `  \n${blockText}` }])])).toBe(true);
    expect(scan([developerLine([
      { type: "input_text", text: LCM_RESTORATION_MARKER },
      { type: "input_text", text: "more" },
    ])])).toBe(true);
  });

  it("requires the marker to end its line", () => {
    const text = (value: string) => developerLine([{ type: "input_text", text: value }]);
    expect(scan([text(LCM_RESTORATION_MARKER)])).toBe(true);
    expect(scan([text(`${LCM_RESTORATION_MARKER}\nbody`)])).toBe(true);
    expect(scan([text(`${LCM_RESTORATION_MARKER}\r\nbody`)])).toBe(true);
    expect(scan([text(`${LCM_RESTORATION_MARKER} extra\nbody`)])).toBe(false);
    expect(scan([text(`${LCM_RESTORATION_MARKER}x`)])).toBe(false);
    expect(scan([text(`${LCM_RESTORATION_MARKER}\rbody`)])).toBe(false);
  });

  it("resets on a later compacted line and on a later rollback", () => {
    expect(scan([block, compacted])).toBe(false);
    expect(scan([block, compacted, block])).toBe(true);
    expect(scan([block, rolledBack])).toBe(false);
    expect(scan([block, rolledBack, block])).toBe(true);
  });

  it("ignores other event messages and quoted or non-developer markers", () => {
    expect(scan([block, makeEventLine("token_count")])).toBe(true);
    expect(scan([developerLine(`quoted ${LCM_RESTORATION_MARKER}`)])).toBe(false);
    expect(scan([makeSessionLine("user", blockText), makeSessionLine("assistant", blockText)])).toBe(false);
    expect(scan([JSON.stringify({ type: "event_msg", payload: { type: "developer", text: blockText } })])).toBe(false);
    expect(scan([JSON.stringify({ type: "response_item", payload: { type: "function_call", role: "developer", content: blockText } })])).toBe(false);
    expect(scan([JSON.stringify({ type: "response_item" }), JSON.stringify({ type: "event_msg" }), "null", "5", compacted])).toBe(false);
  });

  it("treats malformed JSON shapes as inert without throwing", () => {
    const inert = [
      "[]",
      '"str"',
      "5",
      "null",
      "true",
      JSON.stringify({ type: "response_item", payload: null }),
      JSON.stringify({ type: "response_item", payload: "message" }),
      JSON.stringify({ type: "response_item", payload: [] }),
      JSON.stringify({ type: "event_msg", payload: null }),
      developerLine(blockText),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "developer", content: null } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "developer", content: { text: blockText } } }),
      developerLine([null, 5, "str", [], { type: "input_text" }, { type: "input_text", text: 7 }] as never),
    ];
    expect(scan(inert)).toBe(false);
    expect(scan([block, ...inert.slice(0, 9)])).toBe(true);
    expect(scan([developerLine([null as never, { type: "input_text", text: blockText }])])).toBe(true);
  });

  it("treats an unparseable line as a reset and keeps scanning", () => {
    expect(scan([block, "{not json"])).toBe(false);
    expect(scan(["{not json", block])).toBe(true);
    expect(scan([block, "{not json", block])).toBe(true);
    expect(scan([block, "  \t ", ""])).toBe(true);
  });
});

describe("readLiveCodexRestoration", () => {
  function codexHomeWith(lines: string[], root = "sessions"): { home: string; path: string } {
    const home = makeTmpDir();
    const directory = join(home, root, "2026", "01", "01");
    mkdirSync(directory, { recursive: true });
    const path = join(directory, "rollout-t.jsonl");
    writeFileSync(path, `${lines.join("\n")}\n`);
    return { home, path };
  }

  const previousCodexHome = process.env.CODEX_HOME;
  afterEach(() => {
    fsSeam.beforeRealpath = undefined;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  });

  it("reads rollouts under sessions and archived_sessions", () => {
    const active = codexHomeWith([makeSessionMeta("t", "/p"), block]);
    expect(readLiveCodexRestoration(active.path, { codexHome: active.home })).toBe(true);
    const archived = codexHomeWith([block], "archived_sessions");
    expect(readLiveCodexRestoration(archived.path, { codexHome: archived.home })).toBe(true);
    const none = codexHomeWith([makeSessionMeta("t", "/p")]);
    expect(readLiveCodexRestoration(none.path, { codexHome: none.home })).toBe(false);
  });

  it("honors CODEX_HOME and falls back to the home directory when it is empty", () => {
    const { home, path } = codexHomeWith([block]);
    process.env.CODEX_HOME = home;
    expect(readLiveCodexRestoration(path)).toBe(true);
    process.env.CODEX_HOME = "";
    expect(readLiveCodexRestoration(path)).toBe(false);
    delete process.env.CODEX_HOME;
    expect(readLiveCodexRestoration(path)).toBe(false);
  });

  it("rejects absent, non-string, outside, symlinked, missing and non-regular paths", () => {
    const { home, path } = codexHomeWith([block]);
    expect(readLiveCodexRestoration(undefined, { codexHome: home })).toBe(false);
    expect(readLiveCodexRestoration(null, { codexHome: home })).toBe(false);
    expect(readLiveCodexRestoration("", { codexHome: home })).toBe(false);
    expect(readLiveCodexRestoration(join(home, "missing.jsonl"), { codexHome: home })).toBe(false);

    const outside = join(makeTmpDir(), "rollout-outside.jsonl");
    writeFileSync(outside, block);
    expect(readLiveCodexRestoration(outside, { codexHome: home })).toBe(false);
    const link = join(home, "sessions", "link.jsonl");
    symlinkSync(outside, link);
    expect(readLiveCodexRestoration(link, { codexHome: home })).toBe(false);

    // A symlink leaf is rejected even when it points at a rollout inside sessions.
    const innerLink = join(home, "sessions", "inner-link.jsonl");
    symlinkSync(path, innerLink);
    expect(readLiveCodexRestoration(path, { codexHome: home })).toBe(true);
    expect(readLiveCodexRestoration(innerLink, { codexHome: home })).toBe(false);

    expect(readLiveCodexRestoration(join(home, "sessions", "2026"), { codexHome: home })).toBe(false);
    expect(readLiveCodexRestoration(path, { codexHome: join(home, "elsewhere") })).toBe(false);
  });

  it("rejects a rollout swapped for an in-sessions symlink after it was opened", () => {
    const { home, path } = codexHomeWith([block]);
    const other = join(home, "sessions", "rollout-other.jsonl");
    writeFileSync(other, block);
    let swapped = false;
    fsSeam.beforeRealpath = (target) => {
      if (target !== path || swapped) return;
      swapped = true;
      rmSync(path);
      symlinkSync(other, path);
    };
    expect(readLiveCodexRestoration(path, { codexHome: home })).toBe(false);
    expect(swapped).toBe(true);
  });

  it("rejects a rollout replaced by a different file after it was opened", () => {
    const { home, path } = codexHomeWith([block]);
    const replacement = join(home, "sessions", "rollout-replacement.jsonl");
    writeFileSync(replacement, block);
    fsSeam.beforeRealpath = (target) => {
      if (target === path) renameSync(replacement, path);
    };
    expect(readLiveCodexRestoration(path, { codexHome: home })).toBe(false);
  });

  it("does not treat a sibling directory sharing the sessions prefix as inside it", () => {
    const home = makeTmpDir();
    mkdirSync(join(home, "sessions"));
    mkdirSync(join(home, "sessions-extra"));
    const path = join(home, "sessions-extra", "rollout-t.jsonl");
    writeFileSync(path, block);
    expect(readLiveCodexRestoration(path, { codexHome: home })).toBe(false);
  });

  it("scans the tail window normally after dropping its partial first line", () => {
    const filler = developerLine("x".repeat(400));
    const window = (lines: string[]) => Buffer.byteLength(`${lines.join("\n")}\n`) + 20;

    // A compaction above the window cannot affect a block inside it.
    const compactedAbove = codexHomeWith([block, compacted, filler, block]);
    expect(readLiveCodexRestoration(compactedAbove.path, {
      codexHome: compactedAbove.home,
      maxBytes: window([filler, block]),
    })).toBe(true);

    const rolledBackAbove = codexHomeWith([block, rolledBack, filler, block]);
    expect(readLiveCodexRestoration(rolledBackAbove.path, {
      codexHome: rolledBackAbove.home,
      maxBytes: window([filler, block]),
    })).toBe(true);

    // Resets inside the window still apply.
    const rolledBackInside = codexHomeWith([filler, block, rolledBack]);
    expect(readLiveCodexRestoration(rolledBackInside.path, {
      codexHome: rolledBackInside.home,
      maxBytes: window([block, rolledBack]),
    })).toBe(false);

    // A window holding no line break contributes nothing.
    const noBreak = codexHomeWith([filler]);
    writeFileSync(noBreak.path, filler);
    expect(readLiveCodexRestoration(noBreak.path, { codexHome: noBreak.home, maxBytes: 10 })).toBe(false);

    // The whole file is scanned when it fits.
    expect(readLiveCodexRestoration(compactedAbove.path, { codexHome: compactedAbove.home })).toBe(true);
  });
});

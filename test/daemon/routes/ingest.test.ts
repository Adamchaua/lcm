import { appendFileSync, chmodSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDaemon, type DaemonInstance } from "../../../src/daemon/server.js";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { openLocalTranscriptQuarantine } from "../../../src/storage/local-transcript-quarantine.js";
import { projectDbPath, projectPaths } from "../../../src/daemon/project.js";
import { closeLcmConnection, getLcmConnection } from "../../../src/db/connection.js";

const tempDirs: string[] = [];
const projectDirs: string[] = [];

describe("POST /ingest", () => {
  let daemon: DaemonInstance | undefined;

  afterEach(async () => {
    if (daemon) {
      await daemon.stop();
      daemon = undefined;
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    for (const dir of projectDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("archives scrubbed native records and exact links even when parsed messages were already imported", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lcm-native-ingest-"));
    tempDirs.push(cwd);
    const transcriptPath = join(cwd, "session.jsonl");
    writeFileSync(transcriptPath, [
      { type: "metadata", secret: "NATIVE_SECRET" },
      { message: { role: "user", content: "hello NATIVE_SECRET" } },
    ].map(record => JSON.stringify(record)).join("\n") + "\n");
    daemon = await createDaemon(loadDaemonConfig("/nonexistent", {
      daemon: { port: 0 }, security: { sensitivePatterns: ["NATIVE_SECRET"] },
    }));
    const post = (body: object) => fetch(`http://127.0.0.1:${daemon!.address().port}/ingest`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd, session_id: "native-retry", ...body }),
    });
    expect((await post({ messages: [{ role: "user", content: "hello NATIVE_SECRET", tokenCount: 4 }] })).status).toBe(200);
    const imported = await post({ transcript_path: transcriptPath });
    expect(imported.status).toBe(200);
    expect(await imported.json()).toEqual({ ingested: 0, totalTokens: 0 });
    const dbPath = projectDbPath(cwd);
    const db = getLcmConnection(dbPath);
    try {
      const rows = db.prepare("SELECT native_payload FROM runtime_native_transcripts ORDER BY source_ordinal").all();
      expect(rows).toHaveLength(2);
      expect(JSON.stringify(rows)).toContain("[REDACTED]");
      expect(JSON.stringify(rows)).not.toContain("NATIVE_SECRET");
      expect(db.prepare("SELECT t.source_ordinal, m.content FROM runtime_native_transcript_messages AS l JOIN runtime_native_transcripts AS t ON t.transcript_id=l.transcript_id JOIN messages AS m ON m.message_id=l.message_id").all())
        .toEqual([{ source_ordinal: 1, content: "hello [REDACTED]" }]);
      expect(db.prepare("SELECT last_source_ordinal, imported_count FROM runtime_native_ingest_checkpoints").get())
        .toEqual({ last_source_ordinal: 1, imported_count: 2 });
      expect((await post({ transcript_path: transcriptPath })).status).toBe(200);
      expect(db.prepare("SELECT count(*) AS n FROM runtime_native_transcripts").get()).toEqual({ n: 2 });
      expect(db.prepare("SELECT count(*) AS n FROM messages").get()).toEqual({ n: 1 });
    } finally { closeLcmConnection(dbPath); }
  });

  it("retries native persistence after its transaction fails without acknowledging partial import", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lcm-native-failure-"));
    tempDirs.push(cwd);
    daemon = await createDaemon(loadDaemonConfig("/nonexistent", { daemon: { port: 0 } }));
    const post = (body: object) => fetch(`http://127.0.0.1:${daemon!.address().port}/ingest`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd, session_id: "native-failure", ...body }),
    });
    expect((await post({ messages: [{ role: "user", content: "hello", tokenCount: 1 }] })).status).toBe(200);
    const dbPath = projectDbPath(cwd);
    const db = getLcmConnection(dbPath);
    const transcriptPath = join(cwd, "session.jsonl");
    writeFileSync(transcriptPath, JSON.stringify({ message: { role: "user", content: "hello" } }) + "\n");
    try {
      db.exec("CREATE TRIGGER reject_native BEFORE INSERT ON runtime_native_transcripts BEGIN SELECT RAISE(ABORT, 'native failure sentinel'); END");
      const failed = await post({ transcript_path: transcriptPath });
      expect(failed.status).toBe(500);
      expect(await failed.text()).not.toContain("sentinel");
      expect(db.prepare("SELECT count(*) AS n FROM runtime_native_transcripts").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT count(*) AS n FROM runtime_native_ingest_checkpoints").get()).toEqual({ n: 0 });
      db.exec("DROP TRIGGER reject_native");
      expect((await post({ transcript_path: transcriptPath })).status).toBe(200);
      expect(db.prepare("SELECT count(*) AS n FROM runtime_native_transcripts").get()).toEqual({ n: 1 });
      expect(db.prepare("SELECT count(*) AS n FROM messages").get()).toEqual({ n: 1 });
    } finally { closeLcmConnection(dbPath); }
  });

  it("quarantines malformed native records as metadata and links the remaining messages", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lcm-native-quarantine-"));
    tempDirs.push(cwd);
    const transcriptPath = join(cwd, "session.jsonl");
    writeFileSync(transcriptPath, '{"malformed":"SECRET_QUARANTINE"\n' + JSON.stringify({ message: { role: "user", content: "valid" } }) + "\n");
    daemon = await createDaemon(loadDaemonConfig("/nonexistent", { daemon: { port: 0 } }));
    const response = await fetch(`http://127.0.0.1:${daemon.address().port}/ingest`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd, session_id: "quarantine", transcript_path: transcriptPath }),
    });
    expect(response.status).toBe(200);
    const paths = projectPaths(cwd);
    const quarantine = openLocalTranscriptQuarantine(paths.id, "claude-code");
    try {
      const rejected = await quarantine.list();
      expect(rejected).toHaveLength(1);
      expect(rejected[0]).toMatchObject({ reason: "malformed-json", sourceOrdinal: 0 });
      expect(JSON.stringify(rejected)).not.toContain("SECRET_QUARANTINE");
    } finally { await quarantine.close(); }
    const db = getLcmConnection(paths.dbPath);
    try {
      expect(db.prepare("SELECT imported_count, quarantined_count FROM runtime_native_ingest_checkpoints").get())
        .toEqual({ imported_count: 1, quarantined_count: 1 });
      expect(db.prepare("SELECT count(*) AS n FROM runtime_native_transcript_messages").get()).toEqual({ n: 1 });
    } finally { closeLcmConnection(paths.dbPath); }
  });

  it("stores metadata-only native records without creating a parsed conversation", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lcm-native-metadata-"));
    tempDirs.push(cwd);
    const transcriptPath = join(cwd, "session.jsonl");
    writeFileSync(transcriptPath, JSON.stringify({ type: "session_meta", payload: { id: "metadata-only" } }) + "\n");
    daemon = await createDaemon(loadDaemonConfig("/nonexistent", { daemon: { port: 0 } }));
    const response = await fetch(`http://127.0.0.1:${daemon.address().port}/ingest`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd, session_id: "metadata-only", transcript_path: transcriptPath, client: "codex" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ingested: 0, totalTokens: 0 });
    const dbPath = projectDbPath(cwd);
    const db = getLcmConnection(dbPath);
    try {
      expect(db.prepare("SELECT count(*) AS n FROM runtime_native_transcripts").get()).toEqual({ n: 1 });
      expect(db.prepare("SELECT count(*) AS n FROM conversations").get()).toEqual({ n: 0 });
    } finally { closeLcmConnection(dbPath); }
  });

  it("accepts messages[] as an alternative to transcript_path", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-ingest-"));
    tempDirs.push(tempDir);

    daemon = await createDaemon(loadDaemonConfig("/nonexistent", { daemon: { port: 0 } }));
    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "codex-test-1",
        cwd: tempDir,
        messages: [
          { role: "user", content: "hello", tokenCount: 1 },
          { role: "assistant", content: "hi", tokenCount: 1 },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ingested: 2, totalTokens: 2 });
  });

  it("publishes final ingest metadata atomically with private mode", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-ingest-metadata-"));
    tempDirs.push(tempDir);
    const paths = projectPaths(tempDir);
    projectDirs.push(paths.dir);

    daemon = await createDaemon(loadDaemonConfig("/nonexistent", { daemon: { port: 0 } }));
    const endpoint = `http://127.0.0.1:${daemon.address().port}/ingest`;
    const first = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "metadata-first",
        cwd: tempDir,
        messages: [{ role: "user", content: "first", tokenCount: 1 }],
      }),
    });
    expect(first.status).toBe(200);
    const created = JSON.parse(readFileSync(paths.metaPath, "utf8")) as Record<string, unknown>;
    expect(created).toMatchObject({ cwd: paths.canonical, lastIngest: expect.any(String) });
    expect(lstatSync(paths.metaPath).mode & 0o777).toBe(0o600);

    const oldTimestamp = "1970-01-01T00:00:00.000Z";
    writeFileSync(paths.metaPath, JSON.stringify({
      retained: "value",
      cwd: "/old",
      lastIngest: oldTimestamp,
    }), "utf8");
    chmodSync(paths.metaPath, 0o644);
    const second = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "metadata-second",
        cwd: tempDir,
        messages: [{ role: "assistant", content: "second", tokenCount: 1 }],
      }),
    });
    expect(second.status).toBe(200);
    const replaced = JSON.parse(readFileSync(paths.metaPath, "utf8")) as Record<string, unknown>;
    expect(replaced).toMatchObject({ retained: "value", cwd: paths.canonical });
    expect(Date.parse(String(replaced.lastIngest))).toBeGreaterThan(Date.parse(oldTimestamp));
    expect(lstatSync(paths.metaPath).mode & 0o777).toBe(0o600);
    expect(readdirSync(paths.dir).filter(name => /^\.meta\.json\..+\.tmp$/u.test(name))).toEqual([]);
  });

  it("accepts tool messages in structured ingestion mode", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-ingest-tool-"));
    tempDirs.push(tempDir);

    daemon = await createDaemon(loadDaemonConfig("/nonexistent", { daemon: { port: 0 } }));
    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "codex-test-tool",
        cwd: tempDir,
        messages: [
          { role: "user", content: "run rg", tokenCount: 2 },
          { role: "assistant", content: "Tool call shell: rg --files", tokenCount: 6 },
          { role: "tool", content: "README.md", tokenCount: 2 },
          { role: "assistant", content: "Done", tokenCount: 1 },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ingested: 4, totalTokens: 11 });
  });

  it("prefers messages[] over transcript_path when both are present", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-ingest-both-"));
    tempDirs.push(tempDir);

    daemon = await createDaemon(loadDaemonConfig("/nonexistent", { daemon: { port: 0 } }));
    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "codex-test-2",
        cwd: tempDir,
        transcript_path: "/definitely/missing.jsonl",
        messages: [
          { role: "user", content: "preferred", tokenCount: 2 },
          { role: "assistant", content: "path", tokenCount: 1 },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ingested: 2, totalTokens: 3 });
  });

  it("parses Codex transcript_path when client is codex", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-ingest-codex-"));
    tempDirs.push(tempDir);
    const transcriptPath = join(tempDir, "codex-session.jsonl");
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          type: "session_meta",
          payload: { id: "codex-ingest-1", cwd: tempDir },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Hello Codex" }],
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Hello from Codex" }],
          },
        }),
      ].join("\n"),
    );

    daemon = await createDaemon(loadDaemonConfig("/nonexistent", { daemon: { port: 0 } }));
    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "codex-ingest-1",
        cwd: tempDir,
        transcript_path: transcriptPath,
        client: "codex",
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ingested: 2, totalTokens: 7 });
  });

  it("scrubs secrets from message content before SQLite write", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-ingest-scrub-"));
    tempDirs.push(tempDir);

    daemon = await createDaemon(
      loadDaemonConfig("/nonexistent", {
        daemon: { port: 0 },
        security: { sensitivePatterns: ["MY_PROJECT_SECRET"] },
      }),
    );
    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "scrub-test-1",
        cwd: tempDir,
        messages: [
          { role: "user", content: "token=MY_PROJECT_SECRET", tokenCount: 5 },
        ],
      }),
    });

    expect(res.status).toBe(200);

    // Verify the stored content was scrubbed
    const dbPath = projectDbPath(tempDir);
    const db = getLcmConnection(dbPath);
    let row: { content: string } | undefined;
    try {
      row = db.prepare("SELECT content FROM messages LIMIT 1").get() as { content: string } | undefined;
    } finally {
      closeLcmConnection(dbPath);
    }
    expect(row?.content).toContain("[REDACTED]");
    expect(row?.content).not.toContain("MY_PROJECT_SECRET");
  });

  it("increments redaction_stats per category when content contains secrets", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-ingest-redact-stats-"));
    tempDirs.push(tempDir);

    daemon = await createDaemon(
      loadDaemonConfig("/nonexistent", {
        daemon: { port: 0 },
        security: { sensitivePatterns: ["MY_GLOBAL_TOKEN"] },
      }),
    );
    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "redact-stats-1",
        cwd: tempDir,
        messages: [
          {
            role: "user",
            // ghp_ + 36 alphanumeric chars → matches built-in GitHub token pattern
            // MY_GLOBAL_TOKEN → matches the global pattern above
            content: "token ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA and MY_GLOBAL_TOKEN",
            tokenCount: 10,
          },
        ],
      }),
    });

    expect(res.status).toBe(200);

    const dbPath = projectDbPath(tempDir);
    const db = getLcmConnection(dbPath);
    try {
      const rows = db.prepare(
        "SELECT category, count FROM redaction_stats ORDER BY category"
      ).all() as Array<{ category: string; count: number }>;
      const byCategory = Object.fromEntries(rows.map((r) => [r.category, r.count]));
      // ghp_ token is matched by gitleaks github-pat pattern (gitleaks takes priority over native)
      expect(byCategory["gitleaks"]).toBeGreaterThan(0);
      expect(byCategory["global"]).toBeGreaterThan(0);
    } finally {
      closeLcmConnection(dbPath);
    }
  });

  it("returns ingested=0 when transcript_path is missing and messages[] is absent", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-ingest-missing-"));
    tempDirs.push(tempDir);

    daemon = await createDaemon(loadDaemonConfig("/nonexistent", { daemon: { port: 0 } }));
    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "codex-test-3",
        cwd: tempDir,
        transcript_path: "/definitely/missing.jsonl",
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ingested: 0, totalTokens: 0 });
  });

  it("filters malformed structured messages and returns zero when none remain", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-ingest-invalid-messages-"));
    tempDirs.push(tempDir);
    daemon = await createDaemon(loadDaemonConfig("/nonexistent", { daemon: { port: 0 } }));
    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "invalid-messages",
        cwd: tempDir,
        messages: [null, "text", {}, { role: "invalid", content: "x", tokenCount: 1 },
          { role: "user", content: 1, tokenCount: 1 },
          { role: "user", content: "x", tokenCount: "1" }],
      }),
    });
    expect(await res.json()).toEqual({ ingested: 0, totalTokens: 0 });
  });

  it("does not append messages already persisted for the session", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-ingest-repeat-"));
    tempDirs.push(tempDir);
    daemon = await createDaemon(loadDaemonConfig("/nonexistent", { daemon: { port: 0 } }));
    const payload = {
      session_id: "repeat-session",
      cwd: tempDir,
      messages: [{ role: "user", content: "once", tokenCount: 1 }],
    };
    const first = await fetch(`http://127.0.0.1:${daemon.address().port}/ingest`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    expect((await first.json()).ingested).toBe(1);
    const second = await fetch(`http://127.0.0.1:${daemon.address().port}/ingest`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    expect(await second.json()).toEqual({ ingested: 0, totalTokens: 0 });
  });

  it("skips a session recorded as fully ingested", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-ingest-complete-"));
    tempDirs.push(tempDir);
    daemon = await createDaemon(loadDaemonConfig("/nonexistent", { daemon: { port: 0 } }));
    const bootstrap = await fetch(`http://127.0.0.1:${daemon.address().port}/ingest`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "bootstrap", cwd: tempDir, messages: [{ role: "user", content: "x", tokenCount: 1 }] }),
    });
    expect(bootstrap.status).toBe(200);
    const dbPath = projectDbPath(tempDir);
    const db = getLcmConnection(dbPath);
    try {
      db.prepare("INSERT INTO session_ingest_log (session_id, message_count) VALUES (?, ?)").run("complete-session", 1);
    } finally {
      closeLcmConnection(dbPath);
    }
    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/ingest`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "complete-session", cwd: tempDir, messages: [{ role: "user", content: "ignored", tokenCount: 1 }] }),
    });
    expect(await res.json()).toEqual({ ingested: 0, totalTokens: 0 });
  });

  it("records completion from stored messages and resumes when the transcript grows", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-ingest-growing-"));
    tempDirs.push(tempDir);
    daemon = await createDaemon(loadDaemonConfig("/nonexistent", { daemon: { port: 0 } }));
    const base = `http://127.0.0.1:${daemon.address().port}`;
    const firstMessage = { role: "user", content: "first", tokenCount: 1 };
    const first = await fetch(`${base}/ingest`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "growing", cwd: tempDir, messages: [firstMessage] }),
    });
    expect((await first.json()).ingested).toBe(1);

    const completed = await fetch(`${base}/session-complete`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "growing", cwd: tempDir, message_count: 999_999 }),
    });
    expect(completed.status).toBe(200);
    const db = getLcmConnection(projectDbPath(tempDir));
    try {
      const row = db.prepare("SELECT message_count FROM session_ingest_log WHERE session_id = ?").get("growing") as { message_count: number };
      expect(row.message_count).toBe(1);
    } finally { closeLcmConnection(projectDbPath(tempDir)); }

    const grown = await fetch(`${base}/ingest`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "growing", cwd: tempDir,
        messages: [firstMessage, { role: "assistant", content: "second", tokenCount: 1 }],
      }),
    });
    expect((await grown.json()).ingested).toBe(1);
  });

  it("records completion across every conversation in a split legacy session", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-ingest-split-complete-"));
    tempDirs.push(tempDir);
    daemon = await createDaemon(loadDaemonConfig("/nonexistent", { daemon: { port: 0 } }));
    const base = `http://127.0.0.1:${daemon.address().port}`;
    const sessionId = "split-legacy-session";
    const first = await fetch(`${base}/ingest`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        cwd: tempDir,
        messages: [{ role: "user", content: "first", tokenCount: 1 }],
      }),
    });
    expect((await first.json()).ingested).toBe(1);

    const dbPath = projectDbPath(tempDir);
    const db = getLcmConnection(dbPath);
    try {
      const result = db.prepare("INSERT INTO conversations (session_id, title) VALUES (?, ?)").run(sessionId, "legacy split");
      const splitConversationId = Number(result.lastInsertRowid);
      db.prepare(
        "INSERT INTO messages (conversation_id, seq, role, content, token_count) VALUES (?, ?, ?, ?, ?)",
      ).run(splitConversationId, 0, "assistant", "second", 1);
      db.prepare(
        "INSERT INTO messages (conversation_id, seq, role, content, token_count) VALUES (?, ?, ?, ?, ?)",
      ).run(splitConversationId, 1, "user", "third", 1);
    } finally {
      closeLcmConnection(dbPath);
    }

    const completed = await fetch(`${base}/session-complete`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, cwd: tempDir }),
    });
    expect(completed.status).toBe(200);

    const verificationDb = getLcmConnection(dbPath);
    try {
      const row = verificationDb.prepare(
        "SELECT message_count FROM session_ingest_log WHERE session_id = ?",
      ).get(sessionId) as { message_count: number };
      expect(row.message_count).toBe(3);
    } finally {
      closeLcmConnection(dbPath);
    }

    const repeated = await fetch(`${base}/ingest`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        cwd: tempDir,
        messages: [
          { role: "user", content: "first", tokenCount: 1 },
          { role: "assistant", content: "second", tokenCount: 1 },
          { role: "user", content: "third", tokenCount: 1 },
        ],
      }),
    });
    expect(await repeated.json()).toEqual({ ingested: 0, totalTokens: 0 });
  });

  it("stores an interrupted Codex turn: user-role marker parsed, developer marker and TurnAborted event archive-only", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lcm-ingest-aborted-"));
    tempDirs.push(cwd);
    const marker = "<turn_aborted>\nThe user interrupted the previous turn on purpose.\n</turn_aborted>";
    const item = (role: string, text: string) => JSON.stringify({
      type: "response_item",
      payload: { type: "message", role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text }] },
    });
    const event = JSON.stringify({ type: "event_msg", payload: { type: "turn_aborted", turn_id: "t1", reason: "interrupted" } });
    const meta = JSON.stringify({ type: "session_meta", payload: { id: "aborted", cwd } });
    daemon = await createDaemon(loadDaemonConfig("/nonexistent", { daemon: { port: 0 } }));
    const ingest = async (sessionId: string, transcriptPath: string) => {
      const response = await fetch("http://127.0.0.1:" + daemon!.address().port + "/ingest", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, session_id: sessionId, transcript_path: transcriptPath, client: "codex" }),
      });
      expect(response.status).toBe(200);
    };
    const dbPath = projectDbPath(cwd);
    const read = () => {
      const db = getLcmConnection(dbPath);
      return {
        messages: (db.prepare("SELECT m.role AS role, m.content AS content FROM messages AS m ORDER BY m.message_id").all() as Array<{ role: string; content: string }>)
          .map(({ role, content }) => role + ":" + content),
        archived: (db.prepare("SELECT native_payload FROM runtime_native_transcripts ORDER BY source_ordinal").all() as Array<{ native_payload: string }>)
          .map(({ native_payload }) => native_payload),
      };
    };
    try {
      // Before the hook runs: the user-role marker is on disk, the event is not.
      const user = join(cwd, "user-marker.jsonl");
      writeFileSync(user, [meta, item("user", "run the build"), item("assistant", "starting"), item("user", marker)].join("\n") + "\n");
      await ingest("user-marker", user);
      let state = read();
      expect(state.messages).toEqual(["user:run the build", "assistant:starting", "user:" + marker]);
      expect(state.archived).toHaveLength(4);
      expect(state.archived.some((payload) => payload.includes("turn_aborted") && payload.includes('"event_msg"'))).toBe(false);

      // After the hook: Codex appends the event and the user continues. A later
      // ingest archives the event; only the continuation adds parsed messages.
      appendFileSync(user, [event, item("user", "continue"), item("assistant", "done")].join("\n") + "\n");
      await ingest("user-marker", user);
      state = read();
      expect(state.messages).toEqual([
        "user:run the build", "assistant:starting", "user:" + marker, "user:continue", "assistant:done",
      ]);
      expect(state.archived).toHaveLength(7);
      expect(state.archived.filter((payload) => payload.includes('"event_msg"') && payload.includes("turn_aborted"))).toHaveLength(1);
    } finally { closeLcmConnection(dbPath); }

    // Developer-role marker (multi-agent v2): archived raw, never parsed.
    const developerCwd = mkdtempSync(join(tmpdir(), "lcm-ingest-aborted-dev-"));
    tempDirs.push(developerCwd);
    const developer = join(developerCwd, "developer-marker.jsonl");
    writeFileSync(developer, [meta, item("user", "run the build"), item("assistant", "starting"), item("developer", marker), event].join("\n") + "\n");
    const developerResponse = await fetch("http://127.0.0.1:" + daemon.address().port + "/ingest", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: developerCwd, session_id: "developer-marker", transcript_path: developer, client: "codex" }),
    });
    expect(developerResponse.status).toBe(200);
    const developerDb = projectDbPath(developerCwd);
    const db = getLcmConnection(developerDb);
    try {
      expect(db.prepare("SELECT role, content FROM messages ORDER BY message_id").all())
        .toEqual([{ role: "user", content: "run the build" }, { role: "assistant", content: "starting" }]);
      const archived = (db.prepare("SELECT native_payload FROM runtime_native_transcripts ORDER BY source_ordinal").all() as Array<{ native_payload: string }>)
        .map(({ native_payload }) => native_payload);
      expect(archived).toHaveLength(5);
      expect(archived.some((payload) => payload.includes('"developer"') && payload.includes("turn_aborted"))).toBe(true);
    } finally { closeLcmConnection(developerDb); }

    // No marker and no event: nothing in storage distinguishes it from a completed turn.
    const plainCwd = mkdtempSync(join(tmpdir(), "lcm-ingest-aborted-none-"));
    tempDirs.push(plainCwd);
    const plain = join(plainCwd, "plain.jsonl");
    writeFileSync(plain, [meta, item("user", "run the build"), item("assistant", "starting")].join("\n") + "\n");
    const plainResponse = await fetch("http://127.0.0.1:" + daemon.address().port + "/ingest", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: plainCwd, session_id: "plain", transcript_path: plain, client: "codex" }),
    });
    expect(await plainResponse.json()).toEqual({ ingested: 2, totalTokens: expect.any(Number) });
  });
});

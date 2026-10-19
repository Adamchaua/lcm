/**
 * Parser for Codex CLI session transcript files.
 *
 * Codex stores active sessions in ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 * (with an older ~/.codex/sessions/<session-id>/<session-id>.jsonl layout)
 * and archives them in ~/.codex/archived_sessions/<name>.jsonl.
 *
 * Each JSONL line is an event object with a top-level `type` and `payload`:
 *
 *   { type: "session_meta", payload: { id, cwd, ... } }
 *   { type: "response_item", payload: { type: "message", role: "user"|"assistant"|..., content: [...] } }
 *   { type: "event_msg", payload: { ... } }
 *   ...
 *
 * Content blocks for user messages use `type: "input_text"` and for assistant
 * messages use `type: "output_text"` (both carry a `text` string field).
 */

import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { join, basename, sep } from "node:path";
import { homedir } from "node:os";
import { estimateTokens, readTranscriptFileText } from "./transcript.js";
import type { ParsedMessage } from "./transcript.js";

// ---------------------------------------------------------------------------
// Types matching the Codex JSONL event format
// ---------------------------------------------------------------------------

interface CodexContentBlock {
  type?: string;
  text?: string;
}

interface CodexResponseItemPayload {
  type?: string;
  role?: string;
  content?: string | CodexContentBlock[];
}

interface CodexSessionMetaPayload {
  id?: string;
  cwd?: string;
  git?: {
    commit_hash?: string;
    repository_url?: string;
    branch?: string;
  };
}

interface CodexLine {
  type?: string;
  timestamp?: string;
  payload?: CodexResponseItemPayload | CodexSessionMetaPayload | Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------

function extractCodexText(content: string | CodexContentBlock[] | undefined): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => {
      // Codex uses input_text (user) and output_text (assistant)
      if ((b.type === "input_text" || b.type === "output_text") && typeof b.text === "string") {
        return b.text;
      }
      // Plain text fallback
      if (b.type === "text" && typeof b.text === "string") {
        return b.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Exported parser
// ---------------------------------------------------------------------------

/**
 * Parse a Codex JSONL transcript file into the standard ParsedMessage format.
 * Returns an empty array on any read or parse error.
 */
export function parseCodexTranscript(transcriptPath: string): ParsedMessage[] {
  const raw = readTranscriptFileText(transcriptPath);
  if (raw === undefined) return [];

  return parseCodexTranscriptText(raw);
}

/** Parse already-bound transcript bytes without reopening a pathname. */
export function parseCodexTranscriptText(raw: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let obj: CodexLine;
    try {
      obj = JSON.parse(trimmed) as CodexLine;
    } catch {
      continue;
    }

    // Only response_item lines carry user/assistant messages
    if (obj.type !== "response_item") continue;

    const payload = obj.payload as CodexResponseItemPayload | undefined;
    if (!payload || payload.type !== "message") continue;

    const role = payload.role;
    if (!role || !["user", "assistant"].includes(role)) continue;

    const content = extractCodexText(payload.content);
    if (!content.trim()) continue;

    messages.push({ role, content, tokenCount: estimateTokens(content) });
  }

  return messages;
}

/**
 * Extract the working directory from a Codex session JSONL file.
 * Returns undefined if the session_meta line cannot be found/parsed.
 */
export function extractCodexSessionCwd(transcriptPath: string): string | undefined {
  return extractCodexSessionMeta(transcriptPath)?.cwd;
}

export type CodexSessionMetadata = {
  readonly threadId?: string;
  readonly cwd?: string;
  readonly repositoryUrl?: string;
  readonly commit?: string;
  readonly branch?: string;
};

const MAX_CODEX_SESSION_META_PREFIX_BYTES = 256 * 1024;

/**
 * Read only the bounded transcript prefix needed for session_meta. The record
 * is emitted at session start, so scanning an unbounded conversation is both
 * unnecessary and unsafe for import discovery.
 */
export function extractCodexSessionMeta(transcriptPath: string): CodexSessionMetadata | undefined {
  let fd: number | undefined;
  let raw: string;
  try {
    fd = openSync(transcriptPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const leaf = fstatSync(fd);
    if (!leaf.isFile()) return undefined;
    const size = Math.min(leaf.size, MAX_CODEX_SESSION_META_PREFIX_BYTES);
    const buffer = Buffer.alloc(size);
    const bytesRead = readSync(fd, buffer, 0, size, 0);
    raw = buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as CodexLine;
      if (obj.type === "session_meta") {
        const meta = obj.payload as CodexSessionMetaPayload | undefined;
        if (!meta || typeof meta !== "object") return undefined;
        const result: CodexSessionMetadata = {
          ...(typeof meta.id === "string" && meta.id ? { threadId: meta.id } : {}),
          ...(typeof meta.cwd === "string" && meta.cwd ? { cwd: meta.cwd } : {}),
          ...(typeof meta.git?.repository_url === "string" && meta.git.repository_url
            ? { repositoryUrl: meta.git.repository_url }
            : {}),
          ...(typeof meta.git?.commit_hash === "string" && meta.git.commit_hash
            ? { commit: meta.git.commit_hash }
            : {}),
          ...(typeof meta.git?.branch === "string" && meta.git.branch
            ? { branch: meta.git.branch }
            : {}),
        };
        return Object.keys(result).length > 0 ? result : undefined;
      }
    } catch {
      continue;
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// LCM restoration proof
// ---------------------------------------------------------------------------

/** First line of every Codex SessionStart restoration LCM prints. */
export const LCM_RESTORATION_MARKER = "<!-- lcm-restoration -->";

const MAX_LIVE_RESTORATION_WINDOW_BYTES = 64 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when the text, after leading whitespace, is the marker alone on its first line. */
function startsWithMarkerLine(text: string): boolean {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith(LCM_RESTORATION_MARKER)) return false;
  const rest = trimmed.slice(LCM_RESTORATION_MARKER.length);
  return rest === "" || rest.startsWith("\n") || rest.startsWith("\r\n");
}

/** Message text from block-array content; any other shape yields "". */
function messageText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block: unknown) => (isRecord(block) && typeof block.text === "string" ? block.text : ""))
    .join("\n");
}

/**
 * Decide whether rollout text still holds an LCM restoration that is live in the
 * model context: a developer message starting with the restoration marker that
 * follows the last compaction and the last rollback. Compaction drops hook
 * context and rollback removes trailing turns, so either resets the proof. A
 * line that is not valid JSON may hide either record, so it resets it too.
 * Valid JSON of any other shape is inert: it never throws and never counts as
 * a marker.
 */
export function scanLiveCodexRestoration(raw: string): boolean {
  let live = false;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      live = false;
      continue;
    }
    if (!isRecord(obj)) continue;
    const payload = isRecord(obj.payload) ? obj.payload : {};
    if (obj.type === "compacted") {
      live = false;
    } else if (obj.type === "event_msg" && payload.type === "thread_rolled_back") {
      live = false;
    } else if (
      obj.type === "response_item"
      && payload.type === "message"
      && payload.role === "developer"
      && startsWithMarkerLine(messageText(payload.content))
    ) {
      live = true;
    }
  }
  return live;
}

function isUnder(root: string, candidate: string): boolean {
  return candidate.startsWith(`${root}${sep}`);
}

function isCodexRolloutPath(real: string, codexHome: string): boolean {
  return ["sessions", "archived_sessions"].some((name) => {
    try {
      return isUnder(realpathSync(join(codexHome, name)), real);
    } catch {
      return false;
    }
  });
}

/**
 * Prove from a session's own rollout file that a live LCM restoration exists.
 * Opens the given path once (a symlink leaf fails to open), then requires the
 * descriptor to be a regular file whose identity matches the path's realpath
 * under CODEX_HOME (default ~/.codex) sessions or archived_sessions. Reads at
 * most the last 64 MiB. Any failure or mismatch yields false.
 */
export function readLiveCodexRestoration(
  transcriptPath: unknown,
  options: { codexHome?: string; maxBytes?: number } = {},
): boolean {
  if (typeof transcriptPath !== "string" || !transcriptPath) return false;
  const codexHome = options.codexHome ?? (process.env.CODEX_HOME || join(homedir(), ".codex"));
  const maxBytes = options.maxBytes ?? MAX_LIVE_RESTORATION_WINDOW_BYTES;
  let fd: number | undefined;
  try {
    fd = openSync(transcriptPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return false;
    const real = realpathSync(transcriptPath);
    if (!isCodexRolloutPath(real, codexHome)) return false;
    const current = statSync(real);
    if (current.dev !== stat.dev || current.ino !== stat.ino) return false;
    const start = Math.max(0, stat.size - maxBytes);
    const buffer = Buffer.alloc(stat.size - start);
    const read = readSync(fd, buffer, 0, buffer.length, start);
    let raw = buffer.subarray(0, read).toString("utf8");
    if (start > 0) {
      const newline = raw.indexOf("\n");
      raw = newline === -1 ? "" : raw.slice(newline + 1);
    }
    return scanLiveCodexRestoration(raw);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Session discovery
// ---------------------------------------------------------------------------

export interface CodexSessionFile {
  path: string;
  sessionId: string;
  mtime: number;
}

function addCodexTranscriptFile(
  files: CodexSessionFile[],
  directory: string,
  name: string,
): void {
  try {
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) return;
    files.push({
      path,
      sessionId: basename(name, ".jsonl"),
      mtime: stat.mtimeMs,
    });
  } catch {
    // Skip a leaf that disappeared or became unreadable during discovery.
  }
}

function findDatePartitionedCodexSessionFiles(rootDir: string): CodexSessionFile[] {
  const files: CodexSessionFile[] = [];
  const years = /^\d{4}$/u;
  const monthOrDay = /^\d{2}$/u;

  try {
    for (const year of readdirSync(rootDir, { withFileTypes: true })) {
      if (!year.isDirectory() || year.isSymbolicLink() || !years.test(year.name)) continue;
      const yearDir = join(rootDir, year.name);
      for (const month of readdirSync(yearDir, { withFileTypes: true })) {
        if (!month.isDirectory() || month.isSymbolicLink() || !monthOrDay.test(month.name)) continue;
        const monthDir = join(yearDir, month.name);
        for (const day of readdirSync(monthDir, { withFileTypes: true })) {
          if (!day.isDirectory() || day.isSymbolicLink() || !monthOrDay.test(day.name)) continue;
          const dayDir = join(monthDir, day.name);
          for (const transcript of readdirSync(dayDir, { withFileTypes: true })) {
            if (!/^rollout-.+\.jsonl$/u.test(transcript.name)) continue;
            addCodexTranscriptFile(files, dayDir, transcript.name);
          }
        }
      }
    }
  } catch {
    // Discovery is best-effort; a concurrent removal must not abort import.
  }
  return files;
}

/**
 * Discover Codex transcript files under a root directory.
 *
 * Supported layouts:
 *   - Flat:  <root>/<name>.jsonl         (archived_sessions/)
 *   - Nested: <root>/<id>/<id>.jsonl     (sessions/ layout)
 *   - Date-partitioned: <root>/YYYY/MM/DD/rollout-*.jsonl (active sessions)
 */
export function findCodexSessionFiles(rootDir: string): CodexSessionFile[] {
  const files: CodexSessionFile[] = [];
  if (!existsSync(rootDir)) return files;

  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    // Flat layout: rootDir/<name>.jsonl
    if (entry.name.endsWith(".jsonl")) {
      try {
        addCodexTranscriptFile(files, rootDir, entry.name);
      } catch {
        // skip unreadable entries
      }
      continue;
    }

    // Nested layout: rootDir/<id>/<id>.jsonl
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      const nested = join(rootDir, entry.name, `${entry.name}.jsonl`);
      if (existsSync(nested)) {
        try {
          const st = lstatSync(nested);
          if (st.isSymbolicLink()) {
            // skip symlinks
          } else if (st.isFile()) {
            files.push({
              path: nested,
              sessionId: entry.name,
              mtime: st.mtimeMs,
            });
          }
        } catch {
          // skip
        }
      }
    }
  }

  files.push(...findDatePartitionedCodexSessionFiles(rootDir));
  return files.sort((a, b) => {
    const d = a.mtime - b.mtime;
    if (d !== 0) return d;
    return a.sessionId.localeCompare(b.sessionId);
  });
}

/**
 * Collect all Codex transcript files from a Codex home directory.
 *
 * Searches:
 *   - <codexDir>/archived_sessions/*.jsonl  (flat layout)
 *   - <codexDir>/sessions/<id>/<id>.jsonl   (nested legacy layout)
 *   - <codexDir>/sessions/YYYY/MM/DD/rollout-*.jsonl (active layout)
 *
 * Defaults to ~/.codex when codexDir is omitted.
 */
export function findAllCodexTranscripts(codexDir?: string): CodexSessionFile[] {
  const root = codexDir ?? join(homedir(), ".codex");
  const results: CodexSessionFile[] = [];

  // Archived sessions (flat)
  results.push(...findCodexSessionFiles(join(root, "archived_sessions")));

  // Active sessions (nested)
  results.push(...findCodexSessionFiles(join(root, "sessions")));

  // De-duplicate by sessionId (flat archive wins over sessions/)
  const seen = new Map<string, CodexSessionFile>();
  for (const f of results) {
    if (!seen.has(f.sessionId)) seen.set(f.sessionId, f);
  }

  return [...seen.values()].sort((a, b) => {
    const d = a.mtime - b.mtime;
    if (d !== 0) return d;
    return a.sessionId.localeCompare(b.sessionId);
  });
}

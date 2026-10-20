import { admittedProjectIdentity } from "./storage-lifecycle.js";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import {
  CLAUDE_NATIVE_TRANSCRIPT_FORMAT,
  CODEX_NATIVE_TRANSCRIPT_FORMAT,
  createExactNativeTranscriptMessageResolver,
  createFileNativeTranscriptSource,
  inheritedNativeSourceOrdinals,
  runNativeTranscriptBackfill,
  NativeTranscriptSourceChangedError,
  type NativeTranscriptSourceSnapshot,
} from "../../storage/native-transcript-ingest.js";
import { openLocalTranscriptQuarantine } from "../../storage/local-transcript-quarantine.js";
import type { DaemonConfig } from "../config.js";
import {
  MAX_PROJECT_METADATA_BYTES,
  projectPathsForIdentity,
  ensureProjectDirForIdentity,
  isSafeTranscriptPath,
} from "../project.js";
import {
  atomicWritePrivateFile,
  openPrivateDirectory,
  readBoundedRegularFile,
  type PrivateDirectoryHandle,
} from "../../security-files.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import type { ParsedMessage } from "../../transcript.js";
import { normalizeTranscriptClient, parseTranscriptTextForClient, type TranscriptClient } from "../../transcript-provider.js";
import { readCodexInheritedBoundary, readCodexSessionParent, type CodexInheritedBoundary } from "../../codex-transcript.js";
import { ScrubEngine } from "../../scrub.js";
import { validateCwd } from "../validate-cwd.js";
import { safeLogError } from "../../hooks/hook-errors.js";
import type { ProjectStorage, StorageBackendFactory, TransactionRepositories } from "../../storage/index.js";
import { encodeTranscriptSlotMarker, type NativeTranscriptProvenanceRepository } from "../../storage/contracts.js";
import { createCommitCloseBarrier, storageRouteFailureResponse, withProjectStorage } from "./storage-lifecycle.js";
import { isAbortError, throwIfAborted } from "../cancellation.js";
import { BackendPublicationJournalError } from "../../storage/backend-publication.js";

/** Which parse of a forked Codex subagent's rollout the stored conversation follows. */
type SubagentHistory = "filtered" | "unfiltered" | "mismatch";

/**
 * Pick which parse of a forked Codex subagent's rollout the stored conversation
 * follows: the first of [filtered, unfiltered] of which the already-stored
 * (scrubbed) messages are an exact prefix. Because the stored rows are always a
 * prefix of the chosen list, appending its remaining items and numbering native
 * links by its order stay consistent from one snapshot to the next.
 *
 * When both lists extend the stored rows and differ, text alone cannot tell
 * whether the rows came from the inherited-history reading, so native links
 * that already exist decide: a stored link on a record the current bytes
 * classify as inherited means the conversation follows the unfiltered list.
 */
async function chooseSubagentHistory(
  stored: readonly { readonly role: string; readonly content: string }[],
  filtered: readonly ParsedMessage[],
  unfiltered: readonly ParsedMessage[],
  scrubber: ScrubEngine | undefined,
  hasLinkedInheritedRecord: () => Promise<boolean>,
): Promise<SubagentHistory> {
  const extendsStored = (messages: readonly ParsedMessage[]): boolean =>
    stored.length <= messages.length && stored.every((row, index) => (
      row.role === messages[index]!.role && row.content === scrubber!.scrub(messages[index]!.content)
    ));
  const unfilteredExtends = extendsStored(unfiltered);
  if (!extendsStored(filtered)) return unfilteredExtends ? "unfiltered" : "mismatch";
  return stored.length > 0 && unfilteredExtends && filtered.length !== unfiltered.length
    && await hasLinkedInheritedRecord()
    ? "unfiltered"
    : "filtered";
}

function isParsedMessage(value: unknown): value is ParsedMessage {
  if (!value || typeof value !== "object") return false;

  const message = value as Record<string, unknown>;
  return (
    typeof message.role === "string" &&
    ["user", "assistant", "system", "tool"].includes(message.role) &&
    typeof message.content === "string" &&
    typeof message.tokenCount === "number"
  );
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    && typeof error.code === "string"
    ? error.code
    : undefined;
}

/**
 * Store the part of a session's cumulative transcript list that is not stored
 * yet, inside the caller's transaction.
 *
 * The list holds transcript messages only, so its coordinate is session-wide:
 * stored transcript rows plus the compaction events that took one list index
 * (consumed slot markers). Events written before markers existed are adopted
 * here with the legacy rule, consumed when a transcript row follows them in
 * session order, and never re-evaluated. New rows go to the newest
 * conversation.
 *
 * getOrCreateConversation runs first on the transaction's repositories: on
 * PostgreSQL its advisory transaction lock serializes every writer of the
 * session until commit, and SQLite's immediate transaction does the same.
 */
export async function prepareSessionTranscript(
  conversations: TransactionRepositories["conversations"],
  sessionId: string,
): Promise<{
  conversation: Awaited<ReturnType<TransactionRepositories["conversations"]["getOrCreateConversation"]>>;
  transcriptCount: number;
  consumedCount: number;
  eventMessageIds: ReadonlySet<number>;
}> {
  const conversation = await conversations.getOrCreateConversation(sessionId);
  const snapshot = await conversations.getTranscriptSlotSnapshot(sessionId);
  let consumedCount = 0;
  for (const event of snapshot.events) {
    const markers = new Set(event.slotMarkers);
    if (markers.size > 1) throw new Error("conflicting transcript slot markers");
    const consumed = markers.size === 1 ? markers.has(true) : event.followedByTranscript;
    if (markers.size === 0) {
      await conversations.createMessageParts(event.messageId, [{
        sessionId,
        partType: "snapshot",
        ordinal: event.nextOrdinal,
        metadata: encodeTranscriptSlotMarker(consumed),
      }]);
    }
    if (consumed) consumedCount += 1;
  }
  return {
    conversation,
    transcriptCount: snapshot.transcriptCount,
    consumedCount,
    eventMessageIds: new Set(snapshot.events.map((event) => event.messageId)),
  };
}

/** Scrub and append transcript messages to a conversation inside the caller's transaction. */
async function appendTranscriptMessages(
  repositories: Pick<TransactionRepositories, "conversations" | "redactionAdmin" | "context">,
  conversationId: number,
  newMessages: readonly ParsedMessage[],
  scrubber: ScrubEngine,
): Promise<{
  conversationId: number;
  records: Awaited<ReturnType<TransactionRepositories["conversations"]["appendMessages"]>>;
  totalCounts: { gitleaks: number; builtIn: number; global: number; project: number };
} | null> {
  if (newMessages.length === 0) return null;
  const totalCounts = { gitleaks: 0, builtIn: 0, global: 0, project: 0 };
  const inputs = newMessages.map((m) => {
    const { text: scrubbedContent, gitleaks, builtIn, global: globalCount, project: projectCount } = scrubber.scrubWithCounts(m.content);
    totalCounts.gitleaks += gitleaks;
    totalCounts.builtIn += builtIn;
    totalCounts.global += globalCount;
    totalCounts.project += projectCount;
    return {
      role: m.role as "user" | "assistant" | "system" | "tool",
      content: scrubbedContent,
      tokenCount: m.tokenCount,
    };
  });
  const records = await repositories.conversations.appendMessages(conversationId, inputs);
  await repositories.redactionAdmin.upsertCounts(totalCounts);
  await repositories.context.appendContextMessages(
    conversationId,
    records.map((record) => record.messageId),
  );
  return { conversationId, records, totalCounts };
}

export async function appendSessionTranscript(
  repositories: Pick<TransactionRepositories, "conversations" | "redactionAdmin" | "context">,
  sessionId: string,
  parsed: readonly ParsedMessage[],
  scrubber: ScrubEngine,
) {
  const slot = await prepareSessionTranscript(repositories.conversations, sessionId);
  return appendTranscriptMessages(
    repositories,
    slot.conversation.conversationId,
    parsed.slice(slot.transcriptCount + slot.consumedCount),
    scrubber,
  );
}

function resolveMessages(input: { client?: unknown; messages?: unknown; provider?: unknown; transcript_path?: string }, cwd: string): { messages: ParsedMessage[]; nativePath?: string; client?: TranscriptClient } {
  if (Array.isArray(input.messages)) {
    return { messages: input.messages.filter(isParsedMessage) };
  }

  if (input.transcript_path) {
    const safePath = isSafeTranscriptPath(input.transcript_path, cwd);
    if (safePath && existsSync(safePath)) {
      const client = normalizeTranscriptClient(input.client ?? input.provider);
      return { messages: [], nativePath: safePath, client };
    }
  }

  return { messages: [] };
}

export function createIngestHandler(config: DaemonConfig, storageFactory?: StorageBackendFactory): RouteHandler {
  return async (_req, res, body, context) => {
    const input = JSON.parse(body || "{}");
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      sendJson(res, 400, { error: "invalid request body" });
      return;
    }
    const { session_id } = input;

    if (!session_id || !input.cwd) {
      sendJson(res, 400, { error: "session_id and cwd are required" });
      return;
    }

    let cwd: string;
    try {
      cwd = validateCwd(input.cwd);
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : "invalid cwd" });
      return;
    }

    try {
      throwIfAborted(context?.signal);
      // Preserve the route's early identity/configuration rejection while the
      // lifecycle helper re-resolves the identity with its live admission token.
      const storageIdentity = await admittedProjectIdentity(
        cwd,
        config.storage,
        context,
      );
      const localIdentity = {
        id: storageIdentity.localProjectId,
        canonical: storageIdentity.canonical,
        ...(storageIdentity.remoteProjectId === undefined
          ? {}
          : { remoteProjectId: storageIdentity.remoteProjectId }),
      };
      const paths = projectPathsForIdentity(localIdentity);
      const resolved = resolveMessages(input, cwd);
      const resolvedMessages = resolved.messages;
      const importNative = resolved.nativePath;
      if (config.storage.backend === "sqlite" && resolvedMessages.length === 0 && importNative === undefined) {
        sendJson(res, 200, { ingested: 0, totalTokens: 0 });
        return;
      }
      const createScrubber = (messages: ParsedMessage[]) => messages.length > 0
        ? (async () => {
            ensureProjectDirForIdentity(localIdentity);
            return ScrubEngine.forProject(
              config.security?.sensitivePatterns ?? [],
              paths.dir,
            );
          })()
        : undefined;

      const signal = context?.signal ?? new AbortController().signal;
      async function persist(
        project: ProjectStorage,
        messages: ParsedMessage[],
        scrubber: ScrubEngine | undefined,
        filteredMessages: ParsedMessage[] | undefined,
        hasLinkedInheritedRecord: (provenance: NativeTranscriptProvenanceRepository) => Promise<boolean>,
        parentSessionId: string | undefined,
      ) {
        const resolvedMessages = messages;
        return await project.transaction(async (repositories) => {
          // Keep-first parent linkage runs on every attempt, before any early
          // return, and never creates a conversation of its own.
          const linkParent = async (conversation: { conversationId: number; parentSessionId: string | null } | null) => {
            if (parentSessionId === undefined || conversation === null || conversation.parentSessionId !== null) return;
            await repositories.conversations.setParentSessionIdIfNull(conversation.conversationId, parentSessionId);
          };
          if (resolvedMessages.length === 0 && filteredMessages === undefined) {
            if (parentSessionId !== undefined) {
              await linkParent(await repositories.conversations.getConversationBySessionId(session_id));
            }
            return { persisted: null, history: undefined };
          }

          if (filteredMessages === undefined) {
            // The session-wide slot index and the session lock come first.
            const slot = await prepareSessionTranscript(repositories.conversations, session_id);
            await linkParent(slot.conversation);
            const persisted = await appendTranscriptMessages(
              repositories,
              slot.conversation.conversationId,
              resolvedMessages.slice(slot.transcriptCount + slot.consumedCount),
              scrubber!,
            );
            return { persisted, history: undefined };
          }

          const chooseHistory = (stored: readonly { readonly role: string; readonly content: string }[]) =>
            chooseSubagentHistory(
              stored,
              filteredMessages,
              resolvedMessages,
              scrubber,
              async () => repositories.nativeProvenance !== undefined
                && await hasLinkedInheritedRecord(repositories.nativeProvenance),
            );
          if (resolvedMessages.length === 0) {
            // Nothing can be appended without messages, so no conversation is
            // created just to inspect an empty subagent.
            const conversation = await repositories.conversations.getConversationBySessionId(session_id);
            await linkParent(conversation);
            let stored: Awaited<ReturnType<typeof repositories.conversations.getMessages>> = [];
            if (conversation !== null) {
              const snapshot = await repositories.conversations.getTranscriptSlotSnapshot(session_id);
              const eventMessageIds = new Set(snapshot.events.map((event) => event.messageId));
              stored = (await repositories.conversations.getMessages(conversation.conversationId))
                .filter((message) => !eventMessageIds.has(message.messageId));
            }
            return { persisted: null, history: await chooseHistory(stored) };
          }

          const slot = await prepareSessionTranscript(repositories.conversations, session_id);
          await linkParent(slot.conversation);
          const stored = (await repositories.conversations.getMessages(slot.conversation.conversationId))
            .filter((message) => !slot.eventMessageIds.has(message.messageId));
          // A consumed slot or a session split across conversations means the
          // newest conversation's rows are not the session-wide prefix: leave it.
          const history: SubagentHistory = slot.consumedCount > 0 || stored.length !== slot.transcriptCount
            ? "mismatch"
            : await chooseHistory(stored);
          if (history === "mismatch") return { persisted: null, history };
          const chosen = history === "filtered" ? filteredMessages : resolvedMessages;
          const persisted = await appendTranscriptMessages(
            repositories,
            slot.conversation.conversationId,
            chosen.slice(slot.transcriptCount),
            scrubber!,
          );
          return { persisted, history };
        });
      }
      type PersistedIngest = NonNullable<Awaited<ReturnType<typeof persist>>["persisted"]>;
      let accumulated: PersistedIngest | null = null;
      let ingest: (PersistedIngest & { totalTokens: number }) | null = null;
      let sourceWitness: { byteLength: number; sha256: string } | undefined;
      let retryFailure: NativeTranscriptSourceChangedError | undefined;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        throwIfAborted(signal);
        let parentSessionId: string | undefined;
        let snapshot: NativeTranscriptSourceSnapshot | undefined;
        let closeSnapshot: (() => Promise<void>) | undefined;
        let sourceClosed = false;
        let attemptFailed = false;
        let retryableFailure: NativeTranscriptSourceChangedError | undefined;
        const closeSource = async () => {
          if (sourceClosed) return;
          sourceClosed = true;
          try { await closeSnapshot?.(); } catch (error) {
            if (retryableFailure !== undefined) {
              throw new AggregateError([retryableFailure, error], "Native ingest source cleanup failed", { cause: retryableFailure });
            }
            if (!attemptFailed) throw error;
          }
        };
        try {
          let messages = resolvedMessages;
          let inheritedBoundary: CodexInheritedBoundary | undefined;
          let filteredMessages: ParsedMessage[] | undefined;
          let rolloutBytes: Buffer | undefined;
          if (importNative !== undefined) {
            snapshot = await createFileNativeTranscriptSource(dirname(importNative), basename(importNative)).openSnapshot();
            closeSnapshot = snapshot.close.bind(snapshot);
            // The route owns cleanup, including failures before backfill.
            const bound = snapshot;
            snapshot = {
              metadata: bound.metadata,
              stream: bound.stream.bind(bound),
              digestPrefix: bound.digestPrefix.bind(bound),
              assertUnchanged: bound.assertUnchanged.bind(bound),
              assertByteRangesUnchanged: bound.assertByteRangesUnchanged.bind(bound),
              close: async () => undefined,
            };
            if (sourceWitness !== undefined && (
              snapshot.metadata.sizeBytes < sourceWitness.byteLength
              || await snapshot.digestPrefix(sourceWitness.byteLength) !== sourceWitness.sha256
            )) throw retryFailure;
            const chunks: Buffer[] = [];
            for await (const chunk of snapshot.stream()) chunks.push(Buffer.from(chunk));
            await snapshot.assertUnchanged();
            const bytes = Buffer.concat(chunks);
            rolloutBytes = bytes;
            sourceWitness = { byteLength: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
            const raw = bytes.toString("utf8");
            messages = parseTranscriptTextForClient(raw, resolved.client!);
            if (resolved.client === "codex") {
              // The boundary is read from the same bound bytes as the parse.
              inheritedBoundary = readCodexInheritedBoundary(raw);
              if (inheritedBoundary !== undefined) {
                filteredMessages = parseTranscriptTextForClient(raw, "codex", { excludeInheritedSubagentHistory: true });
              }
              // The immediate parent comes from the same bound bytes; only the
              // rollout whose own id is the child key may name one.
              const meta = readCodexSessionParent(raw);
              if (
                meta !== undefined && meta.id === session_id && meta.parentThreadId !== ""
                && meta.parentThreadId !== session_id && !meta.parentThreadId.includes("\0")
              ) parentSessionId = meta.parentThreadId;
            }
          }
          throwIfAborted(signal);
          const scrubber = await createScrubber(messages);
          throwIfAborted(signal);
          const lifetime = createCommitCloseBarrier();
          ingest = await withProjectStorage(
            {
              config, cwd, factory: storageFactory, context, mode: "create",
              expectedIdentity: storageIdentity, beforeClose: lifetime.waitForZero,
            },
            async (project, signal) => {
              const permit = lifetime.acquire(() => ({ release: () => undefined }));
              try {
                throwIfAborted(signal);
                if (resolvedMessages.length === 0 && importNative === undefined) return null;
                if (importNative !== undefined && project.nativeTranscripts === undefined) {
                  throw new Error("native transcript storage unavailable");
                }
                await snapshot?.assertUnchanged();
                throwIfAborted(signal);
                const { persisted, history } = await persist(
                  project,
                  messages,
                  scrubber,
                  filteredMessages,
                  // Only a tie between the two readings asks this: does a
                  // committed native link already sit on inherited history?
                  async (provenance: NativeTranscriptProvenanceRepository) => {
                    const linked = await provenance.listLinkedSourceOrdinals({
                      machineId: project.nativeTranscripts!.machineId,
                      clientName: CODEX_NATIVE_TRANSCRIPT_FORMAT.clientName,
                      sourceLocator: createHash("sha256").update(importNative!).digest("hex"),
                      nativeSessionId: session_id,
                    });
                    if (linked.length === 0) return false;
                    const inherited = await inheritedNativeSourceOrdinals(rolloutBytes!, inheritedBoundary!);
                    return linked.some((ordinal) => inherited.has(ordinal));
                  },
                  parentSessionId,
                );
                if (persisted) {
                  accumulated = accumulated === null ? persisted : {
                    conversationId: persisted.conversationId,
                    records: [...accumulated.records, ...persisted.records],
                    totalCounts: {
                      gitleaks: accumulated.totalCounts.gitleaks + persisted.totalCounts.gitleaks,
                      builtIn: accumulated.totalCounts.builtIn + persisted.totalCounts.builtIn,
                      global: accumulated.totalCounts.global + persisted.totalCounts.global,
                      project: accumulated.totalCounts.project + persisted.totalCounts.project,
                    },
                  };
                }
                throwIfAborted(signal);
                if (history === "mismatch") {
                  // Neither parse extends what is stored for this child, so
                  // appending or linking could misnumber it. Leave it as is.
                  await safeLogError(
                    "ingest",
                    new Error("subagent transcript matches neither the filtered nor the unfiltered stored history"),
                    { cwd, sessionId: session_id },
                  );
                } else if (importNative !== undefined) {
                  const native = project.nativeTranscripts!;
                  const format = resolved.client === "codex"
                    ? CODEX_NATIVE_TRANSCRIPT_FORMAT
                    : CLAUDE_NATIVE_TRANSCRIPT_FORMAT;
                  const projectPatterns = await ScrubEngine.loadProjectPatterns(join(paths.dir, "sensitive-patterns.txt"));
                  const quarantine = openLocalTranscriptQuarantine(project.projectId, format.clientName);
                  let backfillFailed = false;
                  let backfillRetryFailure: NativeTranscriptSourceChangedError | undefined;
                  try {
                    await runNativeTranscriptBackfill({
                      repository: native.repository,
                      messageResolver: createExactNativeTranscriptMessageResolver(native.repository),
                      machineId: native.machineId,
                      format,
                      nativeSessionId: session_id,
                      sourceLocator: createHash("sha256").update(importNative).digest("hex"),
                      source: { openSnapshot: async () => snapshot! },
                      globalPatterns: config.security?.sensitivePatterns ?? [],
                      projectPatterns,
                      quarantine,
                      ...(history === "filtered" && inheritedBoundary !== undefined
                        ? { codexInheritedBoundary: inheritedBoundary }
                        : {}),
                    });
                  } catch (error) {
                    backfillFailed = true;
                    if (error instanceof NativeTranscriptSourceChangedError && attempt === 0 && !signal.aborted) {
                      backfillRetryFailure = error;
                    }
                    throw error;
                  } finally {
                    try { await quarantine.close(); } catch (error) {
                      if (backfillRetryFailure !== undefined) {
                        throw new AggregateError([backfillRetryFailure, error], "Native ingest quarantine cleanup failed", { cause: backfillRetryFailure });
                      }
                      if (!backfillFailed) throw error;
                    }
                  }
                }

                throwIfAborted(signal);
                if (!accumulated) return null;
                const totalTokens = await project.context.getContextTokenCount(accumulated.conversationId);
                throwIfAborted(signal);
                return { ...accumulated, totalTokens };
              } catch (error) {
                attemptFailed = true;
                if (error instanceof NativeTranscriptSourceChangedError && attempt === 0 && !signal.aborted) {
                  retryableFailure = error;
                }
                throw error;
              } finally {
                try { await closeSource(); } finally { permit.release(); }
              }
            },
          );
          break;
        } catch (error) {
          attemptFailed = true;
          if (!(error instanceof NativeTranscriptSourceChangedError) || attempt === 1) throw error;
          throwIfAborted(signal);
          if (sourceWitness === undefined) throw error;
          retryFailure = error;
          retryableFailure = error;
        } finally {
          await closeSource();
        }
      }

      throwIfAborted(context?.signal);
      if (!ingest) {
        sendJson(res, 200, { ingested: 0, totalTokens: 0 });
        return;
      }

      // Update meta.json with lastIngest timestamp
      try {
        const metaPath = paths.metaPath;
        const expectedUid = typeof process.getuid === "function" ? process.getuid() : undefined;
        let meta: Record<string, unknown> = {};
        try {
          const parsed: unknown = JSON.parse(readBoundedRegularFile(metaPath, {
            allowedRoot: paths.dir,
            maxBytes: MAX_PROJECT_METADATA_BYTES,
            expectedUid,
            requireSingleLink: true,
          }));
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("invalid project metadata");
          }
          meta = parsed as Record<string, unknown>;
        } catch (error) {
          if (errorCode(error) !== "ENOENT") throw error;
        }
        meta.cwd = paths.canonical;
        meta.lastIngest = new Date().toISOString();
        const serialized = JSON.stringify(meta, null, 2) + "\n";
        if (Buffer.byteLength(serialized, "utf8") > MAX_PROJECT_METADATA_BYTES) {
          throw new Error("project metadata exceeds size limit");
        }
        const parent: PrivateDirectoryHandle = openPrivateDirectory(paths.dir, { expectedUid });
        let primaryError: unknown;
        let hasPrimaryError = false;
        try {
          atomicWritePrivateFile(metaPath, serialized, {}, parent);
        } catch (error) {
          hasPrimaryError = true;
          primaryError = error;
        } finally {
          try {
            parent.close();
          } catch (error) {
            if (hasPrimaryError) {
              throw new AggregateError(
                [primaryError, error],
                "project metadata publication and directory cleanup failed",
                { cause: primaryError },
              );
            }
            throw error;
          }
        }
        if (hasPrimaryError) throw primaryError;
      } catch {
        // non-fatal: meta.json update failure shouldn't fail the ingest
      }

      const { records, totalCounts, totalTokens } = ingest;
      const totalRedacted = totalCounts.gitleaks + totalCounts.builtIn + totalCounts.global + totalCounts.project;
      const redactionCategories: string[] = [];
      if (totalCounts.gitleaks > 0) redactionCategories.push("gitleaks");
      if (totalCounts.builtIn > 0) redactionCategories.push("built_in");
      if (totalCounts.global > 0) redactionCategories.push("global");
      if (totalCounts.project > 0) redactionCategories.push("project");
      sendJson(res, 200, {
        ingested: records.length,
        totalTokens,
        ...(totalRedacted > 0 ? { redacted: totalRedacted, redactedCategories: redactionCategories } : {}),
      });
    } catch (err) {
      if (isAbortError(err)) {
        if (!res.headersSent && !res.writableEnded && !res.destroyed && res.writable !== false) {
          sendJson(res, 499, { status: "cancelled", error: "ingest cancelled" });
        }
        return;
      }
      if (err instanceof BackendPublicationJournalError) {
        sendJson(res, 503, {
          status: "blocked",
          error: "backend publication admission blocked",
        });
        return;
      }
      await safeLogError("ingest", err, { cwd, sessionId: session_id });
      const storageFailure = storageRouteFailureResponse(config.storage.backend, err, "ingest", storageFactory);
      if (storageFailure) {
        sendJson(res, storageFailure.status, storageFailure.body);
        return;
      }
      sendJson(res, 500, { error: "ingest failed", code: "INGEST_FAILED" });
    }
  };
}

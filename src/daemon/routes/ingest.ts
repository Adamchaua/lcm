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
import { readCodexInheritedBoundary, type CodexInheritedBoundary } from "../../codex-transcript.js";
import { ScrubEngine } from "../../scrub.js";
import { validateCwd } from "../validate-cwd.js";
import { safeLogError } from "../../hooks/hook-errors.js";
import type { ProjectStorage, StorageBackendFactory } from "../../storage/index.js";
import type { NativeTranscriptProvenanceRepository } from "../../storage/contracts.js";
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
      ) {
        const resolvedMessages = messages;
        return await project.transaction(async (repositories) => {
          if (resolvedMessages.length === 0 && filteredMessages === undefined) {
            return { persisted: null, history: undefined };
          }
          // A forked subagent's history mode needs the stored rows, so it never
          // takes the session-count shortcut below, even when nothing is new.
          if (filteredMessages === undefined) {
            const row = await repositories.coordination.getSessionIngest(session_id);
            if (row && resolvedMessages.length <= row.messageCount) return { persisted: null, history: undefined };
          }

          // Nothing can be appended without messages, so no conversation is
          // created just to inspect an empty subagent.
          const conversation = resolvedMessages.length === 0
            ? await repositories.conversations.getConversationBySessionId(session_id)
            : await repositories.conversations.getOrCreateConversation(session_id);
          let history: SubagentHistory | undefined;
          let chosen = resolvedMessages;
          let storedCount: number;
          if (filteredMessages === undefined) {
            storedCount = await repositories.conversations.getMessageCount(conversation!.conversationId);
          } else {
            const stored = conversation === null
              ? []
              : await repositories.conversations.getMessages(conversation.conversationId);
            storedCount = stored.length;
            history = await chooseSubagentHistory(
              stored,
              filteredMessages,
              resolvedMessages,
              scrubber,
              async () => repositories.nativeProvenance !== undefined
                && await hasLinkedInheritedRecord(repositories.nativeProvenance),
            );
            if (history === "mismatch") return { persisted: null, history };
            if (history === "filtered") chosen = filteredMessages;
          }
          const newMessages = chosen.slice(storedCount);
          if (newMessages.length === 0) return { persisted: null, history };

          const totalCounts = { gitleaks: 0, builtIn: 0, global: 0, project: 0 };
          const inputs = newMessages.map((m, i) => {
            const { text: scrubbedContent, gitleaks, builtIn, global: globalCount, project: projectCount } = scrubber!.scrubWithCounts(m.content);
            totalCounts.gitleaks += gitleaks;
            totalCounts.builtIn += builtIn;
            totalCounts.global += globalCount;
            totalCounts.project += projectCount;
            return {
              conversationId: conversation!.conversationId,
              seq: storedCount + i,
              role: m.role as "user" | "assistant" | "system" | "tool",
              content: scrubbedContent,
              tokenCount: m.tokenCount,
            };
          });
          const records = await repositories.conversations.createMessagesBulk(inputs);
          await repositories.redactionAdmin.upsertCounts(totalCounts);
          await repositories.context.appendContextMessages(
            conversation!.conversationId,
            records.map((record) => record.messageId),
          );
          return { persisted: { conversationId: conversation!.conversationId, records, totalCounts }, history };
        });
      }
      type PersistedIngest = NonNullable<Awaited<ReturnType<typeof persist>>["persisted"]>;
      let accumulated: PersistedIngest | null = null;
      let ingest: (PersistedIngest & { totalTokens: number }) | null = null;
      let sourceWitness: { byteLength: number; sha256: string } | undefined;
      let retryFailure: NativeTranscriptSourceChangedError | undefined;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        throwIfAborted(signal);
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

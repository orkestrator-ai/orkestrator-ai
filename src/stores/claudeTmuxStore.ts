// State for the Claude tmux mode tab.
//
// We deliberately emit `ClaudeMessage` (the same shape used by Claude native
// mode) so the same `<ClaudeMessage>` renderer can be reused — that's what
// gives tmux mode visual parity with the native Agent SDK tab.
//
// Keyed by environmentId because each environment has at most one tmux session.

import { create } from "zustand";
import type {
  HookEventKind,
  TranscriptLine,
  TranscriptContent,
} from "@/lib/claude-tmux-client";
import type {
  ClaudeMessage,
  ClaudeMessagePart,
  ToolDiffMetadata,
} from "@/lib/claude-client";

/** A blocking PreToolUse hook event awaiting the user's decision. */
export interface TmuxPendingApproval {
  eventId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  payload: unknown;
  receivedAt: string;
}

/** An informational hook event (Notification / Stop / etc.). */
export interface TmuxInfoEvent {
  id: string;
  kind: HookEventKind;
  message: string;
  receivedAt: string;
}

interface TmuxEnvState {
  sessionId: string | null;
  running: boolean;
  /** Native-shaped messages, ready for `<ClaudeMessage>`. */
  messages: ClaudeMessage[];
  pendingApprovals: TmuxPendingApproval[];
  infoEvents: TmuxInfoEvent[];
}

const emptyEnvState = (): TmuxEnvState => ({
  sessionId: null,
  running: false,
  messages: [],
  pendingApprovals: [],
  infoEvents: [],
});

interface ClaudeTmuxState {
  envs: Map<string, TmuxEnvState>;

  setRunning: (envId: string, running: boolean, sessionId: string | null) => void;
  resetEnvironment: (envId: string) => void;
  applyTranscriptLine: (envId: string, line: TranscriptLine) => void;
  addPendingApproval: (envId: string, approval: TmuxPendingApproval) => void;
  removePendingApproval: (envId: string, eventId: string) => void;
  pushInfoEvent: (envId: string, event: TmuxInfoEvent) => void;
  dismissInfoEvent: (envId: string, id: string) => void;

  getEnv: (envId: string) => TmuxEnvState;
}

function patchEnv(
  state: ClaudeTmuxState,
  envId: string,
  patch: (s: TmuxEnvState) => TmuxEnvState,
): { envs: Map<string, TmuxEnvState> } {
  const next = new Map(state.envs);
  const current = next.get(envId) ?? emptyEnvState();
  next.set(envId, patch(current));
  return { envs: next };
}

export const useClaudeTmuxStore = create<ClaudeTmuxState>()((set, get) => ({
  envs: new Map(),

  setRunning: (envId, running, sessionId) =>
    set((state) =>
      patchEnv(state, envId, (s) => ({
        ...s,
        running,
        sessionId: sessionId ?? s.sessionId,
      })),
    ),

  resetEnvironment: (envId) =>
    set((state) => patchEnv(state, envId, () => emptyEnvState())),

  applyTranscriptLine: (envId, line) =>
    set((state) =>
      patchEnv(state, envId, (s) => applyLine(s, line)),
    ),

  addPendingApproval: (envId, approval) =>
    set((state) =>
      patchEnv(state, envId, (s) => {
        if (s.pendingApprovals.some((a) => a.eventId === approval.eventId)) {
          return s;
        }
        return { ...s, pendingApprovals: [...s.pendingApprovals, approval] };
      }),
    ),

  removePendingApproval: (envId, eventId) =>
    set((state) =>
      patchEnv(state, envId, (s) => ({
        ...s,
        pendingApprovals: s.pendingApprovals.filter(
          (a) => a.eventId !== eventId,
        ),
      })),
    ),

  pushInfoEvent: (envId, event) =>
    set((state) =>
      patchEnv(state, envId, (s) => ({
        ...s,
        infoEvents: [...s.infoEvents.slice(-19), event],
      })),
    ),

  dismissInfoEvent: (envId, id) =>
    set((state) =>
      patchEnv(state, envId, (s) => ({
        ...s,
        infoEvents: s.infoEvents.filter((e) => e.id !== id),
      })),
    ),

  getEnv: (envId) => get().envs.get(envId) ?? emptyEnvState(),
}));

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Apply a JSONL transcript line to the env state. Two distinct flows:
 *
 *  - `user` lines that carry *only* `tool_result` parts are merged into the
 *    parts array of the previous assistant message (so the result is shown
 *    inline under the tool invocation), instead of appearing as a separate
 *    "USER" bubble.
 *  - Everything else replaces or appends a message keyed by `uuid`.
 */
function applyLine(state: TmuxEnvState, line: TranscriptLine): TmuxEnvState {
  if (line.type !== "user" && line.type !== "assistant" && line.type !== "system") {
    return state;
  }

  const id = lineId(line);
  const role = (line.message?.role ?? line.type) as ClaudeMessage["role"];
  const content =
    (line.message?.content as TranscriptLine["content"]) ?? line.content;
  const timestamp =
    typeof line.timestamp === "string" ? line.timestamp : new Date().toISOString();

  const parts = contentToParts(content);

  // Special case: a "user" message that only contains tool_result parts is
  // really Claude relaying the results of the previous assistant turn. Merge
  // the results into the prior assistant message so the renderer can show
  // result-under-tool-use instead of a separate USER bubble.
  const allToolResults =
    role === "user" &&
    parts.length > 0 &&
    parts.every((p) => p.type === "tool-result");
  if (allToolResults) {
    const merged = mergeToolResultsIntoPrior(state.messages, parts);
    if (merged) return { ...state, messages: merged };
  }

  // Drop content-empty user messages produced by hook-injection that have
  // nothing to render (these show up when Claude Code logs system events
  // through the user channel).
  if (role === "user" && parts.length === 0) {
    return state;
  }

  const newMessage: ClaudeMessage = {
    id,
    role,
    content: textOfParts(parts),
    parts,
    timestamp,
  };

  const existingIdx = state.messages.findIndex((m) => m.id === id);
  if (existingIdx >= 0) {
    const updated = [...state.messages];
    updated[existingIdx] = mergeMessage(updated[existingIdx]!, newMessage);
    return { ...state, messages: updated };
  }
  return { ...state, messages: [...state.messages, newMessage] };
}

function lineId(line: TranscriptLine): string {
  if (typeof line.uuid === "string" && line.uuid) return line.uuid;
  if (typeof line.timestamp === "string" && line.timestamp) return line.timestamp;
  return stableHash(line);
}

function contentToParts(
  content: TranscriptLine["content"],
): ClaudeMessagePart[] {
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "text", content }] : [];
  }
  if (!Array.isArray(content)) return [];

  const parts: ClaudeMessagePart[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw as TranscriptContent;
    switch (c.type) {
      case "text":
        if (c.text) parts.push({ type: "text", content: c.text });
        break;
      case "thinking":
        if (c.thinking) parts.push({ type: "thinking", content: c.thinking });
        break;
      case "tool_use": {
        const toolArgs = (c.input ?? {}) as Record<string, unknown>;
        parts.push({
          type: "tool-invocation",
          toolName: c.name,
          toolUseId: c.id,
          toolArgs,
          toolState: "pending",
          toolTitle: c.name,
          toolDiff: buildToolDiff(c.name, toolArgs),
        });
        break;
      }
      case "tool_result": {
        const txt = toolResultText(c.content);
        parts.push({
          type: "tool-result",
          toolUseId: c.tool_use_id,
          toolState: c.is_error ? "failure" : "success",
          toolOutput: c.is_error ? undefined : txt,
          toolError: c.is_error ? txt : undefined,
        });
        break;
      }
    }
  }
  return parts;
}

/**
 * Derive `toolDiff` metadata from a raw `tool_use.input` payload so the
 * `EditToolPart` renderer can show the file path and diff/line-count.
 *
 * The Claude native bridge attaches this metadata server-side. In tmux mode
 * there is no bridge, so we recreate it from the same input shapes the
 * Claude Code CLI uses (Edit/Write/MultiEdit/NotebookEdit).
 */
function buildToolDiff(
  toolName: string | undefined,
  input: Record<string, unknown>,
): ToolDiffMetadata | undefined {
  if (!toolName) return undefined;
  const name = toolName.toLowerCase();

  const filePath =
    (typeof input.file_path === "string" && input.file_path) ||
    (typeof input.notebook_path === "string" && input.notebook_path) ||
    (typeof input.path === "string" && input.path) ||
    undefined;

  switch (name) {
    case "edit":
    case "file_edit":
    case "str_replace_editor":
    case "replace": {
      const before =
        typeof input.old_string === "string" ? input.old_string : undefined;
      const after =
        typeof input.new_string === "string" ? input.new_string : undefined;
      return { filePath, before, after };
    }
    case "write":
    case "create_file": {
      const after = typeof input.content === "string" ? input.content : undefined;
      return { filePath, before: "", after };
    }
    case "multiedit": {
      // MultiEdit applies a sequence of (old → new) replacements. We can't
      // reconstruct an accurate before/after without the original file, so
      // we surface the file path plus a synthetic running diff built from
      // each edit's strings — enough for line counts to make sense.
      const edits = Array.isArray(input.edits) ? input.edits : [];
      const beforeChunks: string[] = [];
      const afterChunks: string[] = [];
      for (const edit of edits) {
        if (!edit || typeof edit !== "object") continue;
        const e = edit as Record<string, unknown>;
        if (typeof e.old_string === "string") beforeChunks.push(e.old_string);
        if (typeof e.new_string === "string") afterChunks.push(e.new_string);
      }
      return {
        filePath,
        before: beforeChunks.join("\n"),
        after: afterChunks.join("\n"),
      };
    }
    case "notebookedit": {
      const after =
        typeof input.new_source === "string" ? input.new_source : undefined;
      return { filePath, after };
    }
    default:
      return filePath ? { filePath } : undefined;
  }
}

function toolResultText(
  raw: string | Array<{ type: string; text?: string }> | undefined,
): string {
  if (!raw) return "";
  if (typeof raw === "string") return raw;
  return raw
    .map((c) => ("text" in c && c.text) || "")
    .filter((t) => t.length > 0)
    .join("\n");
}

function textOfParts(parts: ClaudeMessagePart[]): string {
  return parts
    .filter((p) => p.type === "text")
    .map((p) => p.content ?? "")
    .join("\n");
}

/**
 * Given a series of tool_result parts (typically from a single user line),
 * find each matching tool_use in the most-recent assistant message and:
 *   - flip its toolState from "pending" → "success" / "failure"
 *   - attach the tool output/error
 *   - append a sibling tool-result part right after the tool-invocation
 *
 * Returns `null` if no matching prior assistant message exists, so the caller
 * can fall back to creating a standalone message instead.
 */
function mergeToolResultsIntoPrior(
  messages: ClaudeMessage[],
  resultParts: ClaudeMessagePart[],
): ClaudeMessage[] | null {
  // Walk backwards from the end looking for the assistant message whose
  // tool_use ids match.
  const resultIds = new Set(
    resultParts
      .map((p) => p.toolUseId)
      .filter((x): x is string => typeof x === "string"),
  );
  if (resultIds.size === 0) return null;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== "assistant") continue;
    const hasMatch = msg.parts.some(
      (p) => p.type === "tool-invocation" && p.toolUseId && resultIds.has(p.toolUseId),
    );
    if (!hasMatch) continue;

    const updatedParts: ClaudeMessagePart[] = [];
    for (const p of msg.parts) {
      updatedParts.push(p);
      if (p.type === "tool-invocation" && p.toolUseId && resultIds.has(p.toolUseId)) {
        const match = resultParts.find((r) => r.toolUseId === p.toolUseId);
        if (match) {
          // Flip the invocation's state to mirror the result.
          updatedParts[updatedParts.length - 1] = {
            ...p,
            toolState: match.toolState,
            toolOutput: match.toolOutput ?? p.toolOutput,
            toolError: match.toolError ?? p.toolError,
          };
          // Drop already-existing duplicate result for this tool, then add the new one.
          // Done below by filtering during dedup.
          updatedParts.push(match);
        }
      }
    }

    // Dedup any tool-result parts that share toolUseId (keep the newest).
    const seen = new Set<string>();
    const deduped: ClaudeMessagePart[] = [];
    for (let j = updatedParts.length - 1; j >= 0; j--) {
      const p = updatedParts[j]!;
      if (p.type === "tool-result" && p.toolUseId) {
        if (seen.has(p.toolUseId)) continue;
        seen.add(p.toolUseId);
      }
      deduped.unshift(p);
    }

    const newMessages = [...messages];
    newMessages[i] = { ...msg, parts: deduped };
    return newMessages;
  }
  return null;
}

function mergeMessage(prev: ClaudeMessage, next: ClaudeMessage): ClaudeMessage {
  // Prefer next.parts when non-empty; preserve prev timestamp if next lacks one.
  const parts = next.parts.length > 0 ? next.parts : prev.parts;
  return {
    ...prev,
    role: next.role || prev.role,
    content: textOfParts(parts),
    parts,
    timestamp: next.timestamp || prev.timestamp,
  };
}

/**
 * Deterministic hash so that a transcript line missing both `uuid` and
 * `timestamp` still gets a stable id — the poll loop re-reads the whole
 * transcript every tick, so without stable ids the same line would be added
 * over and over.
 */
function stableHash(line: TranscriptLine): string {
  const json = JSON.stringify(line);
  let h = 5381;
  for (let i = 0; i < json.length; i++) {
    h = ((h << 5) + h + json.charCodeAt(i)) | 0;
  }
  return `h${(h >>> 0).toString(36)}`;
}

/** Build a `TmuxPendingApproval` from a hook payload. */
export function payloadToApproval(
  eventId: string,
  payload: unknown,
): TmuxPendingApproval {
  const p = (payload ?? {}) as Record<string, unknown>;
  const toolName =
    (typeof p.tool_name === "string" && p.tool_name) ||
    (typeof p.toolName === "string" && p.toolName) ||
    "tool";
  const toolInput =
    (p.tool_input as Record<string, unknown> | undefined) ??
    (p.toolInput as Record<string, unknown> | undefined) ??
    {};
  return {
    eventId,
    toolName,
    toolInput,
    payload,
    receivedAt: new Date().toISOString(),
  };
}

/** Build a `TmuxInfoEvent` from a non-blocking hook payload. */
export function payloadToInfoEvent(
  eventId: string,
  kind: HookEventKind,
  payload: unknown,
): TmuxInfoEvent {
  const p = (payload ?? {}) as Record<string, unknown>;
  const message =
    (typeof p.message === "string" && p.message) ||
    (typeof p.notification === "string" && p.notification) ||
    kind;
  return {
    id: eventId,
    kind,
    message,
    receivedAt: new Date().toISOString(),
  };
}

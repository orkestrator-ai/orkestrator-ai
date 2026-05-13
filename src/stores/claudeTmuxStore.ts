// State for the Claude tmux mode tab.
// Keyed by environmentId because each environment has at most one tmux session.

import { create } from "zustand";
import type {
  HookEventKind,
  TranscriptLine,
} from "@/lib/claude-tmux-client";

/** A single displayable message, derived from one or more JSONL lines. */
export interface TmuxMessage {
  /** Stable id (Claude's `uuid` for the line). */
  id: string;
  role: "user" | "assistant" | "system";
  /** Plain-text view. */
  text: string;
  /** Tool invocations made in this assistant turn (assistant only). */
  toolUses: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
  }>;
  /** Tool results captured for the previous tool_use ids (user-role lines). */
  toolResults: Array<{
    toolUseId: string;
    content: string;
    isError: boolean;
  }>;
  thinking: string;
  timestamp: string;
}

/** A blocking PreToolUse hook event awaiting the user's decision. */
export interface TmuxPendingApproval {
  eventId: string;
  /** Tool name from the hook payload (best-effort). */
  toolName: string;
  /** Tool input arguments. */
  toolInput: Record<string, unknown>;
  /** Original raw payload, in case we want to show more. */
  payload: unknown;
  receivedAt: string;
}

/** An informational hook event (Notification / Stop / etc.) shown as a toast. */
export interface TmuxInfoEvent {
  id: string;
  kind: HookEventKind;
  message: string;
  receivedAt: string;
}

interface TmuxEnvState {
  sessionId: string | null;
  running: boolean;
  messages: TmuxMessage[];
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
      patchEnv(state, envId, (s) => {
        const message = transcriptLineToMessage(line);
        if (!message) return s;

        // De-duplicate by id (Claude may rewrite a line with a tool_result).
        const existingIdx = s.messages.findIndex((m) => m.id === message.id);
        const messages = [...s.messages];
        if (existingIdx >= 0) {
          messages[existingIdx] = mergeMessages(messages[existingIdx]!, message);
        } else {
          messages.push(message);
        }
        return { ...s, messages };
      }),
    ),

  addPendingApproval: (envId, approval) =>
    set((state) =>
      patchEnv(state, envId, (s) => ({
        ...s,
        pendingApprovals: [...s.pendingApprovals, approval],
      })),
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

function transcriptLineToMessage(line: TranscriptLine): TmuxMessage | null {
  const type = line.type;
  if (type !== "user" && type !== "assistant" && type !== "system") return null;

  const id =
    typeof line.uuid === "string" && line.uuid
      ? line.uuid
      : typeof line.timestamp === "string"
        ? line.timestamp
        : `${Date.now()}-${Math.random()}`;

  const role = (line.message?.role ?? type) as TmuxMessage["role"];
  const content =
    (line.message?.content as TranscriptLine["content"]) ?? line.content;

  const toolUses: TmuxMessage["toolUses"] = [];
  const toolResults: TmuxMessage["toolResults"] = [];
  let text = "";
  let thinking = "";

  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      switch (part.type) {
        case "text":
          text += (text ? "\n" : "") + (part.text ?? "");
          break;
        case "thinking":
          thinking +=
            (thinking ? "\n" : "") + (("thinking" in part && part.thinking) || "");
          break;
        case "tool_use":
          toolUses.push({
            id: part.id,
            name: part.name,
            input: part.input ?? {},
          });
          break;
        case "tool_result": {
          const resultContent = part.content;
          let textContent = "";
          if (typeof resultContent === "string") {
            textContent = resultContent;
          } else if (Array.isArray(resultContent)) {
            textContent = resultContent
              .map((c) => ("text" in c && c.text) || "")
              .join("\n");
          }
          toolResults.push({
            toolUseId: part.tool_use_id,
            content: textContent,
            isError: part.is_error === true,
          });
          break;
        }
      }
    }
  }

  return {
    id,
    role,
    text,
    toolUses,
    toolResults,
    thinking,
    timestamp:
      typeof line.timestamp === "string" ? line.timestamp : new Date().toISOString(),
  };
}

function mergeMessages(prev: TmuxMessage, next: TmuxMessage): TmuxMessage {
  return {
    ...prev,
    text: next.text || prev.text,
    thinking: next.thinking || prev.thinking,
    toolUses: next.toolUses.length ? next.toolUses : prev.toolUses,
    toolResults: next.toolResults.length
      ? mergeToolResults(prev.toolResults, next.toolResults)
      : prev.toolResults,
    timestamp: next.timestamp || prev.timestamp,
  };
}

function mergeToolResults(
  prev: TmuxMessage["toolResults"],
  next: TmuxMessage["toolResults"],
): TmuxMessage["toolResults"] {
  const byId = new Map(prev.map((r) => [r.toolUseId, r] as const));
  for (const r of next) byId.set(r.toolUseId, r);
  return Array.from(byId.values());
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

// Claude tmux mode client: thin wrapper around Tauri invoke + event listeners.
// All data flow is Rust → Tauri events → store. Commands go store → Tauri invoke.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Channel emitted by the Rust `claude_tmux` module. */
export const CLAUDE_TMUX_EVENT = "claude-tmux:event";

/** Envelope discriminated by `kind`. Matches `claude_tmux::session::TmuxEvent`. */
export type TmuxEvent =
  | {
      kind: "started";
      environment_id: string;
      session_id: string;
    }
  | {
      kind: "transcript-line";
      environment_id: string;
      session_id: string;
      line: TranscriptLine;
    }
  | {
      kind: "hook";
      environment_id: string;
      session_id: string;
      event_id: string;
      event_kind: HookEventKind;
      payload: unknown;
    }
  | {
      kind: "stopped";
      environment_id: string;
    }
  | {
      kind: "warning";
      environment_id: string;
      message: string;
    };

export type HookEventKind =
  | "PreToolUse"
  | "PostToolUse"
  | "UserPromptSubmit"
  | "Stop"
  | "Notification"
  | "SessionStart";

/**
 * Subset of fields we care about from the Claude Code JSONL transcript.
 * The format is not under our control, so we keep the original line on the
 * `_raw` field as an escape hatch.
 */
export interface TranscriptLine {
  type?: "user" | "assistant" | "system" | string;
  subtype?: string;
  sessionId?: string;
  uuid?: string;
  timestamp?: string;
  message?: {
    role?: "user" | "assistant" | "system";
    content?: Array<TranscriptContent> | string;
  };
  // Some entries (e.g. tool_result) are top-level rather than inside `message`.
  content?: Array<TranscriptContent> | string;
  [key: string]: unknown;
}

export type TranscriptContent =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input?: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      tool_use_id: string;
      content?: string | Array<{ type: string; text?: string }>;
      is_error?: boolean;
    };

export interface TmuxStatus {
  environment_id: string;
  session_id: string | null;
  tmux_session: string;
  running: boolean;
  transcript_path: string | null;
}

// ── Commands ─────────────────────────────────────────────────────────────────

export async function startSession(
  environmentId: string,
  options?: { initialPrompt?: string; model?: string },
): Promise<TmuxStatus> {
  return invoke<TmuxStatus>("claude_tmux_start", {
    environmentId,
    initialPrompt: options?.initialPrompt,
    model: options?.model,
  });
}

export async function stopSession(environmentId: string): Promise<void> {
  await invoke("claude_tmux_stop", { environmentId });
}

export async function getStatus(environmentId: string): Promise<TmuxStatus | null> {
  return invoke<TmuxStatus | null>("claude_tmux_status", { environmentId });
}

export async function submit(environmentId: string, text: string): Promise<void> {
  await invoke("claude_tmux_submit", { environmentId, text });
}

export async function sendText(environmentId: string, text: string): Promise<void> {
  await invoke("claude_tmux_send_text", { environmentId, text });
}

export async function sendKeys(environmentId: string, keys: string[]): Promise<void> {
  await invoke("claude_tmux_send_keys", { environmentId, keys });
}

export async function capturePane(environmentId: string): Promise<string> {
  return invoke<string>("claude_tmux_capture_pane", { environmentId });
}

export async function resize(
  environmentId: string,
  cols: number,
  rows: number,
): Promise<void> {
  await invoke("claude_tmux_resize", { environmentId, cols, rows });
}

/**
 * Resolve a PreToolUse hook decision.
 * - "approve": tool is allowed (Claude skips its own permission prompt)
 * - "block":   tool is denied with `reason` shown to Claude
 */
export async function answerPreToolUse(
  environmentId: string,
  eventId: string,
  decision: "approve" | "block",
  reason?: string,
): Promise<void> {
  await invoke("claude_tmux_answer_pre_tool_use", {
    environmentId,
    eventId,
    decision,
    reason,
  });
}

/** Raw escape hatch for replying to any hook with arbitrary JSON. */
export async function replyHook(
  environmentId: string,
  eventKind: HookEventKind,
  eventId: string,
  response: unknown,
): Promise<void> {
  await invoke("claude_tmux_reply_hook", {
    environmentId,
    eventKind,
    eventId,
    response,
  });
}

// ── Event subscription ───────────────────────────────────────────────────────

/**
 * Subscribe to all tmux events. Filter by `environment_id` in the handler.
 * Returns an unlisten function — call it on unmount.
 */
export async function subscribe(
  onEvent: (event: TmuxEvent) => void,
): Promise<UnlistenFn> {
  return listen<TmuxEvent>(CLAUDE_TMUX_EVENT, (event) => {
    onEvent(event.payload);
  });
}

// Claude tmux mode chat tab.
//
// Drives the `claude` CLI under tmux on the host or in a container, and
// surfaces a native-style chat UI populated by the JSONL transcript and
// Claude Code hooks. No Agent SDK required.

import { useEffect, useRef, useState } from "react";
import {
  answerPreToolUse,
  startSession,
  stopSession,
  submit as submitToTmux,
  subscribe,
  type TmuxEvent,
} from "@/lib/claude-tmux-client";
import {
  payloadToApproval,
  payloadToInfoEvent,
  useClaudeTmuxStore,
  type TmuxMessage,
} from "@/stores/claudeTmuxStore";
import type { ClaudeTmuxData } from "@/types/paneLayout";

interface Props {
  tabId: string;
  data: ClaudeTmuxData;
  isActive: boolean;
  initialPrompt?: string;
}

export function ClaudeTmuxChatTab({ data, isActive, initialPrompt }: Props) {
  const { environmentId } = data;

  const envState = useClaudeTmuxStore((s) => s.envs.get(environmentId));
  const setRunning = useClaudeTmuxStore((s) => s.setRunning);
  const applyTranscriptLine = useClaudeTmuxStore((s) => s.applyTranscriptLine);
  const addPendingApproval = useClaudeTmuxStore((s) => s.addPendingApproval);
  const removePendingApproval = useClaudeTmuxStore((s) => s.removePendingApproval);
  const pushInfoEvent = useClaudeTmuxStore((s) => s.pushInfoEvent);
  const dismissInfoEvent = useClaudeTmuxStore((s) => s.dismissInfoEvent);

  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 1. Subscribe to backend events (singleton — one listener for all envs).
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    subscribe((ev: TmuxEvent) => {
      if (ev.kind === "started") {
        if (ev.environment_id === environmentId) {
          setRunning(ev.environment_id, true, ev.session_id);
        }
        return;
      }
      if (ev.kind === "stopped") {
        if (ev.environment_id === environmentId) {
          setRunning(ev.environment_id, false, null);
        }
        return;
      }
      if (ev.environment_id !== environmentId) return;

      switch (ev.kind) {
        case "transcript-line":
          applyTranscriptLine(environmentId, ev.line);
          break;
        case "hook": {
          if (ev.event_kind === "PreToolUse") {
            addPendingApproval(
              environmentId,
              payloadToApproval(ev.event_id, ev.payload),
            );
          } else {
            pushInfoEvent(
              environmentId,
              payloadToInfoEvent(ev.event_id, ev.event_kind, ev.payload),
            );
          }
          break;
        }
        case "warning":
          setError(ev.message);
          break;
      }
    })
      .then((u) => {
        if (cancelled) {
          u();
          return;
        }
        unlisten = u;
      })
      .catch((e) => setError(String(e)));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [
    environmentId,
    setRunning,
    applyTranscriptLine,
    addPendingApproval,
    pushInfoEvent,
  ]);

  // 2. Start the tmux session on mount.
  useEffect(() => {
    let cancelled = false;
    startSession(environmentId, { initialPrompt }).catch((e) => {
      if (!cancelled) setError(String(e));
    });
    return () => {
      cancelled = true;
    };
    // We intentionally only start once per tab mount; restarting on prop
    // change would loop. `initialPrompt` is read on first mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [environmentId]);

  // 3. Auto-scroll to bottom on new messages.
  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [envState?.messages.length, envState?.pendingApprovals.length]);

  const handleSubmit = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      await submitToTmux(environmentId, text);
      setDraft("");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleApproval = async (
    eventId: string,
    decision: "approve" | "block",
  ) => {
    try {
      await answerPreToolUse(environmentId, eventId, decision);
    } catch (e) {
      setError(String(e));
    } finally {
      removePendingApproval(environmentId, eventId);
    }
  };

  const messages = envState?.messages ?? [];
  const pendingApprovals = envState?.pendingApprovals ?? [];
  const infoEvents = envState?.infoEvents ?? [];
  const running = envState?.running ?? false;

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-800 text-xs">
        <div className="flex items-center gap-2 text-muted-foreground">
          <span
            className={`inline-block h-2 w-2 rounded-full ${running ? "bg-emerald-500" : "bg-zinc-500"}`}
          />
          <span>Claude (tmux)</span>
          {envState?.sessionId && (
            <span className="font-mono opacity-60">{envState.sessionId.slice(0, 8)}</span>
          )}
        </div>
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground"
          onClick={() => stopSession(environmentId)}
          disabled={!running}
        >
          Stop
        </button>
      </div>

      {error && (
        <div className="px-4 py-2 text-xs text-red-400 bg-red-950/30 border-b border-red-900/40">
          {error}
        </div>
      )}

      {/* Info events (small, dismissible) */}
      {infoEvents.length > 0 && (
        <div className="px-4 py-1 border-b border-zinc-800/60 space-y-1">
          {infoEvents.slice(-3).map((ev) => (
            <div
              key={ev.id}
              className="flex items-center justify-between text-[11px] text-muted-foreground"
            >
              <span className="truncate">
                <span className="opacity-60">[{ev.kind}]</span> {ev.message}
              </span>
              <button
                type="button"
                onClick={() => dismissInfoEvent(environmentId, ev.id)}
                className="ml-2 opacity-50 hover:opacity-100"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {messages.length === 0 && !pendingApprovals.length && (
          <div className="text-xs text-muted-foreground italic">
            Waiting for claude to start…
          </div>
        )}
        {messages.map((m) => (
          <MessageRow key={m.id} m={m} />
        ))}

        {pendingApprovals.map((a) => (
          <ApprovalCard
            key={a.eventId}
            approval={a}
            onApprove={() => handleApproval(a.eventId, "approve")}
            onDeny={() => handleApproval(a.eventId, "block")}
          />
        ))}
      </div>

      {/* Compose bar */}
      <div className="border-t border-zinc-800 p-3">
        <div className="flex gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                handleSubmit();
              }
            }}
            placeholder={
              running
                ? "Type a message — ⌘↵ to send"
                : "Session not running"
            }
            disabled={!running || busy}
            rows={2}
            autoFocus={isActive}
            className="flex-1 resize-none bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm focus:outline-none focus:border-zinc-600 disabled:opacity-50"
          />
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!running || busy || !draft.trim()}
            className="px-4 py-2 rounded bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

function MessageRow({ m }: { m: TmuxMessage }) {
  const isUser = m.role === "user";
  const isAssistant = m.role === "assistant";

  return (
    <div className={`rounded-lg border px-3 py-2 ${
      isUser
        ? "border-blue-900/40 bg-blue-950/20"
        : isAssistant
          ? "border-zinc-800 bg-zinc-900/40"
          : "border-zinc-800/60 bg-zinc-900/20"
    }`}>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
        {m.role}
      </div>
      {m.thinking && (
        <div className="mb-2 text-xs text-muted-foreground italic whitespace-pre-wrap">
          {m.thinking}
        </div>
      )}
      {m.text && (
        <div className="text-sm whitespace-pre-wrap leading-snug">{m.text}</div>
      )}
      {m.toolUses.length > 0 && (
        <div className="mt-2 space-y-1">
          {m.toolUses.map((tu) => (
            <div
              key={tu.id}
              className="text-xs font-mono bg-zinc-950 border border-zinc-800 rounded px-2 py-1"
            >
              <div className="text-amber-400">⚒ {tu.name}</div>
              <pre className="text-muted-foreground mt-1 whitespace-pre-wrap break-all">
                {JSON.stringify(tu.input, null, 2)}
              </pre>
            </div>
          ))}
        </div>
      )}
      {m.toolResults.length > 0 && (
        <div className="mt-2 space-y-1">
          {m.toolResults.map((tr) => (
            <div
              key={tr.toolUseId}
              className={`text-xs font-mono border rounded px-2 py-1 ${
                tr.isError
                  ? "border-red-900/40 bg-red-950/30 text-red-300"
                  : "border-zinc-800 bg-zinc-950 text-muted-foreground"
              }`}
            >
              <pre className="whitespace-pre-wrap break-all">{tr.content}</pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ApprovalCard({
  approval,
  onApprove,
  onDeny,
}: {
  approval: {
    eventId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
  };
  onApprove: () => void;
  onDeny: () => void;
}) {
  return (
    <div className="rounded-lg border-2 border-amber-700/60 bg-amber-950/20 px-3 py-3">
      <div className="text-xs uppercase tracking-wide text-amber-400 mb-2">
        Claude wants to use a tool
      </div>
      <div className="text-sm font-mono text-amber-200 mb-2">
        {approval.toolName}
      </div>
      <pre className="text-xs bg-zinc-950 border border-zinc-800 rounded px-2 py-1 mb-3 whitespace-pre-wrap break-all">
        {JSON.stringify(approval.toolInput, null, 2)}
      </pre>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onApprove}
          className="flex-1 px-3 py-1.5 rounded bg-emerald-700 hover:bg-emerald-600 text-white text-sm font-medium"
        >
          Allow
        </button>
        <button
          type="button"
          onClick={onDeny}
          className="flex-1 px-3 py-1.5 rounded bg-red-800 hover:bg-red-700 text-white text-sm font-medium"
        >
          Deny
        </button>
      </div>
    </div>
  );
}

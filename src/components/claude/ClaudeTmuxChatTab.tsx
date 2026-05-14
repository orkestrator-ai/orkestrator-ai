// Claude tmux mode chat tab.
//
// Drives the `claude` CLI under tmux on the host or in a container, and
// surfaces a chat UI by reading the JSONL transcript and listening to
// Claude Code hooks. No Agent SDK required.
//
// Visual parity with the native Claude tab is achieved by reusing the
// `<ClaudeMessage>` renderer; we only build a slim compose bar of our own
// that matches the native styling and adds model / plan-mode controls.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  Check,
  ChevronDown,
  Plus,
  Square,
  Terminal as TerminalIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ClaudeMessage } from "@/components/claude/ClaudeMessage";
import {
  answerPreToolUse,
  capturePane,
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
} from "@/stores/claudeTmuxStore";
import type { ClaudeTmuxData } from "@/types/paneLayout";

interface Props {
  tabId: string;
  data: ClaudeTmuxData;
  isActive: boolean;
  initialPrompt?: string;
}

/**
 * Hardcoded model list for tmux mode. There's no SDK to enumerate available
 * models, so we ship a small, stable set. Users can also type `/model …` in
 * the Claude TUI to override at runtime.
 */
const TMUX_MODELS: Array<{ id: string; name: string; description?: string }> = [
  {
    id: "claude-opus-4-7",
    name: "Opus 4.7",
    description: "Most capable; slowest",
  },
  {
    id: "claude-sonnet-4-6",
    name: "Sonnet 4.6",
    description: "Balanced speed and capability (default)",
  },
  {
    id: "claude-haiku-4-5",
    name: "Haiku 4.5",
    description: "Fastest; lightweight tasks",
  },
];
const DEFAULT_MODEL = "claude-sonnet-4-6";

export function ClaudeTmuxChatTab({ data, isActive, initialPrompt }: Props) {
  const { environmentId, containerId } = data;

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
  const [showTui, setShowTui] = useState(false);
  const [tuiSnapshot, setTuiSnapshot] = useState<string>("");
  const [selectedModel, setSelectedModel] = useState<string>(DEFAULT_MODEL);
  const [planMode, setPlanMode] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const startedRef = useRef(false);

  // 1. Subscribe to backend events (one listener for the whole tab).
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
        case "hook":
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
        case "hook-timed-out":
          if (ev.event_kind === "PreToolUse") {
            removePendingApproval(environmentId, ev.event_id);
          }
          break;
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
    removePendingApproval,
    pushInfoEvent,
  ]);

  // 2. Start the tmux session once per tab mount.
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    let cancelled = false;
    startSession(environmentId, {
      initialPrompt,
      model: selectedModel,
      planMode,
    }).catch((e) => {
      if (!cancelled) setError(String(e));
    });
    return () => {
      cancelled = true;
    };
    // We intentionally only start once per tab mount; re-runs would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [environmentId]);

  // 3. Auto-scroll to bottom on new content.
  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [
    envState?.messages.length,
    envState?.pendingApprovals.length,
    envState?.infoEvents.length,
  ]);

  // 4. Raw TUI snapshot polling (debug view).
  useEffect(() => {
    if (!showTui) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const snap = await capturePane(environmentId);
        if (!cancelled) setTuiSnapshot(snap);
      } catch (e) {
        if (!cancelled) setTuiSnapshot(`(capture failed: ${String(e)})`);
      }
    };
    void tick();
    const id = setInterval(tick, 500);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [showTui, environmentId]);

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
    <div className="@container flex flex-col h-full bg-background overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border text-xs shrink-0">
        <div className="flex items-center gap-2 text-muted-foreground">
          <span
            className={cn(
              "inline-block h-2 w-2 rounded-full",
              running ? "bg-emerald-500" : "bg-zinc-500",
            )}
          />
          <span>Claude (tmux)</span>
          {envState?.sessionId && (
            <span className="font-mono opacity-60">
              {envState.sessionId.slice(0, 8)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className={cn(
              "px-1.5 py-0.5 rounded hover:bg-muted/50 transition-colors flex items-center gap-1",
              showTui
                ? "text-foreground bg-muted/40"
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setShowTui((v) => !v)}
            title="Toggle a live view of the underlying tmux pane (debug)"
          >
            <TerminalIcon className="w-3 h-3" />
            {showTui ? "Hide TUI" : "Show TUI"}
          </button>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => stopSession(environmentId)}
            disabled={!running}
          >
            Stop
          </button>
        </div>
      </div>

      {/* Inline error / info bar */}
      {error && (
        <div className="px-3 py-1.5 text-xs text-red-400 bg-red-950/30 border-b border-red-900/40 shrink-0">
          {error}
        </div>
      )}
      {infoEvents.length > 0 && (
        <div className="px-3 py-1 border-b border-border/60 space-y-0.5 shrink-0">
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

      {/* Raw TUI panel (debug) */}
      {showTui && (
        <div className="border-b border-border bg-black p-2 shrink-0">
          <div className="text-[10px] uppercase tracking-wide text-amber-400 mb-1">
            Raw tmux pane (refreshing)
          </div>
          <pre className="text-[11px] font-mono whitespace-pre-wrap max-h-72 overflow-auto text-zinc-200">
            {tuiSnapshot || "(empty)"}
          </pre>
        </div>
      )}

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto min-w-0 px-2 @sm:px-4 py-3">
          {messages.length === 0 && pendingApprovals.length === 0 && (
            <div className="text-xs text-muted-foreground italic py-8 text-center">
              {running
                ? "Waiting for Claude…"
                : "Starting Claude under tmux…"}
            </div>
          )}

          {messages.map((m, idx) => (
            <ClaudeMessage
              key={m.id}
              message={m}
              previousMessage={messages[idx - 1] ?? null}
              isStreaming={running}
              containerId={containerId}
            />
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
      </div>

      {/* Compose bar */}
      <TmuxComposeBar
        value={draft}
        setValue={setDraft}
        disabled={!running}
        busy={busy}
        autoFocus={isActive}
        onSubmit={handleSubmit}
        selectedModel={selectedModel}
        onSelectModel={setSelectedModel}
        planMode={planMode}
        onTogglePlanMode={setPlanMode}
      />
    </div>
  );
}

// ─── Compose bar ─────────────────────────────────────────────────────────────

interface TmuxComposeBarProps {
  value: string;
  setValue: (v: string) => void;
  disabled: boolean;
  busy: boolean;
  autoFocus?: boolean;
  onSubmit: () => void;
  selectedModel: string;
  onSelectModel: (id: string) => void;
  planMode: boolean;
  onTogglePlanMode: (v: boolean) => void;
}

function TmuxComposeBar({
  value,
  setValue,
  disabled,
  busy,
  autoFocus,
  onSubmit,
  selectedModel,
  onSelectModel,
  planMode,
  onTogglePlanMode,
}: TmuxComposeBarProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelObj = useMemo(
    () => TMUX_MODELS.find((m) => m.id === selectedModel) ?? TMUX_MODELS[1]!,
    [selectedModel],
  );

  // Auto-grow textarea, bounded.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 12 * 20 + 16)}px`;
  }, [value]);

  return (
    <div className="shrink-0 border-t border-border bg-background p-3">
      <div className="relative">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            // Enter submits; Shift+Enter (and Cmd/Ctrl+Enter, for muscle
            // memory) inserts a newline.
            if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
              e.preventDefault();
              onSubmit();
            }
          }}
          placeholder={
            disabled
              ? "Session not running"
              : "Ask Claude anything… (Shift+Enter for newline)"
          }
          disabled={disabled || busy}
          rows={2}
          autoFocus={autoFocus}
          className={cn(
            "w-full resize-none bg-transparent text-sm leading-5",
            "px-1 py-1 focus:outline-none placeholder:text-muted-foreground/60",
            "disabled:opacity-60",
          )}
          style={{ minHeight: 28, maxHeight: 12 * 20 + 16 }}
        />
      </div>

      <div className="flex items-center gap-1 pt-1">
        {/* Attach (placeholder for parity — no-op for v1) */}
        <button
          type="button"
          disabled
          className="p-1.5 rounded text-muted-foreground/40 cursor-not-allowed"
          title="Attachments not yet supported in tmux mode"
        >
          <Plus className="w-4 h-4" />
        </button>

        {/* Model picker */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              disabled={disabled}
              className="flex items-center gap-1 px-2 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
            >
              <ChevronDown className="w-3 h-3" />
              <span className="max-w-[200px] truncate">{modelObj.name}</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[240px]">
            {TMUX_MODELS.map((m) => {
              const selected = m.id === selectedModel;
              return (
                <DropdownMenuItem
                  key={m.id}
                  onClick={() => onSelectModel(m.id)}
                  className="flex items-start gap-2 py-2"
                >
                  <div className="w-4 h-4 flex-shrink-0 mt-0.5">
                    {selected && <Check className="w-4 h-4 text-primary" />}
                  </div>
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <span className="text-sm font-medium truncate">
                      {m.name}
                    </span>
                    {m.description && (
                      <span className="text-xs text-muted-foreground line-clamp-2">
                        {m.description}
                      </span>
                    )}
                  </div>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Plan / Build mode */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              disabled={disabled}
              className="flex items-center gap-1 px-2 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
              title="Plan mode requires session restart to take effect"
            >
              <ChevronDown className="w-3 h-3" />
              <span>{planMode ? "Plan" : "Build"}</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={() => onTogglePlanMode(false)}>
              <div className="w-4 h-4 shrink-0 mr-2">
                {!planMode && <Check className="w-4 h-4 text-primary" />}
              </div>
              Build
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onTogglePlanMode(true)}>
              <div className="w-4 h-4 shrink-0 mr-2">
                {planMode && <Check className="w-4 h-4 text-primary" />}
              </div>
              Plan
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="flex-1" />

        {/* Send / Stop button */}
        <Button
          size="sm"
          onClick={onSubmit}
          disabled={disabled || busy || !value.trim()}
          className="h-7 w-7 p-0 rounded-full"
          title="Send (↵)"
        >
          {busy ? (
            <Square className="w-3.5 h-3.5" />
          ) : (
            <ArrowUp className="w-4 h-4" />
          )}
        </Button>
      </div>
    </div>
  );
}

// ─── Approval card (only fires when claude permission flow somehow surfaces) ─

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
    <div className="rounded-lg border-2 border-amber-700/60 bg-amber-950/20 px-3 py-3 mb-3">
      <div className="text-xs uppercase tracking-wide text-amber-400 mb-2">
        Claude wants to use a tool
      </div>
      <div className="text-sm font-mono text-amber-200 mb-2">
        {approval.toolName}
      </div>
      <ApprovalToolInput
        toolName={approval.toolName}
        toolInput={approval.toolInput}
      />
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

/**
 * Renders tool input as labeled fields rather than raw JSON. We special-case
 * the common Claude tools (Bash, Edit, Write, Read) since their args have
 * conventional shapes; unknown tools fall back to a key/value table.
 */
function ApprovalToolInput({
  toolName,
  toolInput,
}: {
  toolName: string;
  toolInput: Record<string, unknown>;
}) {
  const command =
    typeof toolInput.command === "string" ? toolInput.command : null;
  const description =
    typeof toolInput.description === "string" ? toolInput.description : null;
  const filePath =
    typeof toolInput.file_path === "string" ? toolInput.file_path : null;

  // Bash → command + optional description.
  if (toolName === "Bash" && command) {
    return (
      <div className="mb-3 space-y-2">
        {description && (
          <div className="text-xs text-amber-100/80">{description}</div>
        )}
        <pre className="text-xs bg-zinc-950 border border-zinc-800 rounded px-2 py-1 whitespace-pre-wrap break-all font-mono">
          $ {command}
        </pre>
      </div>
    );
  }

  // File-oriented tools → show path + a short content preview if present.
  if (filePath) {
    const preview =
      (typeof toolInput.new_string === "string" && toolInput.new_string) ||
      (typeof toolInput.content === "string" && toolInput.content) ||
      null;
    return (
      <div className="mb-3 space-y-2">
        <div className="text-xs font-mono text-amber-100/90 break-all">
          {filePath}
        </div>
        {preview && (
          <pre className="text-xs bg-zinc-950 border border-zinc-800 rounded px-2 py-1 whitespace-pre-wrap break-all font-mono max-h-40 overflow-auto">
            {preview}
          </pre>
        )}
      </div>
    );
  }

  // Fallback: render keys/values without dumping a single blob of JSON.
  const entries = Object.entries(toolInput);
  if (entries.length === 0) {
    return <div className="mb-3 text-xs text-muted-foreground">(no args)</div>;
  }
  return (
    <div className="mb-3 space-y-1">
      {entries.map(([key, value]) => (
        <div key={key} className="text-xs">
          <span className="font-mono text-amber-300/80">{key}:</span>{" "}
          <span className="font-mono text-amber-100/90 break-all whitespace-pre-wrap">
            {typeof value === "string" ? value : JSON.stringify(value)}
          </span>
        </div>
      ))}
    </div>
  );
}

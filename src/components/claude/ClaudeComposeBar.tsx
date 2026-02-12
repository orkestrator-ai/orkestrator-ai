import { useRef, useState, useEffect, useCallback, type KeyboardEvent } from "react";
import { X, Plus, FileText, Image as ImageIcon, ChevronDown, ArrowUp, Brain, MapPlus, Check, Square } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { readImage } from "@tauri-apps/plugin-clipboard-manager";
import { writeContainerFile, writeLocalFile } from "@/lib/tauri";
import { resizeCanvasIfNeeded } from "@/lib/canvas-utils";
import { toast } from "sonner";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useClaudeStore, createClaudeSessionKey, type ClaudeAttachment } from "@/stores/claudeStore";
import type { ClaudeModel } from "@/lib/claude-client";
import { SlashCommandMenu, parseSlashCommands } from "./SlashCommandMenu";
import { FileMentionMenu } from "./FileMentionMenu";
import { MentionableInput, type MentionableInputRef } from "./MentionableInput";
import { useFileSearch } from "@/hooks/useFileSearch";
import { useFileMentions } from "@/hooks/useFileMentions";
import type { FileMention, FileCandidate } from "@/types";

interface ClaudeComposeBarProps {
  environmentId: string;
  /** Tab ID for multi-tab support */
  tabId: string;
  /** Container ID for containerized environments, undefined for local */
  containerId?: string;
  models: ClaudeModel[];
  onSend: (text: string, attachments: ClaudeAttachment[], thinkingEnabled: boolean, planModeEnabled: boolean) => void;
  disabled?: boolean;
  /** Whether Claude is currently processing a query */
  isLoading?: boolean;
  /** Number of messages in the queue */
  queueLength?: number;
  /** Callback when stop button is clicked */
  onStop?: () => void;
  /** Callback when a message should be added to the queue */
  onQueue?: (text: string, attachments: ClaudeAttachment[], thinkingEnabled: boolean, planModeEnabled: boolean) => void;
}

const MAX_LINES = 12;
const LINE_HEIGHT = 20;
const MAX_IMAGE_SIZE = 8 * 1024 * 1024;
const MAX_RGBA_SIZE = 32 * 1024 * 1024;

function generateImageFilename(): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .slice(0, 19);
  const random = Math.random().toString(36).substring(2, 8);
  return `clipboard-${timestamp}-${random}.png`;
}

export function ClaudeComposeBar({
  environmentId,
  tabId,
  containerId,
  models,
  onSend,
  disabled = false,
  isLoading = false,
  queueLength = 0,
  onStop,
  onQueue,
}: ClaudeComposeBarProps) {
  const [isSending, setIsSending] = useState(false);
  const [showAttachmentMenu, setShowAttachmentMenu] = useState(false);
  const inputRef = useRef<MentionableInputRef>(null);
  const attachmentMenuRef = useRef<HTMLDivElement>(null);

  // Create sessionKey for store lookups (format: "env-{environmentId}:{tabId}")
  const sessionKey = createClaudeSessionKey(environmentId, tabId);

  const {
    getAttachments,
    addAttachment,
    removeAttachment,
    clearAttachments,
    getDraftText,
    setDraftText,
    getDraftMentions,
    setDraftMentions,
    getSelectedModel,
    setSelectedModel,
    isThinkingEnabled,
    setThinkingEnabled,
    isPlanMode,
    setPlanMode,
  } = useClaudeStore();

  // Use a selector for sessionInitData to ensure reactivity when SSE session.init event arrives
  const sessionInitData = useClaudeStore(
    (state) => state.sessionInitData.get(environmentId)
  );

  const attachments = getAttachments(sessionKey);
  const text = getDraftText(sessionKey);
  const mentions = getDraftMentions(sessionKey);
  const selectedModel = getSelectedModel(sessionKey);
  const thinkingEnabled = isThinkingEnabled(sessionKey);
  const planModeEnabled = isPlanMode(sessionKey);

  // Get worktree path for local environments
  const worktreePath = useEnvironmentStore(
    (state) => state.getEnvironmentById(environmentId)?.worktreePath
  );

  // File search hook for @ mentions
  const { searchFiles, error: fileSearchError, refresh: refreshFileTree } = useFileSearch(containerId, worktreePath);

  // Show toast if file search fails to load
  useEffect(() => {
    if (fileSearchError) {
      toast.error("Failed to load files for @mentions", {
        description: fileSearchError,
        duration: 4000,
      });
    }
  }, [fileSearchError]);

  // File mentions hook for @ detection and menu management
  const {
    isMenuOpen: fileMentionMenuOpen,
    selectedIndex: fileMentionSelectedIndex,
    filteredFiles,
    handleCursorChange: detectFileMention,
    handleKeyDown: handleFileMentionKeyDown,
    closeMenu: closeFileMentionMenu,
    serializeForLLM,
    createMention,
  } = useFileMentions({ searchFiles });

  // Track previous menu state to detect opening transition
  const prevFileMentionMenuOpen = useRef(false);

  // Refresh file tree only when @ mention menu opens (not on close)
  useEffect(() => {
    const wasOpen = prevFileMentionMenuOpen.current;
    prevFileMentionMenuOpen.current = fileMentionMenuOpen;

    // Only refresh on rising edge: menu was closed and is now opening
    if (!wasOpen && fileMentionMenuOpen) {
      refreshFileTree();
    }
  }, [fileMentionMenuOpen, refreshFileTree]);

  // Slash command menu state
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);
  const [slashFilter, setSlashFilter] = useState("");

  // Default built-in slash commands (always available)
  const defaultSlashCommands = [
    "/clear - Clear conversation history",
    "/compact - Compact conversation to reduce tokens",
    "/context - Show current context",
    "/cost - Show token usage and cost",
    "/doctor - Check system health",
    "/help - Show available commands",
    "/init - Re-initialize the session",
    "/logout - Log out of Claude",
    "/memory - Show memory usage",
    "/model - Show or change model",
    "/permissions - Manage permissions",
    "/review - Review recent changes",
    "/status - Show session status",
    "/vim - Toggle vim mode",
  ];

  // Parse slash commands - use session init data if available, otherwise use defaults
  const slashCommands = parseSlashCommands(
    sessionInitData?.slashCommands?.length ? sessionInitData.slashCommands : defaultSlashCommands
  );

  const setText = useCallback(
    (newText: string) => setDraftText(sessionKey, newText),
    [sessionKey, setDraftText]
  );

  const setMentions = useCallback(
    (newMentions: FileMention[]) => setDraftMentions(sessionKey, newMentions),
    [sessionKey, setDraftMentions]
  );

  // Handle text and mentions change from MentionableInput
  const handleTextAndMentionsChange = useCallback(
    (newText: string, newMentions: FileMention[]) => {
      setText(newText);
      setMentions(newMentions);
    },
    [setText, setMentions]
  );

  // Handle cursor change for @ detection
  const handleCursorPositionChange = useCallback(
    (position: number) => {
      detectFileMention(position, text);
    },
    [detectFileMention, text]
  );

  // Handle file mention selection
  const handleFileMentionSelect = useCallback(
    (file: FileCandidate) => {
      const mention = createMention(file);
      inputRef.current?.insertMention(mention);
      closeFileMentionMenu();
    },
    [createMention, closeFileMentionMenu]
  );

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Detect "/" being typed to show slash command menu
  useEffect(() => {
    if (text.startsWith("/") && slashCommands.length > 0) {
      // Extract the command being typed (everything after /)
      const spaceIndex = text.indexOf(" ");
      const currentCommand = spaceIndex === -1 ? text.slice(1) : "";

      // Only show menu if we haven't completed typing a command yet (no space)
      if (spaceIndex === -1) {
        setSlashFilter(currentCommand);
        setSlashMenuOpen(true);
        setSlashSelectedIndex(0);
      } else {
        setSlashMenuOpen(false);
      }
    } else {
      setSlashMenuOpen(false);
      setSlashFilter("");
    }
  }, [text, slashCommands.length]);

  // Filter slash commands based on current input
  const filteredSlashCommands = slashCommands.filter((cmd) =>
    cmd.name.toLowerCase().includes(slashFilter.toLowerCase())
  );

  // Handle slash command selection
  const handleSlashCommandSelect = useCallback(
    (command: { name: string }) => {
      // Replace the current "/" + filter with the selected command + space
      setText(command.name + " ");
      setSlashMenuOpen(false);
      inputRef.current?.focus();
    },
    [setText]
  );

  // Close attachment menu when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        attachmentMenuRef.current &&
        !attachmentMenuRef.current.contains(event.target as Node)
      ) {
        setShowAttachmentMenu(false);
      }
    }

    if (showAttachmentMenu) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [showAttachmentMenu]);

  // Handle paste for clipboard images
  // Note: For MentionableInput (contenteditable), the activeElement is the div inside the component
  const handlePaste = useCallback(
    async (event: ClipboardEvent) => {
      // Check if focus is within our input area (contenteditable div)
      const activeEl = document.activeElement;
      if (!activeEl || !activeEl.closest("[data-mentionable-input]")) return;

      try {
        const image = await readImage();
        const rgba = await image.rgba();
        const { width, height } = await image.size();

        // Create canvas with original image data
        let canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const imageDataObj = new ImageData(new Uint8ClampedArray(rgba), width, height);
        ctx.putImageData(imageDataObj, 0, 0);

        // Resize if needed to fit within RGBA size limit
        canvas = resizeCanvasIfNeeded(canvas, MAX_RGBA_SIZE);

        const dataUrl = canvas.toDataURL("image/png");
        const base64Data = dataUrl.split(",")[1] || "";

        const estimatedSize = (base64Data.length * 3) / 4;
        if (estimatedSize > MAX_IMAGE_SIZE) {
          console.error("[ClaudeComposeBar] Image too large after encoding");
          toast.error("Image too large", {
            description: `Image is ${(estimatedSize / 1024 / 1024).toFixed(1)}MB. Maximum is 8MB.`,
          });
          return;
        }

        canvas.width = 0;
        canvas.height = 0;

        event.preventDefault();
        event.stopPropagation();

        // Save to container and add as attachment (only for containerized environments)
        const filename = generateImageFilename();
        const filePath = `.orkestrator/clipboard/${filename}`;

        if (containerId) {
          // Containerized environment - write to container
          await writeContainerFile(containerId, filePath, base64Data);

          const attachment: ClaudeAttachment = {
            id: Math.random().toString(36).substring(2, 9),
            type: "image",
            path: `/workspace/${filePath}`,
            previewUrl: dataUrl,
            name: filename,
          };
          addAttachment(sessionKey, attachment);
        } else if (worktreePath) {
          // Local environment - write to worktree path
          const fullPath = await writeLocalFile(worktreePath, filePath, base64Data);

          const attachment: ClaudeAttachment = {
            id: Math.random().toString(36).substring(2, 9),
            type: "image",
            path: fullPath,
            previewUrl: dataUrl,
            name: filename,
          };
          addAttachment(sessionKey, attachment);
        } else {
          toast.error("Cannot save image", {
            description: "Environment not properly configured for attachments",
          });
        }
      } catch (e) {
        // Clipboard read errors are expected when no image is present - ignore silently
        // Check for known clipboard-related error patterns across platforms
        const isExpectedClipboardError = (error: unknown): boolean => {
          if (!(error instanceof Error)) return false;
          const msg = error.message.toLowerCase();
          const name = error.name?.toLowerCase() ?? "";
          // Common clipboard error patterns across platforms/browsers
          return (
            msg.includes("clipboard") ||
            msg.includes("no image") ||
            msg.includes("not found") ||
            msg.includes("empty") ||
            msg.includes("unavailable") ||
            name.includes("clipboard") ||
            name.includes("notfounderror")
          );
        };

        // Log unexpected errors for debugging
        if (!isExpectedClipboardError(e)) {
          console.error("[ClaudeComposeBar] Unexpected paste error:", e);
        }
        // Let text paste through by not preventing default
      }
    },
    [containerId, sessionKey, worktreePath, addAttachment]
  );

  useEffect(() => {
    document.addEventListener("paste", handlePaste, { capture: true });
    return () => {
      document.removeEventListener("paste", handlePaste, { capture: true });
    };
  }, [handlePaste]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Handle file mention menu navigation first (it takes priority over slash commands)
    if (fileMentionMenuOpen && filteredFiles.length > 0) {
      const handled = handleFileMentionKeyDown(event, (file) => {
        const mention = createMention(file);
        inputRef.current?.insertMention(mention);
      });
      if (handled) return;
    }

    // Handle slash command menu navigation
    if (slashMenuOpen && filteredSlashCommands.length > 0) {
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          setSlashSelectedIndex((prev) =>
            prev < filteredSlashCommands.length - 1 ? prev + 1 : prev
          );
          return;
        case "ArrowUp":
          event.preventDefault();
          setSlashSelectedIndex((prev) => (prev > 0 ? prev - 1 : prev));
          return;
        case "Tab":
        case "Enter":
          if (filteredSlashCommands[slashSelectedIndex]) {
            event.preventDefault();
            handleSlashCommandSelect(filteredSlashCommands[slashSelectedIndex]);
            return;
          }
          break;
        case "Escape":
          event.preventDefault();
          setSlashMenuOpen(false);
          return;
      }
    }

    // Shift+Tab toggles between plan mode and edit mode (bypassPermissions)
    if (event.key === "Tab" && event.shiftKey) {
      event.preventDefault();
      setPlanMode(sessionKey, !planModeEnabled);
    }

    // Enter to send (handled by MentionableInput for regular Enter)
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleSend();
    }
  };

  const handleSend = async () => {
    if (isSending || disabled) return;
    if (attachments.length === 0 && !text.trim()) return;

    setIsSending(true);
    try {
      // Read current values directly from store to avoid stale closures
      const currentThinkingEnabled = isThinkingEnabled(sessionKey);
      const currentPlanModeEnabled = isPlanMode(sessionKey);

      // Serialize mentions: replace @filename with full relative path
      const serializedText = serializeForLLM(text.trim(), mentions);

      // If loading and onQueue is provided, add to queue instead of sending immediately
      if (isLoading && onQueue) {
        onQueue(serializedText, attachments, currentThinkingEnabled, currentPlanModeEnabled);
      } else {
        onSend(serializedText, attachments, currentThinkingEnabled, currentPlanModeEnabled);
      }
      setText("");
      setMentions([]);
      clearAttachments(sessionKey);
    } finally {
      setIsSending(false);
    }
  };

  const handleStop = () => {
    if (onStop) {
      onStop();
    }
  };

  const handleRemoveAttachment = (id: string) => {
    removeAttachment(sessionKey, id);
  };

  const handleModelChange = (modelId: string) => {
    setSelectedModel(sessionKey, modelId);
  };

  // Get display name for selected model - default to first model if none selected
  const effectiveSelectedModel = selectedModel ?? models[0]?.id;
  const selectedModelObj = models.find((m) => m.id === effectiveSelectedModel);
  const selectedModelName = selectedModelObj?.name ?? (models.length > 0 ? models[0]?.name : "No models");

  return (
    <div className="border-t border-border bg-background p-3">
      {/* Attachments preview */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
          {attachments.map((att) => (
            <div
              key={att.id}
              className="relative group flex items-center gap-1.5 px-2 py-1 rounded bg-muted/50 border border-border text-xs"
            >
              {att.type === "image" && att.previewUrl ? (
                <img
                  src={att.previewUrl}
                  alt={att.name}
                  className="w-6 h-6 object-cover rounded"
                />
              ) : (
                <FileText className="w-4 h-4 text-muted-foreground" />
              )}
              <span className="max-w-[120px] truncate">{att.name}</span>
              <button
                onClick={() => handleRemoveAttachment(att.id)}
                className="ml-1 p-0.5 rounded-full hover:bg-muted"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Text input area container with menus */}
      <div className="relative" data-mentionable-input>
        {/* Slash command menu - appears above input */}
        {slashMenuOpen && filteredSlashCommands.length > 0 && (
          <SlashCommandMenu
            commands={filteredSlashCommands}
            selectedIndex={slashSelectedIndex}
            onSelect={handleSlashCommandSelect}
            onClose={() => setSlashMenuOpen(false)}
          />
        )}

        {/* File mention menu - appears above input */}
        {fileMentionMenuOpen && (
          <FileMentionMenu
            files={filteredFiles}
            selectedIndex={fileMentionSelectedIndex}
            onSelect={handleFileMentionSelect}
            onClose={closeFileMentionMenu}
          />
        )}

        {/* Mentionable input with @ file references */}
        <MentionableInput
          ref={inputRef}
          value={text}
          mentions={mentions}
          onChange={handleTextAndMentionsChange}
          onCursorChange={handleCursorPositionChange}
          onKeyDown={handleKeyDown}
          placeholder="Ask Claude anything..."
          disabled={disabled || isSending}
          minHeight={LINE_HEIGHT + 8}
          maxHeight={MAX_LINES * LINE_HEIGHT + 16}
        />
      </div>

      {/* Bottom toolbar row */}
      <div className="flex items-center gap-1 pt-1">
        {/* Attachment button */}
        <div className="relative" ref={attachmentMenuRef}>
          <button
            className="p-1.5 rounded hover:bg-muted/50 text-muted-foreground hover:text-foreground transition-colors"
            disabled={disabled}
            onClick={() => setShowAttachmentMenu(!showAttachmentMenu)}
          >
            <Plus className="w-4 h-4" />
          </button>

          {/* Attachment menu popover */}
          {showAttachmentMenu && (
            <div className="absolute bottom-full left-0 mb-1 w-56 rounded-md border border-border bg-popover p-1 shadow-md z-50">
              <button
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
                onClick={() => {
                  setShowAttachmentMenu(false);
                }}
              >
                <FileText className="w-4 h-4" />
                Attach file from workspace
              </button>
              <button
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-muted-foreground cursor-default"
                disabled
              >
                <ImageIcon className="w-4 h-4" />
                Paste image (Cmd+V)
              </button>
            </div>
          )}
        </div>

        {/* Model dropdown - minimal style */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex items-center gap-1 px-2 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors">
              <ChevronDown className="w-3 h-3" />
              <span className="max-w-[200px] truncate">{selectedModelName}</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-[400px] overflow-y-auto min-w-[240px]">
            {models.length === 0 ? (
              <DropdownMenuItem disabled>No models available</DropdownMenuItem>
            ) : (
              models.map((model) => {
                const isSelected = model.id === effectiveSelectedModel;
                return (
                  <DropdownMenuItem
                    key={model.id}
                    onClick={() => handleModelChange(model.id)}
                    className="flex items-start gap-2 py-2"
                  >
                    <div className="w-4 h-4 flex-shrink-0 mt-0.5">
                      {isSelected && <Check className="w-4 h-4 text-primary" />}
                    </div>
                    <div className="flex flex-col gap-0.5 min-w-0">
                      <span className="text-sm font-medium truncate">{model.name}</span>
                      {model.description && (
                        <span className="text-xs text-muted-foreground line-clamp-2">{model.description}</span>
                      )}
                    </div>
                  </DropdownMenuItem>
                );
              })
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Plan mode toggle */}
        <button
          onClick={() => setPlanMode(sessionKey, !planModeEnabled)}
          disabled={disabled}
          className={cn(
            "flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors",
            planModeEnabled
              ? "text-primary hover:text-primary/80 hover:bg-primary/10"
              : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
          )}
          title={planModeEnabled ? "Plan mode (Shift+Tab to toggle)" : "Edit mode (Shift+Tab to toggle)"}
        >
          <MapPlus className="w-3.5 h-3.5" />
        </button>

        {/* Thinking toggle */}
        <button
          onClick={() => setThinkingEnabled(sessionKey, !thinkingEnabled)}
          disabled={disabled}
          className={cn(
            "flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors",
            thinkingEnabled
              ? "text-primary hover:text-primary/80 hover:bg-primary/10"
              : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
          )}
          title={thinkingEnabled ? "Extended thinking enabled" : "Extended thinking disabled"}
        >
          <Brain className="w-3.5 h-3.5" />
        </button>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Queue indicator */}
        {queueLength > 0 && (
          <div className="flex items-center gap-1 px-2 py-1 rounded text-xs text-muted-foreground bg-muted/50">
            <span>+{queueLength} queued</span>
          </div>
        )}

        {/* Send/Stop button - round grey style */}
        {isLoading && !text.trim() && attachments.length === 0 ? (
          // Stop button when loading and no content
          <button
            onClick={handleStop}
            disabled={disabled}
            className={cn(
              "w-8 h-8 rounded-full flex items-center justify-center transition-colors",
              "bg-destructive/10 hover:bg-destructive/20 text-destructive",
              "disabled:opacity-50 disabled:cursor-not-allowed"
            )}
            title="Stop current query"
          >
            <Square className="w-4 h-4 fill-current" />
          </button>
        ) : (
          // Send button (immediate send or queue)
          <button
            onClick={handleSend}
            disabled={disabled || isSending || (attachments.length === 0 && !text.trim())}
            className={cn(
              "w-8 h-8 rounded-full flex items-center justify-center transition-colors",
              isLoading
                ? "bg-primary/20 hover:bg-primary/30 text-primary"
                : "bg-muted hover:bg-muted/80",
              "disabled:opacity-50 disabled:cursor-not-allowed"
            )}
            title={isLoading ? "Add to queue" : "Send message"}
          >
            <ArrowUp className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
}

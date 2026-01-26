import { useRef, useState, useEffect, useCallback, KeyboardEvent } from "react";
import { X, Plus, FileText, Image as ImageIcon, ChevronDown, ArrowUp, Brain, MapPlus } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { readImage } from "@tauri-apps/plugin-clipboard-manager";
import { writeContainerFile, writeLocalFile } from "@/lib/tauri";
import { toast } from "sonner";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useClaudeStore, type ClaudeAttachment } from "@/stores/claudeStore";
import type { ClaudeModel } from "@/lib/claude-client";

interface ClaudeComposeBarProps {
  environmentId: string;
  /** Container ID for containerized environments, undefined for local */
  containerId?: string;
  models: ClaudeModel[];
  onSend: (text: string, attachments: ClaudeAttachment[], thinkingEnabled: boolean, planModeEnabled: boolean) => void;
  disabled?: boolean;
}

const MAX_LINES = 10;
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
  containerId,
  models,
  onSend,
  disabled = false,
}: ClaudeComposeBarProps) {
  const [isSending, setIsSending] = useState(false);
  const [showAttachmentMenu, setShowAttachmentMenu] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const attachmentMenuRef = useRef<HTMLDivElement>(null);

  const {
    getAttachments,
    addAttachment,
    removeAttachment,
    clearAttachments,
    getDraftText,
    setDraftText,
    getSelectedModel,
    setSelectedModel,
    isThinkingEnabled,
    setThinkingEnabled,
    isPlanMode,
    setPlanMode,
  } = useClaudeStore();

  const attachments = getAttachments(environmentId);
  const text = getDraftText(environmentId);
  const selectedModel = getSelectedModel(environmentId);
  const thinkingEnabled = isThinkingEnabled(environmentId);
  const planModeEnabled = isPlanMode(environmentId);

  const setText = useCallback(
    (newText: string) => setDraftText(environmentId, newText),
    [environmentId, setDraftText]
  );

  // Get worktree path for local environments
  const worktreePath = useEnvironmentStore(
    (state) => state.getEnvironmentById(environmentId)?.worktreePath
  );

  // Focus textarea on mount
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.focus();
    }
  }, []);

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
  const handlePaste = useCallback(
    async (event: ClipboardEvent) => {
      if (document.activeElement !== textareaRef.current) return;

      try {
        const image = await readImage();
        const rgba = await image.rgba();
        const { width, height } = await image.size();

        const rgbaSize = width * height * 4;
        if (rgbaSize > MAX_RGBA_SIZE) {
          console.error("[ClaudeComposeBar] Image too large");
          return;
        }

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const imageDataObj = new ImageData(new Uint8ClampedArray(rgba), width, height);
        ctx.putImageData(imageDataObj, 0, 0);
        const dataUrl = canvas.toDataURL("image/png");
        const base64Data = dataUrl.split(",")[1] || "";

        const estimatedSize = (base64Data.length * 3) / 4;
        if (estimatedSize > MAX_IMAGE_SIZE) {
          console.error("[ClaudeComposeBar] Image too large after encoding");
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
          addAttachment(environmentId, attachment);
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
          addAttachment(environmentId, attachment);
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
    [containerId, environmentId, worktreePath, addAttachment]
  );

  useEffect(() => {
    document.addEventListener("paste", handlePaste, { capture: true });
    return () => {
      document.removeEventListener("paste", handlePaste, { capture: true });
    };
  }, [handlePaste]);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleSend();
    }
    // Shift+Tab toggles between plan mode and edit mode (bypassPermissions)
    if (event.key === "Tab" && event.shiftKey) {
      event.preventDefault();
      setPlanMode(environmentId, !planModeEnabled);
    }
  };

  const handleSend = async () => {
    if (isSending || disabled) return;
    if (attachments.length === 0 && !text.trim()) return;

    setIsSending(true);
    try {
      // Read current values directly from store to avoid stale closures
      const currentThinkingEnabled = isThinkingEnabled(environmentId);
      const currentPlanModeEnabled = isPlanMode(environmentId);
      onSend(text.trim(), attachments, currentThinkingEnabled, currentPlanModeEnabled);
      setText("");
      clearAttachments(environmentId);
    } finally {
      setIsSending(false);
    }
  };

  const handleRemoveAttachment = (id: string) => {
    removeAttachment(environmentId, id);
  };

  const handleModelChange = (modelId: string) => {
    setSelectedModel(environmentId, modelId);
  };

  const textareaRows = Math.min(MAX_LINES, Math.max(1, text.split("\n").length));

  // Get display name for selected model
  const selectedModelObj = models.find((m) => m.id === selectedModel);
  const selectedModelName = selectedModelObj?.name ?? "Select model";

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

      {/* Text input area - on top */}
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Ask Claude anything..."
        rows={textareaRows}
        className={cn(
          "w-full bg-transparent border-none px-1 py-1",
          "text-sm text-foreground placeholder:text-muted-foreground",
          "resize-none outline-none",
          "transition-colors"
        )}
        style={{
          minHeight: LINE_HEIGHT + 8,
          maxHeight: MAX_LINES * LINE_HEIGHT + 16,
        }}
        disabled={disabled || isSending}
      />

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
          <DropdownMenuContent align="start" className="max-h-[400px] overflow-y-auto">
            {models.length === 0 ? (
              <DropdownMenuItem disabled>No models available</DropdownMenuItem>
            ) : (
              models.map((model) => (
                <DropdownMenuItem
                  key={model.id}
                  onClick={() => handleModelChange(model.id)}
                  className="text-sm"
                >
                  <span className="truncate">{model.name}</span>
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Plan mode toggle */}
        <button
          onClick={() => setPlanMode(environmentId, !planModeEnabled)}
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
          onClick={() => setThinkingEnabled(environmentId, !thinkingEnabled)}
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

        {/* Send button - round grey style */}
        <button
          onClick={handleSend}
          disabled={disabled || isSending || (attachments.length === 0 && !text.trim())}
          className={cn(
            "w-8 h-8 rounded-full flex items-center justify-center transition-colors",
            "bg-muted hover:bg-muted/80",
            "disabled:opacity-50 disabled:cursor-not-allowed"
          )}
        >
          <ArrowUp className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

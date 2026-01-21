import { useState, useRef, useEffect, useCallback, KeyboardEvent } from "react";
import { X, Plus, FileText, Image as ImageIcon, ChevronDown, ArrowUp } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuPortal,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { readImage } from "@tauri-apps/plugin-clipboard-manager";
import { writeContainerFile } from "@/lib/tauri";
import { useOpenCodeStore, type OpenCodeAttachment } from "@/stores/openCodeStore";
import type { OpenCodeModel, OpenCodeConversationMode } from "@/lib/opencode-client";

interface OpenCodeComposeBarProps {
  environmentId: string;
  /** Container ID for containerized environments, undefined for local */
  containerId?: string;
  models: OpenCodeModel[];
  onSend: (text: string, attachments: OpenCodeAttachment[]) => void;
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

export function OpenCodeComposeBar({
  environmentId,
  containerId,
  models,
  onSend,
  disabled = false,
}: OpenCodeComposeBarProps) {
  const [text, setText] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [showAttachmentMenu, setShowAttachmentMenu] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const attachmentMenuRef = useRef<HTMLDivElement>(null);

  const {
    getAttachments,
    addAttachment,
    removeAttachment,
    clearAttachments,
    getSelectedModel,
    setSelectedModel,
    getSelectedMode,
    setSelectedMode,
  } = useOpenCodeStore();

  const attachments = getAttachments(environmentId);
  const selectedModel = getSelectedModel(environmentId);
  const selectedMode = getSelectedMode(environmentId);

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
          console.error("[OpenCodeComposeBar] Image too large");
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
          console.error("[OpenCodeComposeBar] Image too large after encoding");
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

          const attachment: OpenCodeAttachment = {
            id: Math.random().toString(36).substring(2, 9),
            type: "image",
            path: `/workspace/${filePath}`,
            previewUrl: dataUrl,
            name: filename,
          };
          addAttachment(environmentId, attachment);
        } else {
          // Local environment - for now, just use the data URL directly
          // TODO: Write to local worktree path
          const attachment: OpenCodeAttachment = {
            id: Math.random().toString(36).substring(2, 9),
            type: "image",
            path: filePath, // Use local path
            previewUrl: dataUrl,
            name: filename,
          };
          addAttachment(environmentId, attachment);
        }
      } catch (e) {
        // Clipboard read errors are expected when no image is present - ignore silently
        // Log unexpected errors for debugging
        if (e instanceof Error && !e.message.toLowerCase().includes("clipboard")) {
          console.error("[OpenCodeComposeBar] Unexpected paste error:", e);
        }
        // Let text paste through by not preventing default
      }
    },
    [containerId, environmentId, addAttachment]
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
  };

  const handleSend = async () => {
    if (isSending || disabled) return;
    if (attachments.length === 0 && !text.trim()) return;

    setIsSending(true);
    try {
      onSend(text.trim(), attachments);
      setText("");
      clearAttachments(environmentId);
    } finally {
      setIsSending(false);
    }
  };

  const handleRemoveAttachment = (id: string) => {
    removeAttachment(environmentId, id);
  };

  const handleModeChange = (mode: string) => {
    setSelectedMode(environmentId, mode as OpenCodeConversationMode);
  };

  const handleModelChange = (modelId: string) => {
    setSelectedModel(environmentId, modelId);
  };

  const textareaRows = Math.min(MAX_LINES, Math.max(1, text.split("\n").length));

  // Get display name for selected model
  const selectedModelObj = models.find((m) => m.id === selectedModel);
  const selectedModelName = selectedModelObj?.name ?? "Select model";
  const isSelectedModelFree = selectedModelObj?.inputCost === 0 && selectedModelObj?.outputCost === 0;

  // Group models by provider
  const modelsByProvider = models.reduce((acc, model) => {
    const provider = model.provider || "Other";
    if (!acc[provider]) {
      acc[provider] = [];
    }
    acc[provider].push(model);
    return acc;
  }, {} as Record<string, OpenCodeModel[]>);

  // Sort providers alphabetically
  const sortedProviders = Object.keys(modelsByProvider).sort();

  // Capitalize mode for display
  const modeDisplayName = selectedMode === "plan" ? "Planning" : "Build";

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
        placeholder="Ask anything (⌘L), @ to mention, / for workflows"
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

        {/* Mode dropdown - minimal style */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex items-center gap-1 px-2 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors">
              <ChevronDown className="w-3 h-3" />
              <span>{modeDisplayName}</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={() => handleModeChange("plan")}>
              Planning
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => handleModeChange("build")}>
              Build
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Model dropdown - minimal style, grouped by provider */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex items-center gap-1 px-2 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors">
              <ChevronDown className="w-3 h-3" />
              <span className="max-w-[200px] truncate">{selectedModelName}</span>
              {isSelectedModelFree && (
                <span className="ml-1 px-1.5 py-0.5 text-[10px] font-medium rounded bg-green-500/20 text-green-600 dark:text-green-400">
                  Free
                </span>
              )}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-[400px] overflow-y-auto">
            {models.length === 0 ? (
              <DropdownMenuItem disabled>No models available</DropdownMenuItem>
            ) : (
              sortedProviders.map((provider) => {
                const providerModels = modelsByProvider[provider] ?? [];
                return (
                  <DropdownMenuSub key={provider}>
                    <DropdownMenuSubTrigger className="text-sm">
                      {provider}
                      <span className="ml-2 text-muted-foreground text-[10px]">
                        ({providerModels.length})
                      </span>
                    </DropdownMenuSubTrigger>
                    <DropdownMenuPortal>
                      <DropdownMenuSubContent className="max-h-[300px] overflow-y-auto">
                        {providerModels.map((model) => {
                          const isFree = model.inputCost === 0 && model.outputCost === 0;
                          return (
                            <DropdownMenuItem
                              key={model.id}
                              onClick={() => handleModelChange(model.id)}
                              className="text-sm"
                            >
                              <span className="truncate">{model.name}</span>
                              {isFree && (
                                <span className="ml-2 px-1.5 py-0.5 text-[10px] font-medium rounded bg-green-500/20 text-green-600 dark:text-green-400">
                                  Free
                                </span>
                              )}
                            </DropdownMenuItem>
                          );
                        })}
                      </DropdownMenuSubContent>
                    </DropdownMenuPortal>
                  </DropdownMenuSub>
                );
              })
            )}
          </DropdownMenuContent>
        </DropdownMenu>

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

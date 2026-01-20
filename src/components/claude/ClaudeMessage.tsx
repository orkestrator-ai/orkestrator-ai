import { memo, useCallback, useState, useMemo, useRef, useEffect, type AnchorHTMLAttributes } from "react";
import { Brain, FileText, ChevronRight, Wrench, AlertCircle, Pencil, ExternalLink as ExternalLinkIcon, Layers } from "lucide-react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import { openInBrowser } from "@/lib/tauri";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { useTerminalContext } from "@/contexts/TerminalContext";
import { ERROR_MESSAGE_PREFIX, type ClaudeMessage as ClaudeMessageType, type ClaudeMessagePart, type ToolDiffMetadata } from "@/lib/claude-client";

/** Custom link component that opens URLs in the system browser */
function ExternalLink({ href, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  const handleClick = useCallback((e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    if (href) {
      openInBrowser(href).catch((err) => {
        console.error("[ClaudeMessage] Failed to open link:", err);
      });
    }
  }, [href]);

  return (
    <a
      href={href}
      onClick={handleClick}
      className="text-primary hover:underline cursor-pointer"
      {...props}
    >
      {children}
    </a>
  );
}

/** Markdown components config with external link handling */
const markdownComponents: Components = {
  a: ExternalLink,
};

interface ClaudeMessageProps {
  message: ClaudeMessageType;
}

/** Render a thinking/reasoning part - collapsible after response completes */
function ThinkingPart({ content, isComplete }: { content: string; isComplete: boolean }) {
  // Start expanded while thinking, collapse when complete
  const [isOpen, setIsOpen] = useState(!isComplete);

  // Track previous isComplete value to detect changes
  const prevIsCompleteRef = useRef(isComplete);

  // Auto-collapse when response completes (isComplete changes from false to true)
  // But don't auto-expand if user manually collapsed
  useEffect(() => {
    // Only collapse when transitioning from incomplete to complete
    if (isComplete && !prevIsCompleteRef.current) {
      setIsOpen(false);
    }
    prevIsCompleteRef.current = isComplete;
  }, [isComplete]);

  // Get truncated preview of thinking content for collapsed state
  const thinkingPreview = useMemo(() => {
    if (!content) return "";
    // Strip markdown formatting and get first line/portion
    const cleaned = content
      .replace(/[#*_`~\[\]]/g, "")
      .replace(/\n+/g, " ")
      .trim();
    return cleaned;
  }, [content]);

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className="mb-3">
      <CollapsibleTrigger className="flex items-center gap-1.5 text-xs text-muted-foreground w-full py-2 px-3 bg-muted/30 rounded-md hover:bg-muted/50 transition-colors cursor-pointer">
        <ChevronRight
          className={cn(
            "w-3 h-3 transition-transform shrink-0",
            isOpen && "rotate-90"
          )}
        />
        <Brain className="w-3 h-3 shrink-0" />
        <span className="font-medium shrink-0">Thinking</span>
        {!isOpen && thinkingPreview && (
          <span className="text-muted-foreground/60 truncate flex-1 text-left">
            {thinkingPreview}
          </span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 rounded-md bg-muted/20 p-3 border border-border/30">
          <div className="text-sm text-muted-foreground/80 leading-relaxed prose prose-sm prose-invert max-w-none prose-p:my-1 prose-headings:my-2 prose-headings:text-muted-foreground prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5 prose-pre:my-1 prose-code:text-xs prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-pre:bg-muted prose-pre:p-2 prose-pre:rounded-md prose-table:text-xs">
            <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{content}</Markdown>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Render a tool invocation part - expandable to show input/output */
function ToolPart({
  toolName,
  toolState,
  toolTitle,
  toolArgs,
  toolOutput,
  toolError,
}: {
  toolName?: string;
  toolState?: "success" | "failure" | "pending";
  toolTitle?: string;
  toolArgs?: Record<string, unknown>;
  toolOutput?: string;
  toolError?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);

  const stateColors = {
    success: "text-green-600",
    failure: "text-red-600",
    pending: "text-yellow-600 animate-pulse",
  };

  // Determine if there's content to show when expanded
  const hasExpandableContent = toolOutput || toolError || (toolArgs && Object.keys(toolArgs).length > 0);

  // Extract display info from toolArgs based on tool type
  const getDisplayInfo = (): string | null => {
    if (!toolArgs) return null;

    // For Task tool - show description
    const description = toolArgs.description as string | undefined;
    if (description) {
      return description;
    }

    // For Bash tool - show command
    const command = toolArgs.command as string | undefined;
    if (command) {
      // Truncate long commands and remove newlines for display
      const cleanedCommand = command.replace(/\n/g, " ").trim();
      return cleanedCommand;
    }

    // For Read tool - show filename
    const filePath = toolArgs.file_path as string | undefined;
    if (filePath) {
      return filePath.split("/").pop() || null;
    }

    // For Glob tool - show pattern
    const pattern = toolArgs.pattern as string | undefined;
    if (pattern) {
      return pattern;
    }

    // For Grep tool - show search pattern
    const grepPattern = toolArgs.regex as string | undefined;
    if (grepPattern) {
      return grepPattern;
    }

    // For WebFetch tool - show hostname from URL
    const url = toolArgs.url as string | undefined;
    if (url) {
      try {
        const hostname = new URL(url).hostname;
        return hostname;
      } catch {
        return url;
      }
    }

    // For WebSearch tool - show search query
    const query = toolArgs.query as string | undefined;
    if (query) {
      return query;
    }

    return null;
  };

  const displayInfo = getDisplayInfo();

  // Format the command input for shell-like display
  const formatInput = () => {
    if (!toolArgs) return null;
    // For shell commands, show the command
    if (toolArgs.command && typeof toolArgs.command === "string") {
      return `$ ${toolArgs.command}`;
    }
    // For other tools, show a JSON representation of args
    return JSON.stringify(toolArgs, null, 2);
  };

  const formattedInput = formatInput();

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className="my-1.5">
      <CollapsibleTrigger
        className={cn(
          "flex items-center gap-2 w-full text-xs text-muted-foreground py-2 px-3 bg-muted/50 rounded-md hover:bg-muted/70 transition-colors",
          hasExpandableContent && "cursor-pointer",
          !hasExpandableContent && "cursor-default"
        )}
        disabled={!hasExpandableContent}
      >
        <ChevronRight
          className={cn(
            "w-3 h-3 transition-transform shrink-0",
            isOpen && "rotate-90",
            !hasExpandableContent && "opacity-0"
          )}
        />
        <Wrench className="w-3.5 h-3.5 shrink-0" />
        <span className="font-medium">{toolName || "Unknown tool"}</span>
        {displayInfo && (
          <span className="font-mono text-muted-foreground/80 truncate flex-1 text-left">
            {displayInfo}
          </span>
        )}
        {toolTitle && !displayInfo && (
          <span className="text-muted-foreground/70 truncate flex-1 text-left">
            {toolTitle}
          </span>
        )}
        {toolState && (
          <span className={cn("ml-auto shrink-0", stateColors[toolState] || "")}>
            {toolState === "pending" ? "running..." : toolState}
          </span>
        )}
      </CollapsibleTrigger>

      {hasExpandableContent && (
        <CollapsibleContent className="mt-1">
          <div className="rounded-md bg-muted/30 border border-border/50 overflow-hidden">
            {/* Input/Command section */}
            {formattedInput && (
              <div className="px-3 py-2 border-b border-border/30">
                <pre className="text-xs font-mono text-muted-foreground whitespace-pre-wrap break-all">
                  {formattedInput}
                </pre>
              </div>
            )}

            {/* Output section */}
            {toolOutput && (
              <div className="px-3 py-2 max-h-64 overflow-auto">
                <pre className="text-xs font-mono text-foreground/80 whitespace-pre-wrap break-all">
                  {toolOutput}
                </pre>
              </div>
            )}

            {/* Error section */}
            {toolError && (
              <div className="px-3 py-2 bg-destructive/10">
                <div className="flex items-start gap-2">
                  <AlertCircle className="w-3.5 h-3.5 text-destructive shrink-0 mt-0.5" />
                  <pre className="text-xs font-mono text-destructive whitespace-pre-wrap break-all">
                    {toolError}
                  </pre>
                </div>
              </div>
            )}
          </div>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}

/** Parse unified diff output into lines with +/- indicators */
function parseDiffLines(output: string): Array<{ type: "add" | "remove" | "context" | "header"; content: string }> {
  if (!output) return [];
  const lines = output.split("\n");
  return lines.map((line) => {
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) {
      return { type: "header" as const, content: line };
    } else if (line.startsWith("+")) {
      return { type: "add" as const, content: line };
    } else if (line.startsWith("-")) {
      return { type: "remove" as const, content: line };
    } else {
      return { type: "context" as const, content: line };
    }
  });
}

/** Generate diff lines from before/after content */
function generateDiffFromBeforeAfter(
  before?: string,
  after?: string
): Array<{ type: "add" | "remove" | "context" | "header"; content: string }> {
  const result: Array<{ type: "add" | "remove" | "context" | "header"; content: string }> = [];

  // If we have both before and after, show the diff
  if (before !== undefined && after !== undefined) {
    // Add removed lines
    const beforeLines = before.split("\n");
    for (const line of beforeLines) {
      result.push({ type: "remove", content: `-${line}` });
    }
    // Add added lines
    const afterLines = after.split("\n");
    for (const line of afterLines) {
      result.push({ type: "add", content: `+${line}` });
    }
  } else if (after !== undefined) {
    // Only additions (write/new content)
    const afterLines = after.split("\n");
    for (const line of afterLines) {
      result.push({ type: "add", content: `+${line}` });
    }
  } else if (before !== undefined) {
    // Only deletions
    const beforeLines = before.split("\n");
    for (const line of beforeLines) {
      result.push({ type: "remove", content: `-${line}` });
    }
  }

  return result;
}

/** Count additions and deletions from diff output or metadata */
function countDiffStats(output?: string, metadata?: ToolDiffMetadata): { additions: number; deletions: number } {
  // First try to use pre-calculated metadata if available
  if (metadata?.additions !== undefined || metadata?.deletions !== undefined) {
    return {
      additions: metadata.additions ?? 0,
      deletions: metadata.deletions ?? 0,
    };
  }

  // Try to calculate from before/after content
  if (metadata?.before !== undefined || metadata?.after !== undefined) {
    const beforeLines = metadata.before ? metadata.before.split("\n").length : 0;
    const afterLines = metadata.after ? metadata.after.split("\n").length : 0;
    return {
      additions: afterLines,
      deletions: beforeLines,
    };
  }

  // Otherwise parse from diff-formatted output
  if (!output) return { additions: 0, deletions: 0 };

  let additions = 0;
  let deletions = 0;
  const lines = output.split("\n");
  for (const line of lines) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      additions++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      deletions++;
    }
  }
  return { additions, deletions };
}

/** Render an edit tool invocation with diff view */
function EditToolPart({
  toolName,
  toolState,
  toolTitle,
  toolOutput,
  toolError,
  toolDiff,
}: {
  toolName?: string;
  toolState?: "success" | "failure" | "pending";
  toolTitle?: string;
  toolOutput?: string;
  toolError?: string;
  toolDiff?: ToolDiffMetadata;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const { createFileTab } = useTerminalContext();

  const stateColors = {
    success: "text-green-600",
    failure: "text-red-600",
    pending: "text-yellow-600 animate-pulse",
  };

  // Get file path from diff metadata
  const filePath = toolDiff?.filePath;
  const fileName = filePath ? filePath.split("/").pop() : null;

  // Calculate diff stats
  const { additions, deletions } = useMemo(
    () => countDiffStats(toolOutput, toolDiff),
    [toolOutput, toolDiff]
  );

  // Parse diff lines for display - try unified diff first, then output, then generate from before/after
  const diffLines = useMemo(() => {
    // First try the unified diff from metadata (most accurate)
    if (toolDiff?.diff) {
      const diffLines = parseDiffLines(toolDiff.diff);
      const hasActualDiffContent = diffLines.some(
        (line) => line.type === "add" || line.type === "remove"
      );
      if (hasActualDiffContent) {
        return diffLines;
      }
    }

    // Then try parsing from output (if it's in diff format)
    const outputLines = parseDiffLines(toolOutput || "");
    const hasActualDiffContent = outputLines.some(
      (line) => line.type === "add" || line.type === "remove"
    );
    if (hasActualDiffContent) {
      return outputLines;
    }

    // Finally generate from before/after content
    if (toolDiff?.before !== undefined || toolDiff?.after !== undefined) {
      return generateDiffFromBeforeAfter(toolDiff.before, toolDiff.after);
    }

    return [];
  }, [toolOutput, toolDiff]);

  // Determine if there's content to show when expanded
  const hasExpandableContent = toolOutput || toolError || diffLines.length > 0 || toolDiff?.diff || toolDiff?.before || toolDiff?.after;

  // Handle pop-out to open diff in new tab
  const handlePopOut = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (createFileTab && filePath) {
        createFileTab(filePath, { isDiff: true, gitStatus: "M" });
      }
    },
    [createFileTab, filePath]
  );

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className="my-1.5">
      <CollapsibleTrigger
        className={cn(
          "flex items-center gap-2 w-full text-xs text-muted-foreground py-2 px-3 bg-muted/50 rounded-md hover:bg-muted/70 transition-colors",
          hasExpandableContent && "cursor-pointer",
          !hasExpandableContent && "cursor-default"
        )}
        disabled={!hasExpandableContent}
      >
        <ChevronRight
          className={cn(
            "w-3 h-3 transition-transform shrink-0",
            isOpen && "rotate-90",
            !hasExpandableContent && "opacity-0"
          )}
        />
        <Pencil className="w-3.5 h-3.5 shrink-0" />
        <span className="font-medium">{toolName || "edit"}</span>
        {fileName && (
          <span className="font-mono text-muted-foreground/80 truncate flex-1 text-left">
            {fileName}
          </span>
        )}
        {toolTitle && !fileName && (
          <span className="text-muted-foreground/70 truncate flex-1 text-left">
            {toolTitle}
          </span>
        )}
        {/* Line count stats - shown after filename */}
        {(additions > 0 || deletions > 0) && (
          <span className="flex items-center gap-1 shrink-0">
            {additions > 0 && (
              <span className="text-green-500 font-mono">+{additions}</span>
            )}
            {deletions > 0 && (
              <span className="text-red-500 font-mono">-{deletions}</span>
            )}
          </span>
        )}
        {toolState && (
          <span className={cn("ml-auto shrink-0", stateColors[toolState] || "")}>
            {toolState === "pending" ? "running..." : toolState}
          </span>
        )}
      </CollapsibleTrigger>

      {hasExpandableContent && (
        <CollapsibleContent className="mt-1">
          <div className="rounded-md bg-muted/30 border border-border/50 overflow-hidden">
            {/* Header with file path and pop-out button */}
            <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/30 bg-muted/20">
              <span className="text-xs font-mono text-muted-foreground truncate">
                {filePath || "Unknown file"}
              </span>
              {createFileTab && filePath && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0 hover:bg-muted"
                  onClick={handlePopOut}
                  title="Open diff in new tab"
                >
                  <ExternalLinkIcon className="w-3 h-3" />
                </Button>
              )}
            </div>

            {/* Unified diff view */}
            {diffLines.length > 0 && (
              <div className="max-h-64 overflow-auto">
                <pre className="text-xs font-mono">
                  {diffLines.map((line, i) => (
                    <div
                      key={i}
                      className={cn(
                        "px-3 py-0.5",
                        line.type === "add" && "bg-green-500/20 text-green-400",
                        line.type === "remove" && "bg-red-500/20 text-red-400",
                        line.type === "header" && "bg-blue-500/10 text-blue-400",
                        line.type === "context" && "text-foreground/60"
                      )}
                    >
                      {line.content}
                    </div>
                  ))}
                </pre>
              </div>
            )}

            {/* Fallback to raw output if no diff lines parsed */}
            {diffLines.length === 0 && toolOutput && (
              <div className="px-3 py-2 max-h-64 overflow-auto">
                <pre className="text-xs font-mono text-foreground/80 whitespace-pre-wrap break-all">
                  {toolOutput}
                </pre>
              </div>
            )}

            {/* Error section */}
            {toolError && (
              <div className="px-3 py-2 bg-destructive/10">
                <div className="flex items-start gap-2">
                  <AlertCircle className="w-3.5 h-3.5 text-destructive shrink-0 mt-0.5" />
                  <pre className="text-xs font-mono text-destructive whitespace-pre-wrap break-all">
                    {toolError}
                  </pre>
                </div>
              </div>
            )}
          </div>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}

/** Render a Task tool with collapsible child tools */
function TaskToolPart({
  toolName,
  toolState,
  toolArgs,
  toolOutput,
  toolError,
  childTools,
}: {
  toolName?: string;
  toolState?: "success" | "failure" | "pending";
  toolArgs?: Record<string, unknown>;
  toolOutput?: string;
  toolError?: string;
  childTools: ClaudeMessagePart[];
}) {
  const [isOpen, setIsOpen] = useState(false);

  const stateColors = {
    success: "text-green-600",
    failure: "text-red-600",
    pending: "text-yellow-600 animate-pulse",
  };

  // Get description from toolArgs
  const description = (toolArgs?.description as string) || "";

  // Count child tools
  const toolCount = childTools.length;

  // Determine if there's content to show when expanded
  const hasExpandableContent = toolCount > 0 || toolOutput || toolError;

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className="my-1.5">
      <CollapsibleTrigger
        className={cn(
          "flex items-center gap-2 w-full text-xs text-muted-foreground py-2 px-3 bg-muted/50 rounded-md hover:bg-muted/70 transition-colors",
          hasExpandableContent && "cursor-pointer",
          !hasExpandableContent && "cursor-default"
        )}
        disabled={!hasExpandableContent}
      >
        <ChevronRight
          className={cn(
            "w-3 h-3 transition-transform shrink-0",
            isOpen && "rotate-90",
            !hasExpandableContent && "opacity-0"
          )}
        />
        <Layers className="w-3.5 h-3.5 shrink-0" />
        <span className="font-medium shrink-0">{toolName || "Task"}</span>
        {description && (
          <span className="text-muted-foreground/80 truncate flex-1 text-left">
            {description}
          </span>
        )}
        {/* Tool count badge */}
        {toolCount > 0 && (
          <span className="ml-auto shrink-0 px-1.5 py-0.5 rounded bg-muted text-muted-foreground/70 font-mono text-[10px]">
            {toolCount} tool{toolCount !== 1 ? "s" : ""}
          </span>
        )}
        {toolState && (
          <span className={cn("shrink-0", stateColors[toolState] || "")}>
            {toolState === "pending" ? "running..." : toolState}
          </span>
        )}
      </CollapsibleTrigger>

      {hasExpandableContent && (
        <CollapsibleContent className="mt-1">
          <div className="ml-4 pl-3 border-l-2 border-border/50 space-y-1">
            {/* Child tool invocations */}
            {childTools.map((part, i) => (
              <ChildToolPart key={`child-tool-${i}`} part={part} />
            ))}

            {/* Task output if no child tools */}
            {toolCount === 0 && toolOutput && (
              <div className="rounded-md bg-muted/30 border border-border/50 px-3 py-2">
                <pre className="text-xs font-mono text-foreground/80 whitespace-pre-wrap break-all">
                  {toolOutput}
                </pre>
              </div>
            )}

            {/* Error section */}
            {toolError && (
              <div className="rounded-md bg-destructive/10 px-3 py-2">
                <div className="flex items-start gap-2">
                  <AlertCircle className="w-3.5 h-3.5 text-destructive shrink-0 mt-0.5" />
                  <pre className="text-xs font-mono text-destructive whitespace-pre-wrap break-all">
                    {toolError}
                  </pre>
                </div>
              </div>
            )}
          </div>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}

/** Render a child tool under a Task - simplified version */
function ChildToolPart({ part }: { part: ClaudeMessagePart }) {
  const [isOpen, setIsOpen] = useState(false);

  const stateColors = {
    success: "text-green-600",
    failure: "text-red-600",
    pending: "text-yellow-600 animate-pulse",
  };

  const toolName = part.toolName;
  const toolArgs = part.toolArgs;
  const toolState = part.toolState;
  const toolOutput = part.toolOutput;
  const toolError = part.toolError;

  // Get display info based on tool type
  const getDisplayInfo = (): string | null => {
    if (!toolArgs) return null;

    // Bash - show command
    const command = toolArgs.command as string | undefined;
    if (command) {
      return command.replace(/\n/g, " ").trim();
    }

    // Read - show filename
    const filePath = toolArgs.file_path as string | undefined;
    if (filePath) {
      return filePath.split("/").pop() || null;
    }

    // Glob - show pattern
    const pattern = toolArgs.pattern as string | undefined;
    if (pattern) return pattern;

    // Grep - show regex
    const regex = toolArgs.regex as string | undefined;
    if (regex) return regex;

    // WebFetch - show hostname
    const url = toolArgs.url as string | undefined;
    if (url) {
      try {
        return new URL(url).hostname;
      } catch {
        return url;
      }
    }

    // WebSearch - show query
    const query = toolArgs.query as string | undefined;
    if (query) return query;

    return null;
  };

  const displayInfo = getDisplayInfo();
  const hasExpandableContent = toolOutput || toolError || (toolArgs && Object.keys(toolArgs).length > 0);

  // For Edit tools, use different icon
  const isEdit = toolName?.toLowerCase() === "edit" || toolName?.toLowerCase() === "write";
  const ToolIcon = isEdit ? Pencil : Wrench;

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className="my-0.5">
      <CollapsibleTrigger
        className={cn(
          "flex items-center gap-2 w-full text-xs text-muted-foreground py-1.5 px-2 bg-muted/30 rounded hover:bg-muted/50 transition-colors",
          hasExpandableContent && "cursor-pointer",
          !hasExpandableContent && "cursor-default"
        )}
        disabled={!hasExpandableContent}
      >
        <ChevronRight
          className={cn(
            "w-2.5 h-2.5 transition-transform shrink-0",
            isOpen && "rotate-90",
            !hasExpandableContent && "opacity-0"
          )}
        />
        <ToolIcon className="w-3 h-3 shrink-0" />
        <span className="font-medium shrink-0">{toolName || "Unknown"}</span>
        {displayInfo && (
          <span className="font-mono text-muted-foreground/70 truncate flex-1 text-left text-[11px]">
            {displayInfo}
          </span>
        )}
        {toolState && (
          <span className={cn("ml-auto shrink-0", stateColors[toolState] || "")}>
            {toolState === "pending" ? "..." : toolState}
          </span>
        )}
      </CollapsibleTrigger>

      {hasExpandableContent && (
        <CollapsibleContent className="mt-0.5">
          <div className="rounded bg-muted/20 border border-border/30 overflow-hidden ml-5">
            {/* Output */}
            {toolOutput && (
              <div className="px-2 py-1.5 max-h-48 overflow-auto">
                <pre className="text-[11px] font-mono text-foreground/70 whitespace-pre-wrap break-all">
                  {toolOutput}
                </pre>
              </div>
            )}
            {/* Error */}
            {toolError && (
              <div className="px-2 py-1.5 bg-destructive/10">
                <pre className="text-[11px] font-mono text-destructive whitespace-pre-wrap break-all">
                  {toolError}
                </pre>
              </div>
            )}
          </div>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}

/** Render a file attachment part */
function FilePart({ path }: { path: string }) {
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground my-1.5 py-1 px-2 bg-muted/50 rounded">
      <FileText className="w-3 h-3" />
      <span className="font-mono truncate">{path}</span>
    </div>
  );
}

/** Render a text content part with markdown support */
function TextPart({ content }: { content: string }) {
  return (
    <div className="text-sm text-foreground leading-relaxed prose prose-sm dark:prose-invert max-w-none prose-p:my-2 prose-headings:my-3 prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5 prose-pre:my-2 prose-code:text-xs prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-pre:bg-muted prose-pre:p-3 prose-pre:rounded-md prose-table:text-xs prose-table:my-2">
      <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{content}</Markdown>
    </div>
  );
}

/** Check if a tool name is an edit tool */
function isEditTool(toolName?: string): boolean {
  if (!toolName) return false;
  const name = toolName.toLowerCase();
  return name === "edit" || name === "write";
}

/** Check if a tool name is a Task tool */
function isTaskTool(toolName?: string): boolean {
  if (!toolName) return false;
  return toolName.toLowerCase() === "task";
}

/** Group tool parts so that non-Task tools following a Task are nested under it */
interface GroupedTool {
  part: ClaudeMessagePart;
  childTools: ClaudeMessagePart[];
}

function groupToolParts(toolParts: ClaudeMessagePart[]): GroupedTool[] {
  const result: GroupedTool[] = [];
  let currentTask: GroupedTool | null = null;

  for (const part of toolParts) {
    if (isTaskTool(part.toolName)) {
      // Start a new task group
      currentTask = { part, childTools: [] };
      result.push(currentTask);
    } else if (currentTask) {
      // Add to current task's children
      currentTask.childTools.push(part);
    } else {
      // No current task, render as standalone
      result.push({ part, childTools: [] });
    }
  }

  return result;
}

/** Render a single message part based on its type */
function MessagePart({ part }: { part: ClaudeMessagePart }) {
  switch (part.type) {
    case "thinking":
      // Thinking parts are typically rendered directly in ClaudeMessage with isComplete
      // If rendered through MessagePart, assume complete (collapsed by default)
      return <ThinkingPart content={part.content || ""} isComplete={true} />;
    case "text":
      return <TextPart content={part.content || ""} />;
    case "tool-invocation":
      // Use specialized EditToolPart for edit/write tools
      if (isEditTool(part.toolName)) {
        return (
          <EditToolPart
            toolName={part.toolName}
            toolState={part.toolState}
            toolTitle={part.toolTitle}
            toolOutput={part.toolOutput}
            toolError={part.toolError}
            toolDiff={part.toolDiff}
          />
        );
      }
      // Use generic ToolPart for other tools
      return (
        <ToolPart
          toolName={part.toolName}
          toolState={part.toolState}
          toolTitle={part.toolTitle}
          toolArgs={part.toolArgs}
          toolOutput={part.toolOutput}
          toolError={part.toolError}
        />
      );
    case "tool-result":
      // Tool results are typically shown inline with tool invocations
      return null;
    case "file":
      return <FilePart path={part.content || ""} />;
    default:
      return null;
  }
}

export const ClaudeMessage = memo(function ClaudeMessage({
  message,
}: ClaudeMessageProps) {
  const isUser = message.role === "user";
  const isError = message.id.startsWith(ERROR_MESSAGE_PREFIX);

  // Group parts by type for better rendering order
  const thinkingParts = message.parts.filter((p) => p.type === "thinking");
  const toolParts = message.parts.filter((p) => p.type === "tool-invocation");
  const textParts = message.parts.filter((p) => p.type === "text");
  const fileParts = message.parts.filter((p) => p.type === "file");

  // Group tool parts to nest non-Task tools under Tasks
  const groupedTools = useMemo(() => groupToolParts(toolParts), [toolParts]);

  // Check if we have any text parts to show
  const hasTextParts = textParts.length > 0;

  // Render error messages with special styling
  if (isError) {
    return (
      <div className="px-4 py-3">
        <div className="max-w-3xl mx-auto">
          <div className="flex items-start gap-2 p-3 rounded-md bg-destructive/10 border border-destructive/20">
            <AlertCircle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
            <div className="flex-1">
              <div className="text-sm text-destructive">{message.content}</div>
              <div className="text-[10px] text-destructive/60 mt-1">
                {formatTime(message.timestamp)}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "px-4 py-3",
        isUser ? "bg-muted/30" : "bg-transparent"
      )}
    >
      <div className="max-w-3xl mx-auto">
        {/* Role indicator with timestamp */}
        <div className="mb-1.5">
          <span
            className={cn(
              "text-xs font-medium",
              isUser ? "text-primary" : "text-muted-foreground"
            )}
          >
            {isUser ? "You" : "Claude"}
          </span>
          <span className="text-[10px] text-muted-foreground/60 ml-2">
            {formatTime(message.timestamp)}
          </span>
        </div>

        {/* Message content - render parts in order: thinking, tools, text */}
        <div className="space-y-2">
          {/* Thinking parts first (collapsible) - collapse when response is complete (has text parts) */}
          {thinkingParts.map((part, i) => (
            <ThinkingPart key={`thinking-${i}`} content={part.content || ""} isComplete={hasTextParts} />
          ))}

          {/* Tool invocations - grouped with Tasks containing their child tools */}
          {groupedTools.length > 0 && (
            <div className="space-y-1">
              {groupedTools.map((group, i) => {
                // Render Task tools with their children
                if (isTaskTool(group.part.toolName)) {
                  return (
                    <TaskToolPart
                      key={`task-${i}`}
                      toolName={group.part.toolName}
                      toolState={group.part.toolState}
                      toolArgs={group.part.toolArgs}
                      toolOutput={group.part.toolOutput}
                      toolError={group.part.toolError}
                      childTools={group.childTools}
                    />
                  );
                }
                // Render non-Task tools normally
                return <MessagePart key={`tool-${i}`} part={group.part} />;
              })}
            </div>
          )}

          {/* File attachments */}
          {fileParts.length > 0 && (
            <div className="space-y-1">
              {fileParts.map((part, i) => (
                <MessagePart key={`file-${i}`} part={part} />
              ))}
            </div>
          )}

          {/* Text content - the main response */}
          {textParts.map((part, i) => (
            <MessagePart key={`text-${i}`} part={part} />
          ))}

          {/* Fallback to raw content if no text parts were parsed */}
          {!hasTextParts && message.content && (
            <TextPart content={message.content} />
          )}
        </div>
      </div>
    </div>
  );
});

function formatTime(isoString: string): string {
  try {
    const date = new Date(isoString);
    return date.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

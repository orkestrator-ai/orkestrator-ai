import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { FileCode, Terminal as TerminalIcon, X } from "lucide-react";
import { ClaudeIcon, OpenCodeIcon } from "@/components/icons/AgentIcons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { TabInfo } from "@/types/paneLayout";
import { createDraggableTabId } from "@/types/paneLayout";
import { useSessionStore } from "@/stores/sessionStore";
import { useFileDirtyStore } from "@/stores";

interface DraggableTabProps {
  tab: TabInfo;
  paneId: string;
  index: number;
  isActive: boolean;
  /** Whether this tab is focused (active tab in the focused pane) */
  isFocused?: boolean;
  onSelect: () => void;
  onClose?: () => void;
  canClose: boolean;
}

export function DraggableTab({
  tab,
  paneId,
  index,
  isActive,
  isFocused = false,
  onSelect,
  onClose,
  canClose,
}: DraggableTabProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: createDraggableTabId(tab.id, paneId),
  });

  // Get session for this tab to check for custom name
  const sessions = useSessionStore((state) => state.sessions);
  const session = Array.from(sessions.values()).find((s) => s.tabId === tab.id);

  // Check if file tab has unsaved changes
  const isDirty = useFileDirtyStore((state) =>
    tab.type === "file" ? state.isDirty(tab.id) : false
  );

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  // Get tab title based on type and session name
  const getTabTitle = () => {
    if (tab.type === "file" && tab.fileData) {
      const parts = tab.fileData.filePath.split("/");
      return parts[parts.length - 1] || tab.fileData.filePath;
    }

    // For terminal tabs, include session name if set
    const tabNumber = index + 1;

    if (session?.name) {
      // Custom session name + number for keyboard shortcut reference
      return `${session.name} ${tabNumber}`;
    }

    // Default names
    if (tab.type === "plain") return `Terminal ${tabNumber}`;
    if (tab.type === "claude") return `Claude ${tabNumber}`;
    if (tab.type === "opencode") return `OpenCode ${tabNumber}`;
    if (tab.type === "root") return `ROOT ${tabNumber}`;
    return `Tab ${tabNumber}`;
  };

  // Get tab icon based on type
  const getTabIcon = () => {
    if (tab.type === "file") {
      return <FileCode className="h-3 w-3 shrink-0" />;
    }
    if (tab.type === "opencode") {
      return <OpenCodeIcon className="h-3 w-3 shrink-0 text-green-500" />;
    }
    if (tab.type === "claude") {
      return <ClaudeIcon className="h-3 w-3 shrink-0 text-orange-400" />;
    }
    return <TerminalIcon className="h-3 w-3 shrink-0" />;
  };

  const handleClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    onClose?.();
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          ref={setNodeRef}
          style={style}
          {...attributes}
          {...listeners}
          className={cn(
            "group relative flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-grab active:cursor-grabbing select-none",
            isActive
              ? "bg-[#1e1e1e] text-foreground"
              : "text-muted-foreground hover:text-foreground hover:bg-[#2a2a2a]",
            isDragging && "opacity-50 z-50"
          )}
          onClick={onSelect}
        >
          {/* Blue focus indicator line at top */}
          {isFocused && (
            <div className="absolute top-0 left-0 right-0 h-0.5 bg-primary" />
          )}
          {getTabIcon()}
          <span className="max-w-[120px] truncate">{getTabTitle()}</span>
          {isDirty && (
            <span
              className="h-2 w-2 rounded-full bg-muted-foreground"
              title="Unsaved changes"
            />
          )}
          {canClose && (
            <button
              className="ml-1 opacity-0 group-hover:opacity-100 hover:text-red-400 transition-opacity"
              onClick={handleClose}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </TooltipTrigger>
      {tab.type === "file" && tab.fileData && (
        <TooltipContent side="bottom">
          {tab.fileData.filePath}
        </TooltipContent>
      )}
    </Tooltip>
  );
}

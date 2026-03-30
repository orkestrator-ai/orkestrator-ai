import { useDraggable } from "@dnd-kit/core";
import { GripVertical, MessageSquare } from "lucide-react";
import type { KanbanTask } from "@/stores/kanbanStore";
import type { BuildPhase } from "@/stores/buildPipelineStore";
import { cn } from "@/lib/utils";

interface KanbanCardProps {
  task: KanbanTask;
  onClick: () => void;
  isDragOverlay?: boolean;
  buildPhase?: BuildPhase;
}

export function KanbanCard({ task, onClick, isDragOverlay, buildPhase }: KanbanCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    isDragging,
  } = useDraggable({
    id: task.id,
    data: { type: "task", task },
  });

  const style = transform
    ? { transform: `translate(${transform.x}px, ${transform.y}px)` }
    : undefined;

  const isFailed = buildPhase === "failed";
  const isBuilding = buildPhase && !["complete", "failed"].includes(buildPhase);
  const isComplete = buildPhase === "complete";
  const hasBuildStatus = isBuilding || isComplete || isFailed;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "group rounded-lg border bg-card p-3 shadow-sm cursor-pointer",
        "hover:shadow-md transition-[border-color,box-shadow,ring-color]",
        // Build status borders
        isBuilding && "border-yellow-500 ring-2 ring-yellow-500/40",
        isComplete && "border-green-500 ring-2 ring-green-500/40",
        isFailed && "border-red-500 ring-2 ring-red-500/40",
        !hasBuildStatus && "border-border hover:border-primary/50",
        isDragging && "opacity-30",
        isDragOverlay && !hasBuildStatus && "shadow-lg border-primary/50 rotate-2",
        isDragOverlay && hasBuildStatus && "shadow-lg rotate-2"
      )}
      onClick={onClick}
    >
      <div className="flex items-start gap-2">
        <button
          className="mt-0.5 shrink-0 cursor-grab active:cursor-grabbing text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity"
          {...attributes}
          {...listeners}
          onClick={(e) => e.stopPropagation()}
        >
          <GripVertical className="h-4 w-4" />
        </button>
        <div className="flex-1 min-w-0">
          <h4 className="text-sm font-medium text-foreground truncate">{task.title}</h4>
          {task.description && (
            <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
              {task.description}
            </p>
          )}
          {task.comments.length > 0 && (
            <div className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
              <MessageSquare className="h-3 w-3" />
              <span>{task.comments.length}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

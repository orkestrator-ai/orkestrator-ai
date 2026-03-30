import { useDraggable } from "@dnd-kit/core";
import { GripVertical, MessageSquare } from "lucide-react";
import type { KanbanTask } from "@/stores/kanbanStore";
import { cn } from "@/lib/utils";

interface KanbanCardProps {
  task: KanbanTask;
  onClick: () => void;
  isDragOverlay?: boolean;
}

export function KanbanCard({ task, onClick, isDragOverlay }: KanbanCardProps) {
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

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "group rounded-lg border border-border bg-card p-3 shadow-sm cursor-pointer",
        "hover:border-primary/50 hover:shadow-md transition-[border-color,box-shadow]",
        isDragging && "opacity-30",
        isDragOverlay && "shadow-lg border-primary/50 rotate-2"
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

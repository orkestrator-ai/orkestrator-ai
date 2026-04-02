import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { EnvironmentItem } from "@/components/environments/EnvironmentItem";
import type { Environment } from "@/types";
import { cn } from "@/lib/utils";

interface SortableEnvironmentItemProps {
  environment: Environment;
  isSelected: boolean;
  onSelect: (environmentId: string, modifiers?: { shiftKey?: boolean; metaKey?: boolean }) => void;
  onDelete: (environmentId: string) => void;
  onStart: (environmentId: string) => void;
  onStop: (environmentId: string) => void;
  onRestart: (environmentId: string) => void;
  onUpdate?: (environment: Environment) => void;
  isMultiSelectMode?: boolean;
  isChecked?: boolean;
}

export function SortableEnvironmentItem({
  environment,
  isSelected,
  onSelect,
  onDelete,
  onStart,
  onStop,
  onRestart,
  onUpdate,
  isMultiSelectMode = false,
  isChecked = false,
}: SortableEnvironmentItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: environment.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        isDragging && "opacity-50 z-50"
      )}
    >
      <div className={cn(
        "flex items-center group/sortable transition-colors",
        isSelected && !isMultiSelectMode
          ? "bg-zinc-900/80 border-l-2 border-l-blue-500"
          : "hover:bg-zinc-800/50 border-l-2 border-l-transparent"
      )}>
        {/* Drag handle - far left */}
        <button
          {...attributes}
          {...listeners}
          className={cn(
            "flex h-8 w-4 shrink-0 cursor-grab items-center justify-center text-muted-foreground opacity-0 transition-opacity hover:text-foreground active:cursor-grabbing",
            "group-hover/sortable:opacity-100"
          )}
        >
          <GripVertical className="h-3 w-3" />
        </button>

        {/* Environment item */}
        <div className="flex-1 min-w-0">
          <EnvironmentItem
            environment={environment}
            isSelected={isSelected}
            onSelect={onSelect}
            onDelete={onDelete}
            onStart={onStart}
            onStop={onStop}
            onRestart={onRestart}
            onUpdate={onUpdate}
            isMultiSelectMode={isMultiSelectMode}
            isChecked={isChecked}
          />
        </div>
      </div>
    </div>
  );
}

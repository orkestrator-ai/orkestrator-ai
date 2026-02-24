import { useEffect, useRef } from "react";
import { Command } from "lucide-react";
import { cn } from "@/lib/utils";
import type { OpenCodeSlashCommand } from "@/lib/opencode-client";

interface OpenCodeSlashCommandMenuProps {
  commands: OpenCodeSlashCommand[];
  selectedIndex: number;
  onSelect: (command: OpenCodeSlashCommand) => void;
  onClose: () => void;
}

export function OpenCodeSlashCommandMenu({
  commands,
  selectedIndex,
  onSelect,
  onClose,
}: OpenCodeSlashCommandMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (selectedRef.current) {
      selectedRef.current.scrollIntoView({
        block: "nearest",
        behavior: "smooth",
      });
    }
  }, [selectedIndex]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [onClose]);

  if (commands.length === 0) {
    return null;
  }

  return (
    <div
      ref={menuRef}
      className={cn(
        "absolute z-50 max-h-48 w-64 overflow-y-auto",
        "animate-in fade-in-0 zoom-in-95 rounded-md border border-border bg-popover shadow-lg",
      )}
      style={{ bottom: "100%", left: 0, marginBottom: "4px" }}
    >
      <div className="p-1">
        <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
          Slash Commands
        </div>
        {commands.map((command, index) => {
          const isSelected = index === selectedIndex;
          return (
            <button
              key={command.name}
              ref={isSelected ? selectedRef : undefined}
              onClick={() => onSelect(command)}
              className={cn(
                "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors",
                isSelected
                  ? "bg-accent text-accent-foreground"
                  : "hover:bg-accent/50 hover:text-accent-foreground",
              )}
            >
              <Command className="h-4 w-4 text-muted-foreground" />
              <span className="font-medium">{command.name}</span>
              {command.description && (
                <span className="ml-auto max-w-[120px] truncate text-xs text-muted-foreground">
                  {command.description}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

import { useEffect, useRef, useCallback } from "react";
import { Command } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SlashCommand {
  name: string;
  description?: string;
}

interface SlashCommandMenuProps {
  /** Already-filtered commands to display */
  commands: SlashCommand[];
  selectedIndex: number;
  onSelect: (command: SlashCommand) => void;
  onClose: () => void;
  position?: { top: number; left: number };
}

/**
 * SlashCommandMenu displays a list of slash commands
 * that appears when the user types "/" in the compose bar.
 *
 * Note: Commands should be pre-filtered by the parent component.
 * Keyboard navigation (arrows, enter, escape) is handled by the parent.
 */
export function SlashCommandMenu({
  commands,
  selectedIndex,
  onSelect,
  onClose,
  position,
}: SlashCommandMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLButtonElement>(null);

  // Scroll selected item into view
  useEffect(() => {
    if (selectedRef.current) {
      selectedRef.current.scrollIntoView({
        block: "nearest",
        behavior: "smooth",
      });
    }
  }, [selectedIndex]);

  // Close on click outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [onClose]);

  // Note: Escape key handling is done by the parent component's handleKeyDown

  const handleSelect = useCallback(
    (command: SlashCommand) => {
      onSelect(command);
    },
    [onSelect]
  );

  if (commands.length === 0) {
    return null;
  }

  return (
    <div
      ref={menuRef}
      className={cn(
        "absolute z-50 w-64 max-h-48 overflow-y-auto",
        "rounded-md border border-border bg-popover shadow-lg",
        "animate-in fade-in-0 zoom-in-95"
      )}
      style={
        position
          ? { bottom: position.top, left: position.left }
          : { bottom: "100%", left: 0, marginBottom: "4px" }
      }
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
              onClick={() => handleSelect(command)}
              className={cn(
                "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm",
                "transition-colors",
                isSelected
                  ? "bg-accent text-accent-foreground"
                  : "hover:bg-accent/50 hover:text-accent-foreground"
              )}
            >
              <Command className="h-4 w-4 text-muted-foreground" />
              <span className="font-medium">{command.name}</span>
              {command.description && (
                <span className="ml-auto text-xs text-muted-foreground truncate max-w-[120px]">
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

/**
 * Normalize a command name to always have the "/" prefix
 */
function normalizeCommandName(name: string): string {
  const trimmed = name.trim();
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/**
 * Parse slash commands from an array of command strings.
 * Commands come from the SDK as strings like "/compact", "/clear", etc.
 * Custom commands may have descriptions in the format "/name - description"
 */
export function parseSlashCommands(
  commandStrings: string[] | undefined
): SlashCommand[] {
  if (!commandStrings || commandStrings.length === 0) {
    return [];
  }

  const result: SlashCommand[] = [];

  for (const cmd of commandStrings) {
    // Handle format "/name - description" or just "/name"
    const dashIndex = cmd.indexOf(" - ");
    let name: string;
    let description: string | undefined;

    if (dashIndex !== -1) {
      name = normalizeCommandName(cmd.slice(0, dashIndex));
      description = cmd.slice(dashIndex + 3).trim();
    } else {
      name = normalizeCommandName(cmd);
    }

    result.push({ name, description });
  }

  // Sort alphabetically by name
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

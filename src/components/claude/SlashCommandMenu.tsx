import { useEffect, useRef, useCallback, useState } from "react";
import { Command } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SlashCommand {
  name: string;
  description?: string;
}

interface SlashCommandMenuProps {
  commands: SlashCommand[];
  filter: string;
  selectedIndex: number;
  onSelect: (command: SlashCommand) => void;
  onClose: () => void;
  position?: { top: number; left: number };
}

/**
 * SlashCommandMenu displays a filterable list of slash commands
 * that appears when the user types "/" in the compose bar.
 */
export function SlashCommandMenu({
  commands,
  filter,
  selectedIndex,
  onSelect,
  onClose,
  position,
}: SlashCommandMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLButtonElement>(null);

  // Filter commands based on input
  const filteredCommands = commands.filter((cmd) =>
    cmd.name.toLowerCase().includes(filter.toLowerCase())
  );

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

  // Close on escape
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const handleSelect = useCallback(
    (command: SlashCommand) => {
      onSelect(command);
    },
    [onSelect]
  );

  if (filteredCommands.length === 0) {
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
        {filteredCommands.map((command, index) => {
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

/**
 * Hook to manage slash command menu state
 */
export function useSlashCommandMenu(
  text: string,
  commands: SlashCommand[],
  onCommandSelect: (command: string) => void
) {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [filter, setFilter] = useState("");

  // Check if we should show the menu (text starts with "/" and we're typing a command)
  useEffect(() => {
    if (text.startsWith("/")) {
      // Extract the command being typed (everything after /)
      const spaceIndex = text.indexOf(" ");
      const currentCommand = spaceIndex === -1 ? text.slice(1) : "";

      // Only show menu if we haven't completed typing a command yet
      if (spaceIndex === -1) {
        setFilter(currentCommand);
        setIsOpen(true);
        setSelectedIndex(0);
      } else {
        setIsOpen(false);
      }
    } else {
      setIsOpen(false);
      setFilter("");
    }
  }, [text]);

  // Filter commands
  const filteredCommands = commands.filter((cmd) =>
    cmd.name.toLowerCase().includes(filter.toLowerCase())
  );

  // Handle keyboard navigation
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (!isOpen || filteredCommands.length === 0) return false;

      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          setSelectedIndex((prev) =>
            prev < filteredCommands.length - 1 ? prev + 1 : prev
          );
          return true;
        case "ArrowUp":
          event.preventDefault();
          setSelectedIndex((prev) => (prev > 0 ? prev - 1 : prev));
          return true;
        case "Tab":
        case "Enter":
          if (filteredCommands[selectedIndex]) {
            event.preventDefault();
            onCommandSelect(filteredCommands[selectedIndex].name);
            setIsOpen(false);
            return true;
          }
          return false;
        case "Escape":
          event.preventDefault();
          setIsOpen(false);
          return true;
        default:
          return false;
      }
    },
    [isOpen, filteredCommands, selectedIndex, onCommandSelect]
  );

  const handleSelect = useCallback(
    (command: SlashCommand) => {
      onCommandSelect(command.name);
      setIsOpen(false);
    },
    [onCommandSelect]
  );

  const closeMenu = useCallback(() => {
    setIsOpen(false);
  }, []);

  return {
    isOpen,
    filter,
    selectedIndex,
    filteredCommands,
    handleKeyDown,
    handleSelect,
    closeMenu,
  };
}

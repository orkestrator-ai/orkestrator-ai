import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { FileIcon } from "@/components/files-panel/FileIcon";
import type { FileCandidate } from "@/types";

interface FileMentionMenuProps {
  /** Already-filtered file candidates to display (max 8) */
  files: FileCandidate[];
  /** Currently highlighted index for keyboard navigation */
  selectedIndex: number;
  /** Called when a file is selected */
  onSelect: (file: FileCandidate) => void;
  /** Called when menu should close */
  onClose: () => void;
}

/**
 * FileMentionMenu displays a list of file candidates
 * that appears when the user types "@" in the compose bar.
 *
 * Note: Files should be pre-filtered by the parent component.
 * Keyboard navigation (arrows, enter, escape) is handled by the parent.
 */
export function FileMentionMenu({
  files,
  selectedIndex,
  onSelect,
  onClose,
}: FileMentionMenuProps) {
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

  if (files.length === 0) {
    return (
      <div
        ref={menuRef}
        role="listbox"
        aria-label="File suggestions"
        className={cn(
          "absolute z-50 w-80 max-h-48 overflow-y-auto",
          "rounded-md border border-border bg-popover shadow-lg",
          "animate-in fade-in-0 zoom-in-95"
        )}
        style={{ bottom: "100%", left: 0, marginBottom: "4px" }}
      >
        <div className="p-3 text-sm text-muted-foreground text-center" role="status">
          No files found
        </div>
      </div>
    );
  }

  return (
    <div
      ref={menuRef}
      role="listbox"
      aria-label="File suggestions"
      className={cn(
        "absolute z-50 w-80 max-h-48 overflow-y-auto",
        "rounded-md border border-border bg-popover shadow-lg",
        "animate-in fade-in-0 zoom-in-95"
      )}
      style={{ bottom: "100%", left: 0, marginBottom: "4px" }}
    >
      <div className="p-1">
        <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground" aria-hidden="true">
          Files
        </div>
        {files.map((file, index) => {
          const isSelected = index === selectedIndex;
          // Extract directory from path for display
          const directory = file.relativePath.slice(
            0,
            file.relativePath.length - file.filename.length - 1
          );

          return (
            <button
              key={file.relativePath}
              ref={isSelected ? selectedRef : undefined}
              role="option"
              aria-selected={isSelected}
              onClick={() => onSelect(file)}
              className={cn(
                "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm",
                "transition-colors",
                isSelected
                  ? "bg-accent text-accent-foreground"
                  : "hover:bg-accent/50 hover:text-accent-foreground"
              )}
            >
              <FileIcon filename={file.filename} className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="font-medium truncate">{file.filename}</span>
              {directory && (
                <span className="ml-auto text-xs text-muted-foreground truncate max-w-[140px]">
                  {directory}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

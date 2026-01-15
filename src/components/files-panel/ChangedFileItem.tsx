import { cn } from "@/lib/utils";
import { FileIcon } from "./FileIcon";
import type { GitFileChange } from "@/lib/tauri";

interface ChangedFileItemProps {
  change: GitFileChange;
  onClick?: (path: string) => void;
}

export function ChangedFileItem({ change, onClick }: ChangedFileItemProps) {
  return (
    <button
      onClick={() => onClick?.(change.path)}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
        "hover:bg-accent/50"
      )}
    >
      <FileIcon filename={change.filename} className="h-4 w-4 shrink-0" />

      <div className="min-w-0 flex-1 text-left">
        {/* Directory path in muted color */}
        {change.directory && (
          <span className="text-xs text-muted-foreground">
            {change.directory}/
          </span>
        )}
        {/* Filename in white */}
        <span className="text-foreground">{change.filename}</span>
      </div>

      {/* Line stats */}
      <div className="flex shrink-0 items-center gap-1.5 font-mono text-xs">
        {change.additions > 0 && (
          <span className="text-green-500">+{change.additions}</span>
        )}
        {change.deletions > 0 && (
          <span className="text-red-500">-{change.deletions}</span>
        )}
      </div>
    </button>
  );
}

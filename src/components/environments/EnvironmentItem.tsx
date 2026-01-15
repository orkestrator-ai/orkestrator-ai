import { useState, useEffect } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Trash2, Play, Square, Container, Shield, Globe, Settings2, RotateCw, Loader2 } from "lucide-react";
import type { Environment } from "@/types";
import { useClaudeActivityStore, useEnvironmentStore } from "@/stores";
import { EnvironmentSettingsDialog } from "./EnvironmentSettingsDialog";
import { cn } from "@/lib/utils";
import * as tauri from "@/lib/tauri";

interface EnvironmentItemProps {
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

export function EnvironmentItem({
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
}: EnvironmentItemProps) {
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showSettingsDialog, setShowSettingsDialog] = useState(false);
  // Local state to track transitioning - ensures spinner shows immediately
  const [isLocalTransitioning, setIsLocalTransitioning] = useState(false);

  // Get Claude activity state for this container
  const containerStates = useClaudeActivityStore((s) => s.containerStates);
  const claudeActivityState = environment.containerId
    ? containerStates[environment.containerId] || "idle"
    : "idle";

  // Check if this environment is being deleted
  const isEnvironmentDeleting = useEnvironmentStore((s) => s.isDeleting(environment.id));

  const isRunning = environment.status === "running";
  const isCreating = environment.status === "creating";
  const isStopping = environment.status === "stopping";
  // Use local state OR prop status for transitioning
  const isTransitioning = isLocalTransitioning || isCreating || isStopping;

  // Clear local transitioning state when environment status changes to non-transitioning
  useEffect(() => {
    if (!isCreating && !isStopping && isLocalTransitioning) {
      setIsLocalTransitioning(false);
    }
  }, [environment.status, isCreating, isStopping, isLocalTransitioning]);

  const confirmDelete = () => {
    onDelete(environment.id);
    setShowDeleteDialog(false);
  };

  const handleEnvironmentUpdate = (updated: Environment) => {
    // Set local transitioning state for immediate spinner feedback
    if (updated.status === "creating" || updated.status === "stopping") {
      setIsLocalTransitioning(true);
    } else {
      setIsLocalTransitioning(false);
    }
    onUpdate?.(updated);
  };

  // Get network mode with null safety (defaults to "restricted")
  const networkMode = environment.networkAccessMode ?? "restricted";

  const handleCheckboxChange = () => {
    // Toggle individual item selection (Cmd/Ctrl+Click behavior)
    onSelect(environment.id, { metaKey: true });
  };

  const handleSelect = (modifiers?: { shiftKey?: boolean; metaKey?: boolean }) => {
    onSelect(environment.id, modifiers);
  };

  const handleClick = (e: React.MouseEvent) => {
    // Pass modifier key states to parent for multi-select handling
    // metaKey covers Cmd on Mac, ctrlKey covers Ctrl on Windows/Linux
    handleSelect({
      shiftKey: e.shiftKey,
      metaKey: e.metaKey || e.ctrlKey
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      // For keyboard navigation, we don't have modifier key context
      // Default behavior is simple selection
      handleSelect({
        shiftKey: e.shiftKey,
        metaKey: e.metaKey || e.ctrlKey
      });
    }
  };

  const createdDate = new Date(environment.createdAt).toLocaleDateString();

  return (
    <>
      <ContextMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <ContextMenuTrigger asChild>
              <div
                role="button"
                tabIndex={0}
                onClick={handleClick}
                onKeyDown={handleKeyDown}
                className={cn(
                  "group flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                  isSelected && !isMultiSelectMode
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                  isChecked && isMultiSelectMode && "bg-accent/30",
                  (isStopping || isEnvironmentDeleting) && "opacity-60"
                )}
              >
                {isEnvironmentDeleting ? (
                  // Show red spinner when deleting (priority over multi-select checkbox)
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-destructive" />
                ) : isMultiSelectMode ? (
                  <Checkbox
                    checked={isChecked}
                    onCheckedChange={handleCheckboxChange}
                    onClick={(e) => e.stopPropagation()}
                    className="h-4 w-4 shrink-0"
                  />
                ) : isTransitioning ? (
                  // Show spinner when creating/stopping
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-amber-500" />
                ) : (
                  <Container className={cn(
                    "h-4 w-4 shrink-0 transition-colors",
                    // Stopped/error: gray (default)
                    !isRunning && "text-muted-foreground",
                    // Running + waiting for input: yellow pulsing
                    isRunning && claudeActivityState === "waiting" && "text-amber-500 animate-pulse",
                    // Running + working: blue pulsing
                    isRunning && claudeActivityState === "working" && "text-blue-500 animate-pulse",
                    // Running + idle: green
                    isRunning && claudeActivityState === "idle" && "text-green-500"
                  )} />
                )}
                <span className="flex-1 truncate">{environment.name}</span>
              </div>
            </ContextMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="start" sideOffset={4}>
            <div className="space-y-1">
              <p className="font-medium">{environment.name}</p>
              <p className="text-xs text-muted-foreground">Created: {createdDate}</p>
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                {networkMode === "full" ? (
                  <>
                    <Globe className="h-3 w-3" />
                    Full network access
                  </>
                ) : (
                  <>
                    <Shield className="h-3 w-3" />
                    Restricted network
                  </>
                )}
              </p>
              {environment.prUrl && (
                <p className="text-xs text-blue-400">PR: {environment.prUrl}</p>
              )}
            </div>
          </TooltipContent>
        </Tooltip>
        <ContextMenuContent>
          <ContextMenuItem onClick={() => setShowSettingsDialog(true)}>
            <Settings2 className="h-4 w-4 mr-2" />
            Settings
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => isRunning ? onStop(environment.id) : onStart(environment.id)} disabled={isTransitioning}>
            {isRunning ? (
              <>
                <Square className="h-4 w-4 mr-2" />
                Stop
              </>
            ) : (
              <>
                <Play className="h-4 w-4 mr-2" />
                Start
              </>
            )}
          </ContextMenuItem>
          <ContextMenuItem onClick={() => onRestart(environment.id)} disabled={!isRunning || isTransitioning}>
            <RotateCw className="h-4 w-4 mr-2" />
            Restart
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onClick={() => setShowDeleteDialog(true)}>
            <Trash2 className="h-4 w-4 mr-2" />
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Environment</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete <strong>{environment.name}</strong>?
              {isRunning && (
                <span className="block mt-2 text-orange-500">
                  Warning: This environment is currently running. It will be stopped before deletion.
                </span>
              )}
              {environment.prUrl && (
                <span className="block mt-2">
                  This environment has an associated PR that will remain open.
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Environment Settings Dialog */}
      <EnvironmentSettingsDialog
        open={showSettingsDialog}
        onOpenChange={setShowSettingsDialog}
        environment={environment}
        onUpdate={handleEnvironmentUpdate}
        onRestart={tauri.recreateEnvironment}
      />
    </>
  );
}

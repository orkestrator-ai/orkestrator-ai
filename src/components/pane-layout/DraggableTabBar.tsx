import { useMemo, useState, useCallback } from "react";
import {
  SortableContext,
  horizontalListSortingStrategy,
} from "@dnd-kit/sortable";
import { usePaneLayoutStore, useFileDirtyStore } from "@/stores";
import type { PaneLeaf } from "@/types/paneLayout";
import { createDraggableTabId, parseDraggableTabId } from "@/types/paneLayout";
import { cn } from "@/lib/utils";
import { DraggableTab } from "./DraggableTab";
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

interface DraggableTabBarProps {
  pane: PaneLeaf;
  onTabSelect: (tabId: string) => void;
  isDropTarget?: boolean;
  /** Currently dragged tab ID (for cross-pane visual feedback) */
  activeDragId?: string | null;
  /** Pane ID currently being dragged over */
  dragOverPaneId?: string | null;
  /** Whether this pane is the focused pane */
  isPaneFocused?: boolean;
}

export function DraggableTabBar({
  pane,
  onTabSelect,
  isDropTarget = false,
  activeDragId,
  dragOverPaneId,
  isPaneFocused = false,
}: DraggableTabBarProps) {
  const { removeTab } = usePaneLayoutStore();
  const { isDirty, clearDirty } = useFileDirtyStore();

  // State for unsaved changes confirmation dialog
  const [pendingCloseTabId, setPendingCloseTabId] = useState<string | null>(null);

  // Create sortable IDs for all tabs in this pane
  // When a tab from another pane is being dragged over this pane,
  // include it in the sortable items so dnd-kit can show visual feedback
  const sortableIds = useMemo(() => {
    const ids: string[] = pane.tabs.map((tab) =>
      createDraggableTabId(tab.id, pane.id)
    );

    // If a tab from another pane is being dragged over this pane, add it to the list
    if (activeDragId && dragOverPaneId === pane.id) {
      const draggedTab = parseDraggableTabId(activeDragId);
      // Only add if it's from a different pane (cross-pane drag)
      if (draggedTab && draggedTab.paneId !== pane.id) {
        ids.push(activeDragId);
      }
    }

    return ids;
  }, [pane.tabs, pane.id, activeDragId, dragOverPaneId]);

  // All tabs can be closed
  const canClose = true;

  const handleClose = useCallback((tabId: string) => {
    // Check if this is a file tab with unsaved changes
    const tab = pane.tabs.find((t) => t.id === tabId);
    if (tab?.type === "file" && isDirty(tabId)) {
      // Show confirmation dialog
      setPendingCloseTabId(tabId);
      return;
    }
    // No unsaved changes, close immediately
    removeTab(pane.id, tabId);
  }, [pane.tabs, pane.id, isDirty, removeTab]);

  const handleConfirmClose = useCallback(() => {
    if (pendingCloseTabId) {
      // Clear dirty state and close the tab
      clearDirty(pendingCloseTabId);
      removeTab(pane.id, pendingCloseTabId);
      setPendingCloseTabId(null);
    }
  }, [pendingCloseTabId, pane.id, clearDirty, removeTab]);

  const handleCancelClose = useCallback(() => {
    setPendingCloseTabId(null);
  }, []);

  // Always show tab bar when there's at least one tab (even for single-tab panes).
  // This provides a consistent drag-drop target for cross-pane tab moves and
  // makes it clear which pane is which. Only hide when truly empty.
  if (pane.tabs.length === 0) {
    return null;
  }

  // Get the filename from the pending close tab for the dialog
  const pendingCloseTab = pendingCloseTabId
    ? pane.tabs.find((t) => t.id === pendingCloseTabId)
    : null;
  const pendingFileName = pendingCloseTab?.fileData?.filePath?.split("/").pop() ?? "this file";

  return (
    <>
      <div
        className={cn(
          "flex items-center gap-0.5 border-b border-border bg-[#252526] px-1 min-h-[32px]",
          isDropTarget && "bg-primary/10"
        )}
      >
        <SortableContext
          items={sortableIds}
          strategy={horizontalListSortingStrategy}
        >
          {pane.tabs.map((tab, index) => {
            const isActive = tab.id === pane.activeTabId;
            return (
              <DraggableTab
                key={tab.id}
                tab={tab}
                paneId={pane.id}
                index={index}
                isActive={isActive}
                isFocused={isActive && isPaneFocused}
                onSelect={() => onTabSelect(tab.id)}
                onClose={() => handleClose(tab.id)}
                canClose={canClose}
              />
            );
          })}
        </SortableContext>
      </div>

      {/* Confirmation dialog for closing tabs with unsaved changes */}
      <AlertDialog open={pendingCloseTabId !== null} onOpenChange={(open) => !open && handleCancelClose()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unsaved Changes</AlertDialogTitle>
            <AlertDialogDescription>
              You have unsaved changes in {pendingFileName}. Are you sure you want to close this tab? Your changes will be lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleCancelClose}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmClose} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Close Without Saving
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

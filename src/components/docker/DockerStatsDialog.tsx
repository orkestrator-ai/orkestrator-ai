import { useState, useEffect, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Loader2,
  Container,
  RefreshCw,
  Trash2,
  AlertCircle,
  CheckCircle2,
  XCircle,
  Square,
  X,
} from "lucide-react";
import * as tauri from "@/lib/tauri";
import type { DockerSystemStats, ContainerInfo, SystemPruneResult } from "@/lib/tauri";
import { useProjectStore } from "@/stores";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

interface DockerStatsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Format bytes to human readable string */
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

/** Format Unix timestamp to relative time */
function formatRelativeTime(timestamp: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - timestamp;

  // Handle future timestamps (e.g., due to clock skew)
  if (diff < 0) return "just now";
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function DockerStatsDialog({ open, onOpenChange }: DockerStatsDialogProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<DockerSystemStats | null>(null);
  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  const [showCleanupConfirm, setShowCleanupConfirm] = useState(false);
  const [isCleaningUp, setIsCleaningUp] = useState(false);
  const [cleanupResult, setCleanupResult] = useState<number | null>(null);
  // Track individual container operations
  const [stoppingContainerId, setStoppingContainerId] = useState<string | null>(null);
  const [deletingContainerId, setDeletingContainerId] = useState<string | null>(null);
  // System prune state
  const [showPruneConfirm, setShowPruneConfirm] = useState(false);
  const [isPruning, setIsPruning] = useState(false);
  const [pruneResult, setPruneResult] = useState<SystemPruneResult | null>(null);
  const [pruneVolumes, setPruneVolumes] = useState(false);

  // Get project lookup function
  const getProjectById = useProjectStore((state) => state.getProjectById);

  // Count orphaned containers
  const orphanedCount = containers.filter(c => !c.isAssigned).length;

  const loadData = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    setCleanupResult(null);

    try {
      const [statsData, containersData] = await Promise.all([
        tauri.getDockerSystemStats(),
        tauri.getOrkestratorContainers(),
      ]);
      setStats(statsData);
      setContainers(containersData);
    } catch (err) {
      console.error("[DockerStatsDialog] Failed to load data:", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Load data when dialog opens
  useEffect(() => {
    if (open) {
      loadData();
    } else {
      // Reset state when closing
      setStats(null);
      setContainers([]);
      setError(null);
      setCleanupResult(null);
      setPruneResult(null);
      setPruneVolumes(false);
    }
  }, [open, loadData]);

  const handleCleanup = async () => {
    setIsCleaningUp(true);
    try {
      const removed = await tauri.cleanupOrphanedContainers();
      setCleanupResult(removed);
      // Refresh the containers list
      const containersData = await tauri.getOrkestratorContainers();
      setContainers(containersData);
    } catch (err) {
      console.error("[DockerStatsDialog] Cleanup failed:", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsCleaningUp(false);
      setShowCleanupConfirm(false);
    }
  };

  const handleStopContainer = async (containerId: string) => {
    setStoppingContainerId(containerId);
    setError(null);
    try {
      await tauri.dockerStopContainer(containerId);
      // Refresh the containers list
      const containersData = await tauri.getOrkestratorContainers();
      setContainers(containersData);
    } catch (err) {
      console.error("[DockerStatsDialog] Stop container failed:", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStoppingContainerId(null);
    }
  };

  const handleDeleteContainer = async (containerId: string) => {
    setDeletingContainerId(containerId);
    setError(null);
    try {
      await tauri.dockerRemoveContainer(containerId);
      // Refresh the containers list
      const containersData = await tauri.getOrkestratorContainers();
      setContainers(containersData);
    } catch (err) {
      console.error("[DockerStatsDialog] Delete container failed:", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingContainerId(null);
    }
  };

  const handleSystemPrune = async () => {
    setIsPruning(true);
    setError(null);
    try {
      const result = await tauri.dockerSystemPrune(pruneVolumes);
      setPruneResult(result);
      // Refresh stats after prune
      const statsData = await tauri.getDockerSystemStats();
      setStats(statsData);
      // Also refresh containers list
      const containersData = await tauri.getOrkestratorContainers();
      setContainers(containersData);
    } catch (err) {
      console.error("[DockerStatsDialog] System prune failed:", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsPruning(false);
      setShowPruneConfirm(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[850px] max-h-[90vh] flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <Container className="h-5 w-5" />
            Docker Configuration
          </DialogTitle>
          <DialogDescription>
            View Docker resource usage and manage Orkestrator containers (Orks).
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-6 py-4">
          {/* Error Display */}
          {error && (
            <div className="flex items-center gap-2 p-3 rounded-md bg-destructive/10 text-destructive text-sm">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Loading State */}
          {isLoading && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              <span className="ml-2 text-muted-foreground">Loading Docker stats...</span>
            </div>
          )}

          {/* System Stats */}
          {!isLoading && stats && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">System Resources</h3>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShowPruneConfirm(true)}
                    disabled={isPruning}
                  >
                    {isPruning ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                        Pruning...
                      </>
                    ) : (
                      <>
                        <Trash2 className="h-4 w-4 mr-1" />
                        Clean Up
                      </>
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={loadData}
                    disabled={isLoading}
                  >
                    <RefreshCw className={`h-4 w-4 mr-1 ${isLoading ? "animate-spin" : ""}`} />
                    Refresh
                  </Button>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-4">
                {/* CPU */}
                <div className="text-center p-3 rounded-md bg-muted/50 border border-input">
                  <div className="text-xs text-muted-foreground uppercase tracking-wide">CPU</div>
                  <div className="text-lg font-semibold mt-1">
                    {stats.cpuUsagePercent}% <span className="text-xs font-normal text-muted-foreground">({stats.cpus} cores)</span>
                  </div>
                  <Progress
                    value={Math.min(stats.cpuUsagePercent, 100)}
                    className="mt-2 h-1"
                  />
                </div>

                {/* Memory */}
                <div className="text-center p-3 rounded-md bg-muted/50 border border-input">
                  <div className="text-xs text-muted-foreground uppercase tracking-wide">MEMORY</div>
                  <div className="text-lg font-semibold mt-1">
                    {formatBytes(stats.memoryUsed)} / {formatBytes(stats.memoryTotal)}
                  </div>
                  <Progress
                    value={stats.memoryTotal > 0 ? (stats.memoryUsed / stats.memoryTotal) * 100 : 0}
                    className="mt-2 h-1"
                  />
                </div>

                {/* Disk Usage */}
                <div className="text-center p-3 rounded-md bg-muted/50 border border-input">
                  <div className="text-xs text-muted-foreground uppercase tracking-wide">DISK</div>
                  <div className="text-lg font-semibold mt-1">
                    {stats.diskTotal > 0
                      ? `${formatBytes(stats.diskUsed)} / ${formatBytes(stats.diskTotal)}`
                      : formatBytes(stats.diskUsed)}
                  </div>
                  <Progress
                    value={stats.diskTotal > 0 ? (stats.diskUsed / stats.diskTotal) * 100 : 0}
                    className="mt-2 h-1"
                  />
                </div>
              </div>

              {/* Container/Image Stats */}
              <div className="grid grid-cols-3 gap-4">
                <div className="text-center p-3 rounded-md bg-muted/50 border border-input">
                  <div className="text-lg font-semibold">{stats.containersRunning}</div>
                  <div className="text-xs text-muted-foreground">Running</div>
                </div>
                <div className="text-center p-3 rounded-md bg-muted/50 border border-input">
                  <div className="text-lg font-semibold">{stats.containersTotal}</div>
                  <div className="text-xs text-muted-foreground">Containers</div>
                </div>
                <div className="text-center p-3 rounded-md bg-muted/50 border border-input">
                  <div className="text-lg font-semibold">{stats.imagesTotal}</div>
                  <div className="text-xs text-muted-foreground">Images</div>
                </div>
              </div>
            </div>
          )}

          {/* Cleanup Success Message */}
          {cleanupResult !== null && (
            <div className="flex items-center gap-2 p-3 rounded-md bg-green-500/10 text-green-700 dark:text-green-400 text-sm">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              <span>
                {cleanupResult === 0
                  ? "No orphaned containers to remove."
                  : `Successfully removed ${cleanupResult} orphaned container${cleanupResult > 1 ? "s" : ""}.`}
              </span>
            </div>
          )}

          {/* System Prune Success Message */}
          {pruneResult !== null && (
            <div className="flex items-start gap-2 p-3 rounded-md bg-green-500/10 text-green-700 dark:text-green-400 text-sm">
              <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
              <div className="flex-1">
                {pruneResult.containersDeleted === 0 &&
                 pruneResult.imagesDeleted === 0 &&
                 pruneResult.networksDeleted === 0 &&
                 pruneResult.volumesDeleted === 0 ? (
                  <div className="font-medium">Nothing to clean up</div>
                ) : (
                  <>
                    <div className="font-medium">Docker cleanup completed</div>
                    <div className="text-xs mt-1 space-y-0.5 opacity-80">
                      {pruneResult.containersDeleted > 0 && (
                        <div>{pruneResult.containersDeleted} container{pruneResult.containersDeleted > 1 ? "s" : ""} removed</div>
                      )}
                      {pruneResult.imagesDeleted > 0 && (
                        <div>{pruneResult.imagesDeleted} image{pruneResult.imagesDeleted > 1 ? "s" : ""} removed</div>
                      )}
                      {pruneResult.networksDeleted > 0 && (
                        <div>{pruneResult.networksDeleted} network{pruneResult.networksDeleted > 1 ? "s" : ""} removed</div>
                      )}
                      {pruneResult.volumesDeleted > 0 && (
                        <div>{pruneResult.volumesDeleted} volume{pruneResult.volumesDeleted > 1 ? "s" : ""} removed</div>
                      )}
                      <div className="font-medium mt-1">
                        {formatBytes(pruneResult.spaceReclaimed)} reclaimed
                      </div>
                    </div>
                  </>
                )}
              </div>
              <button
                onClick={() => setPruneResult(null)}
                className="shrink-0 p-0.5 rounded hover:bg-green-500/20 transition-colors"
                aria-label="Dismiss"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}

          {/* Orkestrator Containers */}
          {!isLoading && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">Orkestrator Containers</h3>
                {orphanedCount > 0 && (
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => setShowCleanupConfirm(true)}
                    disabled={isCleaningUp}
                  >
                    {isCleaningUp ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                        Cleaning...
                      </>
                    ) : (
                      <>
                        <Trash2 className="h-4 w-4 mr-1" />
                        Clean Up ({orphanedCount})
                      </>
                    )}
                  </Button>
                )}
              </div>

              {containers.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">
                  No Orkestrator containers found.
                </p>
              ) : (
                <div className="space-y-2 max-h-[200px] overflow-y-auto">
                  {containers.map((container) => {
                    const isOrphaned = !container.isAssigned;
                    const isStopping = stoppingContainerId === container.id;
                    const isDeleting = deletingContainerId === container.id;
                    const isOperating = isStopping || isDeleting;
                    const isRunning = container.state === "running";
                    const project = container.projectId ? getProjectById(container.projectId) : null;

                    return (
                      <div
                        key={container.id}
                        className={`flex items-center justify-between p-3 rounded-md ${
                          isOrphaned
                            ? "bg-red-500/10 border border-red-500/30"
                            : "bg-muted/50"
                        }`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className={`font-medium text-sm truncate ${isOrphaned ? "text-red-700 dark:text-red-400" : ""}`}>
                              {container.name}
                              {project && (
                                <span className="text-muted-foreground font-normal ml-1">
                                  ({project.name})
                                </span>
                              )}
                            </span>
                            {isOrphaned && (
                              <span className="text-xs px-1.5 py-0.5 rounded bg-red-500/20 text-red-700 dark:text-red-400">
                                Orphaned
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {container.id.substring(0, 12)} · {formatRelativeTime(container.created)}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          {isRunning && container.cpuPercent !== null && (
                            <span className="text-xs text-muted-foreground">
                              CPU: {container.cpuPercent}%
                            </span>
                          )}
                          <div className="flex items-center gap-1">
                            {isRunning ? (
                              <CheckCircle2 className="h-4 w-4 text-green-500" />
                            ) : (
                              <XCircle className="h-4 w-4 text-muted-foreground" />
                            )}
                            <span className="text-xs capitalize">{container.state}</span>
                          </div>

                          {/* Stop/Delete buttons for orphaned containers */}
                          {isOrphaned && (
                            <div className="flex items-center gap-1 ml-2">
                              {isRunning && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 text-orange-600 hover:text-orange-700 hover:bg-orange-100 dark:hover:bg-orange-900/30"
                                  onClick={() => handleStopContainer(container.id)}
                                  disabled={isOperating}
                                  title="Stop container"
                                >
                                  {isStopping ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                  ) : (
                                    <Square className="h-4 w-4" />
                                  )}
                                </Button>
                              )}
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 text-red-600 hover:text-red-700 hover:bg-red-100 dark:hover:bg-red-900/30"
                                onClick={() => handleDeleteContainer(container.id)}
                                disabled={isOperating}
                                title="Delete container"
                              >
                                {isDeleting ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                  <Trash2 className="h-4 w-4" />
                                )}
                              </Button>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {orphanedCount > 0 && (
                <p className="text-xs text-muted-foreground">
                  Orphaned containers are not assigned to any environment in the app.
                  Cleaning them up will permanently delete them.
                </p>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>

      {/* Cleanup Confirmation Dialog */}
      <AlertDialog open={showCleanupConfirm} onOpenChange={setShowCleanupConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clean Up Orphaned Containers?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete {orphanedCount} container{orphanedCount > 1 ? "s" : ""} that {orphanedCount > 1 ? "are" : "is"} not assigned to any environment.
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isCleaningUp}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleCleanup}
              disabled={isCleaningUp}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isCleaningUp ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Cleaning...
                </>
              ) : (
                "Delete Containers"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* System Prune Confirmation Dialog */}
      <AlertDialog open={showPruneConfirm} onOpenChange={(open) => {
        setShowPruneConfirm(open);
        if (!open) setPruneVolumes(false);
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clean Up Docker Resources?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>
                  This will remove unused Docker resources to free up disk space:
                </p>
                <ul className="list-disc list-inside text-sm space-y-1">
                  <li>Stopped containers</li>
                  <li>Dangling images (untagged)</li>
                  <li>Unused networks</li>
                </ul>
                <div className="flex items-center space-x-2 pt-2">
                  <Checkbox
                    id="prune-volumes"
                    checked={pruneVolumes}
                    onCheckedChange={(checked) => setPruneVolumes(checked === true)}
                  />
                  <Label
                    htmlFor="prune-volumes"
                    className="text-sm font-normal cursor-pointer"
                  >
                    Also remove unused volumes (may delete data)
                  </Label>
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPruning}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleSystemPrune}
              disabled={isPruning}
            >
              {isPruning ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Cleaning...
                </>
              ) : (
                "Clean Up"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}

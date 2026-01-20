// Hook for managing environment operations with Tauri backend
import { useCallback, useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { useEnvironmentStore, useErrorDialogStore } from "@/stores";
import { useSessionStore } from "@/stores/sessionStore";
import * as tauri from "@/lib/tauri";
import type { EnvironmentType, NetworkAccessMode, PortMapping, PrState } from "@/types";

/**
 * Extract error message from various error types.
 * Tauri errors can come as plain strings, Error objects, or objects with error info.
 */
function getErrorMessage(err: unknown, fallback: string): string {
  if (typeof err === "string") {
    return err;
  }
  if (err instanceof Error) {
    return err.message;
  }
  if (err && typeof err === "object" && "message" in err && typeof err.message === "string") {
    return err.message;
  }
  return fallback;
}

/**
 * Truncate a message for display in toast notifications.
 * Full message can be shown via the Details dialog.
 */
function truncateForToast(message: string, maxLength = 50): string {
  return message.length > maxLength ? `${message.slice(0, maxLength)}...` : message;
}

/** Payload emitted when an environment is renamed in the background */
interface EnvironmentRenamedPayload {
  environment_id: string;
  new_name: string;
  new_branch: string;
}

export function useEnvironments(projectId: string | null) {
  const {
    environments,
    isLoading,
    error,
    mergeEnvironmentsForProject,
    addEnvironment: addEnvironmentToStore,
    removeEnvironment: removeEnvironmentFromStore,
    updateEnvironment: updateEnvironmentInStore,
    updateEnvironmentStatus: updateStatusInStore,
    setEnvironmentPR: setPRInStore,
    reorderEnvironments: reorderEnvironmentsInStore,
    setLoading,
    setError,
    getEnvironmentsByProjectId,
    setDeleting,
  } = useEnvironmentStore();

  const {
    disconnectEnvironmentSessions,
    deleteSessionsByEnvironment,
  } = useSessionStore();

  const { showError } = useErrorDialogStore();

  // Load environments when projectId changes
  useEffect(() => {
    if (projectId) {
      loadEnvironments(projectId);
    }
  }, [projectId]);

  // Listen for background environment rename events
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;

    const setupListener = async () => {
      unlisten = await listen<EnvironmentRenamedPayload>("environment-renamed", (event) => {
        console.log("[useEnvironments] Received environment-renamed event:", event.payload);
        const { environment_id, new_name, new_branch } = event.payload;

        // Update the environment in the store with the new name and branch
        updateEnvironmentInStore(environment_id, {
          name: new_name,
          branch: new_branch,
        });
      });
    };

    setupListener();

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, [updateEnvironmentInStore]);

  const loadEnvironments = useCallback(
    async (pid: string) => {
      setLoading(true);
      setError(null);
      try {
        const envs = await tauri.getEnvironments(pid);
        // Merge environments for this project (uses current store state, not stale closure)
        mergeEnvironmentsForProject(pid, envs);
      } catch (err) {
        setError(getErrorMessage(err, "Failed to load environments"));
      } finally {
        setLoading(false);
      }
    },
    [mergeEnvironmentsForProject, setLoading, setError]
  );

  const createEnvironment = useCallback(
    async (pid: string, name?: string, networkAccessMode?: NetworkAccessMode, initialPrompt?: string, portMappings?: PortMapping[], environmentType?: EnvironmentType) => {
      setLoading(true);
      setError(null);
      try {
        const environment = await tauri.createEnvironment(pid, name, networkAccessMode, initialPrompt, portMappings, environmentType);
        addEnvironmentToStore(environment);
        toast.success("Environment created");
        return environment;
      } catch (err) {
        const message = getErrorMessage(err, "Failed to create environment");
        setError(message);
        toast.error("Failed to create environment", {
          description: truncateForToast(message),
          action: {
            label: "Details",
            onClick: () => showError("Failed to create environment", message),
          },
        });
        throw new Error(message);
      } finally {
        setLoading(false);
      }
    },
    [addEnvironmentToStore, setLoading, setError, showError]
  );

  const deleteEnvironment = useCallback(
    async (environmentId: string) => {
      setDeleting(environmentId, true);
      setError(null);
      try {
        // Delete all sessions for this environment first (cleans up buffer files too)
        await deleteSessionsByEnvironment(environmentId);

        await tauri.deleteEnvironment(environmentId);
        removeEnvironmentFromStore(environmentId);
        toast.success("Environment deleted");
      } catch (err) {
        const message = getErrorMessage(err, "Failed to delete environment");
        setError(message);
        toast.error("Failed to delete environment", {
          description: truncateForToast(message),
          action: {
            label: "Details",
            onClick: () => showError("Failed to delete environment", message),
          },
        });
        throw new Error(message);
      } finally {
        setDeleting(environmentId, false);
      }
    },
    [removeEnvironmentFromStore, setError, deleteSessionsByEnvironment, setDeleting, showError]
  );

  const startEnvironment = useCallback(
    async (environmentId: string) => {
      console.log("[useEnvironments] startEnvironment called:", environmentId);
      const existingEnv = environments.find((env) => env.id === environmentId);
      if (existingEnv) {
        console.info("[useEnvironments] startEnvironment snapshot:", {
          environmentId,
          environmentType: existingEnv.environmentType,
          status: existingEnv.status,
          branch: existingEnv.branch,
          worktreePath: existingEnv.worktreePath,
          projectId: existingEnv.projectId,
        });
      }
      setError(null);
      try {
        console.log("[useEnvironments] Setting status to creating...");
        updateStatusInStore(environmentId, "creating");
        console.log("[useEnvironments] Calling tauri.startEnvironment...");
        await tauri.startEnvironment(environmentId);
        console.log("[useEnvironments] tauri.startEnvironment completed, refreshing environment...");
        // Refresh the full environment data (including containerId)
        const updatedEnv = await tauri.getEnvironment(environmentId);
        if (updatedEnv) {
          console.log("[useEnvironments] Got updated environment:", updatedEnv);
          if (updatedEnv.environmentType === "local" && !updatedEnv.worktreePath) {
            console.warn("[useEnvironments] Local environment started without worktreePath:", {
              environmentId,
              status: updatedEnv.status,
              branch: updatedEnv.branch,
            });
          }
          updateEnvironmentInStore(environmentId, updatedEnv);
        }
        toast.success("Environment started");
      } catch (err) {
        console.error("[useEnvironments] Error starting environment:", err);
        const message = getErrorMessage(err, "Failed to start environment");
        setError(message);
        updateStatusInStore(environmentId, "error");
        toast.error("Failed to start environment", {
          description: truncateForToast(message),
          action: {
            label: "Details",
            onClick: () => showError("Failed to start environment", message),
          },
        });
        throw new Error(message);
      }
    },
    [updateStatusInStore, updateEnvironmentInStore, setError, showError]
  );

  const stopEnvironment = useCallback(
    async (environmentId: string) => {
      console.log("[useEnvironments] stopEnvironment called:", environmentId);
      setError(null);
      try {
        // Immediately set status to stopping for user feedback
        console.log("[useEnvironments] Setting status to stopping...");
        updateStatusInStore(environmentId, "stopping");
        console.log("[useEnvironments] Calling tauri.stopEnvironment...");
        await tauri.stopEnvironment(environmentId);
        console.log("[useEnvironments] tauri.stopEnvironment completed, updating status...");
        updateStatusInStore(environmentId, "stopped");
        console.log("[useEnvironments] Status updated to stopped");

        // Disconnect all sessions for this environment since container is stopped
        console.log("[useEnvironments] Disconnecting sessions for environment...");
        await disconnectEnvironmentSessions(environmentId);
        console.log("[useEnvironments] Sessions disconnected");
        toast.success("Environment stopped");
      } catch (err) {
        console.error("[useEnvironments] Error stopping environment:", err);
        const message = getErrorMessage(err, "Failed to stop environment");
        setError(message);
        // Revert to running if stop failed
        updateStatusInStore(environmentId, "running");
        toast.error("Failed to stop environment", {
          description: truncateForToast(message),
          action: {
            label: "Details",
            onClick: () => showError("Failed to stop environment", message),
          },
        });
        throw new Error(message);
      }
    },
    [updateStatusInStore, setError, disconnectEnvironmentSessions, showError]
  );

  const setEnvironmentPR = useCallback(
    async (environmentId: string, prUrl: string | null, prState: PrState | null) => {
      try {
        await setPRInStore(environmentId, prUrl, prState);
      } catch (err) {
        const message = getErrorMessage(err, "Failed to set PR URL");
        setError(message);
        toast.error("Failed to set PR URL", {
          description: truncateForToast(message),
          action: {
            label: "Details",
            onClick: () => showError("Failed to set PR URL", message),
          },
        });
        throw new Error(message);
      }
    },
    [setPRInStore, setError, showError]
  );

  const syncEnvironmentStatus = useCallback(
    async (environmentId: string) => {
      try {
        const updatedEnv = await tauri.syncEnvironmentStatus(environmentId);
        updateEnvironmentInStore(environmentId, updatedEnv);
        return updatedEnv;
      } catch (err) {
        console.error("[useEnvironments] Error syncing environment status:", err);
        // Don't throw - just log the error
      }
    },
    [updateEnvironmentInStore]
  );

  const reorderEnvironments = useCallback(
    async (pid: string, environmentIds: string[]) => {
      // Optimistically update the store
      reorderEnvironmentsInStore(pid, environmentIds);
      try {
        // Persist to backend
        const reorderedEnvs = await tauri.reorderEnvironments(pid, environmentIds);
        // Update with the server response (uses current store state, not stale closure)
        mergeEnvironmentsForProject(pid, reorderedEnvs);
      } catch (err) {
        // Reload from backend on error to restore correct state
        const message = getErrorMessage(err, "Failed to reorder environments");
        setError(message);
        toast.error("Failed to reorder environments", {
          description: truncateForToast(message),
          action: {
            label: "Details",
            onClick: () => showError("Failed to reorder environments", message),
          },
        });
        if (pid) {
          await loadEnvironments(pid);
        }
        throw new Error(message);
      }
    },
    [reorderEnvironmentsInStore, mergeEnvironmentsForProject, setError, loadEnvironments, showError]
  );

  const updatePortMappings = useCallback(
    async (environmentId: string, portMappings: PortMapping[]) => {
      try {
        const updated = await tauri.updatePortMappings(environmentId, portMappings);
        updateEnvironmentInStore(environmentId, updated);
        return updated;
      } catch (err) {
        const message = getErrorMessage(err, "Failed to update port mappings");
        setError(message);
        toast.error("Failed to update port mappings", {
          description: truncateForToast(message),
          action: {
            label: "Details",
            onClick: () => showError("Failed to update port mappings", message),
          },
        });
        throw new Error(message);
      }
    },
    [updateEnvironmentInStore, setError, showError]
  );

  const restartEnvironment = useCallback(
    async (environmentId: string) => {
      setError(null);
      try {
        // Stop the environment
        updateStatusInStore(environmentId, "stopping");
        await tauri.stopEnvironment(environmentId);

        // Disconnect all sessions since container is stopped
        await disconnectEnvironmentSessions(environmentId);

        // Start it again
        updateStatusInStore(environmentId, "creating");
        await tauri.startEnvironment(environmentId);

        // Refresh the full environment data
        const updatedEnv = await tauri.getEnvironment(environmentId);
        if (updatedEnv) {
          updateEnvironmentInStore(environmentId, updatedEnv);
        }
        toast.success("Environment restarted");
      } catch (err) {
        console.error("[useEnvironments] Error restarting environment:", err);
        const message = getErrorMessage(err, "Failed to restart environment");
        setError(message);
        updateStatusInStore(environmentId, "error");
        toast.error("Failed to restart environment", {
          description: truncateForToast(message),
          action: {
            label: "Details",
            onClick: () => showError("Failed to restart environment", message),
          },
        });
        throw new Error(message);
      }
    },
    [updateStatusInStore, updateEnvironmentInStore, setError, disconnectEnvironmentSessions, showError]
  );

  // Get environments for the current project
  const projectEnvironments = projectId ? getEnvironmentsByProjectId(projectId) : [];

  return {
    environments: projectEnvironments,
    allEnvironments: environments,
    isLoading,
    error,
    loadEnvironments,
    createEnvironment,
    deleteEnvironment,
    startEnvironment,
    stopEnvironment,
    restartEnvironment,
    setEnvironmentPR,
    syncEnvironmentStatus,
    reorderEnvironments,
    updateEnvironment: updateEnvironmentInStore,
    getEnvironmentsByProjectId,
    updatePortMappings,
  };
}

import { useEffect, useCallback, useRef } from "react";
import { useFilesPanelStore, useConfigStore } from "@/stores";
import { useUIStore, useEnvironmentStore } from "@/stores";
import * as tauri from "@/lib/tauri";

// Auto-refresh interval in milliseconds (5 seconds)
const AUTO_REFRESH_INTERVAL = 5000;

/**
 * Hook for managing files panel data loading.
 * Loads git changes and file tree data from the active container.
 * Auto-refreshes every 5 seconds when the panel is open.
 */
export function useFilesPanel() {
  const { selectedEnvironmentId } = useUIStore();
  const { getEnvironmentById } = useEnvironmentStore();
  const { getRepositoryConfig } = useConfigStore();
  const {
    isOpen,
    activeTab,
    setChanges,
    setFileTree,
    setLoadingChanges,
    setLoadingTree,
    setTargetBranch,
  } = useFilesPanelStore();

  const selectedEnvironment = selectedEnvironmentId
    ? getEnvironmentById(selectedEnvironmentId)
    : null;
  const containerId = selectedEnvironment?.containerId ?? null;
  const projectId = selectedEnvironment?.projectId ?? null;
  const isRunning = selectedEnvironment?.status === "running";

  // Get the target branch for comparison from repository config
  const repoConfig = projectId ? getRepositoryConfig(projectId) : null;
  const targetBranch = repoConfig?.prBaseBranch || "main";

  // Track loading state for changes and tree separately to allow concurrent loads
  // of different data types while preventing duplicate requests of the same type
  const loadingChangesRef = useRef(false);
  const loadingTreeRef = useRef(false);

  // Store the target branch so other components can access it
  useEffect(() => {
    setTargetBranch(targetBranch);
  }, [targetBranch, setTargetBranch]);

  // Load git changes from container (silent mode for auto-refresh)
  const loadChanges = useCallback(async (silent = false) => {
    if (!containerId || !isRunning) {
      setChanges([]);
      return;
    }

    // Skip if already loading changes (prevents overlapping requests for same data)
    if (loadingChangesRef.current) return;

    loadingChangesRef.current = true;
    // Only show loading indicator on manual refresh, not auto-refresh
    if (!silent) {
      setLoadingChanges(true);
    }
    try {
      // Compare against the target branch (prBaseBranch from repo config)
      const changes = await tauri.getGitStatus(containerId, targetBranch);
      setChanges(changes);
    } catch (err) {
      console.error("Failed to load git changes:", err);
      // Only clear on non-silent (manual) refresh to avoid flickering
      if (!silent) {
        setChanges([]);
      }
    } finally {
      loadingChangesRef.current = false;
      if (!silent) {
        setLoadingChanges(false);
      }
    }
  }, [containerId, isRunning, targetBranch, setChanges, setLoadingChanges]);

  // Load file tree from container (silent mode for auto-refresh)
  const loadFileTree = useCallback(async (silent = false) => {
    if (!containerId || !isRunning) {
      setFileTree([]);
      return;
    }

    // Skip if already loading tree (prevents overlapping requests for same data)
    if (loadingTreeRef.current) return;

    loadingTreeRef.current = true;
    if (!silent) {
      setLoadingTree(true);
    }
    try {
      const tree = await tauri.getFileTree(containerId);
      setFileTree(tree);
    } catch (err) {
      console.error("Failed to load file tree:", err);
      if (!silent) {
        setFileTree([]);
      }
    } finally {
      loadingTreeRef.current = false;
      if (!silent) {
        setLoadingTree(false);
      }
    }
  }, [containerId, isRunning, setFileTree, setLoadingTree]);

  // Refresh data based on active tab (manual refresh shows loading indicator)
  const refresh = useCallback(() => {
    if (activeTab === "changes") {
      loadChanges(false);
    } else {
      loadFileTree(false);
    }
  }, [activeTab, loadChanges, loadFileTree]);

  // Silent refresh for auto-refresh (no loading indicator)
  const silentRefresh = useCallback(() => {
    if (activeTab === "changes") {
      loadChanges(true);
    } else {
      loadFileTree(true);
    }
  }, [activeTab, loadChanges, loadFileTree]);

  // Load data when panel opens, tab changes, or environment changes
  useEffect(() => {
    if (isOpen && isRunning) {
      refresh();
    }
  }, [isOpen, activeTab, isRunning, containerId, refresh]);

  // Auto-refresh when panel is open and container is running
  useEffect(() => {
    if (!isOpen || !isRunning || !containerId) {
      return;
    }

    const intervalId = setInterval(() => {
      silentRefresh();
    }, AUTO_REFRESH_INTERVAL);

    return () => {
      clearInterval(intervalId);
    };
  }, [isOpen, isRunning, containerId, silentRefresh]);

  // Clear data when environment stops or changes
  useEffect(() => {
    if (!isRunning) {
      setChanges([]);
      setFileTree([]);
    }
  }, [isRunning, setChanges, setFileTree]);

  return {
    loadChanges,
    loadFileTree,
    refresh,
    isRunning,
    containerId,
  };
}

/**
 * PR Monitor Service Hook
 *
 * This is a singleton-like hook that should be mounted once at the app root level.
 * It manages centralized PR monitoring with mode-based polling intervals.
 *
 * Key responsibilities:
 * - Runs a 1-second tick loop to check if environments need polling
 * - Only polls the active environment (non-active environments are "idle")
 * - Subscribes to environment switches and agent idle events
 * - Performs PR detection and updates the environment store
 */

import { useEffect, useRef, useCallback } from "react";
import {
  usePrMonitorStore,
  PR_MONITOR_INTERVALS,
  PR_MONITOR_TIMEOUTS,
} from "@/stores/prMonitorStore";
import { useEnvironmentStore, useUIStore, useClaudeActivityStore } from "@/stores";
import * as tauri from "@/lib/tauri";
import type { PrDetectionResult } from "@/lib/tauri";
import type { PrState } from "@/types";

/** How often the tick loop runs (1 second) */
const TICK_INTERVAL_MS = 1000;

/**
 * Perform a PR detection for an environment.
 * Returns the detection result or null if no PR found.
 */
async function detectPR(
  environmentId: string,
  containerId: string | null,
  isLocal: boolean
): Promise<PrDetectionResult | null> {
  if (!environmentId) return null;
  if (!isLocal && !containerId) return null;

  try {
    const result = isLocal
      ? await tauri.detectPrLocal(environmentId)
      : await tauri.detectPr(containerId!);
    return result;
  } catch (error) {
    console.debug("[PrMonitorService] Detection error:", error);
    return null;
  }
}

/**
 * Save PR state to both backend (Tauri) and frontend (Zustand) stores.
 */
async function savePRState(
  environmentId: string,
  result: PrDetectionResult | null,
  currentPrUrl: string | null,
  setEnvironmentPR: (
    id: string,
    url: string | null,
    state: PrState | null,
    conflicts: boolean | null
  ) => void
): Promise<void> {
  if (result) {
    // Save to backend
    await tauri.setEnvironmentPr(
      environmentId,
      result.url,
      result.state,
      result.hasMergeConflicts
    );
    // Update frontend store
    setEnvironmentPR(
      environmentId,
      result.url,
      result.state,
      result.hasMergeConflicts
    );
  } else if (currentPrUrl) {
    // No PR found but we had one stored - clear it
    await tauri.clearEnvironmentPr(environmentId);
    setEnvironmentPR(environmentId, null, null, null);
  }
}

/**
 * Service hook that manages the PR monitoring polling loop.
 * Should be mounted once at the app root level.
 */
export function usePrMonitorService(): void {
  const tickIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isInitializedRef = useRef(false);

  // Get store actions (these are stable references)
  const {
    startMonitoring,
    setMonitoringMode,
    setActiveEnvironment,
    getMonitoringState,
    _setCheckInProgress,
    _updateLastCheckTime,
    _resetErrors,
    _incrementErrors,
  } = usePrMonitorStore();

  const { registerStateCallback, unregisterStateCallback } = useClaudeActivityStore();

  /**
   * Perform a single PR check for an environment.
   * Handles concurrency guards, error tracking, and mode transitions.
   */
  const performCheck = useCallback(
    async (environmentId: string) => {
      const monitorState = usePrMonitorStore.getState().getMonitoringState(environmentId);
      if (!monitorState) {
        console.debug(`[PrMonitorService] No monitor state for ${environmentId}`);
        return;
      }

      if (monitorState.checkInProgress) {
        console.debug(`[PrMonitorService] Check already in progress for ${environmentId}`);
        return;
      }

      const environment = useEnvironmentStore.getState().getEnvironmentById(environmentId);
      if (!environment) {
        console.debug(`[PrMonitorService] Environment not found: ${environmentId}`);
        return;
      }

      const isLocal = environment.environmentType === "local";
      const isRunning = isLocal
        ? !!environment.worktreePath
        : environment.status === "running";
      const workspaceReady = useEnvironmentStore.getState().isWorkspaceReady(environmentId);

      if (!isRunning || !workspaceReady) {
        console.debug(
          `[PrMonitorService] Skipping check for ${environmentId} - not ready (running: ${isRunning}, workspace: ${workspaceReady})`
        );
        return;
      }

      console.log(`[PrMonitorService] Performing PR check for ${environmentId} (mode: ${monitorState.mode})`);
      _setCheckInProgress(environmentId, true);

      try {
        const result = await detectPR(environmentId, environment.containerId ?? null, isLocal);

        await savePRState(
          environmentId,
          result,
          environment.prUrl ?? null,
          useEnvironmentStore.getState().setEnvironmentPR
        );

        _resetErrors(environmentId);

        // Handle mode transitions based on result
        const currentMode = usePrMonitorStore.getState().getMonitoringState(environmentId)?.mode;

        // create-pending → normal: When PR is detected
        if (currentMode === "create-pending" && result) {
          console.log(`[PrMonitorService] PR detected, transitioning ${environmentId} from create-pending to normal`);
          setMonitoringMode(environmentId, "normal");
        }

        // merge-pending → normal: When PR state becomes merged/closed
        if (currentMode === "merge-pending" && result) {
          if (result.state === "merged" || result.state === "closed") {
            console.log(
              `[PrMonitorService] PR ${result.state}, transitioning ${environmentId} from merge-pending to normal`
            );
            setMonitoringMode(environmentId, "normal");
          }
        }
      } catch (error) {
        console.error(`[PrMonitorService] Check failed for ${environmentId}:`, error);
        _incrementErrors(environmentId);
      } finally {
        _setCheckInProgress(environmentId, false);
        _updateLastCheckTime(environmentId);
      }
    },
    [_setCheckInProgress, _updateLastCheckTime, _resetErrors, _incrementErrors, setMonitoringMode]
  );

  /**
   * Main tick function - runs every second to check if any environment needs polling.
   */
  const tick = useCallback(() => {
    const now = Date.now();
    const state = usePrMonitorStore.getState();
    const activeEnvId = state.activeEnvironmentId;

    if (!activeEnvId) return;

    const monitorState = state.monitoredEnvironments[activeEnvId];
    if (!monitorState) return;

    const mode = monitorState.mode;
    const interval = PR_MONITOR_INTERVALS[mode];

    // Skip if idle mode
    if (interval === Infinity) return;

    // Check mode timeout (e.g., merge-pending should revert to normal after 20s)
    const modeTimeout = PR_MONITOR_TIMEOUTS[mode];
    if (modeTimeout && now - monitorState.modeStartTime > modeTimeout) {
      console.log(`[PrMonitorService] Mode timeout for ${activeEnvId}, reverting to normal`);
      usePrMonitorStore.getState().setMonitoringMode(activeEnvId, "normal");
      return;
    }

    // Check if enough time has passed since last check
    const timeSinceLastCheck = now - monitorState.lastCheckTime;
    if (timeSinceLastCheck >= interval) {
      performCheck(activeEnvId);
    }
  }, [performCheck]);

  // Start the tick loop on mount
  useEffect(() => {
    if (isInitializedRef.current) return;
    isInitializedRef.current = true;

    console.log("[PrMonitorService] Starting tick loop");
    tickIntervalRef.current = setInterval(tick, TICK_INTERVAL_MS);

    return () => {
      if (tickIntervalRef.current) {
        console.log("[PrMonitorService] Stopping tick loop");
        clearInterval(tickIntervalRef.current);
        tickIntervalRef.current = null;
      }
      isInitializedRef.current = false;
    };
  }, [tick]);

  // Track previous selectedEnvironmentId for change detection
  const prevSelectedEnvIdRef = useRef<string | null>(null);

  // Subscribe to active environment changes (selectedEnvironmentId in uiStore)
  useEffect(() => {
    // Handle initial environment if one is already selected
    const initialEnvId = useUIStore.getState().selectedEnvironmentId;
    prevSelectedEnvIdRef.current = initialEnvId;

    if (initialEnvId) {
      console.log(`[PrMonitorService] Initial environment: ${initialEnvId}`);
      setActiveEnvironment(initialEnvId);
      const existingState = getMonitoringState(initialEnvId);
      if (!existingState) {
        startMonitoring(initialEnvId, "normal");
      } else {
        setMonitoringMode(initialEnvId, "normal");
      }
      // Trigger immediate check
      performCheck(initialEnvId);
    }

    // Subscribe to changes
    const unsub = useUIStore.subscribe((state) => {
      const newId = state.selectedEnvironmentId;
      const prevId = prevSelectedEnvIdRef.current;

      // Only process if there's an actual change
      if (newId === prevId) return;

      console.log(`[PrMonitorService] Environment switched: ${prevId} -> ${newId}`);
      prevSelectedEnvIdRef.current = newId;

      // Set previous environment to idle
      if (prevId) {
        const prevMonitorState = usePrMonitorStore.getState().getMonitoringState(prevId);
        if (prevMonitorState) {
          // If it was in create-pending, it loses focus so revert to idle
          // (create-pending stops when environment loses focus)
          setMonitoringMode(prevId, "idle");
        }
      }

      // Start monitoring new environment
      if (newId) {
        setActiveEnvironment(newId);
        const existingState = usePrMonitorStore.getState().getMonitoringState(newId);
        if (!existingState) {
          startMonitoring(newId, "normal");
        } else {
          setMonitoringMode(newId, "normal");
        }
        // Trigger immediate check on environment switch
        performCheck(newId);
      } else {
        setActiveEnvironment(null);
      }
    });

    return unsub;
  }, [
    setActiveEnvironment,
    startMonitoring,
    setMonitoringMode,
    getMonitoringState,
    performCheck,
  ]);

  // Subscribe to Claude/Agent idle transitions
  useEffect(() => {
    const callbackId = registerStateCallback((containerId, prevState, newState) => {
      if (newState === "idle" && prevState !== "idle") {
        // Find environment by containerId or environmentId (for local envs)
        const envs = useEnvironmentStore.getState().environments;
        const env = envs.find(
          (e) => e.containerId === containerId || e.id === containerId
        );

        if (env) {
          const activeEnvId = usePrMonitorStore.getState().activeEnvironmentId;
          // Only trigger check if this is the active environment
          if (env.id === activeEnvId) {
            console.log(
              `[PrMonitorService] Agent became idle for active environment ${env.id}, triggering check`
            );
            performCheck(env.id);
          }
        }
      }
    });

    return () => {
      unregisterStateCallback(callbackId);
    };
  }, [registerStateCallback, unregisterStateCallback, performCheck]);

  // Track previous workspace ready set for change detection
  const prevWorkspaceReadyRef = useRef<Set<string>>(new Set());

  // Subscribe to workspace ready changes - trigger check when workspace becomes ready
  useEffect(() => {
    // Initialize with current state
    prevWorkspaceReadyRef.current = new Set(useEnvironmentStore.getState().workspaceReadyEnvironments);

    const unsub = useEnvironmentStore.subscribe((state) => {
      const newSet = state.workspaceReadyEnvironments;
      const prevSet = prevWorkspaceReadyRef.current;

      // Find environments that just became ready
      const activeEnvId = usePrMonitorStore.getState().activeEnvironmentId;
      if (!activeEnvId) {
        prevWorkspaceReadyRef.current = new Set(newSet);
        return;
      }

      const wasReady = prevSet.has(activeEnvId);
      const isNowReady = newSet.has(activeEnvId);

      if (!wasReady && isNowReady) {
        console.log(`[PrMonitorService] Workspace became ready for ${activeEnvId}, triggering check`);
        performCheck(activeEnvId);
      }

      // Update previous state
      prevWorkspaceReadyRef.current = new Set(newSet);
    });

    return unsub;
  }, [performCheck]);
}

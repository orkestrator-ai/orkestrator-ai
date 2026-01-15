// Hook for managing pull request state and actions
import { useCallback, useState, useEffect, useRef } from "react";
import * as tauri from "@/lib/tauri";
import { useEnvironmentStore } from "@/stores";
import { useClaudeStateCallbacks } from "./useClaudeStateCallbacks";
import type { PrState } from "@/types";

/** Interval for periodic PR detection (30 seconds) */
const PR_DETECTION_INTERVAL_MS = 30_000;

/** Minimum interval between PR detections (5 seconds) to prevent rapid-fire calls */
const PR_DETECTION_DEBOUNCE_MS = 5_000;

interface UsePullRequestOptions {
  environmentId: string | null;
  containerId?: string | null;
  isRunning?: boolean;
  /** Whether this environment is currently active (only active environment runs periodic checks) */
  isActive?: boolean;
}

interface UsePullRequestReturn {
  prUrl: string | null;
  prState: PrState | null;
  hasMergeConflicts: boolean | null;
  isDetecting: boolean;
  error: string | null;
  viewPR: () => Promise<void>;
  resetPR: () => Promise<void>;
  detectPR: () => Promise<void>;
}

export function usePullRequest({
  environmentId,
  containerId,
  isRunning = false,
  isActive = false,
}: UsePullRequestOptions): UsePullRequestReturn {
  const [isDetecting, setIsDetecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasDetectedRef = useRef(false);
  const isDetectingRef = useRef(false); // Guard against concurrent detection
  const prevEnvironmentIdRef = useRef<string | null>(null);
  const lastDetectionTimeRef = useRef<number>(0); // Track last detection time for debouncing

  const { getEnvironmentById, setEnvironmentPR, isWorkspaceReady } = useEnvironmentStore();

  // Get PR URL, state, and merge conflicts from environment store
  const environment = environmentId ? getEnvironmentById(environmentId) : null;
  const prUrl = environment?.prUrl ?? null;
  const prState = environment?.prState ?? null;
  const hasMergeConflicts = environment?.hasMergeConflicts ?? null;

  // Check if workspace is ready (git cloned, shell available)
  const workspaceReady = environmentId ? isWorkspaceReady(environmentId) : false;

  // Detect PR by running gh pr view in the container
  // Uses a ref-based guard to prevent concurrent execution
  // Also enforces a minimum interval between detections to prevent rapid-fire calls
  const detectPR = useCallback(async () => {
    if (!containerId || !environmentId) return;

    // Guard against concurrent detection
    if (isDetectingRef.current) {
      console.debug("[usePullRequest] Detection already in progress, skipping");
      return;
    }

    // Debounce: skip if last detection was less than 5 seconds ago
    const now = Date.now();
    const timeSinceLastDetection = now - lastDetectionTimeRef.current;
    if (timeSinceLastDetection < PR_DETECTION_DEBOUNCE_MS) {
      console.debug(
        `[usePullRequest] Skipping detection, only ${timeSinceLastDetection}ms since last check (min: ${PR_DETECTION_DEBOUNCE_MS}ms)`
      );
      return;
    }

    isDetectingRef.current = true;
    lastDetectionTimeRef.current = now;
    setIsDetecting(true);
    setError(null);

    try {
      const result = await tauri.detectPr(containerId);

      if (result) {
        // Found a PR, save URL, state, and merge conflicts
        await tauri.setEnvironmentPr(environmentId, result.url, result.state, result.hasMergeConflicts);
        setEnvironmentPR(environmentId, result.url, result.state, result.hasMergeConflicts);
      } else if (prUrl) {
        // No PR found but we had one stored - clear it
        await tauri.clearEnvironmentPr(environmentId);
        setEnvironmentPR(environmentId, null, null, null);
      }
    } catch (err) {
      // Don't treat detection failures as errors - just means no PR
      console.debug("[usePullRequest] PR detection:", err);
    } finally {
      isDetectingRef.current = false;
      setIsDetecting(false);
    }
  }, [containerId, environmentId, prUrl, setEnvironmentPR]);

  // Auto-detect PR when workspace becomes ready
  useEffect(() => {
    // Reset detection flag when environmentId changes
    if (prevEnvironmentIdRef.current !== environmentId) {
      hasDetectedRef.current = false;
      prevEnvironmentIdRef.current = environmentId;
    }

    if (workspaceReady && containerId && environmentId && !hasDetectedRef.current) {
      hasDetectedRef.current = true;
      console.log("[usePullRequest] Workspace ready, detecting PR for environment:", environmentId);
      detectPR();
    }

    // Reset detection flag when container stops running
    if (!isRunning) {
      hasDetectedRef.current = false;
    }
  }, [workspaceReady, isRunning, containerId, environmentId, detectPR]);

  // Register Claude state callback to detect PR when Claude becomes idle
  useClaudeStateCallbacks({
    containerId,
    onBecomeIdle: useCallback((eventContainerId: string) => {
      if (containerId && eventContainerId === containerId) {
        console.log("[usePullRequest] Claude became idle, checking for PR");
        detectPR();
      }
    }, [containerId, detectPR]),
  });

  // Track previous isActive state to detect tab activation
  const prevIsActiveRef = useRef(false);

  // Detect PR when tab becomes active (to check if PR has been merged/closed)
  useEffect(() => {
    const justBecameActive = isActive && !prevIsActiveRef.current;
    prevIsActiveRef.current = isActive;

    // If tab just became active and we have a PR, re-check its state
    if (justBecameActive && prUrl && containerId && environmentId && workspaceReady && isRunning) {
      console.log("[usePullRequest] Tab activated with existing PR, refreshing PR state");
      detectPR();
    }
  }, [isActive, prUrl, containerId, environmentId, workspaceReady, isRunning, detectPR]);

  // Periodic PR detection every 30 seconds while container is running AND active
  // Only runs if no PR is currently detected (once a PR is found, no need to keep checking)
  // Only the active environment runs periodic checks to avoid unnecessary API calls
  useEffect(() => {
    // Don't run periodic detection if we already have a PR
    if (!isRunning || !containerId || !environmentId || !workspaceReady || !isActive || prUrl) {
      return;
    }

    console.log("[usePullRequest] Starting periodic PR detection for active environment:", environmentId);

    const intervalId = setInterval(() => {
      console.log("[usePullRequest] Periodic PR detection check");
      detectPR();
    }, PR_DETECTION_INTERVAL_MS);

    return () => {
      console.log("[usePullRequest] Stopping periodic PR detection");
      clearInterval(intervalId);
    };
  }, [isRunning, containerId, environmentId, workspaceReady, isActive, prUrl, detectPR]);

  // View the PR in the default browser
  const viewPR = useCallback(async () => {
    if (!prUrl) {
      // Fallback: try to get the PR URL from the backend
      if (environmentId) {
        try {
          const url = await tauri.getEnvironmentPrUrl(environmentId);
          if (url) {
            await tauri.openInBrowser(url);
            return;
          }
        } catch (err) {
          console.error("Failed to get PR URL:", err);
        }
      }

      // If still no URL, set error
      setError("No PR URL available");
      return;
    }

    try {
      await tauri.openInBrowser(prUrl);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to open browser";
      setError(message);
    }
  }, [prUrl, environmentId]);

  // Reset/clear the PR URL, state, and merge conflicts
  const resetPR = useCallback(async () => {
    if (!environmentId) return;

    try {
      await tauri.clearEnvironmentPr(environmentId);
      setEnvironmentPR(environmentId, null, null, null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to reset PR";
      setError(message);
    }
  }, [environmentId, setEnvironmentPR]);

  return {
    prUrl,
    prState,
    hasMergeConflicts,
    isDetecting,
    error,
    viewPR,
    resetPR,
    detectPR,
  };
}

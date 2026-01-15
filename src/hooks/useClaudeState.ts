// Hook for monitoring Claude Code activity state in containers
import { useEffect, useRef } from "react";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import * as tauri from "@/lib/tauri";
import {
  useClaudeActivityStore,
  type ClaudeActivityState,
} from "@/stores/claudeActivityStore";

interface ClaudeStateEvent {
  container_id: string;
  state: string;
}

/**
 * Hook to monitor Claude Code activity state for a container.
 * Starts polling when containerId is provided and stops on cleanup.
 *
 * @param containerId - The Docker container ID to monitor (null to disable)
 * @param tabId - The terminal tab ID to associate state with
 */
export function useClaudeState(
  containerId: string | null,
  tabId: string
): void {
  const { setTabState, removeTabState, setContainerState, removeContainerState } = useClaudeActivityStore();
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const containerIdRef = useRef<string | null>(null);

  useEffect(() => {
    // Helper to clean up previous container state
    const cleanupPreviousContainer = (previousContainerId: string) => {
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }
      tauri.stopClaudeStatePolling(previousContainerId).catch((e) => {
        console.warn("Failed to stop claude state polling:", e);
      });
      removeContainerState(previousContainerId);
    };

    // If containerId is null but we had a previous container, clean it up
    if (!containerId) {
      if (containerIdRef.current) {
        cleanupPreviousContainer(containerIdRef.current);
        containerIdRef.current = null;
      }
      removeTabState(tabId);
      return;
    }

    // If container changed, clean up previous listener
    if (containerIdRef.current && containerIdRef.current !== containerId) {
      cleanupPreviousContainer(containerIdRef.current);
    }

    containerIdRef.current = containerId;

    // Listen for state change events BEFORE starting polling
    const eventName = `claude-state-${containerId}`;

    listen<ClaudeStateEvent>(eventName, (event) => {
      const state = event.payload.state as ClaudeActivityState;
      if (state === "working" || state === "waiting" || state === "idle") {
        setTabState(tabId, state);
        // Also set container-level state for sidebar display
        setContainerState(event.payload.container_id, state);
      }
    }).then((unlisten) => {
      unlistenRef.current = unlisten;

      // Start polling AFTER listener is attached
      tauri.startClaudeStatePolling(containerId).catch((e) => {
        console.error("Failed to start claude state polling:", e);
      });
    }).catch((e) => {
      console.error("Failed to listen for claude state events:", e);
    });

    // Cleanup on unmount or when containerId changes
    return () => {
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }
      if (containerIdRef.current) {
        tauri.stopClaudeStatePolling(containerIdRef.current).catch((e) => {
          console.warn("Failed to stop claude state polling on cleanup:", e);
        });
        removeContainerState(containerIdRef.current);
      }
      removeTabState(tabId);
    };
  }, [containerId, tabId, setTabState, removeTabState, setContainerState, removeContainerState]);
}

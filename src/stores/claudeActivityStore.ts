import { create } from "zustand";

export type ClaudeActivityState = "idle" | "working" | "waiting";

/** Callback type for state transitions */
export type ClaudeStateCallback = (
  containerId: string,
  previousState: ClaudeActivityState,
  newState: ClaudeActivityState
) => void;

/** Unique identifier for registered callbacks */
type CallbackId = string;

interface ClaudeActivityStoreState {
  // State: Map of tabId -> activity state
  tabStates: Record<string, ClaudeActivityState>;
  // State: Map of containerId -> activity state (for sidebar display)
  containerStates: Record<string, ClaudeActivityState>;
  // Callbacks: Map of callbackId -> callback function
  stateChangeCallbacks: Map<CallbackId, ClaudeStateCallback>;

  // Actions
  setTabState: (tabId: string, state: ClaudeActivityState) => void;
  removeTabState: (tabId: string) => void;
  setContainerState: (containerId: string, state: ClaudeActivityState) => void;
  removeContainerState: (containerId: string) => void;

  // Callback registration
  registerStateCallback: (callback: ClaudeStateCallback) => CallbackId;
  unregisterStateCallback: (callbackId: CallbackId) => void;

  // Selectors
  getTabState: (tabId: string) => ClaudeActivityState;
  getContainerState: (containerId: string) => ClaudeActivityState;
}

// Counter for generating unique callback IDs
let callbackIdCounter = 0;

export const useClaudeActivityStore = create<ClaudeActivityStoreState>()(
  (set, get) => ({
    // Initial state
    tabStates: {},
    containerStates: {},
    stateChangeCallbacks: new Map(),

    // Actions
    setTabState: (tabId, state) =>
      set((prev) => ({
        tabStates: { ...prev.tabStates, [tabId]: state },
      })),

    removeTabState: (tabId) =>
      set((prev) => {
        const { [tabId]: _, ...rest } = prev.tabStates;
        return { tabStates: rest };
      }),

    setContainerState: (containerId, state) => {
      const previousState = get().containerStates[containerId] || "idle";

      // Update state first
      set((prev) => ({
        containerStates: { ...prev.containerStates, [containerId]: state },
      }));

      // Notify callbacks if state actually changed
      // Deferred to next microtask to avoid blocking state updates
      if (previousState !== state) {
        queueMicrotask(() => {
          const callbacks = get().stateChangeCallbacks;
          callbacks.forEach((callback) => {
            try {
              callback(containerId, previousState, state);
            } catch (e) {
              console.error("[claudeActivityStore] Callback error:", e);
            }
          });
        });
      }
    },

    removeContainerState: (containerId) =>
      set((prev) => {
        const { [containerId]: _, ...rest } = prev.containerStates;
        return { containerStates: rest };
      }),

    // Callback registration
    registerStateCallback: (callback) => {
      const callbackId = `cb-${++callbackIdCounter}`;
      set((prev) => {
        const newCallbacks = new Map(prev.stateChangeCallbacks);
        newCallbacks.set(callbackId, callback);
        return { stateChangeCallbacks: newCallbacks };
      });
      console.log("[claudeActivityStore] Registered state callback:", callbackId);
      return callbackId;
    },

    unregisterStateCallback: (callbackId) => {
      set((prev) => {
        const newCallbacks = new Map(prev.stateChangeCallbacks);
        newCallbacks.delete(callbackId);
        return { stateChangeCallbacks: newCallbacks };
      });
      console.log("[claudeActivityStore] Unregistered state callback:", callbackId);
    },

    // Selectors
    getTabState: (tabId) => get().tabStates[tabId] || "idle",
    getContainerState: (containerId) => get().containerStates[containerId] || "idle",
  })
);

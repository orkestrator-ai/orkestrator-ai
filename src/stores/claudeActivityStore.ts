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
  // Reference counts: Map of containerId -> number of tabs using it
  containerRefCounts: Record<string, number>;
  // Callbacks: Map of callbackId -> callback function
  stateChangeCallbacks: Map<CallbackId, ClaudeStateCallback>;

  // Actions
  setTabState: (tabId: string, state: ClaudeActivityState) => void;
  removeTabState: (tabId: string) => void;
  setContainerState: (containerId: string, state: ClaudeActivityState) => void;
  /**
   * @deprecated Use decrementContainerRef instead to properly handle multiple tabs.
   * This is kept for backward compatibility but directly removes the state.
   */
  removeContainerState: (containerId: string) => void;
  /** Increment the reference count for a container (call when tab mounts) */
  incrementContainerRef: (containerId: string) => void;
  /** Decrement the reference count and remove state when it reaches 0 (call when tab unmounts) */
  decrementContainerRef: (containerId: string) => void;

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
    containerRefCounts: {},
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
        const { [containerId]: __, ...restCounts } = prev.containerRefCounts;
        return { containerStates: rest, containerRefCounts: restCounts };
      }),

    incrementContainerRef: (containerId) =>
      set((prev) => ({
        containerRefCounts: {
          ...prev.containerRefCounts,
          [containerId]: (prev.containerRefCounts[containerId] || 0) + 1,
        },
      })),

    decrementContainerRef: (containerId) =>
      set((prev) => {
        const currentCount = prev.containerRefCounts[containerId] || 0;
        const newCount = Math.max(0, currentCount - 1);

        if (newCount === 0) {
          // No more tabs using this container, remove state
          const { [containerId]: _, ...restStates } = prev.containerStates;
          const { [containerId]: __, ...restCounts } = prev.containerRefCounts;
          return { containerStates: restStates, containerRefCounts: restCounts };
        }

        // Still have tabs, just decrement count
        return {
          containerRefCounts: {
            ...prev.containerRefCounts,
            [containerId]: newCount,
          },
        };
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

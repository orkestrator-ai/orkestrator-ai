import { create } from "zustand";
import type {
  PaneNode,
  PaneLeaf,
  PaneSplit,
  TabInfo,
  EdgeDirection,
} from "@/types/paneLayout";
import {
  isPaneLeaf,
  MAX_SPLIT_DEPTH,
} from "@/types/paneLayout";
import { useTerminalSessionStore, createSessionKey } from "./terminalSessionStore";
import { useSessionStore } from "./sessionStore";
import { useTerminalPortalStore } from "./terminalPortalStore";
import * as tauri from "@/lib/tauri";

/**
 * Per-environment state for pane layout
 */
interface EnvironmentPaneState {
  root: PaneNode;
  activePaneId: string;
  containerId: string | null;
}

// Generate unique IDs using crypto.randomUUID for collision resistance
function generateId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

// Tree helper functions
function findLeaf(node: PaneNode, paneId: string): PaneLeaf | null {
  if (isPaneLeaf(node)) {
    return node.id === paneId ? node : null;
  }
  for (const child of node.children) {
    const found = findLeaf(child, paneId);
    if (found) return found;
  }
  return null;
}

function findParentSplit(node: PaneNode, targetId: string, parent: PaneSplit | null = null): PaneSplit | null {
  if (isPaneLeaf(node)) {
    return node.id === targetId ? parent : null;
  }

  for (const child of node.children) {
    if (child.id === targetId) {
      return node;
    }
    const found = findParentSplit(child, targetId, node);
    if (found) return found;
  }
  return null;
}

function findFirstLeaf(node: PaneNode): PaneLeaf {
  if (isPaneLeaf(node)) return node;
  // Defensive check: ensure children array has elements
  const firstChild = node.children[0];
  if (!firstChild) {
    throw new Error("[PaneLayout] Invalid tree structure: split node has no children");
  }
  return findFirstLeaf(firstChild);
}

/**
 * Find which pane contains a tab with the given ID
 * Returns the pane leaf if found, null otherwise
 */
function findPaneWithTab(node: PaneNode, tabId: string): PaneLeaf | null {
  if (isPaneLeaf(node)) {
    return node.tabs.some((t) => t.id === tabId) ? node : null;
  }
  for (const child of node.children) {
    const found = findPaneWithTab(child, tabId);
    if (found) return found;
  }
  return null;
}

function getDepth(node: PaneNode): number {
  if (isPaneLeaf(node)) return 0;
  return 1 + Math.max(getDepth(node.children[0]), getDepth(node.children[1]));
}

function replaceNode(root: PaneNode, targetId: string, replacement: PaneNode): PaneNode {
  if (root.id === targetId) {
    return replacement;
  }
  if (isPaneLeaf(root)) {
    return root;
  }
  return {
    ...root,
    children: [
      replaceNode(root.children[0], targetId, replacement),
      replaceNode(root.children[1], targetId, replacement),
    ] as [PaneNode, PaneNode],
  };
}

function updateLeaf(root: PaneNode, paneId: string, updater: (leaf: PaneLeaf) => PaneLeaf): PaneNode {
  if (isPaneLeaf(root)) {
    return root.id === paneId ? updater(root) : root;
  }
  return {
    ...root,
    children: [
      updateLeaf(root.children[0], paneId, updater),
      updateLeaf(root.children[1], paneId, updater),
    ] as [PaneNode, PaneNode],
  };
}

/**
 * Recursively collects all leaf panes from a pane tree.
 * Useful for getting all tabs across all panes.
 */
export function getAllLeaves(node: PaneNode): PaneLeaf[] {
  if (isPaneLeaf(node)) return [node];
  return [...getAllLeaves(node.children[0]), ...getAllLeaves(node.children[1])];
}

interface PaneLayoutState {
  // Per-environment state (keyed by environmentId)
  environments: Map<string, EnvironmentPaneState>;
  // Currently active environment ID
  activeEnvironmentId: string | null;

  // Actions
  setActiveEnvironment: (environmentId: string) => void;
  initialize: (containerId: string | null) => void;
  reset: () => void;

  // Tab management
  addTab: (paneId: string, tab: TabInfo, environmentId?: string) => void;
  removeTab: (paneId: string, tabId: string) => void;
  setActiveTab: (paneId: string, tabId: string) => void;
  moveTab: (fromPaneId: string, toPaneId: string, tabId: string, toIndex?: number) => void;
  reorderTabs: (paneId: string, fromIndex: number, toIndex: number) => void;

  // Pane management
  splitPane: (paneId: string, direction: "horizontal" | "vertical", tabId: string) => void;
  splitPaneAtEdge: (targetPaneId: string, edge: EdgeDirection, tabId: string, fromPaneId: string) => void;
  closePane: (paneId: string) => void;
  setActivePane: (paneId: string) => void;
  updateSizes: (splitId: string, sizes: [number, number]) => void;

  // Getters for current environment state
  getRoot: () => PaneNode;
  getActivePaneId: () => string;
  getContainerId: () => string | null;
  getPane: (paneId: string) => PaneLeaf | null;
  getActivePane: () => PaneLeaf | null;
  getAllTabs: () => TabInfo[];
  getOpenFilePaths: () => string[];
  findPaneWithTab: (tabId: string) => PaneLeaf | null;
}

// Create initial single-pane layout
function createInitialLayout(): PaneLeaf {
  return {
    kind: "leaf",
    id: "default",
    tabs: [],
    activeTabId: null,
  };
}

// Helper to get current environment state or default
function getCurrentEnvState(state: PaneLayoutState): EnvironmentPaneState {
  if (!state.activeEnvironmentId) {
    return {
      root: createInitialLayout(),
      activePaneId: "default",
      containerId: null,
    };
  }
  return state.environments.get(state.activeEnvironmentId) ?? {
    root: createInitialLayout(),
    activePaneId: "default",
    containerId: null,
  };
}

export const usePaneLayoutStore = create<PaneLayoutState>()((set, get) => ({
  environments: new Map(),
  activeEnvironmentId: null,

  // Getter functions for current environment state
  getRoot: () => getCurrentEnvState(get()).root,
  getActivePaneId: () => getCurrentEnvState(get()).activePaneId,
  getContainerId: () => getCurrentEnvState(get()).containerId,

  setActiveEnvironment: (environmentId: string) => {
    const state = get();
    if (state.activeEnvironmentId === environmentId) return;

    console.debug("[PaneLayout] Setting active environment:", environmentId);

    // Ensure the environment has state (create if not exists)
    if (!state.environments.has(environmentId)) {
      const newEnvs = new Map(state.environments);
      newEnvs.set(environmentId, {
        root: createInitialLayout(),
        activePaneId: "default",
        containerId: null,
      });
      set({ environments: newEnvs, activeEnvironmentId: environmentId });
    } else {
      set({ activeEnvironmentId: environmentId });
    }
  },

  initialize: (containerId) => {
    const state = get();
    const envId = state.activeEnvironmentId;
    if (!envId) {
      console.warn("[PaneLayout] initialize called without active environment");
      return;
    }

    console.debug("[PaneLayout] Initializing environment:", envId, "with containerId:", containerId);

    const newEnvs = new Map(state.environments);
    newEnvs.set(envId, {
      root: createInitialLayout(),
      activePaneId: "default",
      containerId,
    });
    set({ environments: newEnvs });
  },

  reset: () => {
    const state = get();
    const envId = state.activeEnvironmentId;
    if (!envId) return;

    const envState = state.environments.get(envId);
    if (!envState) return;

    // Clear terminal sessions for this environment's tabs
    // Handle both container environments (containerId set) and local environments (containerId null)
    const sessionStore = useTerminalSessionStore.getState();
    const terminalPortalStore = useTerminalPortalStore.getState();
    const containerId = envState.containerId;

    const envTabs = getAllLeaves(envState.root).flatMap((leaf) => leaf.tabs);
    envTabs.forEach((tab) => {
      const sessionKey = createSessionKey(containerId, tab.id, envId);
      const sessionData = sessionStore.sessions.get(sessionKey);
      if (sessionData) {
        console.debug("[PaneLayout] Cleaning up terminal session on reset:", sessionKey, sessionData.sessionId);
        // Only detach if we have a PTY session ID (may be undefined if restored from persistent)
        if (sessionData.sessionId) {
          tauri.detachTerminal(sessionData.sessionId).catch((err) => {
            console.error("[PaneLayout] Error detaching terminal session:", err);
          });
        }
        // Update persistent session status to disconnected
        if (sessionData.persistentSessionId) {
          useSessionStore.getState().updateSessionStatus(sessionData.persistentSessionId, "disconnected")
            .catch((err) => {
              console.error("[PaneLayout] Error updating persistent session status:", err);
            });
        }
        sessionStore.removeSession(sessionKey);
      }
    });

    // Clear all terminal instances from portal store for this environment
    console.debug("[PaneLayout] Clearing terminal instances for environment on reset:", envId);
    terminalPortalStore.clearTerminalsForEnvironment(envId);

    const newEnvs = new Map(state.environments);
    newEnvs.set(envId, {
      root: createInitialLayout(),
      activePaneId: "default",
      containerId: null,
    });
    set({ environments: newEnvs });
  },

  addTab: (paneId, tab, environmentId) => {
    const state = get();
    // Use explicit environmentId if provided, otherwise fall back to activeEnvironmentId
    const envId = environmentId ?? state.activeEnvironmentId;
    if (!envId) return;

    const envState = state.environments.get(envId);
    if (!envState) return;

    // Check if a tab with this ID already exists in any pane
    const existingPane = findPaneWithTab(envState.root, tab.id);
    if (existingPane) {
      // Tab already exists - just activate it instead of duplicating
      console.debug("[PaneLayout] Tab already exists, activating:", tab.id, "in pane:", existingPane.id);
      const newRoot = updateLeaf(envState.root, existingPane.id, (leaf) => ({
        ...leaf,
        activeTabId: tab.id,
      }));
      const newEnvs = new Map(state.environments);
      newEnvs.set(envId, { ...envState, root: newRoot, activePaneId: existingPane.id });
      set({ environments: newEnvs });
      return;
    }

    // Tab doesn't exist - add it to the specified pane
    const newRoot = updateLeaf(envState.root, paneId, (leaf) => ({
      ...leaf,
      tabs: [...leaf.tabs, tab],
      activeTabId: tab.id,
    }));

    const newEnvs = new Map(state.environments);
    newEnvs.set(envId, { ...envState, root: newRoot });
    set({ environments: newEnvs });
  },

  removeTab: (paneId, tabId) => {
    const state = get();
    const envId = state.activeEnvironmentId;
    if (!envId) return;

    const envState = state.environments.get(envId);
    if (!envState) return;

    const leaf = findLeaf(envState.root, paneId);
    if (!leaf) return;

    // Clean up terminal session for this tab (if it exists)
    // Handle both container environments (containerId set) and local environments (containerId null)
    const sessionStore = useTerminalSessionStore.getState();
    const terminalPortalStore = useTerminalPortalStore.getState();
    const sessionKey = createSessionKey(envState.containerId, tabId, envId);
    const sessionId = sessionStore.getSessionId(sessionKey);
    if (sessionId) {
      console.debug("[PaneLayout] Cleaning up terminal session for closed tab:", sessionKey, sessionId);
      // Remove from session store
      sessionStore.removeSession(sessionKey);
      // Detach the terminal session (async, fire and forget)
      tauri.detachTerminal(sessionId).catch((err) => {
        console.error("[PaneLayout] Error detaching terminal session:", err);
      });
      // Update persistent session status to disconnected (for sidebar display)
      useSessionStore.getState().updateSessionStatus(sessionId, "disconnected")
        .catch((err) => {
          console.error("[PaneLayout] Error updating persistent session status:", err);
        });
    }

    // Dispose the terminal instance from portal store
    terminalPortalStore.disposeTerminal(envId, tabId);

    const remainingTabs = leaf.tabs.filter((t) => t.id !== tabId);

    // If this was the last tab, close the pane
    if (remainingTabs.length === 0) {
      get().closePane(paneId);
      return;
    }

    // Update the leaf with remaining tabs
    const newActiveTabId = leaf.activeTabId === tabId
      ? remainingTabs[remainingTabs.length - 1]?.id ?? null
      : leaf.activeTabId;

    const newRoot = updateLeaf(envState.root, paneId, () => ({
      ...leaf,
      tabs: remainingTabs,
      activeTabId: newActiveTabId,
    }));

    const newEnvs = new Map(state.environments);
    newEnvs.set(envId, { ...envState, root: newRoot });
    set({ environments: newEnvs });
  },

  setActiveTab: (paneId, tabId) => {
    const state = get();
    const envId = state.activeEnvironmentId;
    if (!envId) return;

    const envState = state.environments.get(envId);
    if (!envState) return;

    const newRoot = updateLeaf(envState.root, paneId, (leaf) => ({
      ...leaf,
      activeTabId: tabId,
    }));

    const newEnvs = new Map(state.environments);
    newEnvs.set(envId, { ...envState, root: newRoot, activePaneId: paneId });
    set({ environments: newEnvs });
  },

  moveTab: (fromPaneId, toPaneId, tabId, toIndex) => {
    const state = get();
    const envId = state.activeEnvironmentId;
    if (!envId) {
      console.warn("[paneLayoutStore] moveTab failed: no activeEnvironmentId");
      return;
    }

    const envState = state.environments.get(envId);
    if (!envState) {
      console.warn("[paneLayoutStore] moveTab failed: no envState for", envId);
      return;
    }

    const fromLeaf = findLeaf(envState.root, fromPaneId);
    const toLeaf = findLeaf(envState.root, toPaneId);
    if (!fromLeaf || !toLeaf) {
      console.warn("[paneLayoutStore] moveTab failed: pane not found", { fromPaneId, toPaneId, fromLeaf: !!fromLeaf, toLeaf: !!toLeaf });
      return;
    }

    const tab = fromLeaf.tabs.find((t) => t.id === tabId);
    if (!tab) {
      console.warn("[paneLayoutStore] moveTab failed: tab not found", { tabId, availableTabs: fromLeaf.tabs.map(t => t.id) });
      return;
    }

    console.debug("[paneLayoutStore] moveTab executing", { fromPaneId, toPaneId, tabId });

    // If moving within the same pane, just reorder
    if (fromPaneId === toPaneId) {
      const fromIndex = fromLeaf.tabs.findIndex((t) => t.id === tabId);
      if (toIndex !== undefined && fromIndex !== toIndex) {
        get().reorderTabs(fromPaneId, fromIndex, toIndex);
      }
      return;
    }

    // Remove from source
    const remainingTabs = fromLeaf.tabs.filter((t) => t.id !== tabId);

    // If source pane will be empty, we need to close it
    if (remainingTabs.length === 0) {
      // First add to target, then close source
      let newRoot = updateLeaf(envState.root, toPaneId, (leaf) => {
        const newTabs = [...leaf.tabs];
        if (toIndex !== undefined) {
          newTabs.splice(toIndex, 0, tab);
        } else {
          newTabs.push(tab);
        }
        return {
          ...leaf,
          tabs: newTabs,
          activeTabId: tab.id,
        };
      });

      const newEnvs = new Map(state.environments);
      newEnvs.set(envId, { ...envState, root: newRoot, activePaneId: toPaneId });
      set({ environments: newEnvs });

      // Then close empty source pane
      get().closePane(fromPaneId);
      return;
    }

    // Both panes will have tabs after the move
    // Remove from source
    let newRoot = updateLeaf(envState.root, fromPaneId, (leaf) => ({
      ...leaf,
      tabs: remainingTabs,
      activeTabId: leaf.activeTabId === tabId
        ? remainingTabs[remainingTabs.length - 1]?.id ?? null
        : leaf.activeTabId,
    }));

    // Add to target
    newRoot = updateLeaf(newRoot, toPaneId, (leaf) => {
      const newTabs = [...leaf.tabs];
      if (toIndex !== undefined) {
        newTabs.splice(toIndex, 0, tab);
      } else {
        newTabs.push(tab);
      }
      return {
        ...leaf,
        tabs: newTabs,
        activeTabId: tab.id,
      };
    });

    const newEnvs = new Map(state.environments);
    newEnvs.set(envId, { ...envState, root: newRoot, activePaneId: toPaneId });
    set({ environments: newEnvs });
  },

  reorderTabs: (paneId, fromIndex, toIndex) => {
    const state = get();
    const envId = state.activeEnvironmentId;
    if (!envId) return;

    const envState = state.environments.get(envId);
    if (!envState) return;

    const newRoot = updateLeaf(envState.root, paneId, (leaf) => {
      const newTabs = [...leaf.tabs];
      const [moved] = newTabs.splice(fromIndex, 1);
      if (moved) {
        newTabs.splice(toIndex, 0, moved);
      }
      return {
        ...leaf,
        tabs: newTabs,
      };
    });

    const newEnvs = new Map(state.environments);
    newEnvs.set(envId, { ...envState, root: newRoot });
    set({ environments: newEnvs });
  },

  splitPane: (paneId, direction, tabId) => {
    const state = get();
    const envId = state.activeEnvironmentId;
    if (!envId) return;

    const envState = state.environments.get(envId);
    if (!envState) return;

    const leaf = findLeaf(envState.root, paneId);
    if (!leaf) return;

    // Check depth limit
    const currentDepth = getDepth(envState.root);
    if (currentDepth >= MAX_SPLIT_DEPTH) {
      console.debug("[PaneLayout] Max split depth reached");
      return;
    }

    // Find the tab to move to the new pane
    const tab = leaf.tabs.find((t) => t.id === tabId);
    if (!tab) return;

    // Remove the tab from the original pane
    const remainingTabs = leaf.tabs.filter((t) => t.id !== tabId);

    // Create the new pane with the moved tab
    const newPaneId = generateId("pane");
    const newPane: PaneLeaf = {
      kind: "leaf",
      id: newPaneId,
      tabs: [tab],
      activeTabId: tab.id,
    };

    // Update the original pane
    const updatedOriginalPane: PaneLeaf = {
      ...leaf,
      tabs: remainingTabs,
      activeTabId: remainingTabs.length > 0
        ? remainingTabs[remainingTabs.length - 1]?.id ?? null
        : null,
    };

    // Create the split - new pane goes to the right/bottom
    const newSplit: PaneSplit = {
      kind: "split",
      id: generateId("split"),
      direction,
      children: [updatedOriginalPane, newPane],
      sizes: [50, 50],
      depth: currentDepth + 1,
    };

    // Replace the original pane with the split
    const newRoot = replaceNode(envState.root, paneId, newSplit);
    const newEnvs = new Map(state.environments);
    newEnvs.set(envId, { ...envState, root: newRoot, activePaneId: newPaneId });
    set({ environments: newEnvs });
  },

  splitPaneAtEdge: (targetPaneId, edge, tabId, fromPaneId) => {
    const state = get();
    const envId = state.activeEnvironmentId;
    if (!envId) {
      console.warn("[paneLayoutStore] splitPaneAtEdge failed: no activeEnvironmentId");
      return;
    }

    const envState = state.environments.get(envId);
    if (!envState) {
      console.warn("[paneLayoutStore] splitPaneAtEdge failed: no envState for", envId);
      return;
    }

    const targetLeaf = findLeaf(envState.root, targetPaneId);
    if (!targetLeaf) {
      console.warn("[paneLayoutStore] splitPaneAtEdge failed: target pane not found", targetPaneId);
      return;
    }

    const sourceLeaf = findLeaf(envState.root, fromPaneId);
    if (!sourceLeaf) {
      console.warn("[paneLayoutStore] splitPaneAtEdge failed: source pane not found", fromPaneId);
      return;
    }

    // Check depth limit
    const currentDepth = getDepth(envState.root);
    if (currentDepth >= MAX_SPLIT_DEPTH) {
      console.debug("[PaneLayout] Max split depth reached");
      return;
    }

    // Find the tab in the SOURCE pane
    const tab = sourceLeaf.tabs.find((t) => t.id === tabId);
    if (!tab) {
      console.warn("[paneLayoutStore] splitPaneAtEdge failed: tab not found in source pane", { tabId, fromPaneId });
      return;
    }

    console.debug("[paneLayoutStore] splitPaneAtEdge executing", { targetPaneId, edge, tabId, fromPaneId });

    // Create the new pane with the moved tab
    const newPaneId = generateId("pane");
    const newPane: PaneLeaf = {
      kind: "leaf",
      id: newPaneId,
      tabs: [tab],
      activeTabId: tab.id,
    };

    // Determine split direction and child order based on edge
    const direction: "horizontal" | "vertical" =
      edge === "left" || edge === "right" ? "horizontal" : "vertical";

    // Check if we're splitting within the same pane (source === target)
    const isSamePaneSplit = fromPaneId === targetPaneId;

    let newRoot: PaneNode;

    if (isSamePaneSplit) {
      // When splitting within the same pane, we need to:
      // 1. Create updated target leaf WITHOUT the moved tab
      // 2. Create the split with the updated target leaf
      const remainingTabs = targetLeaf.tabs.filter((t) => t.id !== tabId);
      const updatedTargetLeaf: PaneLeaf = {
        ...targetLeaf,
        tabs: remainingTabs,
        activeTabId: targetLeaf.activeTabId === tabId
          ? remainingTabs[remainingTabs.length - 1]?.id ?? null
          : targetLeaf.activeTabId,
      };

      // For left/top edges, new pane comes first; for right/bottom, updated target comes first
      const children: [PaneNode, PaneNode] =
        edge === "left" || edge === "top"
          ? [newPane, updatedTargetLeaf]
          : [updatedTargetLeaf, newPane];

      const newSplit: PaneSplit = {
        kind: "split",
        id: generateId("split"),
        direction,
        children,
        sizes: [50, 50],
        depth: currentDepth + 1,
      };

      // Replace the pane with the split (no need to update source separately since it's the same pane)
      newRoot = replaceNode(envState.root, targetPaneId, newSplit);
    } else {
      // Different panes: remove from source, then create split at target
      // For left/top edges, new pane comes first; for right/bottom, target comes first
      const children: [PaneNode, PaneNode] =
        edge === "left" || edge === "top"
          ? [newPane, targetLeaf]
          : [targetLeaf, newPane];

      const newSplit: PaneSplit = {
        kind: "split",
        id: generateId("split"),
        direction,
        children,
        sizes: [50, 50],
        depth: currentDepth + 1,
      };

      // First, remove the tab from the source pane
      newRoot = updateLeaf(envState.root, fromPaneId, (leaf) => {
        const remainingTabs = leaf.tabs.filter((t) => t.id !== tabId);
        return {
          ...leaf,
          tabs: remainingTabs,
          activeTabId: leaf.activeTabId === tabId
            ? remainingTabs[remainingTabs.length - 1]?.id ?? null
            : leaf.activeTabId,
        };
      });

      // Then, replace the target pane with the split
      newRoot = replaceNode(newRoot, targetPaneId, newSplit);
    }

    const newEnvs = new Map(state.environments);
    newEnvs.set(envId, { ...envState, root: newRoot, activePaneId: newPaneId });
    set({ environments: newEnvs });

    // If the source pane is now empty, close it (only for cross-pane splits)
    // For same-pane splits, the source pane was replaced by the split, so it doesn't exist anymore
    if (!isSamePaneSplit) {
      const updatedSourceLeaf = findLeaf(newRoot, fromPaneId);
      if (updatedSourceLeaf && updatedSourceLeaf.tabs.length === 0) {
        // Use a timeout to avoid state update conflicts
        setTimeout(() => get().closePane(fromPaneId), 0);
      }
    }
  },

  closePane: (paneId) => {
    const state = get();
    const envId = state.activeEnvironmentId;
    if (!envId) return;

    const envState = state.environments.get(envId);
    if (!envState) return;

    const parentSplit = findParentSplit(envState.root, paneId);

    // If no parent, this is the only pane - can't close it
    if (!parentSplit) {
      console.debug("[PaneLayout] Cannot close the only pane");
      return;
    }

    // Find the sibling
    const siblingIndex = parentSplit.children[0].id === paneId ? 1 : 0;
    const sibling = parentSplit.children[siblingIndex];

    // Replace parent split with sibling
    const newRoot = replaceNode(envState.root, parentSplit.id, sibling);

    // Update active pane if needed
    let newActivePaneId = envState.activePaneId;
    if (envState.activePaneId === paneId) {
      const firstLeaf = findFirstLeaf(sibling);
      newActivePaneId = firstLeaf.id;
    }

    const newEnvs = new Map(state.environments);
    newEnvs.set(envId, { ...envState, root: newRoot, activePaneId: newActivePaneId });
    set({ environments: newEnvs });
  },

  setActivePane: (paneId) => {
    const state = get();
    const envId = state.activeEnvironmentId;
    if (!envId) return;

    const envState = state.environments.get(envId);
    if (!envState) return;

    const newEnvs = new Map(state.environments);
    newEnvs.set(envId, { ...envState, activePaneId: paneId });
    set({ environments: newEnvs });
  },

  updateSizes: (splitId, sizes) => {
    const state = get();
    const envId = state.activeEnvironmentId;
    if (!envId) return;

    const envState = state.environments.get(envId);
    if (!envState) return;

    const update = (node: PaneNode): PaneNode => {
      if (isPaneLeaf(node)) return node;
      if (node.id === splitId) {
        return { ...node, sizes };
      }
      return {
        ...node,
        children: [update(node.children[0]), update(node.children[1])] as [PaneNode, PaneNode],
      };
    };

    const newRoot = update(envState.root);
    const newEnvs = new Map(state.environments);
    newEnvs.set(envId, { ...envState, root: newRoot });
    set({ environments: newEnvs });
  },

  getPane: (paneId) => {
    const state = get();
    const envState = getCurrentEnvState(state);
    return findLeaf(envState.root, paneId);
  },

  getActivePane: () => {
    const state = get();
    const envState = getCurrentEnvState(state);
    return findLeaf(envState.root, envState.activePaneId);
  },

  getAllTabs: () => {
    const state = get();
    const envState = getCurrentEnvState(state);
    const leaves = getAllLeaves(envState.root);
    return leaves.flatMap((leaf) => leaf.tabs);
  },

  getOpenFilePaths: () => {
    const tabs = get().getAllTabs();
    return tabs
      .filter((t) => t.type === "file" && t.fileData?.filePath)
      .map((t) => t.fileData!.filePath);
  },

  findPaneWithTab: (tabId: string) => {
    const state = get();
    const envState = getCurrentEnvState(state);
    return findPaneWithTab(envState.root, tabId);
  },
}));

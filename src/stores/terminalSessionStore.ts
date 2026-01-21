import { create } from "zustand";

/**
 * Creates a container-scoped session key for terminal sessions.
 * This ensures tab IDs (which may be reused across environments, e.g., "default")
 * don't collide when multiple environments are running.
 *
 * @param containerId - The container ID (null for local environments)
 * @param tabId - The tab ID within the environment
 * @param environmentId - The environment ID (required for local environments to ensure uniqueness)
 * @returns A unique session key in the format "containerId:tabId" or "local-environmentId:tabId"
 */
export function createSessionKey(containerId: string | null, tabId: string, environmentId?: string): string {
  if (containerId) {
    return `${containerId}:${tabId}`;
  }
  // For local environments, use environmentId to ensure each environment gets its own session
  if (environmentId) {
    return `local-${environmentId}:${tabId}`;
  }
  // Fallback for cases where environmentId is not available (should be rare)
  return `local:${tabId}`;
}

/**
 * Terminal session data including the session ID and serialized buffer.
 */
export interface TerminalSessionData {
  /** Backend PTY session ID (optional - may be undefined when restoring from persistent session) */
  sessionId?: string;
  /** Persistent session ID for sidebar tracking (different from PTY session ID) */
  persistentSessionId?: string;
  /** Serialized terminal buffer (VT sequences) for restoration */
  serializedBuffer?: string;
  /** Whether the auto-launch command (e.g., claude) was already executed */
  hasLaunchedCommand?: boolean;
}

/**
 * Store for mapping tab IDs to their terminal session data.
 * This allows terminal sessions to persist when tabs are moved between panes.
 *
 * The key insight is that the backend PTY session continues running even when
 * the React component unmounts. By storing the sessionId and serialized buffer,
 * we can reattach to the same session and restore the terminal content when
 * the component remounts in a new pane.
 */
interface TerminalSessionStore {
  /** Map of tab ID to terminal session data */
  sessions: Map<string, TerminalSessionData>;

  /** Get session data by tab ID */
  getSession: (tabId: string) => TerminalSessionData | undefined;

  /** Get just the session ID by tab ID (convenience method) */
  getSessionId: (tabId: string) => string | undefined;

  /** Get the persistent session ID by tab ID */
  getPersistentSessionId: (tabId: string) => string | undefined;

  /** Register a session for a tab */
  setSession: (tabId: string, data: TerminalSessionData) => void;

  /** Update the serialized buffer for a tab */
  setSerializedBuffer: (tabId: string, buffer: string) => void;

  /** Set the persistent session ID for a tab */
  setPersistentSessionId: (tabId: string, persistentSessionId: string) => void;

  /** Mark that the auto-launch command was executed for a tab */
  setHasLaunchedCommand: (tabId: string, launched: boolean) => void;

  /** Remove session mapping when tab is closed */
  removeSession: (tabId: string) => void;

  /** Clear all sessions (e.g., when container changes) */
  clearAllSessions: () => void;
}

export const useTerminalSessionStore = create<TerminalSessionStore>(
  (set, get) => ({
    sessions: new Map(),

    getSession: (tabId: string) => {
      return get().sessions.get(tabId);
    },

    getSessionId: (tabId: string) => {
      return get().sessions.get(tabId)?.sessionId;
    },

    getPersistentSessionId: (tabId: string) => {
      return get().sessions.get(tabId)?.persistentSessionId;
    },

    setSession: (tabId: string, data: TerminalSessionData) => {
      set((state) => {
        const newSessions = new Map(state.sessions);
        newSessions.set(tabId, data);
        return { sessions: newSessions };
      });
    },

    setSerializedBuffer: (tabId: string, buffer: string) => {
      set((state) => {
        const existing = state.sessions.get(tabId);
        if (!existing) return state;

        const newSessions = new Map(state.sessions);
        newSessions.set(tabId, { ...existing, serializedBuffer: buffer });
        return { sessions: newSessions };
      });
    },

    setPersistentSessionId: (tabId: string, persistentSessionId: string) => {
      set((state) => {
        const existing = state.sessions.get(tabId);
        if (!existing) return state;

        const newSessions = new Map(state.sessions);
        newSessions.set(tabId, { ...existing, persistentSessionId });
        return { sessions: newSessions };
      });
    },

    setHasLaunchedCommand: (tabId: string, launched: boolean) => {
      set((state) => {
        const existing = state.sessions.get(tabId);
        if (!existing) return state;

        const newSessions = new Map(state.sessions);
        newSessions.set(tabId, { ...existing, hasLaunchedCommand: launched });
        return { sessions: newSessions };
      });
    },

    removeSession: (tabId: string) => {
      set((state) => {
        const newSessions = new Map(state.sessions);
        newSessions.delete(tabId);
        return { sessions: newSessions };
      });
    },

    clearAllSessions: () => {
      set({ sessions: new Map() });
    },
  })
);

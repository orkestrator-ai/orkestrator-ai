import { create } from "zustand";
import {
  ERROR_MESSAGE_PREFIX,
  type OpenCodeMessage,
  type OpenCodeModel,
  type OpenCodeConversationMode,
  type OpencodeClient,
  type QuestionRequest,
  type OpenCodeEvent,
} from "@/lib/opencode-client";
import { createSessionKey } from "@/lib/utils";

/**
 * Creates a unique session key for OpenCode sessions.
 * Re-exported from utils for backwards compatibility.
 */
export const createOpenCodeSessionKey = createSessionKey;

/** Shared event subscription state per environment */
export interface EventSubscriptionState {
  /** Abort controller for the subscription */
  abortController: AbortController;
  /** Reference to the async iterator for cleanup */
  stream: AsyncIterable<OpenCodeEvent> | null;
  /** Whether the subscription is active */
  isActive: boolean;
}

/** Server status for a container */
export interface OpenCodeServerStatus {
  running: boolean;
  hostPort: number | null;
}

/** Session state for an environment */
export interface OpenCodeSessionState {
  sessionId: string;
  messages: OpenCodeMessage[];
  isLoading: boolean;
  /** Error message to display (cleared when new message is sent) */
  error?: string;
}

/** Attachment types for compose bar */
export interface OpenCodeAttachment {
  id: string;
  type: "file" | "image";
  path: string;
  /** Preview URL for images */
  previewUrl?: string;
  /** File name for display */
  name: string;
}

interface OpenCodeState {
  // State per environment (keyed by environmentId)
  /** Server status per environment */
  serverStatus: Map<string, OpenCodeServerStatus>;
  /** Active session per environment */
  sessions: Map<string, OpenCodeSessionState>;
  /** SDK client per environment (keyed by environmentId) */
  clients: Map<string, OpencodeClient>;
  /** Available models (shared across all environments) */
  models: OpenCodeModel[];
  /** Currently selected model per environment */
  selectedModel: Map<string, string>;
  /** Currently selected mode per environment */
  selectedMode: Map<string, OpenCodeConversationMode>;
  /** Current attachments per tab session key (format: env-{environmentId}:{tabId}) */
  attachments: Map<string, OpenCodeAttachment[]>;
  /** Whether the compose bar is loading per environment */
  isComposing: Map<string, boolean>;
  /** Pending question requests (keyed by requestId) */
  pendingQuestions: Map<string, QuestionRequest>;
  /** Shared event subscriptions per environment - only ONE per environment */
  eventSubscriptions: Map<string, EventSubscriptionState>;

  // Actions
  /** Set server status for an environment */
  setServerStatus: (environmentId: string, status: OpenCodeServerStatus) => void;
  /** Set the SDK client for an environment */
  setClient: (environmentId: string, client: OpencodeClient | null) => void;
  /** Get the SDK client for an environment */
  getClient: (environmentId: string) => OpencodeClient | undefined;
  /** Set available models */
  setModels: (models: OpenCodeModel[]) => void;
  /** Set selected model for an environment */
  setSelectedModel: (environmentId: string, modelId: string) => void;
  /** Set selected mode for an environment */
  setSelectedMode: (environmentId: string, mode: OpenCodeConversationMode) => void;
  /** Set session for an environment */
  setSession: (environmentId: string, session: OpenCodeSessionState | null) => void;
  /** Add a message to a session */
  addMessage: (environmentId: string, message: OpenCodeMessage) => void;
  /** Update messages for a session */
  setMessages: (environmentId: string, messages: OpenCodeMessage[]) => void;
  /** Set loading state for a session */
  setSessionLoading: (environmentId: string, isLoading: boolean) => void;
  /** Set error message for a session */
  setSessionError: (environmentId: string, error: string | undefined) => void;
  /** Add attachment to compose bar */
  addAttachment: (sessionKey: string, attachment: OpenCodeAttachment) => void;
  /** Remove attachment from compose bar */
  removeAttachment: (sessionKey: string, attachmentId: string) => void;
  /** Clear all attachments for a tab session */
  clearAttachments: (sessionKey: string) => void;
  /** Set composing state */
  setComposing: (environmentId: string, isComposing: boolean) => void;
  /** Clear all state for an environment (cleanup) */
  clearEnvironment: (environmentId: string) => void;
  /** Add a pending question request */
  addPendingQuestion: (question: QuestionRequest) => void;
  /** Remove a pending question request */
  removePendingQuestion: (requestId: string) => void;
  /** Get or create event subscription for an environment (returns existing if already active) */
  getOrCreateEventSubscription: (environmentId: string) => EventSubscriptionState | null;
  /** Set the event stream for an environment's subscription */
  setEventStream: (environmentId: string, stream: AsyncIterable<OpenCodeEvent> | null) => void;
  /** Close and remove event subscription for an environment */
  closeEventSubscription: (environmentId: string) => void;
  /** Check if event subscription exists and is active for an environment */
  hasActiveEventSubscription: (environmentId: string) => boolean;

  // Selectors
  /** Get server status for an environment */
  getServerStatus: (environmentId: string) => OpenCodeServerStatus | undefined;
  /** Get session for an environment */
  getSession: (environmentId: string) => OpenCodeSessionState | undefined;
  /** Get selected model for an environment */
  getSelectedModel: (environmentId: string) => string | undefined;
  /** Get selected mode for an environment */
  getSelectedMode: (environmentId: string) => OpenCodeConversationMode;
  /** Get attachments for a tab session */
  getAttachments: (sessionKey: string) => OpenCodeAttachment[];
  /** Check if composing for an environment */
  isComposingFor: (environmentId: string) => boolean;
  /** Get pending questions for a session */
  getPendingQuestionsForSession: (sessionId: string) => QuestionRequest[];
  /** Get a specific pending question by ID */
  getPendingQuestion: (requestId: string) => QuestionRequest | undefined;
}

export const useOpenCodeStore = create<OpenCodeState>()((set, get) => ({
  // Initial state
  serverStatus: new Map(),
  sessions: new Map(),
  clients: new Map(),
  models: [],
  selectedModel: new Map(),
  selectedMode: new Map(),
  attachments: new Map(),
  isComposing: new Map(),
  pendingQuestions: new Map(),
  eventSubscriptions: new Map(),

  // Actions
  setServerStatus: (environmentId, status) =>
    set((state) => {
      const newMap = new Map(state.serverStatus);
      newMap.set(environmentId, status);
      return { serverStatus: newMap };
    }),

  setClient: (environmentId, client) =>
    set((state) => {
      const newMap = new Map(state.clients);
      if (client) {
        newMap.set(environmentId, client);
      } else {
        newMap.delete(environmentId);
      }
      return { clients: newMap };
    }),

  getClient: (environmentId) => get().clients.get(environmentId),

  setModels: (models) => set({ models }),

  setSelectedModel: (environmentId, modelId) =>
    set((state) => {
      const newMap = new Map(state.selectedModel);
      newMap.set(environmentId, modelId);
      return { selectedModel: newMap };
    }),

  setSelectedMode: (environmentId, mode) =>
    set((state) => {
      const newMap = new Map(state.selectedMode);
      newMap.set(environmentId, mode);
      return { selectedMode: newMap };
    }),

  setSession: (environmentId, session) =>
    set((state) => {
      const newMap = new Map(state.sessions);
      if (session) {
        newMap.set(environmentId, session);
      } else {
        newMap.delete(environmentId);
      }
      return { sessions: newMap };
    }),

  addMessage: (environmentId, message) =>
    set((state) => {
      const session = state.sessions.get(environmentId);
      if (!session) return state;

      const newMap = new Map(state.sessions);
      newMap.set(environmentId, {
        ...session,
        messages: [...session.messages, message],
      });
      return { sessions: newMap };
    }),

  setMessages: (environmentId, messages) =>
    set((state) => {
      const session = state.sessions.get(environmentId);
      if (!session) return state;

      // Preserve client-side error messages (IDs starting with ERROR_MESSAGE_PREFIX)
      // These are not stored on the server, so we need to merge them back
      const existingErrors = session.messages.filter((m) => m.id.startsWith(ERROR_MESSAGE_PREFIX));

      // If there are no error messages to preserve, just use server messages
      if (existingErrors.length === 0) {
        const newMap = new Map(state.sessions);
        newMap.set(environmentId, {
          ...session,
          messages,
        });
        return { sessions: newMap };
      }

      // Merge error messages into server messages based on timestamp
      // Each error should appear after the message it follows chronologically
      const mergedMessages = [...messages];
      for (const errorMsg of existingErrors) {
        const errorTime = new Date(errorMsg.createdAt || 0).getTime();
        // Find the position to insert: after the last message with earlier/equal timestamp
        let insertIndex = mergedMessages.length;
        for (let i = mergedMessages.length - 1; i >= 0; i--) {
          const msg = mergedMessages[i];
          if (!msg) continue;
          const msgTime = new Date(msg.createdAt || 0).getTime();
          if (msgTime <= errorTime) {
            insertIndex = i + 1;
            break;
          }
          if (i === 0 && msgTime > errorTime) {
            insertIndex = 0;
          }
        }
        mergedMessages.splice(insertIndex, 0, errorMsg);
      }

      const newMap = new Map(state.sessions);
      newMap.set(environmentId, {
        ...session,
        messages: mergedMessages,
      });
      return { sessions: newMap };
    }),

  setSessionLoading: (environmentId, isLoading) =>
    set((state) => {
      const session = state.sessions.get(environmentId);
      if (!session) return state;

      const newMap = new Map(state.sessions);
      newMap.set(environmentId, {
        ...session,
        isLoading,
      });
      return { sessions: newMap };
    }),

  setSessionError: (environmentId, error) =>
    set((state) => {
      const session = state.sessions.get(environmentId);
      if (!session) return state;

      const newMap = new Map(state.sessions);
      newMap.set(environmentId, {
        ...session,
        error,
      });
      return { sessions: newMap };
    }),

  addAttachment: (sessionKey, attachment) =>
    set((state) => {
      const current = state.attachments.get(sessionKey) || [];
      const newMap = new Map(state.attachments);
      newMap.set(sessionKey, [...current, attachment]);
      return { attachments: newMap };
    }),

  removeAttachment: (sessionKey, attachmentId) =>
    set((state) => {
      const current = state.attachments.get(sessionKey) || [];
      const newMap = new Map(state.attachments);
      newMap.set(
        sessionKey,
        current.filter((a) => a.id !== attachmentId)
      );
      return { attachments: newMap };
    }),

  clearAttachments: (sessionKey) =>
    set((state) => {
      const newMap = new Map(state.attachments);
      newMap.set(sessionKey, []);
      return { attachments: newMap };
    }),

  setComposing: (environmentId, isComposing) =>
    set((state) => {
      const newMap = new Map(state.isComposing);
      newMap.set(environmentId, isComposing);
      return { isComposing: newMap };
    }),

  clearEnvironment: (environmentId) => {
    // First close the event subscription if it exists
    const subscription = get().eventSubscriptions.get(environmentId);
    if (subscription) {
      console.log("[openCodeStore] Closing event subscription during environment cleanup:", environmentId);
      subscription.abortController.abort();
      if (subscription.stream && Symbol.asyncIterator in subscription.stream) {
        const iterator = subscription.stream[Symbol.asyncIterator]();
        if (iterator.return) {
          iterator.return().catch(() => {});
        }
      }
    }

    // Then clear all state
    set((state) => {
      const newServerStatus = new Map(state.serverStatus);
      const newSessions = new Map(state.sessions);
      const newClients = new Map(state.clients);
      const newSelectedModel = new Map(state.selectedModel);
      const newSelectedMode = new Map(state.selectedMode);
      const newAttachments = new Map(state.attachments);
      const newIsComposing = new Map(state.isComposing);
      const newPendingQuestions = new Map(state.pendingQuestions);
      const newEventSubscriptions = new Map(state.eventSubscriptions);

      const sessionKeyPrefix = `env-${environmentId}:`;

      newServerStatus.delete(environmentId);
      newSessions.delete(environmentId);
      newClients.delete(environmentId);
      newSelectedModel.delete(environmentId);
      newSelectedMode.delete(environmentId);
      for (const key of newAttachments.keys()) {
        if (key.startsWith(sessionKeyPrefix)) {
          newAttachments.delete(key);
        }
      }
      newIsComposing.delete(environmentId);
      newEventSubscriptions.delete(environmentId);
      // Remove pending questions for this environment's sessions
      for (const [requestId, question] of newPendingQuestions) {
        // Find the session for this environment
        const session = state.sessions.get(environmentId);
        if (session && question.sessionID === session.sessionId) {
          newPendingQuestions.delete(requestId);
        }
      }

      return {
        serverStatus: newServerStatus,
        sessions: newSessions,
        clients: newClients,
        selectedModel: newSelectedModel,
        selectedMode: newSelectedMode,
        attachments: newAttachments,
        isComposing: newIsComposing,
        pendingQuestions: newPendingQuestions,
        eventSubscriptions: newEventSubscriptions,
      };
    });
  },

  addPendingQuestion: (question) =>
    set((state) => {
      const newMap = new Map(state.pendingQuestions);
      newMap.set(question.id, question);
      return { pendingQuestions: newMap };
    }),

  removePendingQuestion: (requestId) =>
    set((state) => {
      const newMap = new Map(state.pendingQuestions);
      newMap.delete(requestId);
      return { pendingQuestions: newMap };
    }),

  getOrCreateEventSubscription: (environmentId) => {
    const state = get();
    const existing = state.eventSubscriptions.get(environmentId);

    // If we already have an active subscription, return it
    if (existing && existing.isActive) {
      console.log("[openCodeStore] Reusing existing event subscription for environment:", environmentId);
      return existing;
    }

    // Create new subscription state
    console.log("[openCodeStore] Creating new event subscription for environment:", environmentId);
    const newSubscription: EventSubscriptionState = {
      abortController: new AbortController(),
      stream: null,
      isActive: true,
    };

    // Store it
    const newMap = new Map(state.eventSubscriptions);
    newMap.set(environmentId, newSubscription);
    set({ eventSubscriptions: newMap });

    return newSubscription;
  },

  setEventStream: (environmentId, stream) =>
    set((state) => {
      const subscription = state.eventSubscriptions.get(environmentId);
      if (!subscription) return state;

      const newMap = new Map(state.eventSubscriptions);
      // When stream is set to null, mark subscription as inactive so a new one can be started
      const isActive = stream !== null;
      newMap.set(environmentId, { ...subscription, stream, isActive });
      return { eventSubscriptions: newMap };
    }),

  closeEventSubscription: (environmentId) => {
    const state = get();
    const subscription = state.eventSubscriptions.get(environmentId);

    if (!subscription) return;

    console.log("[openCodeStore] Closing event subscription for environment:", environmentId);

    // Abort the controller
    subscription.abortController.abort();

    // Close the stream if it exists
    if (subscription.stream && Symbol.asyncIterator in subscription.stream) {
      const iterator = subscription.stream[Symbol.asyncIterator]();
      if (iterator.return) {
        iterator.return().catch(() => {
          // Ignore errors during cleanup
        });
      }
    }

    // Remove from map
    const newMap = new Map(state.eventSubscriptions);
    newMap.delete(environmentId);
    set({ eventSubscriptions: newMap });
  },

  hasActiveEventSubscription: (environmentId) => {
    const subscription = get().eventSubscriptions.get(environmentId);
    return subscription?.isActive ?? false;
  },

  // Selectors
  getServerStatus: (environmentId) => get().serverStatus.get(environmentId),

  getSession: (environmentId) => get().sessions.get(environmentId),

  getSelectedModel: (environmentId) => get().selectedModel.get(environmentId),

  getSelectedMode: (environmentId) =>
    get().selectedMode.get(environmentId) || "build",

  getAttachments: (sessionKey) => get().attachments.get(sessionKey) || [],

  isComposingFor: (environmentId) =>
    get().isComposing.get(environmentId) || false,

  getPendingQuestionsForSession: (sessionId) => {
    const questions: QuestionRequest[] = [];
    for (const question of get().pendingQuestions.values()) {
      if (question.sessionID === sessionId) {
        questions.push(question);
      }
    }
    return questions;
  },

  getPendingQuestion: (requestId) => get().pendingQuestions.get(requestId),
}));

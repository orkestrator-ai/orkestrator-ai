import { create } from "zustand";
import {
  ERROR_MESSAGE_PREFIX,
  SYSTEM_MESSAGE_PREFIX,
  type ClaudeMessage,
  type ClaudeModel,
  type ClaudeClient,
  type ClaudeQuestionRequest,
  type ClaudePlanApprovalRequest,
  type ClaudeEvent,
  type SessionInitData,
  type ClaudeSessionKey,
  type ClaudeSdkSessionId,
} from "@/lib/claude-client";
import type { ContextUsageSnapshot } from "@/lib/context-usage";
import { createSessionKey } from "@/lib/utils";
import type { FileMention } from "@/types";

/**
 * Creates a unique session key for Claude sessions.
 * Re-exported from utils for backwards compatibility.
 */
export const createClaudeSessionKey = createSessionKey;

// Re-export types for convenience
export type { ClaudeSessionKey, ClaudeSdkSessionId };

/** Shared event subscription state per environment */
export interface ClaudeEventSubscriptionState {
  abortController: AbortController;
  stream: AsyncIterable<ClaudeEvent> | null;
  isActive: boolean;
}

/** Server status for a container */
export interface ClaudeServerStatus {
  running: boolean;
  hostPort: number | null;
}

/** Session state for an environment */
export interface ClaudeSessionState {
  sessionId: string;
  messages: ClaudeMessage[];
  isLoading: boolean;
  error?: string;
  title?: string;
}

/** Attachment types for compose bar */
export interface ClaudeAttachment {
  id: string;
  type: "file" | "image";
  path: string;
  previewUrl?: string;
  name: string;
}

/** Queued message for sending when session becomes idle */
export interface QueuedMessage {
  id: string;
  text: string;
  attachments: ClaudeAttachment[];
  thinkingEnabled: boolean;
  planModeEnabled: boolean;
}

interface ClaudeState {
  // State keyed by environmentId (raw environment UUID)
  serverStatus: Map<string, ClaudeServerStatus>;
  clients: Map<string, ClaudeClient>;
  eventSubscriptions: Map<string, ClaudeEventSubscriptionState>;

  // State keyed by sessionKey (format: "env-{environmentId}:{tabId}")
  // Use createClaudeSessionKey() to generate these keys
  sessions: Map<ClaudeSessionKey, ClaudeSessionState>;
  attachments: Map<ClaudeSessionKey, ClaudeAttachment[]>;
  draftText: Map<ClaudeSessionKey, string>;
  draftMentions: Map<ClaudeSessionKey, FileMention[]>;
  isComposing: Map<ClaudeSessionKey, boolean>;
  thinkingEnabled: Map<ClaudeSessionKey, boolean>;
  planMode: Map<ClaudeSessionKey, boolean>;
  selectedModel: Map<ClaudeSessionKey, string>;
  messageQueue: Map<ClaudeSessionKey, QueuedMessage[]>;
  sessionInitData: Map<string, SessionInitData>;
  contextUsage: Map<ClaudeSessionKey, ContextUsageSnapshot>;

  // State keyed by request/question ID
  pendingQuestions: Map<string, ClaudeQuestionRequest>;
  pendingPlanApprovals: Map<string, ClaudePlanApprovalRequest>;

  // Global state
  models: ClaudeModel[];

  // Actions - keyed by environmentId
  setServerStatus: (environmentId: string, status: ClaudeServerStatus) => void;
  setClient: (environmentId: string, client: ClaudeClient | null) => void;
  getClient: (environmentId: string) => ClaudeClient | undefined;
  setModels: (models: ClaudeModel[]) => void;

  // Actions - keyed by sessionKey (use createClaudeSessionKey to generate)
  setSelectedModel: (sessionKey: ClaudeSessionKey, modelId: string) => void;
  setSession: (sessionKey: ClaudeSessionKey, session: ClaudeSessionState | null) => void;
  addMessage: (sessionKey: ClaudeSessionKey, message: ClaudeMessage) => void;
  setMessages: (sessionKey: ClaudeSessionKey, messages: ClaudeMessage[]) => void;
  setSessionLoading: (sessionKey: ClaudeSessionKey, isLoading: boolean) => void;
  setSessionError: (sessionKey: ClaudeSessionKey, error: string | undefined) => void;
  setSessionTitle: (sessionKey: ClaudeSessionKey, title: string) => void;
  addAttachment: (sessionKey: ClaudeSessionKey, attachment: ClaudeAttachment) => void;
  removeAttachment: (sessionKey: ClaudeSessionKey, attachmentId: string) => void;
  clearAttachments: (sessionKey: ClaudeSessionKey) => void;
  setDraftText: (sessionKey: ClaudeSessionKey, text: string) => void;
  setDraftMentions: (sessionKey: ClaudeSessionKey, mentions: FileMention[]) => void;
  setComposing: (sessionKey: ClaudeSessionKey, isComposing: boolean) => void;
  setThinkingEnabled: (sessionKey: ClaudeSessionKey, enabled: boolean) => void;
  setPlanMode: (sessionKey: ClaudeSessionKey, enabled: boolean) => void;
  setSessionInitData: (environmentId: string, initData: SessionInitData | null) => void;
  setContextUsage: (sessionKey: ClaudeSessionKey, usage: ContextUsageSnapshot | null) => void;
  clearEnvironment: (environmentId: string) => void;

  // Queue actions - keyed by sessionKey
  addToQueue: (sessionKey: ClaudeSessionKey, message: QueuedMessage) => void;
  removeFromQueue: (sessionKey: ClaudeSessionKey) => QueuedMessage | undefined;
  clearQueue: (sessionKey: ClaudeSessionKey) => void;
  getQueueLength: (sessionKey: ClaudeSessionKey) => number;

  addPendingQuestion: (question: ClaudeQuestionRequest) => void;
  removePendingQuestion: (requestId: string) => void;
  addPendingPlanApproval: (approval: ClaudePlanApprovalRequest) => void;
  removePendingPlanApproval: (requestId: string) => void;
  getOrCreateEventSubscription: (environmentId: string) => ClaudeEventSubscriptionState | null;
  setEventStream: (environmentId: string, stream: AsyncIterable<ClaudeEvent> | null) => void;
  closeEventSubscription: (environmentId: string) => void;
  hasActiveEventSubscription: (environmentId: string) => boolean;

  // Selectors - keyed by environmentId
  getServerStatus: (environmentId: string) => ClaudeServerStatus | undefined;

  // Selectors - keyed by sessionKey
  getSession: (sessionKey: ClaudeSessionKey) => ClaudeSessionState | undefined;
  getSelectedModel: (sessionKey: ClaudeSessionKey) => string | undefined;
  getAttachments: (sessionKey: ClaudeSessionKey) => ClaudeAttachment[];
  getDraftText: (sessionKey: ClaudeSessionKey) => string;
  getDraftMentions: (sessionKey: ClaudeSessionKey) => FileMention[];
  isComposingFor: (sessionKey: ClaudeSessionKey) => boolean;
  isThinkingEnabled: (sessionKey: ClaudeSessionKey) => boolean;
  isPlanMode: (sessionKey: ClaudeSessionKey) => boolean;
  getSessionInitData: (environmentId: string) => SessionInitData | undefined;
  getContextUsage: (sessionKey: ClaudeSessionKey) => ContextUsageSnapshot | undefined;

  // Selectors - keyed by SDK session ID
  getPendingQuestionsForSession: (sdkSessionId: ClaudeSdkSessionId) => ClaudeQuestionRequest[];
  getPendingQuestion: (requestId: string) => ClaudeQuestionRequest | undefined;
  getPendingPlanApprovalsForSession: (sdkSessionId: ClaudeSdkSessionId) => ClaudePlanApprovalRequest[];
  getPendingPlanApproval: (requestId: string) => ClaudePlanApprovalRequest | undefined;

  /**
   * Find the sessionKey (store Map key) for a given SDK session ID.
   * This is useful when handling SSE events that include the SDK session ID
   * but need to update state in the store which is keyed by sessionKey.
   *
   * @param sdkSessionId - The Claude SDK session ID (e.g., "session-{uuid}")
   * @returns The sessionKey if found, null otherwise
   */
  getSessionKeyBySdkSessionId: (sdkSessionId: ClaudeSdkSessionId) => ClaudeSessionKey | null;
}

export const useClaudeStore = create<ClaudeState>()((set, get) => ({
  // Initial state
  serverStatus: new Map(),
  sessions: new Map(),
  clients: new Map(),
  models: [],
  selectedModel: new Map(),
  attachments: new Map(),
  draftText: new Map(),
  draftMentions: new Map(),
  isComposing: new Map(),
  pendingQuestions: new Map(),
  pendingPlanApprovals: new Map(),
  eventSubscriptions: new Map(),
  thinkingEnabled: new Map(),
  planMode: new Map(),
  messageQueue: new Map(),
  sessionInitData: new Map(),
  contextUsage: new Map(),

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

  setSelectedModel: (sessionKey, modelId) =>
    set((state) => {
      const newMap = new Map(state.selectedModel);
      newMap.set(sessionKey, modelId);
      return { selectedModel: newMap };
    }),

  setSession: (sessionKey, session) =>
    set((state) => {
      const newMap = new Map(state.sessions);
      if (session) {
        newMap.set(sessionKey, session);
      } else {
        newMap.delete(sessionKey);
      }
      return { sessions: newMap };
    }),

  addMessage: (sessionKey, message) =>
    set((state) => {
      const session = state.sessions.get(sessionKey);
      if (!session) return state;

      const newMap = new Map(state.sessions);
      newMap.set(sessionKey, {
        ...session,
        messages: [...session.messages, message],
      });
      return { sessions: newMap };
    }),

  setMessages: (sessionKey, messages) =>
    set((state) => {
      const session = state.sessions.get(sessionKey);
      if (!session) return state;

      // Preserve client-side messages (errors and system messages like compact notifications)
      // These exist only on the client and would be lost when fetching from server
      const existingClientMessages = session.messages.filter(
        (m) => m.id.startsWith(ERROR_MESSAGE_PREFIX) || m.id.startsWith(SYSTEM_MESSAGE_PREFIX)
      );

      if (existingClientMessages.length === 0) {
        const newMap = new Map(state.sessions);
        newMap.set(sessionKey, {
          ...session,
          messages,
        });
        return { sessions: newMap };
      }

      // Merge client-side messages into server messages based on timestamp
      const mergedMessages = [...messages];
      for (const clientMsg of existingClientMessages) {
        const clientTime = new Date(clientMsg.timestamp || 0).getTime();
        let insertIndex = mergedMessages.length;
        for (let i = mergedMessages.length - 1; i >= 0; i--) {
          const msg = mergedMessages[i];
          if (!msg) continue;
          const msgTime = new Date(msg.timestamp || 0).getTime();
          if (msgTime <= clientTime) {
            insertIndex = i + 1;
            break;
          }
          if (i === 0 && msgTime > clientTime) {
            insertIndex = 0;
          }
        }
        mergedMessages.splice(insertIndex, 0, clientMsg);
      }

      const newMap = new Map(state.sessions);
      newMap.set(sessionKey, {
        ...session,
        messages: mergedMessages,
      });
      return { sessions: newMap };
    }),

  setSessionLoading: (sessionKey, isLoading) =>
    set((state) => {
      const session = state.sessions.get(sessionKey);
      if (!session) return state;

      const newMap = new Map(state.sessions);
      newMap.set(sessionKey, {
        ...session,
        isLoading,
      });
      return { sessions: newMap };
    }),

  setSessionError: (sessionKey, error) =>
    set((state) => {
      const session = state.sessions.get(sessionKey);
      if (!session) return state;

      const newMap = new Map(state.sessions);
      newMap.set(sessionKey, {
        ...session,
        error,
      });
      return { sessions: newMap };
    }),

  setSessionTitle: (sessionKey, title) =>
    set((state) => {
      const session = state.sessions.get(sessionKey);
      if (!session) return state;

      const newMap = new Map(state.sessions);
      newMap.set(sessionKey, {
        ...session,
        title,
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

  setDraftText: (sessionKey, text) =>
    set((state) => {
      const newMap = new Map(state.draftText);
      if (text) {
        newMap.set(sessionKey, text);
      } else {
        newMap.delete(sessionKey);
      }
      return { draftText: newMap };
    }),

  setDraftMentions: (sessionKey, mentions) =>
    set((state) => {
      const newMap = new Map(state.draftMentions);
      if (mentions.length > 0) {
        newMap.set(sessionKey, mentions);
      } else {
        newMap.delete(sessionKey);
      }
      return { draftMentions: newMap };
    }),

  setComposing: (sessionKey, isComposing) =>
    set((state) => {
      const newMap = new Map(state.isComposing);
      newMap.set(sessionKey, isComposing);
      return { isComposing: newMap };
    }),

  setThinkingEnabled: (sessionKey, enabled) =>
    set((state) => {
      const newMap = new Map(state.thinkingEnabled);
      newMap.set(sessionKey, enabled);
      return { thinkingEnabled: newMap };
    }),

  setPlanMode: (sessionKey, enabled) =>
    set((state) => {
      const newMap = new Map(state.planMode);
      newMap.set(sessionKey, enabled);
      return { planMode: newMap };
    }),

  setSessionInitData: (environmentId, initData) =>
    set((state) => {
      const newMap = new Map(state.sessionInitData);
      if (initData) {
        newMap.set(environmentId, initData);
      } else {
        newMap.delete(environmentId);
      }
      return { sessionInitData: newMap };
    }),

  setContextUsage: (sessionKey, usage) =>
    set((state) => {
      const newMap = new Map(state.contextUsage);
      if (usage) {
        newMap.set(sessionKey, usage);
      } else {
        newMap.delete(sessionKey);
      }
      return { contextUsage: newMap };
    }),

  clearEnvironment: (environmentId) => {
    // First close the event subscription if it exists
    const subscription = get().eventSubscriptions.get(environmentId);
    if (subscription) {
      console.log("[claudeStore] Closing event subscription during environment cleanup:", environmentId);
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
      // Maps keyed by environmentId (raw UUID)
      const newServerStatus = new Map(state.serverStatus);
      const newClients = new Map(state.clients);
      const newEventSubscriptions = new Map(state.eventSubscriptions);
      const newSessionInitData = new Map(state.sessionInitData);

      newServerStatus.delete(environmentId);
      newClients.delete(environmentId);
      newEventSubscriptions.delete(environmentId);
      newSessionInitData.delete(environmentId);

      // Maps keyed by sessionKey (format: "env-{environmentId}:{tabId}")
      // Must iterate and delete all keys matching this environment
      const sessionKeyPrefix = `env-${environmentId}:`;

      const newSessions = new Map(state.sessions);
      const newSelectedModel = new Map(state.selectedModel);
      const newAttachments = new Map(state.attachments);
      const newDraftText = new Map(state.draftText);
      const newDraftMentions = new Map(state.draftMentions);
      const newIsComposing = new Map(state.isComposing);
      const newThinkingEnabled = new Map(state.thinkingEnabled);
      const newPlanMode = new Map(state.planMode);
      const newMessageQueue = new Map(state.messageQueue);
      const newContextUsage = new Map(state.contextUsage);

      // Collect session IDs for pending question cleanup before deleting sessions
      const sessionIdsToCleanup: string[] = [];
      for (const [key, session] of newSessions) {
        if (key.startsWith(sessionKeyPrefix)) {
          sessionIdsToCleanup.push(session.sessionId);
        }
      }

      // Delete sessionKey-keyed entries for this environment
      for (const key of newSessions.keys()) {
        if (key.startsWith(sessionKeyPrefix)) newSessions.delete(key);
      }
      for (const key of newSelectedModel.keys()) {
        if (key.startsWith(sessionKeyPrefix)) newSelectedModel.delete(key);
      }
      for (const key of newAttachments.keys()) {
        if (key.startsWith(sessionKeyPrefix)) newAttachments.delete(key);
      }
      for (const key of newDraftText.keys()) {
        if (key.startsWith(sessionKeyPrefix)) newDraftText.delete(key);
      }
      for (const key of newDraftMentions.keys()) {
        if (key.startsWith(sessionKeyPrefix)) newDraftMentions.delete(key);
      }
      for (const key of newIsComposing.keys()) {
        if (key.startsWith(sessionKeyPrefix)) newIsComposing.delete(key);
      }
      for (const key of newThinkingEnabled.keys()) {
        if (key.startsWith(sessionKeyPrefix)) newThinkingEnabled.delete(key);
      }
      for (const key of newPlanMode.keys()) {
        if (key.startsWith(sessionKeyPrefix)) newPlanMode.delete(key);
      }
      for (const key of newMessageQueue.keys()) {
        if (key.startsWith(sessionKeyPrefix)) newMessageQueue.delete(key);
      }
      for (const key of newContextUsage.keys()) {
        if (key.startsWith(sessionKeyPrefix)) newContextUsage.delete(key);
      }

      // Remove pending questions and plan approvals for this environment's sessions
      const newPendingQuestions = new Map(state.pendingQuestions);
      const newPendingPlanApprovals = new Map(state.pendingPlanApprovals);

      for (const [requestId, question] of newPendingQuestions) {
        if (sessionIdsToCleanup.includes(question.sessionId)) {
          newPendingQuestions.delete(requestId);
        }
      }
      for (const [requestId, approval] of newPendingPlanApprovals) {
        if (sessionIdsToCleanup.includes(approval.sessionId)) {
          newPendingPlanApprovals.delete(requestId);
        }
      }

      return {
        serverStatus: newServerStatus,
        sessions: newSessions,
        clients: newClients,
        selectedModel: newSelectedModel,
        attachments: newAttachments,
        draftText: newDraftText,
        draftMentions: newDraftMentions,
        isComposing: newIsComposing,
        pendingQuestions: newPendingQuestions,
        pendingPlanApprovals: newPendingPlanApprovals,
        eventSubscriptions: newEventSubscriptions,
        thinkingEnabled: newThinkingEnabled,
        planMode: newPlanMode,
        messageQueue: newMessageQueue,
        sessionInitData: newSessionInitData,
        contextUsage: newContextUsage,
      };
    });
  },

  // Queue actions
  addToQueue: (sessionKey, message) =>
    set((state) => {
      const current = state.messageQueue.get(sessionKey) || [];
      const newMap = new Map(state.messageQueue);
      newMap.set(sessionKey, [...current, message]);
      return { messageQueue: newMap };
    }),

  removeFromQueue: (sessionKey) => {
    const state = get();
    const current = state.messageQueue.get(sessionKey) || [];
    if (current.length === 0) return undefined;

    const [first, ...rest] = current;
    const newMap = new Map(state.messageQueue);
    newMap.set(sessionKey, rest);
    set({ messageQueue: newMap });
    return first;
  },

  clearQueue: (sessionKey) =>
    set((state) => {
      const newMap = new Map(state.messageQueue);
      newMap.set(sessionKey, []);
      return { messageQueue: newMap };
    }),

  getQueueLength: (sessionKey) => {
    const queue = get().messageQueue.get(sessionKey);
    return queue?.length || 0;
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

  addPendingPlanApproval: (approval) =>
    set((state) => {
      const newMap = new Map(state.pendingPlanApprovals);
      newMap.set(approval.id, approval);
      return { pendingPlanApprovals: newMap };
    }),

  removePendingPlanApproval: (requestId) =>
    set((state) => {
      const newMap = new Map(state.pendingPlanApprovals);
      newMap.delete(requestId);
      return { pendingPlanApprovals: newMap };
    }),

  getOrCreateEventSubscription: (environmentId) => {
    const state = get();
    const existing = state.eventSubscriptions.get(environmentId);

    if (existing && existing.isActive) {
      console.log("[claudeStore] Reusing existing event subscription for environment:", environmentId);
      return existing;
    }

    console.log("[claudeStore] Creating new event subscription for environment:", environmentId);
    const newSubscription: ClaudeEventSubscriptionState = {
      abortController: new AbortController(),
      stream: null,
      isActive: true,
    };

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
      const isActive = stream !== null;
      newMap.set(environmentId, { ...subscription, stream, isActive });
      return { eventSubscriptions: newMap };
    }),

  closeEventSubscription: (environmentId) => {
    const state = get();
    const subscription = state.eventSubscriptions.get(environmentId);

    if (!subscription) return;

    console.log("[claudeStore] Closing event subscription for environment:", environmentId);

    subscription.abortController.abort();

    if (subscription.stream && Symbol.asyncIterator in subscription.stream) {
      const iterator = subscription.stream[Symbol.asyncIterator]();
      if (iterator.return) {
        iterator.return().catch(() => {});
      }
    }

    const newMap = new Map(state.eventSubscriptions);
    newMap.delete(environmentId);
    set({ eventSubscriptions: newMap });
  },

  hasActiveEventSubscription: (environmentId) => {
    const subscription = get().eventSubscriptions.get(environmentId);
    return subscription?.isActive ?? false;
  },

  // Selectors - keyed by environmentId
  getServerStatus: (environmentId) => get().serverStatus.get(environmentId),

  // Selectors - keyed by sessionKey
  getSession: (sessionKey) => get().sessions.get(sessionKey),

  getSelectedModel: (sessionKey) => get().selectedModel.get(sessionKey),

  getAttachments: (sessionKey) => get().attachments.get(sessionKey) || [],

  getDraftText: (sessionKey) => get().draftText.get(sessionKey) || "",

  getDraftMentions: (sessionKey) => get().draftMentions.get(sessionKey) || [],

  isComposingFor: (sessionKey) => get().isComposing.get(sessionKey) || false,

  // Default to true (thinking enabled) if not explicitly set
  isThinkingEnabled: (sessionKey) => get().thinkingEnabled.get(sessionKey) ?? true,

  // Default to false (plan mode disabled) - uses bypassPermissions by default
  isPlanMode: (sessionKey) => get().planMode.get(sessionKey) ?? false,

  getSessionInitData: (environmentId) => get().sessionInitData.get(environmentId),

  getContextUsage: (sessionKey) => get().contextUsage.get(sessionKey),

  // Selectors - keyed by SDK session ID
  getPendingQuestionsForSession: (sdkSessionId) => {
    const questions: ClaudeQuestionRequest[] = [];
    for (const question of get().pendingQuestions.values()) {
      if (question.sessionId === sdkSessionId) {
        questions.push(question);
      }
    }
    return questions;
  },

  getPendingQuestion: (requestId) => get().pendingQuestions.get(requestId),

  getPendingPlanApprovalsForSession: (sdkSessionId) => {
    const approvals: ClaudePlanApprovalRequest[] = [];
    for (const approval of get().pendingPlanApprovals.values()) {
      if (approval.sessionId === sdkSessionId) {
        approvals.push(approval);
      }
    }
    return approvals;
  },

  getPendingPlanApproval: (requestId) => get().pendingPlanApprovals.get(requestId),

  /**
   * Find the sessionKey (store Map key) for a given SDK session ID.
   * This is useful when handling SSE events that include the SDK session ID
   * but need to update state in the store which is keyed by sessionKey.
   */
  getSessionKeyBySdkSessionId: (sdkSessionId) => {
    const sessions = get().sessions;
    for (const [sessionKey, sessionState] of sessions) {
      if (sessionState.sessionId === sdkSessionId) {
        return sessionKey;
      }
    }
    return null;
  },
}));

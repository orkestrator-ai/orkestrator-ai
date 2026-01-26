import { create } from "zustand";
import {
  ERROR_MESSAGE_PREFIX,
  type ClaudeMessage,
  type ClaudeModel,
  type ClaudeClient,
  type ClaudeQuestionRequest,
  type ClaudePlanApprovalRequest,
  type ClaudeEvent,
  type SessionInitData,
} from "@/lib/claude-client";
import { createSessionKey } from "@/lib/utils";

/**
 * Creates a unique session key for Claude sessions.
 * Re-exported from utils for backwards compatibility.
 */
export const createClaudeSessionKey = createSessionKey;

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
}

/** Attachment types for compose bar */
export interface ClaudeAttachment {
  id: string;
  type: "file" | "image";
  path: string;
  previewUrl?: string;
  name: string;
}

interface ClaudeState {
  // State per environment (keyed by environmentId)
  serverStatus: Map<string, ClaudeServerStatus>;
  sessions: Map<string, ClaudeSessionState>;
  clients: Map<string, ClaudeClient>;
  models: ClaudeModel[];
  selectedModel: Map<string, string>;
  attachments: Map<string, ClaudeAttachment[]>;
  draftText: Map<string, string>;
  isComposing: Map<string, boolean>;
  pendingQuestions: Map<string, ClaudeQuestionRequest>;
  pendingPlanApprovals: Map<string, ClaudePlanApprovalRequest>;
  eventSubscriptions: Map<string, ClaudeEventSubscriptionState>;
  thinkingEnabled: Map<string, boolean>;
  planMode: Map<string, boolean>;
  sessionInitData: Map<string, SessionInitData>;

  // Actions
  setServerStatus: (environmentId: string, status: ClaudeServerStatus) => void;
  setClient: (environmentId: string, client: ClaudeClient | null) => void;
  getClient: (environmentId: string) => ClaudeClient | undefined;
  setModels: (models: ClaudeModel[]) => void;
  setSelectedModel: (environmentId: string, modelId: string) => void;
  setSession: (environmentId: string, session: ClaudeSessionState | null) => void;
  addMessage: (environmentId: string, message: ClaudeMessage) => void;
  setMessages: (environmentId: string, messages: ClaudeMessage[]) => void;
  setSessionLoading: (environmentId: string, isLoading: boolean) => void;
  setSessionError: (environmentId: string, error: string | undefined) => void;
  addAttachment: (environmentId: string, attachment: ClaudeAttachment) => void;
  removeAttachment: (environmentId: string, attachmentId: string) => void;
  clearAttachments: (environmentId: string) => void;
  setDraftText: (environmentId: string, text: string) => void;
  setComposing: (environmentId: string, isComposing: boolean) => void;
  setThinkingEnabled: (environmentId: string, enabled: boolean) => void;
  setPlanMode: (environmentId: string, enabled: boolean) => void;
  setSessionInitData: (environmentId: string, initData: SessionInitData | null) => void;
  clearEnvironment: (environmentId: string) => void;
  addPendingQuestion: (question: ClaudeQuestionRequest) => void;
  removePendingQuestion: (requestId: string) => void;
  addPendingPlanApproval: (approval: ClaudePlanApprovalRequest) => void;
  removePendingPlanApproval: (requestId: string) => void;
  getOrCreateEventSubscription: (environmentId: string) => ClaudeEventSubscriptionState | null;
  setEventStream: (environmentId: string, stream: AsyncIterable<ClaudeEvent> | null) => void;
  closeEventSubscription: (environmentId: string) => void;
  hasActiveEventSubscription: (environmentId: string) => boolean;

  // Selectors
  getServerStatus: (environmentId: string) => ClaudeServerStatus | undefined;
  getSession: (environmentId: string) => ClaudeSessionState | undefined;
  getSelectedModel: (environmentId: string) => string | undefined;
  getAttachments: (environmentId: string) => ClaudeAttachment[];
  getDraftText: (environmentId: string) => string;
  isComposingFor: (environmentId: string) => boolean;
  isThinkingEnabled: (environmentId: string) => boolean;
  isPlanMode: (environmentId: string) => boolean;
  getSessionInitData: (environmentId: string) => SessionInitData | undefined;
  getPendingQuestionsForSession: (sessionId: string) => ClaudeQuestionRequest[];
  getPendingQuestion: (requestId: string) => ClaudeQuestionRequest | undefined;
  getPendingPlanApprovalsForSession: (sessionId: string) => ClaudePlanApprovalRequest[];
  getPendingPlanApproval: (requestId: string) => ClaudePlanApprovalRequest | undefined;
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
  isComposing: new Map(),
  pendingQuestions: new Map(),
  pendingPlanApprovals: new Map(),
  eventSubscriptions: new Map(),
  thinkingEnabled: new Map(),
  planMode: new Map(),
  sessionInitData: new Map(),

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

      // Preserve client-side error messages
      const existingErrors = session.messages.filter((m) => m.id.startsWith(ERROR_MESSAGE_PREFIX));

      if (existingErrors.length === 0) {
        const newMap = new Map(state.sessions);
        newMap.set(environmentId, {
          ...session,
          messages,
        });
        return { sessions: newMap };
      }

      // Merge error messages into server messages based on timestamp
      const mergedMessages = [...messages];
      for (const errorMsg of existingErrors) {
        const errorTime = new Date(errorMsg.timestamp || 0).getTime();
        let insertIndex = mergedMessages.length;
        for (let i = mergedMessages.length - 1; i >= 0; i--) {
          const msg = mergedMessages[i];
          if (!msg) continue;
          const msgTime = new Date(msg.timestamp || 0).getTime();
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

  addAttachment: (environmentId, attachment) =>
    set((state) => {
      const current = state.attachments.get(environmentId) || [];
      const newMap = new Map(state.attachments);
      newMap.set(environmentId, [...current, attachment]);
      return { attachments: newMap };
    }),

  removeAttachment: (environmentId, attachmentId) =>
    set((state) => {
      const current = state.attachments.get(environmentId) || [];
      const newMap = new Map(state.attachments);
      newMap.set(
        environmentId,
        current.filter((a) => a.id !== attachmentId)
      );
      return { attachments: newMap };
    }),

  clearAttachments: (environmentId) =>
    set((state) => {
      const newMap = new Map(state.attachments);
      newMap.set(environmentId, []);
      return { attachments: newMap };
    }),

  setDraftText: (environmentId, text) =>
    set((state) => {
      const newMap = new Map(state.draftText);
      if (text) {
        newMap.set(environmentId, text);
      } else {
        newMap.delete(environmentId);
      }
      return { draftText: newMap };
    }),

  setComposing: (environmentId, isComposing) =>
    set((state) => {
      const newMap = new Map(state.isComposing);
      newMap.set(environmentId, isComposing);
      return { isComposing: newMap };
    }),

  setThinkingEnabled: (environmentId, enabled) =>
    set((state) => {
      const newMap = new Map(state.thinkingEnabled);
      newMap.set(environmentId, enabled);
      return { thinkingEnabled: newMap };
    }),

  setPlanMode: (environmentId, enabled) =>
    set((state) => {
      const newMap = new Map(state.planMode);
      newMap.set(environmentId, enabled);
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
      const newServerStatus = new Map(state.serverStatus);
      const newSessions = new Map(state.sessions);
      const newClients = new Map(state.clients);
      const newSelectedModel = new Map(state.selectedModel);
      const newAttachments = new Map(state.attachments);
      const newDraftText = new Map(state.draftText);
      const newIsComposing = new Map(state.isComposing);
      const newPendingQuestions = new Map(state.pendingQuestions);
      const newEventSubscriptions = new Map(state.eventSubscriptions);
      const newThinkingEnabled = new Map(state.thinkingEnabled);
      const newPlanMode = new Map(state.planMode);
      const newSessionInitData = new Map(state.sessionInitData);

      newServerStatus.delete(environmentId);
      newSessions.delete(environmentId);
      newClients.delete(environmentId);
      newSelectedModel.delete(environmentId);
      newAttachments.delete(environmentId);
      newDraftText.delete(environmentId);
      newIsComposing.delete(environmentId);
      newEventSubscriptions.delete(environmentId);
      newThinkingEnabled.delete(environmentId);
      newPlanMode.delete(environmentId);
      newSessionInitData.delete(environmentId);

      // Remove pending questions for this environment's sessions
      for (const [requestId, question] of newPendingQuestions) {
        const session = state.sessions.get(environmentId);
        if (session && question.sessionId === session.sessionId) {
          newPendingQuestions.delete(requestId);
        }
      }

      return {
        serverStatus: newServerStatus,
        sessions: newSessions,
        clients: newClients,
        selectedModel: newSelectedModel,
        attachments: newAttachments,
        draftText: newDraftText,
        isComposing: newIsComposing,
        pendingQuestions: newPendingQuestions,
        eventSubscriptions: newEventSubscriptions,
        thinkingEnabled: newThinkingEnabled,
        planMode: newPlanMode,
        sessionInitData: newSessionInitData,
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

  // Selectors
  getServerStatus: (environmentId) => get().serverStatus.get(environmentId),

  getSession: (environmentId) => get().sessions.get(environmentId),

  getSelectedModel: (environmentId) => get().selectedModel.get(environmentId),

  getAttachments: (environmentId) => get().attachments.get(environmentId) || [],

  getDraftText: (environmentId) => get().draftText.get(environmentId) || "",

  isComposingFor: (environmentId) => get().isComposing.get(environmentId) || false,

  // Default to true (thinking enabled) if not explicitly set
  isThinkingEnabled: (environmentId) => get().thinkingEnabled.get(environmentId) ?? true,

  // Default to false (plan mode disabled) - uses bypassPermissions by default
  isPlanMode: (environmentId) => get().planMode.get(environmentId) ?? false,

  getSessionInitData: (environmentId) => get().sessionInitData.get(environmentId),

  getPendingQuestionsForSession: (sessionId) => {
    const questions: ClaudeQuestionRequest[] = [];
    for (const question of get().pendingQuestions.values()) {
      if (question.sessionId === sessionId) {
        questions.push(question);
      }
    }
    return questions;
  },

  getPendingQuestion: (requestId) => get().pendingQuestions.get(requestId),

  getPendingPlanApprovalsForSession: (sessionId) => {
    const approvals: ClaudePlanApprovalRequest[] = [];
    for (const approval of get().pendingPlanApprovals.values()) {
      if (approval.sessionId === sessionId) {
        approvals.push(approval);
      }
    }
    return approvals;
  },

  getPendingPlanApproval: (requestId) => get().pendingPlanApprovals.get(requestId),
}));

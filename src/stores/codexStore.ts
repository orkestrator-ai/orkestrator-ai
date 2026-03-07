import { create } from "zustand";
import {
  CODEX_MODELS,
  DEFAULT_CODEX_MODEL,
  type CodexClient,
  type CodexConversationMode,
  type CodexMessage,
  type CodexModel,
  type CodexReasoningEffort,
  type CodexSlashCommand,
} from "@/lib/codex-client";
import { createSessionKey } from "@/lib/utils";

export const createCodexSessionKey = createSessionKey;

export interface CodexServerStatus {
  running: boolean;
  hostPort: number | null;
}

export interface CodexSessionState {
  sessionId: string;
  messages: CodexMessage[];
  isLoading: boolean;
  error?: string;
  title?: string;
}

export interface CodexAttachment {
  id: string;
  type: "image";
  path: string;
  previewUrl?: string;
  name: string;
}

interface CodexState {
  models: CodexModel[];
  serverStatus: Map<string, CodexServerStatus>;
  clients: Map<string, CodexClient>;
  sessions: Map<string, CodexSessionState>;
  slashCommands: Map<string, CodexSlashCommand[]>;
  attachments: Map<string, CodexAttachment[]>;
  draftText: Map<string, string>;
  selectedModel: Map<string, string>;
  selectedMode: Map<string, CodexConversationMode>;
  selectedReasoningEffort: Map<string, CodexReasoningEffort>;
  setModels: (models: CodexModel[]) => void;
  setServerStatus: (environmentId: string, status: CodexServerStatus) => void;
  setClient: (environmentId: string, client: CodexClient | null) => void;
  setSession: (sessionKey: string, session: CodexSessionState | null) => void;
  setMessages: (sessionKey: string, messages: CodexMessage[]) => void;
  setSlashCommands: (environmentId: string, commands: CodexSlashCommand[]) => void;
  setSessionLoading: (sessionKey: string, isLoading: boolean) => void;
  setSessionError: (sessionKey: string, error: string | undefined) => void;
  setSessionTitle: (sessionKey: string, title: string | undefined) => void;
  addAttachment: (sessionKey: string, attachment: CodexAttachment) => void;
  removeAttachment: (sessionKey: string, attachmentId: string) => void;
  clearAttachments: (sessionKey: string) => void;
  setDraftText: (sessionKey: string, text: string) => void;
  setSelectedModel: (sessionKey: string, model: string) => void;
  setSelectedMode: (sessionKey: string, mode: CodexConversationMode) => void;
  setSelectedReasoningEffort: (
    sessionKey: string,
    effort: CodexReasoningEffort,
  ) => void;
  clearEnvironment: (environmentId: string) => void;
}

export const useCodexStore = create<CodexState>()((set) => ({
  models: CODEX_MODELS,
  serverStatus: new Map(),
  clients: new Map(),
  sessions: new Map(),
  slashCommands: new Map(),
  attachments: new Map(),
  draftText: new Map(),
  selectedModel: new Map(),
  selectedMode: new Map(),
  selectedReasoningEffort: new Map(),

  setModels: (models) => set({ models: models.length > 0 ? models : CODEX_MODELS }),

  setServerStatus: (environmentId, status) =>
    set((state) => {
      const next = new Map(state.serverStatus);
      next.set(environmentId, status);
      return { serverStatus: next };
    }),

  setClient: (environmentId, client) =>
    set((state) => {
      const next = new Map(state.clients);
      if (client) {
        next.set(environmentId, client);
      } else {
        next.delete(environmentId);
      }
      return { clients: next };
    }),

  setSession: (sessionKey, session) =>
    set((state) => {
      const next = new Map(state.sessions);
      if (session) {
        next.set(sessionKey, session);
      } else {
        next.delete(sessionKey);
      }
      return { sessions: next };
    }),

  setMessages: (sessionKey, messages) =>
    set((state) => {
      const session = state.sessions.get(sessionKey);
      if (!session) return state;
      const next = new Map(state.sessions);
      next.set(sessionKey, { ...session, messages });
      return { sessions: next };
    }),

  setSlashCommands: (environmentId, commands) =>
    set((state) => {
      const next = new Map(state.slashCommands);
      if (commands.length > 0) {
        next.set(environmentId, commands);
      } else {
        next.delete(environmentId);
      }
      return { slashCommands: next };
    }),

  setSessionLoading: (sessionKey, isLoading) =>
    set((state) => {
      const session = state.sessions.get(sessionKey);
      if (!session) return state;
      const next = new Map(state.sessions);
      next.set(sessionKey, { ...session, isLoading });
      return { sessions: next };
    }),

  setSessionError: (sessionKey, error) =>
    set((state) => {
      const session = state.sessions.get(sessionKey);
      if (!session) return state;
      const next = new Map(state.sessions);
      next.set(sessionKey, { ...session, error });
      return { sessions: next };
    }),

  setSessionTitle: (sessionKey, title) =>
    set((state) => {
      const session = state.sessions.get(sessionKey);
      if (!session) return state;
      const next = new Map(state.sessions);
      next.set(sessionKey, { ...session, title });
      return { sessions: next };
    }),

  addAttachment: (sessionKey, attachment) =>
    set((state) => {
      const current = state.attachments.get(sessionKey) || [];
      const next = new Map(state.attachments);
      next.set(sessionKey, [...current, attachment]);
      return { attachments: next };
    }),

  removeAttachment: (sessionKey, attachmentId) =>
    set((state) => {
      const current = state.attachments.get(sessionKey) || [];
      const next = new Map(state.attachments);
      const filtered = current.filter((attachment) => attachment.id !== attachmentId);
      if (filtered.length > 0) {
        next.set(sessionKey, filtered);
      } else {
        next.delete(sessionKey);
      }
      return { attachments: next };
    }),

  clearAttachments: (sessionKey) =>
    set((state) => {
      const next = new Map(state.attachments);
      next.delete(sessionKey);
      return { attachments: next };
    }),

  setDraftText: (sessionKey, text) =>
    set((state) => {
      const next = new Map(state.draftText);
      if (text.length > 0) {
        next.set(sessionKey, text);
      } else {
        next.delete(sessionKey);
      }
      return { draftText: next };
    }),

  setSelectedModel: (sessionKey, model) =>
    set((state) => {
      const next = new Map(state.selectedModel);
      next.set(sessionKey, model || DEFAULT_CODEX_MODEL);
      return { selectedModel: next };
    }),

  setSelectedMode: (sessionKey, mode) =>
    set((state) => {
      const next = new Map(state.selectedMode);
      next.set(sessionKey, mode);
      return { selectedMode: next };
    }),

  setSelectedReasoningEffort: (sessionKey, effort) =>
    set((state) => {
      const next = new Map(state.selectedReasoningEffort);
      next.set(sessionKey, effort);
      return { selectedReasoningEffort: next };
    }),

  clearEnvironment: (environmentId) =>
    set((state) => {
      const nextServerStatus = new Map(state.serverStatus);
      nextServerStatus.delete(environmentId);

      const nextClients = new Map(state.clients);
      nextClients.delete(environmentId);

      const nextSlashCommands = new Map(state.slashCommands);
      nextSlashCommands.delete(environmentId);

      const nextSessions = new Map(state.sessions);
      const nextAttachments = new Map(state.attachments);
      const nextDraftText = new Map(state.draftText);
      const nextSelectedModel = new Map(state.selectedModel);
      const nextSelectedMode = new Map(state.selectedMode);
      const nextSelectedReasoningEffort = new Map(state.selectedReasoningEffort);
      const prefix = `env-${environmentId}:`;

      for (const key of nextSessions.keys()) {
        if (key.startsWith(prefix)) {
          nextSessions.delete(key);
        }
      }

      for (const key of nextAttachments.keys()) {
        if (key.startsWith(prefix)) {
          nextAttachments.delete(key);
        }
      }

      for (const key of nextDraftText.keys()) {
        if (key.startsWith(prefix)) {
          nextDraftText.delete(key);
        }
      }

      for (const key of nextSelectedModel.keys()) {
        if (key.startsWith(prefix)) {
          nextSelectedModel.delete(key);
        }
      }

      for (const key of nextSelectedMode.keys()) {
        if (key.startsWith(prefix)) {
          nextSelectedMode.delete(key);
        }
      }

      for (const key of nextSelectedReasoningEffort.keys()) {
        if (key.startsWith(prefix)) {
          nextSelectedReasoningEffort.delete(key);
        }
      }

      return {
        models: state.models,
        serverStatus: nextServerStatus,
        clients: nextClients,
        slashCommands: nextSlashCommands,
        sessions: nextSessions,
        attachments: nextAttachments,
        draftText: nextDraftText,
        selectedModel: nextSelectedModel,
        selectedMode: nextSelectedMode,
        selectedReasoningEffort: nextSelectedReasoningEffort,
      };
    }),
}));

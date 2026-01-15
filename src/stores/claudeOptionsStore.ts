import { create } from "zustand";

export type AgentType = "claude" | "opencode";

export interface ClaudeOptions {
  launchAgent: boolean;
  agentType: AgentType;
  initialPrompt: string;
}

interface ClaudeOptionsState {
  // Map of environmentId to Claude options
  options: Record<string, ClaudeOptions>;

  // Actions
  setOptions: (environmentId: string, options: ClaudeOptions) => void;
  getOptions: (environmentId: string) => ClaudeOptions | undefined;
  clearOptions: (environmentId: string) => void;
}

export const useClaudeOptionsStore = create<ClaudeOptionsState>()((set, get) => ({
  options: {},

  setOptions: (environmentId, options) =>
    set((state) => ({
      options: { ...state.options, [environmentId]: options },
    })),

  getOptions: (environmentId) => get().options[environmentId],

  clearOptions: (environmentId) =>
    set((state) => {
      const { [environmentId]: _, ...rest } = state.options;
      return { options: rest };
    }),
}));

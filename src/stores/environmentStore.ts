import { create } from "zustand";
import type { Environment, EnvironmentStatus, PrState } from "@/types";

/** Sort environments by their order field */
const sortByOrder = (environments: Environment[]): Environment[] =>
  [...environments].sort((a, b) => a.order - b.order);

interface EnvironmentState {
  // State
  environments: Environment[];
  isLoading: boolean;
  error: string | null;
  /** Runtime state: environments whose workspace is ready (git cloned, shell prompt available) */
  workspaceReadyEnvironments: Set<string>;
  /** Runtime state: environments currently being deleted */
  deletingEnvironments: Set<string>;
  /** Runtime state: pending setup commands to run in terminal (from orkestrator-ai.json setupLocal) */
  pendingSetupCommands: Map<string, string[]>;
  /** Runtime state: tracks whether setup commands have been resolved for an environment (true = we know if there are commands or not) */
  setupCommandsResolved: Set<string>;

  // Actions
  setEnvironments: (environments: Environment[]) => void;
  /** Merge environments for a specific project (replaces that project's envs, keeps others) */
  mergeEnvironmentsForProject: (projectId: string, environments: Environment[]) => void;
  addEnvironment: (environment: Environment) => void;
  removeEnvironment: (environmentId: string) => void;
  updateEnvironment: (
    environmentId: string,
    updates: Partial<Environment>
  ) => void;
  updateEnvironmentStatus: (
    environmentId: string,
    status: EnvironmentStatus
  ) => void;
  setEnvironmentPR: (environmentId: string, prUrl: string | null, prState: PrState | null, hasMergeConflicts?: boolean | null) => void;
  /** Reorder environments within a project based on the new order of IDs */
  reorderEnvironments: (projectId: string, environmentIds: string[]) => void;
  setLoading: (isLoading: boolean) => void;
  setError: (error: string | null) => void;
  /** Mark an environment's workspace as ready */
  setWorkspaceReady: (environmentId: string, isReady: boolean) => void;
  /** Mark an environment as being deleted */
  setDeleting: (environmentId: string, isDeleting: boolean) => void;
  /** Set pending setup commands for an environment (to be run in terminal) */
  setPendingSetupCommands: (environmentId: string, commands: string[]) => void;
  /** Get and clear pending setup commands for an environment */
  consumePendingSetupCommands: (environmentId: string) => string[] | undefined;
  /** Mark setup commands as resolved for an environment (we know if there are commands or not) */
  setSetupCommandsResolved: (environmentId: string, resolved: boolean) => void;

  // Selectors
  getEnvironmentById: (environmentId: string) => Environment | undefined;
  getEnvironmentsByProjectId: (projectId: string) => Environment[];
  /** Check if an environment's workspace is ready */
  isWorkspaceReady: (environmentId: string) => boolean;
  /** Check if an environment is being deleted */
  isDeleting: (environmentId: string) => boolean;
  /** Check if setup commands have been resolved for an environment */
  isSetupCommandsResolved: (environmentId: string) => boolean;
}

export const useEnvironmentStore = create<EnvironmentState>()((set, get) => ({
  // Initial state
  environments: [],
  isLoading: false,
  error: null,
  workspaceReadyEnvironments: new Set<string>(),
  deletingEnvironments: new Set<string>(),
  pendingSetupCommands: new Map<string, string[]>(),
  setupCommandsResolved: new Set<string>(),

  // Actions
  setEnvironments: (environments) => set({ environments: sortByOrder(environments) }),

  mergeEnvironmentsForProject: (projectId, newEnvs) =>
    set((state) => {
      // Keep environments from other projects, replace this project's environments
      const otherEnvs = state.environments.filter((e) => e.projectId !== projectId);
      return { environments: sortByOrder([...otherEnvs, ...newEnvs]) };
    }),

  addEnvironment: (environment) =>
    set((state) => ({
      environments: sortByOrder([...state.environments, environment]),
    })),

  removeEnvironment: (environmentId) =>
    set((state) => ({
      environments: state.environments.filter((e) => e.id !== environmentId),
    })),

  updateEnvironment: (environmentId, updates) =>
    set((state) => ({
      environments: sortByOrder(
        state.environments.map((e) =>
          e.id === environmentId ? { ...e, ...updates } : e
        )
      ),
    })),

  updateEnvironmentStatus: (environmentId, status) =>
    set((state) => ({
      environments: state.environments.map((e) =>
        e.id === environmentId ? { ...e, status } : e
      ),
    })),

  setEnvironmentPR: (environmentId, prUrl, prState, hasMergeConflicts) =>
    set((state) => ({
      environments: state.environments.map((e) =>
        e.id === environmentId ? { ...e, prUrl, prState, hasMergeConflicts: hasMergeConflicts ?? null } : e
      ),
    })),

  reorderEnvironments: (projectId, environmentIds) =>
    set((state) => {
      // Keep environments from other projects as-is
      const otherProjectEnvs = state.environments.filter(
        (e) => e.projectId !== projectId
      );
      // Reorder environments for this project
      const reorderedEnvs = environmentIds
        .map((id, index) => {
          const env = state.environments.find(
            (e) => e.id === id && e.projectId === projectId
          );
          return env ? { ...env, order: index } : null;
        })
        .filter((e): e is Environment => e !== null);

      return {
        environments: [...otherProjectEnvs, ...reorderedEnvs],
      };
    }),

  setLoading: (isLoading) => set({ isLoading }),

  setError: (error) => set({ error }),

  setWorkspaceReady: (environmentId, isReady) =>
    set((state) => {
      const newSet = new Set(state.workspaceReadyEnvironments);
      if (isReady) {
        newSet.add(environmentId);
      } else {
        newSet.delete(environmentId);
      }
      return { workspaceReadyEnvironments: newSet };
    }),

  setDeleting: (environmentId, isDeleting) =>
    set((state) => {
      const newSet = new Set(state.deletingEnvironments);
      if (isDeleting) {
        newSet.add(environmentId);
      } else {
        newSet.delete(environmentId);
      }
      return { deletingEnvironments: newSet };
    }),

  setPendingSetupCommands: (environmentId, commands) =>
    set((state) => {
      const newMap = new Map(state.pendingSetupCommands);
      newMap.set(environmentId, commands);
      return { pendingSetupCommands: newMap };
    }),

  consumePendingSetupCommands: (environmentId) => {
    const commands = get().pendingSetupCommands.get(environmentId);
    if (commands) {
      set((state) => {
        const newMap = new Map(state.pendingSetupCommands);
        newMap.delete(environmentId);
        return { pendingSetupCommands: newMap };
      });
    }
    return commands;
  },

  setSetupCommandsResolved: (environmentId, resolved) =>
    set((state) => {
      const newSet = new Set(state.setupCommandsResolved);
      if (resolved) {
        newSet.add(environmentId);
      } else {
        newSet.delete(environmentId);
      }
      return { setupCommandsResolved: newSet };
    }),

  // Selectors
  getEnvironmentById: (environmentId) =>
    get().environments.find((e) => e.id === environmentId),

  getEnvironmentsByProjectId: (projectId) =>
    sortByOrder(get().environments.filter((e) => e.projectId === projectId)),

  isWorkspaceReady: (environmentId) =>
    get().workspaceReadyEnvironments.has(environmentId),

  isDeleting: (environmentId) =>
    get().deletingEnvironments.has(environmentId),

  isSetupCommandsResolved: (environmentId) =>
    get().setupCommandsResolved.has(environmentId),
}));

import { useEnvironmentStore } from "@/stores/environmentStore";
import * as tauri from "@/lib/tauri";

const setupCompletionPersistenceInFlight = new Set<string>();

interface ShouldAutoResolveSetupCommandsOptions {
  isLocalEnvironment: boolean;
  isLocalEnvironmentReady: boolean;
  setupCommandsResolved: boolean;
  hasPendingCommands: boolean;
}

/**
 * Auto-resolve setup command state when local environment is already ready and
 * no setup command payload is waiting to be consumed.
 */
export const shouldAutoResolveSetupCommands = ({
  isLocalEnvironment,
  isLocalEnvironmentReady,
  setupCommandsResolved,
  hasPendingCommands,
}: ShouldAutoResolveSetupCommandsOptions): boolean =>
  isLocalEnvironment &&
  isLocalEnvironmentReady &&
  !setupCommandsResolved &&
  !hasPendingCommands;

/**
 * Determines whether setup is still pending for a given environment type.
 * Used to gate agent initialization and show the "waiting for setup" UI.
 */
/**
 * Persist that setup scripts have completed for an environment, and reflect
 * that in the in-memory store. Safe to call repeatedly; no-ops if already
 * marked complete. Fire-and-forget: errors are logged but not thrown.
 */
export function markSetupScriptsComplete(environmentId: string): void {
  const store = useEnvironmentStore.getState();
  const env = store.getEnvironmentById(environmentId);
  if (!env || env.setupScriptsComplete || setupCompletionPersistenceInFlight.has(environmentId)) {
    console.debug(
      "[setup-commands] markSetupScriptsComplete skipped",
      { environmentId, hasEnv: !!env, alreadyComplete: env?.setupScriptsComplete, inFlight: setupCompletionPersistenceInFlight.has(environmentId) }
    );
    return;
  }

  console.debug("[setup-commands] markSetupScriptsComplete persisting", { environmentId });
  setupCompletionPersistenceInFlight.add(environmentId);
  tauri
    .setEnvironmentSetupComplete(environmentId, true)
    .then((updatedEnvironment) => {
      console.debug(
        "[setup-commands] markSetupScriptsComplete persisted",
        { environmentId, setupScriptsComplete: updatedEnvironment.setupScriptsComplete }
      );
      store.updateEnvironment(environmentId, updatedEnvironment);
    })
    .catch((err) => {
      console.error(
        "[setup-commands] Failed to persist setupScriptsComplete:",
        err
      );
    })
    .finally(() => {
      setupCompletionPersistenceInFlight.delete(environmentId);
    });
}

/**
 * Force the runtime setup-pending gates open for an environment without
 * persisting completion. Intended for the user-facing "skip waiting" override
 * when detection fails to fire. Covers both container and local envs.
 */
export function forceResolveSetupRuntime(environmentId: string): void {
  const store = useEnvironmentStore.getState();
  const env = store.getEnvironmentById(environmentId);
  const isLocal = env?.environmentType === "local";
  console.warn(
    "[setup-commands] forceResolveSetupRuntime invoked (manual override)",
    { environmentId, isLocal }
  );
  if (isLocal) {
    store.setSetupScriptsRunning(environmentId, false);
    store.setSetupCommandsResolved(environmentId, true);
    store.consumePendingSetupCommands(environmentId);
  } else {
    store.setWorkspaceReady(environmentId, true);
  }
}

export function isSetupPending(params: {
  isLocal: boolean;
  setupCommandsResolved: boolean;
  hasPendingSetupCommands: boolean;
  setupScriptsRunning: boolean;
  workspaceReady: boolean;
}): boolean {
  if (params.isLocal) {
    return params.setupScriptsRunning || params.hasPendingSetupCommands || !params.setupCommandsResolved;
  }
  return !params.workspaceReady;
}

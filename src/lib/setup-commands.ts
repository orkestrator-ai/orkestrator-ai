import { useEnvironmentStore } from "@/stores/environmentStore";
import * as tauri from "@/lib/tauri";

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
  if (env?.setupScriptsComplete) return;

  store.updateEnvironment(environmentId, { setupScriptsComplete: true });
  tauri.setEnvironmentSetupComplete(environmentId, true).catch((err) => {
    console.error(
      "[setup-commands] Failed to persist setupScriptsComplete:",
      err
    );
  });
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

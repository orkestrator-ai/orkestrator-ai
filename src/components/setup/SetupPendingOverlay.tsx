import { useEffect } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { forceResolveSetupRuntime } from "@/lib/setup-commands";
import { useEnvironmentStore } from "@/stores/environmentStore";

interface SetupPendingOverlayProps {
  environmentId: string;
  /** Short agent-specific message, e.g. "Claude will connect automatically once setup finishes" */
  subtext: string;
}

/**
 * Shared waiting-for-setup UI with a manual "Skip waiting" override.
 *
 * The override calls forceResolveSetupRuntime, which flips the runtime gates
 * without persisting completion. Use this when the normal detection path
 * (OSC marker or workspace-ready text marker) fails to fire.
 */
export function SetupPendingOverlay({ environmentId, subtext }: SetupPendingOverlayProps) {
  useEffect(() => {
    const snap = () => {
      const s = useEnvironmentStore.getState();
      return {
        workspaceReady: s.workspaceReadyEnvironments.has(environmentId),
        setupScriptsRunning: s.setupScriptsRunning.has(environmentId),
        setupCommandsResolved: s.setupCommandsResolved.has(environmentId),
        hasPendingSetupCommands: s.pendingSetupCommands.has(environmentId),
      };
    };
    console.log("[SetupPendingOverlay] mounted", { environmentId, ...snap() });
    return () => {
      console.log("[SetupPendingOverlay] unmounted (unblocked)", { environmentId, ...snap() });
    };
  }, [environmentId]);

  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
      <Loader2 className="w-8 h-8 animate-spin text-yellow-400" />
      <p className="text-sm">Waiting for setup scripts to complete...</p>
      <p className="text-xs">{subtext}</p>
      <Button
        variant="ghost"
        size="sm"
        className="mt-2 text-xs text-muted-foreground"
        onClick={() => forceResolveSetupRuntime(environmentId)}
      >
        Skip waiting
      </Button>
    </div>
  );
}

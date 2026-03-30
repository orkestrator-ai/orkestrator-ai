import { useCallback } from "react";
import { toast } from "sonner";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { useKanbanStore } from "@/stores/kanbanStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { useUIStore } from "@/stores/uiStore";
import { useClaudeOptionsStore } from "@/stores/claudeOptionsStore";
import { useEnvironments } from "@/hooks/useEnvironments";
import * as tauri from "@/lib/tauri";
import type { EnvironmentType } from "@/types";
import type { KanbanTask } from "@/lib/tauri";

export function useBuildPipeline() {
  const { createEnvironment, startEnvironment } = useEnvironments(null, { listenForRenameEvents: false });
  const { createPipeline, setPipelineEnvironment, setPhase, setPipelineError } = useBuildPipelineStore();
  const { updateTask } = useKanbanStore();
  const { addTab } = usePaneLayoutStore();
  const { selectProjectAndEnvironment } = useUIStore();
  const { setOptions } = useClaudeOptionsStore();

  const startBuild = useCallback(
    async (task: KanbanTask, environmentType: EnvironmentType) => {
      try {
        // 1. Create pipeline
        const pipelineId = createPipeline({
          taskId: task.id,
          projectId: task.projectId,
          environmentType,
          taskTitle: task.title,
        });

        // 2. Create environment named after the ticket
        const envName = `Build: ${task.title}`.slice(0, 60);

        const environment = await createEnvironment(
          task.projectId,
          envName,
          environmentType === "containerized" ? "restricted" : "full",
          undefined, // no initial prompt - we handle it via the pipeline
          undefined, // no port mappings
          environmentType,
        );

        // 3. Link pipeline to environment
        setPipelineEnvironment(pipelineId, environment.id);

        // 4. Configure environment for Claude native mode
        const configuredEnvironment = await tauri.updateEnvironmentAgentSettings(
          environment.id,
          "claude",
          "native",
          null,
        );

        // Update environment in store
        const { updateEnvironment } = await import("@/stores/environmentStore").then(m => ({
          updateEnvironment: m.useEnvironmentStore.getState().updateEnvironment,
        }));
        updateEnvironment(environment.id, configuredEnvironment);

        // Store agent options (needed for Claude bridge server to be started)
        setOptions(configuredEnvironment.id, {
          launchAgent: true,
          agentType: "claude",
          initialPrompt: "",
        });

        // 5. Update kanban task with pipeline/environment link
        await updateTask(task.id, {
          environmentId: environment.id,
          buildPipelineId: pipelineId,
        });

        // 6. Select the environment in the UI
        selectProjectAndEnvironment(task.projectId, configuredEnvironment.id);

        // 7. Start the environment
        setPhase(pipelineId, "starting-environment");
        try {
          await startEnvironment(configuredEnvironment.id);
        } catch (startErr) {
          console.error("[useBuildPipeline] Failed to start environment:", startErr);
          setPipelineError(pipelineId, `Failed to start environment: ${startErr instanceof Error ? startErr.message : String(startErr)}`);
          return;
        }

        // 8. Create build tab in the pane layout
        // Wait a tick for the environment pane to be initialized
        setTimeout(() => {
          const paneState = usePaneLayoutStore.getState();
          const envState = paneState.environments.get(configuredEnvironment.id);
          const activePaneId = envState?.activePaneId ?? "default";

          const buildTabId = `build-${pipelineId}`;
          const isLocal = environmentType === "local";

          addTab(activePaneId, {
            id: buildTabId,
            type: "claude-build",
            buildTabData: {
              environmentId: configuredEnvironment.id,
              pipelineId,
              taskId: task.id,
              isLocal,
            },
          }, configuredEnvironment.id);
        }, 500);

        toast.success("Build pipeline started");
      } catch (error) {
        console.error("[useBuildPipeline] Failed to start build:", error);
        toast.error("Failed to start build pipeline", {
          description: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
    [createPipeline, createEnvironment, setPipelineEnvironment, setPhase, setPipelineError, updateTask, addTab, selectProjectAndEnvironment, setOptions, startEnvironment]
  );

  const navigateToBuild = useCallback(
    (task: KanbanTask) => {
      if (!task.environmentId) return;

      selectProjectAndEnvironment(task.projectId, task.environmentId);

      // Find and activate the build tab
      setTimeout(() => {
        const paneState = usePaneLayoutStore.getState();
        const envState = paneState.environments.get(task.environmentId!);
        if (!envState) return;

        // Search all panes for the build tab
        const findBuildTab = (node: import("@/types/paneLayout").PaneNode): { paneId: string; tabId: string } | null => {
          if (node.kind === "leaf") {
            const tab = node.tabs.find((t) => t.type === "claude-build" && t.buildTabData?.taskId === task.id);
            if (tab) return { paneId: node.id, tabId: tab.id };
            return null;
          }
          for (const child of node.children) {
            const result = findBuildTab(child);
            if (result) return result;
          }
          return null;
        };

        const result = findBuildTab(envState.root);
        if (result) {
          paneState.setActiveTab(result.paneId, result.tabId);
        }
      }, 100);
    },
    [selectProjectAndEnvironment]
  );

  return { startBuild, navigateToBuild };
}

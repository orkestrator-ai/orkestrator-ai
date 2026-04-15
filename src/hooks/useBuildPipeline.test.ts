import { beforeEach, describe, expect, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { useUIStore } from "@/stores/uiStore";

const { useBuildPipeline } = await import("./useBuildPipeline");

describe("useBuildPipeline", () => {
  beforeEach(() => {
    usePaneLayoutStore.setState({
      environments: new Map(),
      activeEnvironmentId: "env-visible",
    });

    useUIStore.setState({
      selectedProjectId: null,
      selectedEnvironmentId: null,
      collapsedProjects: ["project-1"],
      selectedEnvironmentIds: [],
      expandedSessionsEnvironments: [],
      sidebarWidth: 280,
      zoomLevel: 100,
    });
  });

  test("navigateToBuild activates the build tab for the target environment without switching pane store focus", async () => {
    usePaneLayoutStore.setState({
      environments: new Map([
        ["env-hidden", {
          root: {
            kind: "leaf",
            id: "pane-hidden",
            tabs: [{
              id: "build-tab",
              type: "claude-build",
              buildTabData: {
                environmentId: "env-hidden",
                pipelineId: "pipeline-1",
                taskId: "task-1",
                isLocal: false,
              },
            }],
            activeTabId: null,
          },
          activePaneId: "pane-hidden",
          containerId: "container-hidden",
        }],
      ]),
      activeEnvironmentId: "env-visible",
    });

    const { result } = renderHook(() => useBuildPipeline());

    await act(async () => {
      await result.current.navigateToBuild({
        id: "task-1",
        projectId: "project-1",
        title: "Build task",
        description: "",
        acceptanceCriteria: "",
        status: "backlog",
        comments: [],
        images: [],
        environmentId: "env-hidden",
        createdAt: "2024-01-01T00:00:00.000Z",
        order: 0,
      });
    });

    expect(useUIStore.getState().selectedProjectId).toBe("project-1");
    expect(useUIStore.getState().selectedEnvironmentId).toBe("env-hidden");
    expect(useUIStore.getState().collapsedProjects).not.toContain("project-1");

    const envHidden = usePaneLayoutStore.getState().environments.get("env-hidden");
    expect(envHidden?.root.kind).toBe("leaf");
    if (!envHidden || envHidden.root.kind !== "leaf") {
      throw new Error("env-hidden root should be a leaf");
    }

    expect(envHidden.root.activeTabId).toBe("build-tab");
    expect(usePaneLayoutStore.getState().activeEnvironmentId).toBe("env-visible");
  });
});

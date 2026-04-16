import { beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { TerminalProvider } from "@/contexts";
import { useClaudeOptionsStore } from "@/stores/claudeOptionsStore";
import { useConfigStore } from "@/stores/configStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";

mock.module("@/components/pane-layout", () => ({
  PaneTree: () => null,
}));

mock.module("./TerminalPortalHost", () => ({
  TerminalPortalHost: () => null,
}));

mock.module("./InitializationLogs", () => ({
  InitializationLogs: () => null,
}));

const { TerminalContainer } = await import("./TerminalContainer");

describe("TerminalContainer", () => {
  beforeEach(() => {
    cleanup();

    usePaneLayoutStore.setState({
      environments: new Map([
        ["env-visible", {
          root: {
            kind: "leaf",
            id: "default",
            tabs: [{ id: "visible-tab", type: "plain" }],
            activeTabId: "visible-tab",
          },
          activePaneId: "default",
          containerId: "container-visible",
        }],
      ]),
      activeEnvironmentId: "env-visible",
    });

    useEnvironmentStore.setState({
      environments: [
        {
          id: "env-visible",
          projectId: "project-1",
          name: "visible",
          branch: "main",
          containerId: "container-visible",
          status: "running",
          prUrl: null,
          prState: null,
          hasMergeConflicts: null,
          createdAt: "2024-01-01T00:00:00.000Z",
          networkAccessMode: "restricted",
          order: 0,
          environmentType: "containerized",
        },
        {
          id: "env-hidden",
          projectId: "project-1",
          name: "hidden",
          branch: "main",
          containerId: "container-hidden",
          status: "running",
          prUrl: null,
          prState: null,
          hasMergeConflicts: null,
          createdAt: "2024-01-01T00:00:00.000Z",
          networkAccessMode: "restricted",
          order: 1,
          environmentType: "containerized",
        },
      ],
      isLoading: false,
      error: null,
      workspaceReadyEnvironments: new Set(),
      deletingEnvironments: new Set(),
      pendingSetupCommands: new Map(),
      setupCommandsResolved: new Set(),
      setupScriptsRunning: new Set(),
    });

    useConfigStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        repositories: {},
      },
    }));

    useClaudeOptionsStore.setState({
      options: {},
    });
  });

  test("initializes a hidden environment without changing the active pane-layout environment", async () => {
    render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-hidden"
          isContainerRunning
          isActive={false}
        />
      </TerminalProvider>
    );

    await waitFor(() => {
      const envHidden = usePaneLayoutStore.getState().environments.get("env-hidden");
      expect(envHidden).toBeDefined();
      expect(envHidden?.containerId).toBe("container-hidden");
      expect(envHidden?.root.kind).toBe("leaf");
      if (envHidden?.root.kind === "leaf") {
        expect(envHidden.root.tabs).toHaveLength(1);
        expect(envHidden.root.activeTabId).toBe("default");
      }
    });

    expect(usePaneLayoutStore.getState().activeEnvironmentId).toBe("env-visible");
  });

  test("creates a codex terminal tab when codexMode is terminal", async () => {
    useConfigStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          codexMode: "terminal",
        },
        repositories: {},
      },
    }));

    useClaudeOptionsStore.setState({
      options: {
        "env-hidden": {
          launchAgent: true,
          agentType: "codex",
          initialPrompt: "Review this diff",
        },
      },
    });

    render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId="container-hidden"
          isContainerRunning
          isActive={false}
        />
      </TerminalProvider>
    );

    await waitFor(() => {
      const envHidden = usePaneLayoutStore.getState().environments.get("env-hidden");
      expect(envHidden?.root.kind).toBe("leaf");
      if (!envHidden || envHidden.root.kind !== "leaf") {
        throw new Error("env-hidden root should be a leaf");
      }

      expect(envHidden.root.tabs).toHaveLength(1);
      expect(envHidden.root.tabs[0]?.type).toBe("codex");
      expect(envHidden.root.tabs[0]?.initialPrompt).toBe("Review this diff");
    });
  });

  test("creates a codex native tab for ready local environments when codexMode is native", async () => {
    useConfigStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          codexMode: "native",
        },
        repositories: {},
      },
    }));

    useEnvironmentStore.setState((state) => ({
      ...state,
      environments: state.environments.map((env) =>
        env.id === "env-hidden"
          ? {
              ...env,
              containerId: null,
              environmentType: "local",
              worktreePath: "/tmp/env-hidden-worktree",
            }
          : env
      ),
      setupCommandsResolved: new Set(["env-hidden"]),
    }));

    useClaudeOptionsStore.setState({
      options: {
        "env-hidden": {
          launchAgent: true,
          agentType: "codex",
          initialPrompt: "Ship it",
        },
      },
    });

    render(
      <TerminalProvider>
        <TerminalContainer
          environmentId="env-hidden"
          containerId={null}
          isActive={false}
        />
      </TerminalProvider>
    );

    await waitFor(() => {
      const envHidden = usePaneLayoutStore.getState().environments.get("env-hidden");
      expect(envHidden?.root.kind).toBe("leaf");
      if (!envHidden || envHidden.root.kind !== "leaf") {
        throw new Error("env-hidden root should be a leaf");
      }

      expect(envHidden.root.tabs).toHaveLength(1);
      expect(envHidden.root.tabs[0]?.type).toBe("codex-native");
      expect(envHidden.root.tabs[0]?.initialPrompt).toBe("Ship it");
    });
  });
});

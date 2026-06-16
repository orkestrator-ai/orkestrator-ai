import { beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useGlobalActivityMonitor } from "./useGlobalActivityMonitor";
import { useAgentActivityStore } from "@/stores/agentActivityStore";
import { useClaudeStore } from "@/stores/claudeStore";
import {
  createClaudeTmuxStateKey,
  useClaudeTmuxStore,
} from "@/stores/claudeTmuxStore";
import { useCodexStore } from "@/stores/codexStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useOpenCodeStore } from "@/stores/openCodeStore";

function MonitorHarness() {
  useGlobalActivityMonitor();
  return null;
}

function resetStores() {
  useEnvironmentStore.setState({
    environments: [],
    isLoading: false,
    error: null,
    workspaceReadyEnvironments: new Set(),
    deletingEnvironments: new Set(),
    pendingSetupCommands: new Map(),
    setupCommandsResolved: new Set(),
    setupScriptsRunning: new Set(),
    sessionActivated: new Set(),
  });
  useAgentActivityStore.setState({
    tabStates: {},
    containerStates: {},
    containerRefCounts: {},
    stateChangeCallbacks: new Map(),
  });
  useClaudeStore.setState({
    clients: new Map(),
    sessions: new Map(),
    pendingQuestions: new Map(),
    pendingPlanApprovals: new Map(),
  });
  useClaudeTmuxStore.setState({
    tabs: new Map(),
    attachments: new Map(),
    draftText: new Map(),
    draftMentions: new Map(),
    messageQueue: new Map(),
    effortLevels: new Map(),
  });
  useCodexStore.setState({
    clients: new Map(),
    sessions: new Map(),
  });
  useOpenCodeStore.setState({
    clients: new Map(),
    sessions: new Map(),
    pendingQuestions: new Map(),
    pendingPermissions: new Map(),
  });
}

describe("useGlobalActivityMonitor tmux activity", () => {
  beforeEach(() => {
    cleanup();
    resetStores();
  });

  test("maps a busy Claude tmux tab to working activity for the environment", async () => {
    const stateKey = createClaudeTmuxStateKey("env-tmux", "tab-1");
    render(<MonitorHarness />);

    act(() => {
      const store = useClaudeTmuxStore.getState();
      store.setRunning(stateKey, true, {
        environmentId: "env-tmux",
        sessionId: "session-1",
      });
      store.setBusy(stateKey, true);
    });

    await waitFor(() => {
      expect(useAgentActivityStore.getState().getContainerState("env-tmux"))
        .toBe("working");
    });

    act(() => {
      useClaudeTmuxStore.getState().setBusy(stateKey, false);
    });

    await waitFor(() => {
      expect(useAgentActivityStore.getState().getContainerState("env-tmux"))
        .toBe("idle");
    });
  });

  test("maps pending Claude tmux hook cards to waiting activity", async () => {
    const stateKey = createClaudeTmuxStateKey("env-tmux", "tab-1");
    render(<MonitorHarness />);

    act(() => {
      const store = useClaudeTmuxStore.getState();
      store.setRunning(stateKey, true, {
        environmentId: "env-tmux",
        sessionId: "session-1",
      });
      store.addPendingQuestion(stateKey, {
        eventId: "question-1",
        questions: [],
        toolInput: {},
        payload: {},
        receivedAt: "2026-06-16T00:00:00.000Z",
      });
    });

    await waitFor(() => {
      expect(useAgentActivityStore.getState().getContainerState("env-tmux"))
        .toBe("waiting");
    });

    act(() => {
      useClaudeTmuxStore.getState().setBusy(stateKey, true);
    });

    await waitFor(() => {
      expect(useAgentActivityStore.getState().getContainerState("env-tmux"))
        .toBe("working");
    });
  });
});

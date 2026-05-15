import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { useClaudeTmuxStore } from "@/stores/claudeTmuxStore";
import * as realTmuxClient from "@/lib/claude-tmux-client";

const realTmuxClientSnapshot = { ...realTmuxClient };

const startSessionMock = mock(async () => ({
  tab_id: "tab-1",
  environment_id: "env-1",
  session_id: "session-1",
  tmux_session: "orkestrator-env1-tab1",
  running: true,
  transcript_path: null,
  resumed: false,
  busy: false,
}));
const getStatusMock = mock(async () => null);
const getTranscriptMock = mock(async () => []);
const getPendingHooksMock = mock(async () => []);
let subscribedHandler: ((event: realTmuxClient.TmuxEvent) => void) | null = null;
const subscribeMock = mock(async (handler: (event: realTmuxClient.TmuxEvent) => void) => {
  subscribedHandler = handler;
  return () => {
    subscribedHandler = null;
  };
});
const stopSessionMock = mock(async () => {});
const capturePaneMock = mock(async () => "");
const sendKeysMock = mock(async () => {});
const replyHookMock = mock(async () => {});
const submitMock = mock(async () => {});
const answerPreToolUseMock = mock(async () => {});

mock.module("@/lib/claude-tmux-client", () => ({
  ...realTmuxClientSnapshot,
  startSession: startSessionMock,
  getStatus: getStatusMock,
  getTranscript: getTranscriptMock,
  getPendingHooks: getPendingHooksMock,
  subscribe: subscribeMock,
  stopSession: stopSessionMock,
  capturePane: capturePaneMock,
  sendKeys: sendKeysMock,
  replyHook: replyHookMock,
  submit: submitMock,
  answerPreToolUse: answerPreToolUseMock,
}));

const { ClaudeTmuxChatTab, parseTmuxSelectionPrompt } = await import(
  "@/components/claude/ClaudeTmuxChatTab"
);

function seedPane(initialPrompt?: string) {
  usePaneLayoutStore.setState({
    environments: new Map([
      [
        "env-1",
        {
          root: {
            kind: "leaf",
            id: "default",
            activeTabId: "tab-1",
            tabs: [
              {
                id: "tab-1",
                type: "claude-tmux",
                initialPrompt,
                claudeTmuxData: { environmentId: "env-1" },
              },
            ],
          },
          activePaneId: "default",
          containerId: "container-1",
        },
      ],
    ]),
    activeEnvironmentId: "env-1",
  });
}

describe("ClaudeTmuxChatTab", () => {
  afterAll(() => {
    mock.module("@/lib/claude-tmux-client", () => realTmuxClientSnapshot);
  });

  beforeEach(() => {
    cleanup();
    startSessionMock.mockClear();
    getStatusMock.mockClear();
    getStatusMock.mockImplementation(async () => null);
    getTranscriptMock.mockClear();
    getTranscriptMock.mockImplementation(async () => []);
    getPendingHooksMock.mockClear();
    getPendingHooksMock.mockImplementation(async () => []);
    subscribedHandler = null;
    subscribeMock.mockClear();
    stopSessionMock.mockClear();
    capturePaneMock.mockClear();
    sendKeysMock.mockClear();
    replyHookMock.mockClear();
    submitMock.mockClear();
    answerPreToolUseMock.mockClear();
    capturePaneMock.mockImplementation(async () => "");
    useClaudeTmuxStore.setState({ tabs: new Map() });
    seedPane("Run the audit");
  });

  test("starts once with tabId+envId and clears the tab initialPrompt after launch succeeds", async () => {
    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
        initialPrompt="Run the audit"
      />,
    );

    await waitFor(() => expect(startSessionMock).toHaveBeenCalledTimes(1));
    expect(startSessionMock.mock.calls[0]).toEqual([
      "tab-1",
      "env-1",
      {
        initialPrompt: "Run the audit",
        model: "claude-sonnet-4-6",
        planMode: false,
        resumeSessionId: undefined,
      },
    ]);

    await waitFor(() => {
      const tab = usePaneLayoutStore.getState().getAllTabs("env-1")[0];
      expect(tab?.initialPrompt).toBeUndefined();
    });
  });

  test("hydrates a running backend session and replays missed transcript before auto-starting", async () => {
    getStatusMock.mockImplementation(async () => ({
      tab_id: "tab-1",
      environment_id: "env-1",
      session_id: "session-existing",
      tmux_session: "orkestrator-env1-tab1",
      running: true,
      transcript_path: "/tmp/session-existing.jsonl",
      resumed: false,
      busy: false,
    }));
    getTranscriptMock.mockImplementation(async () => [
      {
        type: "user",
        uuid: "u-1",
        timestamp: "2026-05-15T12:00:00.000Z",
        message: { role: "user", content: "Run the audit" },
      },
      {
        type: "assistant",
        uuid: "a-1",
        timestamp: "2026-05-15T12:01:00.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Final result: tests pass." }],
        },
      },
    ]);

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
        initialPrompt="Run the audit"
      />,
    );

    await waitFor(() => {
      const tab = useClaudeTmuxStore.getState().getTab("tab-1");
      expect(tab.sessionId).toBe("session-existing");
      expect(tab.messages.map((m) => m.content)).toEqual([
        "Run the audit",
        "Final result: tests pass.",
      ]);
      expect(tab.busy).toBe(false);
    });

    expect(startSessionMock).not.toHaveBeenCalled();
  });

  test("hydrates backend busy state and pending hook prompts", async () => {
    getStatusMock.mockImplementation(async () => ({
      tab_id: "tab-1",
      environment_id: "env-1",
      session_id: "session-existing",
      tmux_session: "orkestrator-env1-tab1",
      running: true,
      transcript_path: "/tmp/session-existing.jsonl",
      resumed: false,
      busy: true,
    }));
    getPendingHooksMock.mockImplementation(async () => [
      {
        id: "q-hook",
        kind: "PreToolUse",
        payload: {
          tool_name: "AskUserQuestion",
          tool_input: {
            questions: [
              {
                question: "Which framework?",
                header: "Framework",
                options: [{ label: "React" }],
                multiSelect: false,
              },
            ],
          },
        },
      },
      {
        id: "perm-hook",
        kind: "PermissionRequest",
        payload: {
          tool_name: "Bash",
          tool_input: { command: "bun test" },
          permission_suggestions: [],
        },
      },
    ]);

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
        initialPrompt="Run the audit"
      />,
    );

    await waitFor(() => {
      const tab = useClaudeTmuxStore.getState().getTab("tab-1");
      expect(tab.busy).toBe(true);
      expect(tab.pendingQuestions).toHaveLength(1);
      expect(tab.pendingQuestions[0]!.eventId).toBe("q-hook");
      expect(tab.pendingPermissions).toHaveLength(1);
      expect(tab.pendingPermissions[0]!.eventId).toBe("perm-hook");
    });
    expect(startSessionMock).not.toHaveBeenCalled();
  });

  test("hydrates pending hook snapshot as authoritative and clears stale prompts", async () => {
    useClaudeTmuxStore.getState().addPendingApproval("tab-1", {
      eventId: "stale",
      toolName: "Bash",
      toolInput: {},
      payload: {},
      receivedAt: new Date().toISOString(),
    });
    getStatusMock.mockImplementation(async () => ({
      tab_id: "tab-1",
      environment_id: "env-1",
      session_id: "session-existing",
      tmux_session: "orkestrator-env1-tab1",
      running: true,
      transcript_path: "/tmp/session-existing.jsonl",
      resumed: false,
      busy: false,
    }));

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    await waitFor(() => {
      const tab = useClaudeTmuxStore.getState().getTab("tab-1");
      expect(tab.pendingApprovals).toEqual([]);
    });
  });

  test("keeps busy during SubagentStop and clears it on top-level Stop", async () => {
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });
    useClaudeTmuxStore.getState().setBusy("tab-1", true);

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    await waitFor(() => expect(subscribedHandler).not.toBeNull());

    act(() => {
      subscribedHandler?.({
        kind: "hook",
        tab_id: "tab-1",
        environment_id: "env-1",
        session_id: "session-1",
        event_id: "subagent-stop",
        event_kind: "SubagentStop",
        payload: {},
      });
    });
    expect(useClaudeTmuxStore.getState().getTab("tab-1").busy).toBe(true);

    act(() => {
      subscribedHandler?.({
        kind: "hook",
        tab_id: "tab-1",
        environment_id: "env-1",
        session_id: "session-1",
        event_id: "stop",
        event_kind: "Stop",
        payload: {},
      });
    });
    expect(useClaudeTmuxStore.getState().getTab("tab-1").busy).toBe(false);
  });

  test("typing / opens the built-in slash command menu and selecting one fills the input", async () => {
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    const textarea = screen.getByPlaceholderText(
      /Ask Claude anything/,
    ) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "/" } });

    // Menu opens with the builtin list visible.
    const slashHeader = await screen.findByText("Slash Commands");
    expect(slashHeader).toBeTruthy();
    expect(screen.getByText("/clear")).toBeTruthy();
    expect(screen.getByText("/model")).toBeTruthy();

    // Filtering narrows the list.
    fireEvent.change(textarea, { target: { value: "/com" } });
    await waitFor(() => {
      expect(screen.queryByText("/clear")).toBeNull();
      expect(screen.getByText("/compact")).toBeTruthy();
    });

    // Clicking inserts the command and a trailing space.
    fireEvent.click(screen.getByText("/compact"));
    expect(textarea.value).toBe("/compact ");
  });

  test("locks launch-only model and plan controls once the session is running", async () => {
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    const modelButton = screen.getByRole("button", {
      name: /Sonnet 4\.6/,
    }) as HTMLButtonElement;
    const planButton = screen.getByRole("button", {
      name: /Build/,
    }) as HTMLButtonElement;

    expect(modelButton.disabled).toBe(true);
    expect(planButton.disabled).toBe(true);
  });

  test("parses Claude Code in-TUI selection prompts from a tmux pane snapshot", () => {
    const prompt = parseTmuxSelectionPrompt(`
› 1. Kill stale tmux before launch (Recommended)
  2. Always kill before launch
  3. Randomize tmux session name

Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`);

    expect(prompt?.selectedOptionIndex).toBe(0);
    expect(prompt?.options.map((o) => o.label)).toEqual([
      "Kill stale tmux before launch (Recommended)",
      "Always kill before launch",
      "Randomize tmux session name",
    ]);
  });

  test("shows controls for Claude Code selection prompts and answers through tmux keys", async () => {
    capturePaneMock.mockImplementation(async () => `
  1. Kill stale tmux before launch (Recommended)
› 2. Always kill before launch
  3. Randomize tmux session name

Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`);
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByText("Claude is asking for a choice")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: /Randomize tmux session name/ }),
    );

    await waitFor(() => {
      expect(sendKeysMock).toHaveBeenCalledWith("tab-1", ["Down", "Enter"]);
    });
  });

  test("answers AskUserQuestion hooks with PreToolUse updatedInput", async () => {
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });
    useClaudeTmuxStore.getState().addPendingQuestion("tab-1", {
      eventId: "q-hook",
      questions: [
        {
          question: "Which framework?",
          header: "Framework",
          options: [{ label: "React" }, { label: "Vue" }],
          multiSelect: false,
        },
      ],
      toolInput: {
        questions: [
          {
            question: "Which framework?",
            header: "Framework",
            options: [{ label: "React" }, { label: "Vue" }],
            multiSelect: false,
          },
        ],
      },
      payload: {},
      receivedAt: new Date().toISOString(),
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /React/ }));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expect(replyHookMock).toHaveBeenCalledWith(
        "tab-1",
        "PreToolUse",
        "q-hook",
        expect.objectContaining({
          hookSpecificOutput: expect.objectContaining({
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
            updatedInput: expect.objectContaining({
              answers: { "Which framework?": "React" },
            }),
          }),
        }),
      );
    });
  });

  test("answers PermissionRequest hooks with nested permission decision", async () => {
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });
    useClaudeTmuxStore.getState().addPendingPermission("tab-1", {
      eventId: "perm-hook",
      toolName: "Bash",
      toolInput: { command: "bun test", description: "Run tests" },
      permissionSuggestions: [],
      payload: {},
      receivedAt: new Date().toISOString(),
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Allow" }));

    await waitFor(() => {
      expect(replyHookMock).toHaveBeenCalledWith(
        "tab-1",
        "PermissionRequest",
        "perm-hook",
        expect.objectContaining({
          hookSpecificOutput: expect.objectContaining({
            hookEventName: "PermissionRequest",
            decision: expect.objectContaining({
              behavior: "allow",
              updatedInput: { command: "bun test", description: "Run tests" },
            }),
          }),
        }),
      );
    });
  });

  test("answers MCP Elicitation hooks with form content", async () => {
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });
    useClaudeTmuxStore.getState().addPendingElicitation("tab-1", {
      eventId: "elicit-hook",
      mcpServerName: "docs-mcp",
      message: "Provide credentials",
      mode: "form",
      url: null,
      requestedSchema: {
        type: "object",
        properties: {
          username: { type: "string", title: "Username" },
        },
      },
      payload: {},
      receivedAt: new Date().toISOString(),
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    fireEvent.change(screen.getByLabelText("Username"), {
      target: { value: "alice" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expect(replyHookMock).toHaveBeenCalledWith(
        "tab-1",
        "Elicitation",
        "elicit-hook",
        {
          hookSpecificOutput: {
            hookEventName: "Elicitation",
            action: "accept",
            content: { username: "alice" },
          },
        },
      );
    });
  });
});

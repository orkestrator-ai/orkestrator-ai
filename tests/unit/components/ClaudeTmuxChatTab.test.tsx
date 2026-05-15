import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
}));
const subscribeMock = mock(async () => () => {});
const stopSessionMock = mock(async () => {});
const capturePaneMock = mock(async () => "");
const sendKeysMock = mock(async () => {});
const replyHookMock = mock(async () => {});
const submitMock = mock(async () => {});
const answerPreToolUseMock = mock(async () => {});

mock.module("@/lib/claude-tmux-client", () => ({
  ...realTmuxClientSnapshot,
  startSession: startSessionMock,
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

  test("parses only the active TUI option block and shows its question", () => {
    const prompt = parseTmuxSelectionPrompt(`
1. Run \`git diff origin/main...HEAD\` to see all changes that will be in the PR
2. Run \`git log main..HEAD --oneline\` to see all commits
3. Create the PR using: \`gh pr create --base main --fill\`

Two staged files look like they shouldn't be in the PR. How should I handle them?

› 1. Unstage & add to .gitignore (Recommended)
     .codex/hooks.json has session-specific /tmp paths and tsconfig.tsbuildinfo is generated.
  2. Commit them as-is
  3. Unstage only (no .gitignore change)
  4. Type something.
  5. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`);

    expect(prompt?.question).toBe(
      "Two staged files look like they shouldn't be in the PR. How should I handle them?",
    );
    expect(prompt?.selectedOptionIndex).toBe(0);
    expect(prompt?.options.map((o) => o.label)).toEqual([
      "Unstage & add to .gitignore (Recommended) .codex/hooks.json has session-specific /tmp paths and tsconfig.tsbuildinfo is generated.",
      "Commit them as-is",
      "Unstage only (no .gitignore change)",
      "Type something.",
      "Chat about this",
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

  test("renders the active TUI question without stale numbered transcript lines", async () => {
    capturePaneMock.mockImplementation(async () => `
1. Run \`git diff origin/main...HEAD\` to see all changes that will be in the PR
2. Run \`git log main..HEAD --oneline\` to see all commits

Two staged files look like they shouldn't be in the PR. How should I handle them?

› 1. Unstage & add to .gitignore (Recommended)
  2. Commit them as-is
  3. Unstage only (no .gitignore change)

Enter to select · ↑/↓ to navigate · Esc to cancel
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

    expect(
      await screen.findByText(
        "Two staged files look like they shouldn't be in the PR. How should I handle them?",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /git diff origin\/main/ }),
    ).toBeNull();
    expect(
      screen.getByRole("button", {
        name: /Unstage & add to \.gitignore \(Recommended\)/,
      }),
    ).toBeTruthy();
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

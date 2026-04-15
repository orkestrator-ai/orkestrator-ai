import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createOpenCodeSessionKey, useOpenCodeStore } from "@/stores/openCodeStore";
import { useEnvironmentStore } from "@/stores/environmentStore";

const mockRenameEnvironmentFromPrompt = mock(async () => {});
const mockSendPrompt = mock(async () => ({ success: true }));

mock.module("@/lib/opencode-client", () => ({
  createClient: mock(() => ({ baseUrl: "http://127.0.0.1:9999" })),
  getModelsWithDefaults: mock(async () => ({ models: [], defaults: {} })),
  createSession: mock(async () => ({ id: "session-1", createdAt: "2026-04-15T10:00:00.000Z" })),
  getSessionMessages: mock(async () => []),
  getPendingPermissions: mock(async () => []),
  getPendingQuestions: mock(async () => []),
  getAvailableSlashCommands: mock(async () => []),
  sendPrompt: mockSendPrompt,
  formatOpenCodeError: mock((error) => String(error)),
  abortSession: mock(async () => true),
  subscribeToEvents: mock(() => (async function* () {})()),
  ERROR_MESSAGE_PREFIX: "error-",
  SYSTEM_MESSAGE_PREFIX: "system-",
}));

mock.module("@/lib/tauri", () => ({
  startOpenCodeServer: mock(async () => ({ hostPort: 9999 })),
  getOpenCodeServerStatus: mock(async () => ({ running: true, hostPort: 9999 })),
  getOpenCodeServerLog: mock(async () => ""),
  getOpencodeModelPreferences: mock(async () => ({ recent: [], favorite: [], variant: {} })),
  startLocalOpencodeServer: mock(async () => ({ running: true, port: 9999, pid: 1234 })),
  getLocalOpencodeServerStatus: mock(async () => ({ running: true, port: 9999, pid: 1234 })),
  renameEnvironmentFromPrompt: mockRenameEnvironmentFromPrompt,
}));

let composeText = "Rename the environment";
let composeAttachments: Array<{
  id: string;
  type: "file" | "image";
  path: string;
  previewUrl?: string;
  name: string;
}> = [];

mock.module("./OpenCodeComposeBar", () => ({
  OpenCodeComposeBar: ({
    onSend,
    disabled,
  }: {
    onSend: (text: string, attachments: typeof composeAttachments) => Promise<void>;
    disabled?: boolean;
  }) => (
    <button
      type="button"
      data-testid="opencode-send"
      disabled={disabled}
      onClick={() => {
        void onSend(composeText, composeAttachments);
      }}
    >
      Send
    </button>
  ),
}));

mock.module("./OpenCodePermissionCard", () => ({
  OpenCodePermissionCard: () => null,
}));

mock.module("./OpenCodeQuestionCard", () => ({
  OpenCodeQuestionCard: () => null,
}));

mock.module("./OpenCodeResumeSessionDialog", () => ({
  OpenCodeResumeSessionDialog: () => null,
}));

mock.module("./slash-command-directory", () => ({
  resolveSlashCommandDirectory: mock(() => undefined),
  shouldLoadSlashCommands: mock(() => false),
}));

mock.module("./slash-command-registry", () => ({
  getNativeSlashCommands: mock(() => []),
}));

import { OpenCodeChatTab } from "./OpenCodeChatTab";
import type { OpenCodeNativeData } from "@/types/paneLayout";

const ENVIRONMENT_ID = "env-1";
const TAB_ID = "tab-1";
const SESSION_KEY = createOpenCodeSessionKey(ENVIRONMENT_ID, TAB_ID);
const MOCK_CLIENT = { baseUrl: "http://127.0.0.1:9999" } as const;

function createData(overrides: Partial<OpenCodeNativeData> = {}): OpenCodeNativeData {
  return {
    environmentId: ENVIRONMENT_ID,
    containerId: "container-1",
    isLocal: false,
    ...overrides,
  };
}

function resetStores(name = "20260415-123456") {
  useOpenCodeStore.setState({
    serverStatus: new Map(),
    sessions: new Map([
      [
        SESSION_KEY,
        {
          sessionId: "session-1",
          messages: [],
          isLoading: false,
        },
      ],
    ]),
    clients: new Map([[ENVIRONMENT_ID, MOCK_CLIENT as any]]),
    models: new Map(),
    slashCommands: new Map(),
    selectedModel: new Map([[ENVIRONMENT_ID, "openai/gpt-5"]]),
    selectedVariant: new Map(),
    selectedMode: new Map([[SESSION_KEY, "build"]]),
    attachments: new Map(),
    draftText: new Map(),
    draftMentions: new Map(),
    messageQueue: new Map(),
    isComposing: new Map(),
    pendingQuestions: new Map(),
    pendingPermissions: new Map(),
    eventSubscriptions: new Map(),
    contextUsage: new Map(),
  });

  useEnvironmentStore.setState({
    environments: [
      {
        id: ENVIRONMENT_ID,
        projectId: "project-1",
        name,
        branch: "main",
        containerId: "container-1",
        status: "running",
        prUrl: null,
        prState: null,
        hasMergeConflicts: null,
        createdAt: "2026-04-15T10:00:00.000Z",
        networkAccessMode: "restricted",
        order: 0,
        environmentType: "containerized",
      },
    ],
    isLoading: false,
    error: null,
    workspaceReadyEnvironments: new Set([ENVIRONMENT_ID]),
    deletingEnvironments: new Set(),
    pendingSetupCommands: new Map(),
    setupCommandsResolved: new Set(),
    setupScriptsRunning: new Set(),
  });
}

describe("OpenCodeChatTab", () => {
  beforeEach(() => {
    cleanup();
    composeText = "Rename the environment";
    composeAttachments = [];
    mockRenameEnvironmentFromPrompt.mockClear();
    mockRenameEnvironmentFromPrompt.mockImplementation(async () => {});
    mockSendPrompt.mockClear();
    mockSendPrompt.mockImplementation(async () => ({ success: true }));
    resetStores();
  });

  afterEach(() => {
    cleanup();
    mock.restore();
  });

  test("shows the first prompt and naming feedback before the rename completes", async () => {
    composeText = "Audit the flaky reconnect flow";

    let resolveRename: (() => void) | undefined;
    mockRenameEnvironmentFromPrompt.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveRename = resolve;
        }),
    );

    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    fireEvent.click(screen.getByTestId("opencode-send"));

    await waitFor(() => {
      const messages = useOpenCodeStore.getState().getSession(SESSION_KEY)?.messages ?? [];
      expect(messages.some((message) => message.content === composeText)).toBe(true);
      expect(messages.some((message) => message.content === "Naming environment...")).toBe(true);
      expect(mockSendPrompt).not.toHaveBeenCalled();
    });

    resolveRename?.();

    await waitFor(() => {
      expect(mockSendPrompt).toHaveBeenCalled();
    });

    await waitFor(() => {
      const messages = useOpenCodeStore.getState().getSession(SESSION_KEY)?.messages ?? [];
      expect(messages.some((message) => message.content === "Naming environment...")).toBe(false);
    });
  });

  test("removes the optimistic message and shows an error when sendPrompt fails", async () => {
    composeText = "This should not stick around";
    mockSendPrompt.mockImplementation(async () => ({
      success: false,
      error: "Prompt rejected",
    }));
    resetStores("review-table");

    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    fireEvent.click(screen.getByTestId("opencode-send"));

    await waitFor(() => {
      const session = useOpenCodeStore.getState().getSession(SESSION_KEY);
      expect(session?.messages.some((message) => message.content === composeText)).toBe(false);
      expect(session?.messages.some((message) => message.content === "Prompt rejected")).toBe(true);
      expect(session?.isLoading).toBe(false);
    });
  });

  test("stores optimistic attachment parts and forwards attachments to sendPrompt", async () => {
    composeText = "Please inspect the screenshot";
    composeAttachments = [
      {
        id: "attachment-1",
        type: "image",
        path: "/workspace/screenshot.png",
        previewUrl: "data:image/png;base64,abc123",
        name: "screenshot.png",
      },
    ];
    resetStores("review-table");

    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    fireEvent.click(screen.getByTestId("opencode-send"));

    await waitFor(() => {
      const messages = useOpenCodeStore.getState().getSession(SESSION_KEY)?.messages ?? [];
      const userMessage = messages.find((message) => message.role === "user");
      expect(userMessage?.parts).toEqual([
        { type: "text", content: composeText },
        {
          type: "file",
          content: "screenshot.png",
          fileUrl: "data:image/png;base64,abc123",
        },
      ]);
    });

    expect(mockSendPrompt).toHaveBeenCalledWith(
      MOCK_CLIENT,
      "session-1",
      composeText,
      {
        model: "openai/gpt-5",
        variant: undefined,
        mode: "build",
        attachments: [
          {
            type: "image",
            path: "/workspace/screenshot.png",
            dataUrl: "data:image/png;base64,abc123",
            filename: "screenshot.png",
          },
        ],
      },
    );
  });
});

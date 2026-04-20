import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { useEffect } from "react";
import { ERROR_MESSAGE_PREFIX, type ClaudeMessage as ClaudeMessageType } from "../../../src/lib/claude-client";
import { TerminalProvider, useTerminalContext } from "../../../src/contexts/TerminalContext";
import { CLAUDE_AUTH_LOGIN_COMMAND } from "../../../src/lib/claude-auth";

mock.module("@/lib/tauri", () => ({
  openInBrowser: async () => {},
  readFileBase64: async () => "",
}));

mock.module("sonner", () => ({
  toast: {
    success: () => {},
    error: () => {},
  },
}));

import { ClaudeMessage } from "../../../src/components/claude/ClaudeMessage";

function TerminalContextHarness({
  children,
  createTab,
}: {
  children: React.ReactNode;
  createTab?: (type: "plain" | "claude" | "opencode" | "codex" | "root", options?: { initialPrompt?: string; initialCommands?: string[] }) => void;
}) {
  return (
    <TerminalProvider>
      <ConfigureTerminalContext createTab={createTab} />
      {children}
    </TerminalProvider>
  );
}

function ConfigureTerminalContext({
  createTab,
}: {
  createTab?: (type: "plain" | "claude" | "opencode" | "codex" | "root", options?: { initialPrompt?: string; initialCommands?: string[] }) => void;
}) {
  const { setCreateTab } = useTerminalContext();

  useEffect(() => {
    setCreateTab(createTab ?? null);
    return () => setCreateTab(null);
  }, [createTab, setCreateTab]);

  return null;
}

describe("ClaudeMessage", () => {
  test("renders single newlines as visible line breaks in user text", () => {
    const message: ClaudeMessageType = {
      id: "msg-line-breaks",
      role: "user",
      content: "First line\nSecond line\nThird line",
      timestamp: "2026-03-07T12:00:00.000Z",
      parts: [
        { type: "text", content: "First line\nSecond line\nThird line" },
      ],
    };

    const { container } = render(
      <TerminalContextHarness>
        <ClaudeMessage message={message} />
      </TerminalContextHarness>,
    );
    const lineBreaks = container.querySelectorAll("br");

    expect(container.textContent).toContain("First line");
    expect(container.textContent).toContain("Second line");
    expect(container.textContent).toContain("Third line");
    expect(lineBreaks).toHaveLength(2);
  });

  test("shows a Claude auth login action for authentication failures", () => {
    const createTab = mock(() => {});
    const message: ClaudeMessageType = {
      id: `${ERROR_MESSAGE_PREFIX}auth`,
      role: "assistant",
      content: "Failed to authenticate. API Error: 401 {\"type\":\"error\",\"error\":{\"type\":\"authentication_error\",\"message\":\"Invalid authentication credentials\"}}",
      timestamp: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "text",
          content: "Failed to authenticate. API Error: 401 {\"type\":\"error\",\"error\":{\"type\":\"authentication_error\",\"message\":\"Invalid authentication credentials\"}}",
        },
      ],
    };

    const { container } = render(
      <TerminalContextHarness createTab={createTab}>
        <ClaudeMessage message={message} />
      </TerminalContextHarness>,
    );
    const view = within(container);

    expect(view.getByText("Claude is not authenticated. Run claude auth login to continue.")).toBeTruthy();
    expect(view.getByRole("button", { name: "Run claude auth login" })).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Run claude auth login" }));

    expect(createTab).toHaveBeenCalledWith("plain", {
      initialCommands: [CLAUDE_AUTH_LOGIN_COMMAND],
    });
  });

  test("renders auth errors safely when no terminal context is available", () => {
    const message: ClaudeMessageType = {
      id: `${ERROR_MESSAGE_PREFIX}auth-no-context`,
      role: "assistant",
      content: "authentication_error: Invalid authentication credentials",
      timestamp: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "text",
          content: "authentication_error: Invalid authentication credentials",
        },
      ],
    };

    const { container } = render(<ClaudeMessage message={message} />);
    const view = within(container);

    const button = view.getByRole("button", { name: `Run ${CLAUDE_AUTH_LOGIN_COMMAND}` });
    expect(button).toBeTruthy();
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  test("keeps generic error messages unchanged for non-auth failures", () => {
    const message: ClaudeMessageType = {
      id: `${ERROR_MESSAGE_PREFIX}generic`,
      role: "assistant",
      content: "Something went wrong while sending the prompt.",
      timestamp: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "text",
          content: "Something went wrong while sending the prompt.",
        },
      ],
    };

    const { container } = render(<ClaudeMessage message={message} />);
    const view = within(container);

    expect(view.getByText("Something went wrong while sending the prompt.")).toBeTruthy();
    expect(view.queryByRole("button", { name: `Run ${CLAUDE_AUTH_LOGIN_COMMAND}` })).toBeNull();
  });
});

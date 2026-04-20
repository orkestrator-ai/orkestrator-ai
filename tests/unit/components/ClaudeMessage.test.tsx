import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import type { ClaudeMessage as ClaudeMessageType } from "../../../src/lib/claude-client";
import { TerminalProvider, useTerminalContext } from "../../../src/contexts/TerminalContext";

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
      id: "error-auth",
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

    render(
      <TerminalContextHarness createTab={createTab}>
        <ClaudeMessage message={message} />
      </TerminalContextHarness>,
    );

    expect(screen.getByText("Claude is not authenticated. Run claude auth login to continue.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run claude auth login" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Run claude auth login" }));

    expect(createTab).toHaveBeenCalledWith("plain", {
      initialCommands: ["claude auth login"],
    });
  });
});

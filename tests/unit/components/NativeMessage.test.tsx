import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import type { NativeMessage as NativeMessageType } from "../../../src/lib/chat/native-message-types";

mock.module("@/lib/tauri", () => ({
  openInBrowser: async () => {},
  readFileBase64: async () => "",
}));

import { NativeMessage } from "../../../src/components/chat/NativeMessage";

describe("NativeMessage", () => {
  test("renders single newlines as visible line breaks in text parts", () => {
    const message: NativeMessageType = {
      id: "msg-line-breaks",
      role: "user",
      content: "First line\nSecond line\nThird line",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        { type: "text", content: "First line\nSecond line\nThird line" },
      ],
    };

    const { container } = render(<NativeMessage message={message} />);
    const lineBreaks = container.querySelectorAll("br");

    expect(container.textContent).toContain("First line");
    expect(container.textContent).toContain("Second line");
    expect(container.textContent).toContain("Third line");
    expect(lineBreaks).toHaveLength(2);
  });

  test("preserves chronological order for interleaved text and tool parts", () => {
    const message: NativeMessageType = {
      id: "msg-chronological-order",
      role: "assistant",
      content: "First explanation. Then a tool call. Then more explanation.",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        { type: "text", content: "First explanation." },
        {
          type: "tool-invocation",
          content: "",
          toolName: "Read",
          toolArgs: { file_path: "/workspace/src/example.ts" },
          toolState: "success",
        },
        { type: "text", content: "More explanation after the tool call." },
      ],
    };

    const { container } = render(<NativeMessage message={message} />);
    const renderedText = container.textContent ?? "";

    const firstTextIndex = renderedText.indexOf("First explanation.");
    const toolIndex = renderedText.indexOf("Read");
    const fileIndex = renderedText.indexOf("example.ts");
    const secondTextIndex = renderedText.indexOf("More explanation after the tool call.");

    expect(firstTextIndex).toBeGreaterThanOrEqual(0);
    expect(toolIndex).toBeGreaterThan(firstTextIndex);
    expect(fileIndex).toBeGreaterThanOrEqual(toolIndex);
    expect(secondTextIndex).toBeGreaterThan(fileIndex);
  });

  test("renders transcript-derived subagent groups as collapsible activity stacks", () => {
    const message: NativeMessageType = {
      id: "msg-subagent",
      role: "assistant",
      content: "Main agent response",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "subagent",
          content: "Lovelace",
          subagentId: "agent-1",
          subagentName: "Lovelace",
          subagentRole: "explorer",
          subagentPrompt: "Inspect the Codex integration",
          subagentActionCount: 1,
          toolState: "pending",
          subagentActions: [
            {
              type: "tool-invocation",
              content: "exec_command",
              toolName: "exec_command",
              toolArgs: {
                command: "rg -n \"codex\" src",
              },
              toolState: "success",
              toolTitle: "exec_command",
              toolOutput: "matches",
            },
          ],
        },
      ],
    };

    render(<NativeMessage message={message} />);

    expect(screen.getByText("Agent")).toBeTruthy();
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.getByText("1 tool")).toBeTruthy();
    expect(screen.getByText("1 update")).toBeTruthy();
    expect(screen.getByText('rg -n "codex" src')).toBeTruthy();
    expect(screen.queryByText("Inspect the Codex integration")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /lovelace/i }));

    expect(screen.getByText("Inspect the Codex integration")).toBeTruthy();
    expect(screen.getAllByText("exec_command")).toHaveLength(2);
    fireEvent.click(screen.getAllByText("exec_command")[0]!);
    expect(screen.getByText("$ rg -n \"codex\" src")).toBeTruthy();
    expect(screen.getByText("matches")).toBeTruthy();
  });

  test("renders success and failure subagent states when no activity was captured", () => {
    const message: NativeMessageType = {
      id: "msg-subagent-empty-states",
      role: "assistant",
      content: "Main agent response",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "subagent",
          content: "Hopper",
          subagentId: "agent-success",
          subagentName: "Hopper",
          subagentRole: "explorer",
          subagentActionCount: 0,
          toolState: "success",
          subagentActions: [],
        },
        {
          type: "subagent",
          content: "Shannon",
          subagentId: "agent-failure",
          subagentName: "Shannon",
          subagentRole: "worker",
          subagentActionCount: 0,
          toolState: "failure",
          subagentActions: [],
        },
      ],
    };

    render(<NativeMessage message={message} />);

    expect(screen.getByText("Success")).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getAllByText("No activity captured.")).toHaveLength(2);
  });

  test("shows waiting preview when a pending subagent has no actions", () => {
    const message: NativeMessageType = {
      id: "msg-subagent-waiting",
      role: "assistant",
      content: "Main agent response",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "subagent",
          content: "Lovelace",
          subagentId: "agent-pending",
          subagentName: "Lovelace",
          subagentRole: "explorer",
          subagentActionCount: 0,
          toolState: "pending",
          subagentActions: [],
        },
      ],
    };

    render(<NativeMessage message={message} />);

    expect(screen.getByText("Waiting for activity.")).toBeTruthy();
  });

  test("uses text updates and tool titles as subagent preview fallbacks", () => {
    const message: NativeMessageType = {
      id: "msg-subagent-preview-fallbacks",
      role: "assistant",
      content: "Main agent response",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "subagent",
          content: "Turing",
          subagentId: "agent-text-preview",
          subagentName: "Turing",
          subagentRole: "worker",
          subagentActionCount: 0,
          toolState: "success",
          subagentActions: [
            {
              type: "text",
              content: "Summarized the repository layout.",
            },
          ],
        },
        {
          type: "subagent",
          content: "Kay",
          subagentId: "agent-title-preview",
          subagentName: "Kay",
          subagentRole: "explorer",
          subagentActionCount: 1,
          toolState: "success",
          subagentActions: [
            {
              type: "tool-invocation",
              content: "exec_command",
              toolName: "exec_command",
              toolTitle: "grep",
              toolState: "success",
            },
          ],
        },
      ],
    };

    render(<NativeMessage message={message} />);

    expect(screen.getByText("Summarized the repository layout.")).toBeTruthy();
    expect(screen.getByText("grep")).toBeTruthy();
  });
});

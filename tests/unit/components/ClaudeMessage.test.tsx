import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect } from "react";
import { ERROR_MESSAGE_PREFIX, type ClaudeMessage as ClaudeMessageType } from "../../../src/lib/claude-client";
import { TerminalProvider, useTerminalContext } from "../../../src/contexts/TerminalContext";
import { CLAUDE_AUTH_LOGIN_COMMAND } from "../../../src/lib/claude-auth";
import { mockWriteText } from "../../mocks/clipboard";

const mockReadFileBase64 = mock(async () => "local-base64");
const mockReadContainerFileBase64 = mock(async () => "container-base64");

mock.module("@/lib/tauri", () => ({
  openInBrowser: async () => {},
  readFileBase64: mockReadFileBase64,
  readContainerFileBase64: mockReadContainerFileBase64,
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
  afterEach(() => {
    cleanup();
    mockReadContainerFileBase64.mockReset();
    mockReadContainerFileBase64.mockImplementation(async () => "container-base64");
    mockReadFileBase64.mockReset();
    mockReadFileBase64.mockImplementation(async () => "local-base64");
    mockWriteText.mockReset();
    mockWriteText.mockImplementation(async () => {});
  });

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

  test("renders a copy button for text parts", async () => {
    const message: ClaudeMessageType = {
      id: "msg-copy",
      role: "assistant",
      content: "Copy this Claude response",
      timestamp: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "text",
          content: "Copy this Claude response",
        },
      ],
    };

    render(<ClaudeMessage message={message} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy text" }));

    await waitFor(() => {
      expect(mockWriteText).toHaveBeenCalledWith("Copy this Claude response");
    });
    expect(screen.getByRole("button", { name: "Copied text" })).toBeTruthy();
  });

  test("renders thinking blocks collapsed by default while streaming", () => {
    const message: ClaudeMessageType = {
      id: "msg-thinking-streaming",
      role: "assistant",
      content: "",
      timestamp: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "thinking",
          content: "I am mapping out the implementation details.",
        },
      ],
    };

    render(<ClaudeMessage message={message} isStreaming />);

    const trigger = screen.getByRole("button", { name: /Thinking/i });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger);

    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  test("renders thinking blocks collapsed by default after completion", () => {
    const message: ClaudeMessageType = {
      id: "msg-thinking-complete",
      role: "assistant",
      content: "",
      timestamp: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "thinking",
          content: "I am checking the final behavior.",
        },
        {
          type: "text",
          content: "Done.",
        },
      ],
    };

    render(<ClaudeMessage message={message} />);

    expect(screen.getByRole("button", { name: /Thinking/i }).getAttribute("aria-expanded")).toBe("false");
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

  test("loads container-backed image attachments through the container file reader", async () => {
    const message: ClaudeMessageType = {
      id: "msg-container-image",
      role: "user",
      content: 'Here is the image\n\n<attached-files>\n<attachment type="image" path="/workspace/.orkestrator/clipboard/clipboard.png" filename="clipboard.png" />\n</attached-files>',
      timestamp: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "text",
          content: 'Here is the image\n\n<attached-files>\n<attachment type="image" path="/workspace/.orkestrator/clipboard/clipboard.png" filename="clipboard.png" />\n</attached-files>',
        },
      ],
    };

    render(<ClaudeMessage message={message} containerId="container-1" />);

    fireEvent.click(screen.getByRole("button", { name: /clipboard\.png/i }));

    const preview = await screen.findByAltText("clipboard.png") as HTMLImageElement;
    expect(preview.src).toBe("data:image/png;base64,container-base64");
    expect(mockReadContainerFileBase64).toHaveBeenCalledWith(
      "container-1",
      "/workspace/.orkestrator/clipboard/clipboard.png",
    );
    expect(mockReadFileBase64).not.toHaveBeenCalled();
  });

  test("loads local image attachments through the local file reader", async () => {
    const message: ClaudeMessageType = {
      id: "msg-local-image",
      role: "user",
      content: 'Local image\n\n<attached-files>\n<attachment type="image" path="/tmp/orkestrator/clipboard/local.jpg" filename="local.jpg" />\n</attached-files>',
      timestamp: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "text",
          content: 'Local image\n\n<attached-files>\n<attachment type="image" path="/tmp/orkestrator/clipboard/local.jpg" filename="local.jpg" />\n</attached-files>',
        },
      ],
    };

    render(<ClaudeMessage message={message} />);

    fireEvent.click(screen.getByRole("button", { name: /local\.jpg/i }));

    const preview = await screen.findByAltText("local.jpg") as HTMLImageElement;
    expect(preview.src).toBe("data:image/jpeg;base64,local-base64");
    expect(mockReadFileBase64).toHaveBeenCalledWith("/tmp/orkestrator/clipboard/local.jpg");
    expect(mockReadContainerFileBase64).not.toHaveBeenCalled();
  });

  test("does not preview unsafe parsed container attachment paths", () => {
    const message: ClaudeMessageType = {
      id: "msg-unsafe-image",
      role: "user",
      content: 'Unsafe image\n\n<attached-files>\n<attachment type="image" path="/etc/passwd" filename="passwd.png" />\n</attached-files>',
      timestamp: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "text",
          content: 'Unsafe image\n\n<attached-files>\n<attachment type="image" path="/etc/passwd" filename="passwd.png" />\n</attached-files>',
        },
      ],
    };

    render(<ClaudeMessage message={message} containerId="container-1" />);

    const button = screen.getByRole("button", { name: /passwd\.png/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    fireEvent.click(button);
    expect(mockReadContainerFileBase64).not.toHaveBeenCalled();
    expect(mockReadFileBase64).not.toHaveBeenCalled();
  });

  test("shows an attachment error when image loading fails", async () => {
    mockReadContainerFileBase64.mockImplementationOnce(async () => {
      throw new Error("not found");
    });

    const message: ClaudeMessageType = {
      id: "msg-image-error",
      role: "user",
      content: 'Missing image\n\n<attached-files>\n<attachment type="image" path="/workspace/missing.png" filename="missing.png" />\n</attached-files>',
      timestamp: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "text",
          content: 'Missing image\n\n<attached-files>\n<attachment type="image" path="/workspace/missing.png" filename="missing.png" />\n</attached-files>',
        },
      ],
    };

    render(<ClaudeMessage message={message} containerId="container-1" />);

    fireEvent.click(screen.getByRole("button", { name: /missing\.png/i }));

    expect(await screen.findByText("(error)")).toBeTruthy();
    expect(screen.queryByAltText("missing.png")).toBeNull();
  });

  test("renders non-image attachments as disabled preview buttons", () => {
    const message: ClaudeMessageType = {
      id: "msg-file-attachment",
      role: "user",
      content: 'File attachment\n\n<attached-files>\n<attachment type="file" path="/workspace/notes.txt" filename="notes.txt" />\n</attached-files>',
      timestamp: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "text",
          content: 'File attachment\n\n<attached-files>\n<attachment type="file" path="/workspace/notes.txt" filename="notes.txt" />\n</attached-files>',
        },
      ],
    };

    render(<ClaudeMessage message={message} containerId="container-1" />);

    const button = screen.getByRole("button", { name: /notes\.txt/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(mockReadContainerFileBase64).not.toHaveBeenCalled();
    expect(mockReadFileBase64).not.toHaveBeenCalled();
  });

  test("parses multiple attachments with flexible attribute order and closes previews on escape", async () => {
    const message: ClaudeMessageType = {
      id: "msg-multiple-images",
      role: "user",
      content: 'Images\n\n<attached-files>\n<attachment filename="first.webp" path="/workspace/first.webp" type="image" />\n<attachment type="image" path="/workspace/second.gif" filename="second.gif" />\n</attached-files>',
      timestamp: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "text",
          content: 'Images\n\n<attached-files>\n<attachment filename="first.webp" path="/workspace/first.webp" type="image" />\n<attachment type="image" path="/workspace/second.gif" filename="second.gif" />\n</attached-files>',
        },
      ],
    };

    render(<ClaudeMessage message={message} containerId="container-1" />);

    expect(screen.getByRole("button", { name: /first\.webp/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /second\.gif/i })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /first\.webp/i }));
    expect(await screen.findByAltText("first.webp")).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByAltText("first.webp")).toBeNull();
    });
  });
});

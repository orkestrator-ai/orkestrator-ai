import { describe, expect, mock, test } from "bun:test";
import { render } from "@testing-library/react";
import type { OpenCodeMessage as OpenCodeMessageType } from "../../../src/lib/opencode-client";

mock.module("@/lib/tauri", () => ({
  openInBrowser: async () => {},
  readFileBase64: async () => "",
}));

import { OpenCodeMessage } from "../../../src/components/opencode/OpenCodeMessage";

describe("OpenCodeMessage", () => {
  test("preserves chronological order for interleaved text and tool parts", () => {
    const message: OpenCodeMessageType = {
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

    const { container } = render(<OpenCodeMessage message={message} />);
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
});

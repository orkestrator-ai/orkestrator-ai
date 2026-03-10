import { afterEach, describe, expect, test, mock } from "bun:test";
import { getSessionMessages, type ClaudeClient } from "./claude-client";

const originalFetch = globalThis.fetch;

describe("claude-client todo snapshots", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restore();
  });

  test("appends a latest todo snapshot to fetched session messages", async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({
        messages: [
          {
            id: "msg-1",
            role: "assistant",
            content: "",
            parts: [{
              type: "tool-invocation",
              toolName: "TodoWrite",
              toolArgs: {
                todos: [{ content: "Claude task", status: "cancelled" }],
              },
              toolState: "success",
            }],
            timestamp: "2026-03-10T11:00:00.000Z",
          },
        ],
      })),
    ) as unknown as typeof fetch;

    const client: ClaudeClient = { baseUrl: "http://127.0.0.1:4001" };
    const messages = await getSessionMessages(client, "session-1");

    expect(messages).toHaveLength(2);
    expect(messages[1]?.id).toBe("todo-snapshot-msg-1");
    expect(messages[1]?.parts[0]?.toolArgs).toEqual({
      todos: [{ content: "Claude task", status: "cancelled" }],
    });
  });
});

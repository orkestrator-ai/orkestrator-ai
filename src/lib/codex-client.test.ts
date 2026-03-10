import { afterEach, describe, expect, test, mock } from "bun:test";
import { getSessionMessages, resumeSession, type CodexClient } from "./codex-client";

const originalFetch = globalThis.fetch;

describe("codex-client todo snapshots", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restore();
  });

  test("appends a latest todo snapshot when fetching session messages", async () => {
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
                todos: [{ content: "Track work", status: "completed" }],
              },
              toolState: "success",
            }],
            createdAt: "2026-03-10T10:00:00.000Z",
          },
        ],
      })),
    ) as unknown as typeof fetch;

    const client: CodexClient = { baseUrl: "http://127.0.0.1:4000" };
    const messages = await getSessionMessages(client, "session-1");

    expect(messages).toHaveLength(2);
    expect(messages[1]?.id).toBe("todo-snapshot-msg-1");
    expect(messages[1]?.parts[0]?.toolArgs).toEqual({
      todos: [{ content: "Track work", status: "completed" }],
    });
  });

  test("appends a latest todo snapshot when resuming a session", async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({
        sessionId: "session-1",
        title: "Resume",
        messages: [
          {
            id: "msg-2",
            role: "assistant",
            content: "",
            parts: [{
              type: "tool-invocation",
              toolName: "TodoWrite",
              toolOutput: JSON.stringify({
                todos: [{ content: "Resume task", status: "in_progress" }],
              }),
              toolState: "pending",
            }],
            createdAt: "2026-03-10T10:05:00.000Z",
          },
        ],
      })),
    ) as unknown as typeof fetch;

    const client: CodexClient = { baseUrl: "http://127.0.0.1:4000" };
    const resumed = await resumeSession(client, { threadId: "thread-1" });

    expect(resumed?.messages).toHaveLength(2);
    expect(resumed?.messages[1]?.id).toBe("todo-snapshot-msg-2");
    expect(resumed?.messages[1]?.parts[0]?.toolArgs).toEqual({
      todos: [{ content: "Resume task", status: "in_progress" }],
    });
  });
});

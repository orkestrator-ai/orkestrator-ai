import { afterEach, describe, expect, test, mock } from "bun:test";
import { getSessionMessages, resumeSession, type CodexClient } from "./codex-client";

const originalFetch = globalThis.fetch;

describe("codex-client getSessionMessages", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restore();
  });

  test("returns messages without appending todo snapshots", async () => {
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
                todos: [{ content: "Track work", status: "in_progress" }],
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

    expect(messages).toHaveLength(1);
    expect(messages[0]?.id).toBe("msg-1");
  });

  test("returns messages without appending todo snapshots when resuming a session", async () => {
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

    expect(resumed?.messages).toHaveLength(1);
    expect(resumed?.messages[0]?.id).toBe("msg-2");
  });

  test("returns messages as-is when no TodoWrite parts exist", async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({
        messages: [
          {
            id: "msg-1",
            role: "assistant",
            content: "Done",
            parts: [{
              type: "tool-invocation",
              toolName: "Bash",
              toolArgs: { command: "ls" },
              toolState: "success",
            }],
            createdAt: "2026-03-10T10:00:00.000Z",
          },
        ],
      })),
    ) as unknown as typeof fetch;

    const client: CodexClient = { baseUrl: "http://127.0.0.1:4000" };
    const messages = await getSessionMessages(client, "session-1");

    expect(messages).toHaveLength(1);
    expect(messages[0]?.id).toBe("msg-1");
  });
});

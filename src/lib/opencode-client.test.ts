import { describe, expect, test } from "bun:test";
import {
  getModelsWithDefaults,
  getSessionMessages,
  listSessions,
  type OpencodeClient,
} from "./opencode-client";

describe("opencode-client listSessions", () => {
  test("maps SDK sessions into UI session shape", async () => {
    const createdMs = 1739232000000;
    const client = {
      session: {
        list: async () => ({
          data: [
            {
              id: "session-1",
              title: "My Session",
              time: {
                created: createdMs,
              },
            },
          ],
        }),
      },
    } as unknown as OpencodeClient;

    const sessions = await listSessions(client);

    expect(sessions).toEqual([
      {
        id: "session-1",
        title: "My Session",
        createdAt: new Date(createdMs).toISOString(),
      },
    ]);
  });

  test("rethrows errors so callers can display failure state", async () => {
    const expectedError = new Error("network unavailable");
    const client = {
      session: {
        list: async () => {
          throw expectedError;
        },
      },
    } as unknown as OpencodeClient;

    await expect(listSessions(client)).rejects.toThrow("network unavailable");
  });
});

describe("opencode-client getModelsWithDefaults", () => {
  test("maps default model and variant from direct default config", async () => {
    const client = {
      config: {
        providers: async () => ({
          data: {
            providers: [
              {
                id: "anthropic",
                models: {
                  "claude-sonnet-4": {
                    id: "claude-sonnet-4",
                    name: "Claude Sonnet 4",
                    variants: {
                      low: {},
                      high: {},
                    },
                  },
                },
              },
            ],
            default: {
              model: "anthropic/claude-sonnet-4",
              variant: "high",
            },
          },
        }),
      },
    } as unknown as OpencodeClient;

    const result = await getModelsWithDefaults(client);

    expect(result.defaults).toEqual({
      modelId: "anthropic/claude-sonnet-4",
      variant: "high",
    });
    expect(result.models.map((m) => m.id)).toContain("anthropic/claude-sonnet-4");
  });

  test("maps nested default model object to provider/model id", async () => {
    const client = {
      config: {
        providers: async () => ({
          data: {
            providers: [
              {
                id: "openai",
                models: {
                  "gpt-5": {
                    id: "gpt-5",
                    name: "GPT-5",
                    variants: {
                      medium: {},
                    },
                  },
                },
              },
            ],
            default: {
              model: {
                providerID: "openai",
                modelID: "gpt-5",
                variant: "medium",
              },
            },
          },
        }),
      },
    } as unknown as OpencodeClient;

    const result = await getModelsWithDefaults(client);

    expect(result.defaults).toEqual({
      modelId: "openai/gpt-5",
      variant: "medium",
    });
  });
});

describe("opencode-client getSessionMessages", () => {
  test("serializes non-string tool output and error values", async () => {
    const createdMs = 1739232000000;
    const outputPayload = {
      todos: [{ content: "Handle edge case", status: "cancelled" }],
    };
    const errorPayload = {
      reason: "tool failed",
      retryable: false,
    };

    const client = {
      session: {
        messages: async () => ({
          data: [
            {
              info: {
                id: "msg-1",
                role: "assistant",
                time: {
                  created: createdMs,
                },
              },
              parts: [
                {
                  type: "tool",
                  tool: "TodoWrite",
                  state: {
                    status: "completed",
                    input: {
                      todos: [{ content: "Task", status: "pending" }],
                    },
                    output: outputPayload,
                    error: errorPayload,
                  },
                },
              ],
            },
          ],
        }),
      },
    } as unknown as OpencodeClient;

    const messages = await getSessionMessages(client, "session-1");

    expect(messages).toHaveLength(1);
    expect(messages[0]?.id).toBe("msg-1");

    const part = messages[0]?.parts[0];
    expect(part?.type).toBe("tool-invocation");
    expect(part?.toolOutput).toBe(JSON.stringify(outputPayload, null, 2));
    expect(part?.toolError).toBe(JSON.stringify(errorPayload, null, 2));
  });
});

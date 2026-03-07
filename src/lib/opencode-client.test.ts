import { describe, expect, test } from "bun:test";
import {
  formatOpenCodeError,
  getAvailableSlashCommands,
  getModelsWithDefaults,
  getSessionMessages,
  listSessions,
  sendPrompt,
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

  test("accepts provider models returned as an array", async () => {
    const client = {
      config: {
        providers: async () => ({
          data: {
            providers: [
              {
                id: "openai",
                models: [
                  {
                    id: "gpt-5",
                    name: "GPT-5",
                    variants: {
                      high: {},
                    },
                  },
                ],
              },
            ],
            default: {
              providerID: "openai",
              modelID: "gpt-5",
            },
          },
        }),
      },
    } as unknown as OpencodeClient;

    const result = await getModelsWithDefaults(client);

    expect(result.models).toEqual([
      {
        id: "openai/gpt-5",
        name: "GPT-5",
        provider: "openai",
        variants: ["high"],
      },
    ]);
    expect(result.defaults.modelId).toBe("openai/gpt-5");
  });
});

describe("opencode-client getAvailableSlashCommands", () => {
  test("normalizes, deduplicates, and sorts commands", async () => {
    const client = {
      command: {
        list: async () => ({
          data: [
            {
              name: "fix",
              description: "Fix issues",
              hints: ["fix lint", "fix tests"],
            },
            {
              name: " /build ",
              hints: ["Build project"],
            },
            {
              name: "agent-helper",
              description: "Agent helper command",
              subtask: true,
              hints: [],
            },
            {
              name: "/fix",
              description: "Duplicate should be ignored",
            },
            {
              name: " ",
              description: "Ignored empty command",
            },
          ],
        }),
      },
    } as unknown as OpencodeClient;

    const commands = await getAvailableSlashCommands(client);

    expect(commands).toEqual([
      {
        name: "/agent-helper",
        description: "Agent helper command",
      },
      {
        name: "/build",
        description: "Build project",
        hints: ["Build project"],
      },
      {
        name: "/fix",
        description: "Fix issues",
        hints: ["fix lint", "fix tests"],
      },
    ]);
  });

  test("passes directory when provided (two calls: global + directory)", async () => {
    const capturedCalls: unknown[] = [];

    const client = {
      command: {
        list: async (request?: { directory?: string }) => {
          capturedCalls.push(request);
          return { data: [] };
        },
      },
    } as unknown as OpencodeClient;

    await getAvailableSlashCommands(client, "/workspace");

    // Should make two calls: one without directory, one with
    expect(capturedCalls).toEqual([undefined, { directory: "/workspace" }]);
  });

  test("keeps successful command source when one source fails", async () => {
    const client = {
      command: {
        list: async (request?: { directory?: string }) => {
          if (request?.directory) {
            throw new Error("directory unavailable");
          }

          return {
            data: [
              {
                name: "global-only",
                description: "Global command",
                hints: [],
              },
            ],
          };
        },
      },
    } as unknown as OpencodeClient;

    const commands = await getAvailableSlashCommands(client, "/workspace");

    expect(commands).toEqual([
      {
        name: "/global-only",
        description: "Global command",
      },
    ]);
  });

  test("prefers directory metadata and backfills missing fields from global", async () => {
    const client = {
      command: {
        list: async (request?: { directory?: string }) => {
          if (request?.directory) {
            return {
              data: [
                {
                  name: "fix",
                  description: "Project fix",
                  hints: ["project hint"],
                },
                {
                  name: "build",
                  hints: [],
                },
              ],
            };
          }

          return {
            data: [
              {
                name: "fix",
                description: "Global fix",
                hints: ["global hint"],
              },
              {
                name: "build",
                description: "Global build",
                hints: ["build hint"],
              },
            ],
          };
        },
      },
    } as unknown as OpencodeClient;

    const commands = await getAvailableSlashCommands(client, "/workspace");

    expect(commands).toEqual([
      {
        name: "/build",
        description: "Global build",
        hints: ["build hint"],
      },
      {
        name: "/fix",
        description: "Project fix",
        hints: ["project hint"],
      },
    ]);
  });

  test("returns empty array when command list fails", async () => {
    const client = {
      command: {
        list: async () => {
          throw new Error("not available");
        },
      },
    } as unknown as OpencodeClient;

    const commands = await getAvailableSlashCommands(client);

    expect(commands).toEqual([]);
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

describe("opencode-client sendPrompt", () => {
  test("maps build/plan mode to SDK agent", async () => {
    let capturedRequest: Record<string, unknown> | undefined;

    const client = {
      session: {
        promptAsync: async (request: Record<string, unknown>) => {
          capturedRequest = request;
          return { data: null };
        },
      },
    } as unknown as OpencodeClient;

    const result = await sendPrompt(client, "session-1", "Hello", {
      model: "anthropic/claude-sonnet-4",
      variant: "high",
      mode: "plan",
    });

    expect(result.success).toBe(true);
    expect(capturedRequest).toEqual(
      expect.objectContaining({
        sessionID: "session-1",
        agent: "plan",
        variant: "high",
      }),
    );
  });

  test("returns detailed error information on prompt failure", async () => {
    const client = {
      session: {
        promptAsync: async () => {
          throw {
            name: "APIError",
            data: {
              errorType: "rate_limit_error",
              message: "Too many requests. Please retry in 30 seconds.",
              status: 429,
              requestID: "req_123",
            },
          };
        },
      },
    } as unknown as OpencodeClient;

    const result = await sendPrompt(client, "session-1", "Hello");

    expect(result.success).toBe(false);
    expect(result.error).toContain("rate_limit_error");
    expect(result.error).toContain("Too many requests");
    expect(result.error).toContain("Status: 429");
    expect(result.error).toContain("Request ID: req_123");
    expect(result.error).toContain("Raw error:");
  });
});

describe("opencode-client formatOpenCodeError", () => {
  test("redacts sensitive values from raw error details", () => {
    const errorText = formatOpenCodeError({
      name: "APIError",
      data: {
        message: "Unauthorized",
        status: 401,
        requestID: "req_redact_1",
        authorization: "Bearer top-secret-token",
        apiKey: "sk-secret-key",
        nested: {
          refresh_token: "refresh-secret",
          safeField: "safe-value",
        },
      },
    });

    expect(errorText).toContain("Unauthorized");
    expect(errorText).toContain("Status: 401");
    expect(errorText).toContain("Request ID: req_redact_1");
    expect(errorText).toContain('"authorization": "[REDACTED]"');
    expect(errorText).toContain('"apiKey": "[REDACTED]"');
    expect(errorText).toContain('"refresh_token": "[REDACTED]"');
    expect(errorText).toContain('"safeField": "safe-value"');
    expect(errorText).not.toContain("top-secret-token");
    expect(errorText).not.toContain("sk-secret-key");
    expect(errorText).not.toContain("refresh-secret");
  });
});

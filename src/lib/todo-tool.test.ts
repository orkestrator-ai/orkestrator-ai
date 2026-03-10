import { describe, expect, test } from "bun:test";
import {
  appendLatestTodoSnapshot,
  getTodoItems,
  isTodoItem,
  parseTodosFromOutput,
} from "./todo-tool";

describe("todo-tool", () => {
  test("accepts cancelled todos as valid items", () => {
    expect(
      isTodoItem({
        content: "Skip flaky test",
        status: "cancelled",
      }),
    ).toBe(true);
  });

  test("parses todos from nested output payload", () => {
    const output = JSON.stringify({
      todos: [
        { content: "Implement feature", status: "completed" },
        { content: "Document follow-up", status: "pending" },
      ],
    });

    expect(parseTodosFromOutput(output)).toEqual([
      { content: "Implement feature", status: "completed" },
      { content: "Document follow-up", status: "pending" },
    ]);
  });

  test("falls back to output todos when args are invalid", () => {
    const todos = getTodoItems(
      {
        todos: [{ content: "Bad status", status: "unknown" }],
      },
      JSON.stringify({
        todos: [
          { content: "Read fallback todos", status: "in_progress" },
          { content: "Ignore old task", status: "cancelled" },
        ],
      }),
    );

    expect(todos).toEqual([
      { content: "Read fallback todos", status: "in_progress" },
      { content: "Ignore old task", status: "cancelled" },
    ]);
  });

  test("prefers valid args todos over output todos", () => {
    const todos = getTodoItems(
      {
        todos: [{ content: "Take args todos", status: "completed" }],
      },
      JSON.stringify({
        todos: [{ content: "Output should not be used", status: "pending" }],
      }),
    );

    expect(todos).toEqual([
      { content: "Take args todos", status: "completed" },
    ]);
  });

  test("appends one latest todo snapshot message at the end of the timeline", () => {
    interface TestMessage {
      id: string;
      role: string;
      content: string;
      parts: Array<{
        type: "tool-invocation";
        toolName: "TodoWrite";
        toolArgs?: { todos: Array<{ content: string; status: string }> };
        toolOutput?: string;
        toolState: "success" | "pending";
      }>;
    }

    const messages = appendLatestTodoSnapshot<TestMessage>(
      [
        {
          id: "assistant-1",
          role: "assistant",
          content: "",
          parts: [{
            type: "tool-invocation",
            toolName: "TodoWrite",
            toolArgs: {
              todos: [{ content: "Old todo", status: "pending" }],
            },
            toolState: "success" as const,
          }],
        },
        {
          id: "assistant-2",
          role: "assistant",
          content: "",
          parts: [{
            type: "tool-invocation",
            toolName: "TodoWrite",
            toolOutput: JSON.stringify({
              todos: [{ content: "Newest todo", status: "in_progress" }],
            }),
            toolState: "pending" as const,
          }],
        },
      ] satisfies TestMessage[],
      ({ message, part, todos }): TestMessage => ({
        id: `todo-snapshot-${message.id}`,
        role: "assistant",
        content: "",
        parts: [{
          type: "tool-invocation",
          toolName: "TodoWrite",
          toolOutput: part.toolOutput,
          toolState: part.toolState === "success" ? "success" : "pending",
          toolArgs: { todos },
        }],
      }),
    );

    expect(messages).toHaveLength(3);
    expect(messages[2]?.id).toBe("todo-snapshot-assistant-2");
    expect(messages[2]?.parts[0]).toMatchObject({
      type: "tool-invocation",
      toolName: "TodoWrite",
      toolState: "pending",
      toolArgs: {
        todos: [{ content: "Newest todo", status: "in_progress" }],
      },
    });
  });
});

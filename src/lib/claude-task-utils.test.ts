import { describe, expect, test } from "bun:test";
import { isTaskTool, processPartsInOrder } from "./claude-task-utils";
import type { ClaudeMessagePart } from "./claude-client";

describe("isTaskTool", () => {
  test("returns true for 'Task' (exact case)", () => {
    expect(isTaskTool("Task")).toBe(true);
  });

  test("returns true for 'task' (lowercase)", () => {
    expect(isTaskTool("task")).toBe(true);
  });

  test("returns true for 'TASK' (uppercase)", () => {
    expect(isTaskTool("TASK")).toBe(true);
  });

  test("returns false for other tool names", () => {
    expect(isTaskTool("Read")).toBe(false);
    expect(isTaskTool("Write")).toBe(false);
    expect(isTaskTool("Bash")).toBe(false);
    expect(isTaskTool("TaskOutput")).toBe(false); // Not the same as Task
  });

  test("returns false for undefined", () => {
    expect(isTaskTool(undefined)).toBe(false);
  });

  test("returns false for empty string", () => {
    expect(isTaskTool("")).toBe(false);
  });
});

describe("processPartsInOrder", () => {
  // Helper to create test parts
  const createToolPart = (
    toolName: string,
    toolUseId?: string,
    parentTaskUseId?: string
  ): ClaudeMessagePart => ({
    type: "tool-invocation",
    toolName,
    toolUseId,
    parentTaskUseId,
  });

  const createTaskPart = (toolUseId: string): ClaudeMessagePart =>
    createToolPart("Task", toolUseId);

  const createThinkingPart = (): ClaudeMessagePart => ({
    type: "thinking",
    content: "thinking...",
  });

  const createTextPart = (): ClaudeMessagePart => ({
    type: "text",
    content: "some text",
  });

  test("standalone tool without Task is rendered as tool-group", () => {
    const parts: ClaudeMessagePart[] = [createToolPart("Read")];
    const result = processPartsInOrder(parts);

    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe("tool-group");
    expect(result[0]!.part?.toolName).toBe("Read");
  });

  test("Task tool creates task-group with empty children", () => {
    const parts: ClaudeMessagePart[] = [createTaskPart("task-1")];
    const result = processPartsInOrder(parts);

    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe("task-group");
    expect(result[0]!.childTools).toEqual([]);
  });

  test("tools following Task are grouped via positional fallback", () => {
    const parts: ClaudeMessagePart[] = [
      createTaskPart("task-1"),
      createToolPart("Read"),
      createToolPart("Write"),
    ];
    const result = processPartsInOrder(parts);

    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe("task-group");
    expect(result[0]!.childTools).toHaveLength(2);
    expect(result[0]!.childTools![0]!.toolName).toBe("Read");
    expect(result[0]!.childTools![1]!.toolName).toBe("Write");
  });

  test("thinking part breaks positional fallback", () => {
    const parts: ClaudeMessagePart[] = [
      createTaskPart("task-1"),
      createToolPart("Read"),
      createThinkingPart(),
      createToolPart("Write"), // Should be standalone
    ];
    const result = processPartsInOrder(parts);

    expect(result).toHaveLength(3);
    expect(result[0]!.type).toBe("task-group");
    expect(result[0]!.childTools).toHaveLength(1);
    expect(result[1]!.type).toBe("thinking");
    expect(result[2]!.type).toBe("tool-group");
    expect(result[2]!.part?.toolName).toBe("Write");
  });

  test("explicit parentTaskUseId groups tool with correct Task", () => {
    const parts: ClaudeMessagePart[] = [
      createTaskPart("task-1"),
      createTextPart(), // Breaks positional fallback
      createToolPart("Read", "read-1", "task-1"), // Has explicit parent
    ];
    const result = processPartsInOrder(parts);

    expect(result).toHaveLength(2);
    expect(result[0]!.type).toBe("task-group");
    expect(result[0]!.childTools).toHaveLength(1);
    expect(result[0]!.childTools![0]!.toolName).toBe("Read");
    expect(result[1]!.type).toBe("text");
  });

  test("multiple Tasks with explicit parentTaskUseId grouping", () => {
    const parts: ClaudeMessagePart[] = [
      createTaskPart("task-1"),
      createTaskPart("task-2"),
      createToolPart("Read", "read-1", "task-1"), // Belongs to task-1
      createToolPart("Write", "write-1", "task-2"), // Belongs to task-2
    ];
    const result = processPartsInOrder(parts);

    expect(result).toHaveLength(2);

    // First Task group
    expect(result[0]!.type).toBe("task-group");
    expect(result[0]!.part?.toolUseId).toBe("task-1");
    expect(result[0]!.childTools).toHaveLength(1);
    expect(result[0]!.childTools![0]!.toolName).toBe("Read");

    // Second Task group
    expect(result[1]!.type).toBe("task-group");
    expect(result[1]!.part?.toolUseId).toBe("task-2");
    expect(result[1]!.childTools).toHaveLength(1);
    expect(result[1]!.childTools![0]!.toolName).toBe("Write");
  });

  test("tool with invalid parentTaskUseId falls back to positional", () => {
    const parts: ClaudeMessagePart[] = [
      createTaskPart("task-1"),
      createToolPart("Read", "read-1", "non-existent-task"),
    ];
    const result = processPartsInOrder(parts);

    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe("task-group");
    // Falls back to positional - tool is still grouped under task-1
    expect(result[0]!.childTools).toHaveLength(1);
    expect(result[0]!.childTools![0]!.toolName).toBe("Read");
  });

  test("tool with invalid parentTaskUseId and no positional fallback is standalone", () => {
    const parts: ClaudeMessagePart[] = [
      createTaskPart("task-1"),
      createTextPart(), // Breaks positional fallback
      createToolPart("Read", "read-1", "non-existent-task"),
    ];
    const result = processPartsInOrder(parts);

    expect(result).toHaveLength(3);
    expect(result[0]!.type).toBe("task-group");
    expect(result[0]!.childTools).toHaveLength(0);
    expect(result[1]!.type).toBe("text");
    expect(result[2]!.type).toBe("tool-group"); // Standalone
  });

  test("nested Tasks - inner Task is child of outer Task", () => {
    const parts: ClaudeMessagePart[] = [
      createTaskPart("task-outer"),
      { ...createTaskPart("task-inner"), parentTaskUseId: "task-outer" },
    ];
    const result = processPartsInOrder(parts);

    // Both are rendered as task-groups at top level since Task tools don't
    // get nested (they ARE parents, not children)
    expect(result).toHaveLength(2);
    expect(result[0]!.type).toBe("task-group");
    expect(result[1]!.type).toBe("task-group");
  });

  test("file parts break positional fallback", () => {
    const parts: ClaudeMessagePart[] = [
      createTaskPart("task-1"),
      createToolPart("Read"),
      { type: "file", content: "file content" } as ClaudeMessagePart,
      createToolPart("Write"),
    ];
    const result = processPartsInOrder(parts);

    expect(result).toHaveLength(3);
    expect(result[0]!.type).toBe("task-group");
    expect(result[0]!.childTools).toHaveLength(1);
    expect(result[1]!.type).toBe("file");
    expect(result[2]!.type).toBe("tool-group");
  });
});

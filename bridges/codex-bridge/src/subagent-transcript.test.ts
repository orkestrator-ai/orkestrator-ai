import { describe, expect, test } from "bun:test";
import {
  deriveSubagentPartsFromTranscriptRecords,
  mergeSubagentPartsIntoMessageParts,
  parseTranscriptRecords,
  type TranscriptRecord,
} from "./subagent-transcript.js";

function recordsFromLines(lines: string[]): TranscriptRecord[] {
  return parseTranscriptRecords(lines);
}

describe("deriveSubagentPartsFromTranscriptRecords", () => {
  test("creates a folded subagent part and hydrates child actions", () => {
    const parentRecords = recordsFromLines([
      JSON.stringify({
        timestamp: "2026-04-16T11:17:23.623Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          arguments: JSON.stringify({
            agent_type: "explorer",
            message: "Inspect the Codex integration",
          }),
          call_id: "call-spawn-1",
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-16T11:17:23.681Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-spawn-1",
          output: JSON.stringify({
            agent_id: "agent-1",
            nickname: "Lovelace",
          }),
        },
      }),
    ]);

    const childRecordsByAgentId = new Map<string, TranscriptRecord[]>([
      [
        "agent-1",
        recordsFromLines([
          JSON.stringify({
            timestamp: "2026-04-16T11:17:23.681Z",
            type: "session_meta",
            payload: {
              id: "agent-1",
              agent_nickname: "Lovelace",
              agent_role: "explorer",
            },
          }),
          JSON.stringify({
            timestamp: "2026-04-16T11:17:31.150Z",
            type: "event_msg",
            payload: {
              type: "agent_message",
              phase: "commentary",
              message: "I am checking the codebase now.",
            },
          }),
          JSON.stringify({
            timestamp: "2026-04-16T11:17:31.153Z",
            type: "response_item",
            payload: {
              type: "function_call",
              name: "exec_command",
              arguments: JSON.stringify({
                cmd: "rg -n \"codex\" src",
                workdir: "/workspace",
              }),
              call_id: "child-call-1",
            },
          }),
          JSON.stringify({
            timestamp: "2026-04-16T11:17:31.237Z",
            type: "response_item",
            payload: {
              type: "function_call_output",
              call_id: "child-call-1",
              output: "Command output",
            },
          }),
          JSON.stringify({
            timestamp: "2026-04-16T11:19:00.119Z",
            type: "event_msg",
            payload: {
              type: "task_complete",
            },
          }),
        ]),
      ],
    ]);

    const parts = deriveSubagentPartsFromTranscriptRecords(
      parentRecords,
      childRecordsByAgentId,
    );

    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual({
      type: "subagent",
      content: "Lovelace",
      subagentId: "agent-1",
      subagentName: "Lovelace",
      subagentRole: "explorer",
      subagentPrompt: "Inspect the Codex integration",
      subagentActionCount: 1,
      toolState: "success",
      subagentActions: [
        {
          type: "text",
          content: "I am checking the codebase now.",
        },
        {
          type: "tool-invocation",
          content: "exec_command",
          toolName: "exec_command",
          toolArgs: {
            cmd: "rg -n \"codex\" src",
            workdir: "/workspace",
            command: "rg -n \"codex\" src",
          },
          toolState: undefined,
          toolTitle: "exec_command",
          toolOutput: "Command output",
          toolError: undefined,
        },
      ],
    });
  });

  test("keeps pending subagents visible before the child transcript exists", () => {
    const parentRecords = recordsFromLines([
      JSON.stringify({
        timestamp: "2026-04-16T11:17:23.623Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          arguments: JSON.stringify({
            agent_type: "worker",
            message: "Implement the patch",
          }),
          call_id: "call-spawn-2",
        },
      }),
    ]);

    const parts = deriveSubagentPartsFromTranscriptRecords(parentRecords, new Map());

    expect(parts).toHaveLength(1);
    expect(parts[0]?.toolState).toBe("pending");
    expect(parts[0]?.subagentActionCount).toBe(0);
    expect(parts[0]?.subagentRole).toBe("worker");
    expect(parts[0]?.subagentPrompt).toBe("Implement the patch");
  });

  test("keeps top-level success when a child tool fails but the subagent completes", () => {
    const parentRecords = recordsFromLines([
      JSON.stringify({
        timestamp: "2026-04-16T11:17:23.623Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          arguments: JSON.stringify({
            agent_type: "worker",
            message: "Check the patch",
          }),
          call_id: "call-spawn-3",
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-16T11:17:23.681Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-spawn-3",
          output: JSON.stringify({
            agent_id: "agent-3",
            nickname: "Turing",
          }),
        },
      }),
    ]);

    const childRecordsByAgentId = new Map<string, TranscriptRecord[]>([
      [
        "agent-3",
        recordsFromLines([
          JSON.stringify({
            timestamp: "2026-04-16T11:17:23.681Z",
            type: "session_meta",
            payload: {
              id: "agent-3",
              agent_nickname: "Turing",
              agent_role: "worker",
            },
          }),
          JSON.stringify({
            timestamp: "2026-04-16T11:17:31.153Z",
            type: "response_item",
            payload: {
              type: "custom_tool_call",
              name: "exec_command",
              input: JSON.stringify({
                cmd: "exit 1",
              }),
              output: "Command failed",
              status: "failed",
              call_id: "child-call-3",
            },
          }),
          JSON.stringify({
            timestamp: "2026-04-16T11:19:00.119Z",
            type: "event_msg",
            payload: {
              type: "task_complete",
            },
          }),
        ]),
      ],
    ]);

    const parts = deriveSubagentPartsFromTranscriptRecords(
      parentRecords,
      childRecordsByAgentId,
    );

    expect(parts).toHaveLength(1);
    expect(parts[0]?.toolState).toBe("success");
    expect(parts[0]?.subagentActions[0]).toEqual({
      type: "tool-invocation",
      content: "exec_command",
      toolName: "exec_command",
      toolArgs: {
        cmd: "exit 1",
        command: "exit 1",
      },
      toolState: "failure",
      toolTitle: "exec_command",
      toolOutput: undefined,
      toolError: "Command failed",
    });
  });

  test("uses wait_agent results to mark successful subagents before child completion records arrive", () => {
    const parentRecords = recordsFromLines([
      JSON.stringify({
        timestamp: "2026-04-16T11:17:23.623Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          arguments: JSON.stringify({
            agent_type: "explorer",
            message: "Inspect the bridge",
          }),
          call_id: "call-spawn-4",
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-16T11:17:23.681Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-spawn-4",
          output: JSON.stringify({
            agent_id: "agent-4",
            nickname: "Hopper",
          }),
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-16T11:18:23.681Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "wait_agent",
          arguments: JSON.stringify({
            targets: ["agent-4"],
            timeout_ms: 300000,
          }),
          call_id: "call-wait-4",
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-16T11:18:24.681Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-wait-4",
          output: JSON.stringify({
            status: {
              "agent-4": {
                completed: "Done",
              },
            },
            timed_out: false,
          }),
        },
      }),
    ]);

    const parts = deriveSubagentPartsFromTranscriptRecords(parentRecords, new Map());

    expect(parts).toHaveLength(1);
    expect(parts[0]?.toolState).toBe("success");
    expect(parts[0]?.subagentActionCount).toBe(0);
  });

  test("marks subagents as failed on explicit task failure", () => {
    const parentRecords = recordsFromLines([
      JSON.stringify({
        timestamp: "2026-04-16T11:17:23.623Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          arguments: JSON.stringify({
            agent_type: "worker",
            message: "Apply the patch",
          }),
          call_id: "call-spawn-5",
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-16T11:17:23.681Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-spawn-5",
          output: JSON.stringify({
            agent_id: "agent-5",
            nickname: "Shannon",
          }),
        },
      }),
    ]);

    const childRecordsByAgentId = new Map<string, TranscriptRecord[]>([
      [
        "agent-5",
        recordsFromLines([
          JSON.stringify({
            timestamp: "2026-04-16T11:17:23.681Z",
            type: "session_meta",
            payload: {
              id: "agent-5",
              agent_nickname: "Shannon",
              agent_role: "worker",
            },
          }),
          JSON.stringify({
            timestamp: "2026-04-16T11:19:00.119Z",
            type: "event_msg",
            payload: {
              type: "task_failed",
            },
          }),
        ]),
      ],
    ]);

    const parts = deriveSubagentPartsFromTranscriptRecords(
      parentRecords,
      childRecordsByAgentId,
    );

    expect(parts).toHaveLength(1);
    expect(parts[0]?.toolState).toBe("failure");
  });

  test("inserts collated subagent parts without reordering existing message parts", () => {
    const merged = mergeSubagentPartsIntoMessageParts(
      [
        { type: "text", content: "First explanation." },
        { type: "tool-invocation", content: "Read" },
        { type: "text", content: "More explanation." },
      ],
      [
        { type: "subagent", content: "Lovelace" },
      ],
    );

    expect(merged).toEqual([
      { type: "text", content: "First explanation." },
      { type: "tool-invocation", content: "Read" },
      { type: "subagent", content: "Lovelace" },
      { type: "text", content: "More explanation." },
    ]);
  });

  test("prepends subagent parts when all existing parts are text", () => {
    const merged = mergeSubagentPartsIntoMessageParts(
      [
        { type: "text", content: "A" },
        { type: "text", content: "B" },
      ],
      [{ type: "subagent", content: "Sub" }],
    );

    expect(merged).toEqual([
      { type: "subagent", content: "Sub" },
      { type: "text", content: "A" },
      { type: "text", content: "B" },
    ]);
  });

  test("appends subagent parts when no parts are text", () => {
    const merged = mergeSubagentPartsIntoMessageParts(
      [
        { type: "tool-invocation", content: "Read" },
        { type: "tool-result", content: "ok" },
      ],
      [{ type: "subagent", content: "Sub" }],
    );

    expect(merged).toEqual([
      { type: "tool-invocation", content: "Read" },
      { type: "tool-result", content: "ok" },
      { type: "subagent", content: "Sub" },
    ]);
  });

  test("returns subagent parts alone when parts array is empty", () => {
    const merged = mergeSubagentPartsIntoMessageParts(
      [],
      [{ type: "subagent", content: "Sub" }],
    );

    expect(merged).toEqual([{ type: "subagent", content: "Sub" }]);
  });

  test("returns parts unchanged when subagent parts array is empty", () => {
    const parts = [
      { type: "text", content: "Hello" },
      { type: "tool-invocation", content: "Read" },
    ];
    const merged = mergeSubagentPartsIntoMessageParts(parts, []);
    expect(merged).toBe(parts);
  });
});

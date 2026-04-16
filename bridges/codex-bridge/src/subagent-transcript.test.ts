import { describe, expect, test } from "bun:test";
import {
  deriveSubagentPartsFromTranscriptRecords,
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
});

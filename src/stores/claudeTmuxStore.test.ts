import { beforeEach, describe, expect, test } from "bun:test";
import type { TranscriptLine } from "@/lib/claude-tmux-client";
import {
  payloadToApproval,
  payloadToInfoEvent,
  useClaudeTmuxStore,
} from "./claudeTmuxStore";

function reset() {
  useClaudeTmuxStore.setState({ envs: new Map() });
}

beforeEach(() => {
  reset();
});

describe("applyTranscriptLine", () => {
  test("user text line becomes a message", () => {
    const line: TranscriptLine = {
      type: "user",
      uuid: "u1",
      timestamp: "2026-01-01T00:00:00Z",
      message: { role: "user", content: "hello" },
    };
    useClaudeTmuxStore.getState().applyTranscriptLine("env-1", line);
    const env = useClaudeTmuxStore.getState().getEnv("env-1");
    expect(env.messages).toHaveLength(1);
    expect(env.messages[0]!.content).toBe("hello");
    expect(env.messages[0]!.role).toBe("user");
    expect(env.messages[0]!.id).toBe("u1");
    expect(env.messages[0]!.parts.find((p) => p.type === "text")?.content).toBe(
      "hello",
    );
  });

  test("assistant tool_use + later tool_result merge into prior assistant message", () => {
    const useLine: TranscriptLine = {
      type: "assistant",
      uuid: "a1",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "thinking…" },
          { type: "tool_use", id: "tu1", name: "Bash", input: { cmd: "ls" } },
        ],
      },
    };
    const resultLine: TranscriptLine = {
      type: "user",
      uuid: "result-line-uuid",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu1",
            content: "ok\n",
            is_error: false,
          },
        ],
      },
    };
    useClaudeTmuxStore.getState().applyTranscriptLine("e", useLine);
    useClaudeTmuxStore.getState().applyTranscriptLine("e", resultLine);
    const env = useClaudeTmuxStore.getState().getEnv("e");
    // Crucial: the tool_result-only "user" line should NOT create a second
    // message; it merges into the prior assistant message's parts.
    expect(env.messages).toHaveLength(1);
    const parts = env.messages[0]!.parts;
    const invocation = parts.find(
      (p) => p.type === "tool-invocation" && p.toolUseId === "tu1",
    );
    const result = parts.find(
      (p) => p.type === "tool-result" && p.toolUseId === "tu1",
    );
    expect(invocation).toBeTruthy();
    expect(invocation!.toolState).toBe("success");
    expect(result).toBeTruthy();
    expect(result!.toolOutput).toBe("ok\n");
  });

  test("ignores non-message line types", () => {
    useClaudeTmuxStore.getState().applyTranscriptLine("e", {
      type: "summary",
    } as unknown as TranscriptLine);
    expect(useClaudeTmuxStore.getState().getEnv("e").messages).toHaveLength(0);
  });

  test("re-applying the same line is idempotent (dedup by uuid)", () => {
    const line: TranscriptLine = {
      type: "assistant",
      uuid: "u-stable",
      message: { role: "assistant", content: "hi" },
    };
    useClaudeTmuxStore.getState().applyTranscriptLine("e", line);
    useClaudeTmuxStore.getState().applyTranscriptLine("e", line);
    useClaudeTmuxStore.getState().applyTranscriptLine("e", line);
    expect(useClaudeTmuxStore.getState().getEnv("e").messages).toHaveLength(1);
  });

  test("falls back to a stable hash when uuid and timestamp are absent", () => {
    const line: TranscriptLine = {
      type: "system",
      message: { role: "system", content: "boot" },
    };
    useClaudeTmuxStore.getState().applyTranscriptLine("e", line);
    useClaudeTmuxStore.getState().applyTranscriptLine("e", line);
    // Two applications of an identical line MUST dedupe.
    expect(useClaudeTmuxStore.getState().getEnv("e").messages).toHaveLength(1);
  });

  test("Edit tool_use populates toolDiff with file_path and before/after", () => {
    const line: TranscriptLine = {
      type: "assistant",
      uuid: "edit-1",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu-edit",
            name: "Edit",
            input: {
              file_path: "/work/apps/web/package.json",
              old_string: "\"react\": \"18.0.0\"",
              new_string: "\"react\": \"19.0.0\"",
            },
          },
        ],
      },
    };
    useClaudeTmuxStore.getState().applyTranscriptLine("e", line);
    const msg = useClaudeTmuxStore.getState().getEnv("e").messages[0]!;
    const tool = msg.parts.find((p) => p.type === "tool-invocation");
    expect(tool?.toolDiff?.filePath).toBe("/work/apps/web/package.json");
    expect(tool?.toolDiff?.before).toBe("\"react\": \"18.0.0\"");
    expect(tool?.toolDiff?.after).toBe("\"react\": \"19.0.0\"");
  });

  test("Write tool_use populates toolDiff with after = content", () => {
    const line: TranscriptLine = {
      type: "assistant",
      uuid: "write-1",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu-write",
            name: "Write",
            input: { file_path: "/work/foo.txt", content: "line1\nline2" },
          },
        ],
      },
    };
    useClaudeTmuxStore.getState().applyTranscriptLine("e", line);
    const msg = useClaudeTmuxStore.getState().getEnv("e").messages[0]!;
    const tool = msg.parts.find((p) => p.type === "tool-invocation");
    expect(tool?.toolDiff?.filePath).toBe("/work/foo.txt");
    expect(tool?.toolDiff?.before).toBe("");
    expect(tool?.toolDiff?.after).toBe("line1\nline2");
  });

  test("array content collects text, thinking, and tool_use", () => {
    const line: TranscriptLine = {
      type: "assistant",
      uuid: "a2",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "let me see" },
          { type: "text", text: "result" },
          { type: "tool_use", id: "tu2", name: "Read", input: { path: "f" } },
        ],
      },
    };
    useClaudeTmuxStore.getState().applyTranscriptLine("e", line);
    const msg = useClaudeTmuxStore.getState().getEnv("e").messages[0]!;
    const thinking = msg.parts.find((p) => p.type === "thinking");
    const text = msg.parts.find((p) => p.type === "text");
    const tool = msg.parts.find((p) => p.type === "tool-invocation");
    expect(thinking?.content).toContain("let me see");
    expect(text?.content).toContain("result");
    expect(tool?.toolName).toBe("Read");
  });
});

describe("pendingApprovals", () => {
  test("addPendingApproval dedupes by eventId", () => {
    const a = payloadToApproval("evt-1", { tool_name: "Bash", tool_input: {} });
    useClaudeTmuxStore.getState().addPendingApproval("e", a);
    useClaudeTmuxStore.getState().addPendingApproval("e", a);
    useClaudeTmuxStore.getState().addPendingApproval("e", a);
    expect(
      useClaudeTmuxStore.getState().getEnv("e").pendingApprovals,
    ).toHaveLength(1);
  });

  test("removePendingApproval removes by eventId", () => {
    useClaudeTmuxStore.getState().addPendingApproval(
      "e",
      payloadToApproval("evt-1", { tool_name: "Bash", tool_input: {} }),
    );
    useClaudeTmuxStore.getState().addPendingApproval(
      "e",
      payloadToApproval("evt-2", { tool_name: "Write", tool_input: {} }),
    );
    useClaudeTmuxStore.getState().removePendingApproval("e", "evt-1");
    const env = useClaudeTmuxStore.getState().getEnv("e");
    expect(env.pendingApprovals).toHaveLength(1);
    expect(env.pendingApprovals[0]!.eventId).toBe("evt-2");
  });
});

describe("payloadToApproval", () => {
  test("reads snake_case tool_name and tool_input", () => {
    const a = payloadToApproval("e1", {
      tool_name: "Bash",
      tool_input: { cmd: "ls" },
    });
    expect(a.toolName).toBe("Bash");
    expect(a.toolInput).toEqual({ cmd: "ls" });
  });

  test("accepts camelCase variants", () => {
    const a = payloadToApproval("e1", {
      toolName: "Read",
      toolInput: { path: "x" },
    });
    expect(a.toolName).toBe("Read");
    expect(a.toolInput).toEqual({ path: "x" });
  });

  test("falls back when payload is empty", () => {
    const a = payloadToApproval("e1", {});
    expect(a.toolName).toBe("tool");
    expect(a.toolInput).toEqual({});
  });

  test("handles null payload", () => {
    const a = payloadToApproval("e1", null);
    expect(a.toolName).toBe("tool");
    expect(a.toolInput).toEqual({});
  });
});

describe("payloadToInfoEvent", () => {
  test("prefers .message field", () => {
    const e = payloadToInfoEvent("e1", "Notification", { message: "hi" });
    expect(e.message).toBe("hi");
  });

  test("falls back to .notification then to kind", () => {
    expect(payloadToInfoEvent("e1", "Stop", { notification: "n" }).message).toBe(
      "n",
    );
    expect(payloadToInfoEvent("e1", "Stop", {}).message).toBe("Stop");
  });
});

describe("infoEvents", () => {
  test("pushInfoEvent keeps at most 20", () => {
    for (let i = 0; i < 25; i++) {
      useClaudeTmuxStore.getState().pushInfoEvent("e", {
        id: `i${i}`,
        kind: "Notification",
        message: String(i),
        receivedAt: "now",
      });
    }
    const events = useClaudeTmuxStore.getState().getEnv("e").infoEvents;
    expect(events).toHaveLength(20);
    expect(events[events.length - 1]!.id).toBe("i24");
  });

  test("dismissInfoEvent removes by id", () => {
    useClaudeTmuxStore.getState().pushInfoEvent("e", {
      id: "a",
      kind: "Notification",
      message: "x",
      receivedAt: "n",
    });
    useClaudeTmuxStore.getState().pushInfoEvent("e", {
      id: "b",
      kind: "Notification",
      message: "y",
      receivedAt: "n",
    });
    useClaudeTmuxStore.getState().dismissInfoEvent("e", "a");
    const events = useClaudeTmuxStore.getState().getEnv("e").infoEvents;
    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe("b");
  });
});

describe("session lifecycle", () => {
  test("setRunning preserves prior sessionId when called with null", () => {
    useClaudeTmuxStore.getState().setRunning("e", true, "sess-1");
    useClaudeTmuxStore.getState().setRunning("e", false, null);
    const env = useClaudeTmuxStore.getState().getEnv("e");
    expect(env.running).toBe(false);
    expect(env.sessionId).toBe("sess-1");
  });

  test("resetEnvironment clears state", () => {
    useClaudeTmuxStore.getState().setRunning("e", true, "sess-1");
    useClaudeTmuxStore.getState().applyTranscriptLine("e", {
      type: "user",
      uuid: "u",
      message: { role: "user", content: "hi" },
    });
    useClaudeTmuxStore.getState().resetEnvironment("e");
    const env = useClaudeTmuxStore.getState().getEnv("e");
    expect(env.running).toBe(false);
    expect(env.sessionId).toBeNull();
    expect(env.messages).toHaveLength(0);
  });
});

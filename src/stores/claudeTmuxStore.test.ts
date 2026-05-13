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
    expect(env.messages[0]!.text).toBe("hello");
    expect(env.messages[0]!.role).toBe("user");
    expect(env.messages[0]!.id).toBe("u1");
  });

  test("assistant tool_use + later tool_result merge into the same message id", () => {
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
      uuid: "a1",
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
    expect(env.messages).toHaveLength(1);
    expect(env.messages[0]!.toolUses).toHaveLength(1);
    expect(env.messages[0]!.toolResults).toHaveLength(1);
    expect(env.messages[0]!.toolResults[0]!.content).toBe("ok\n");
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
    expect(msg.thinking).toContain("let me see");
    expect(msg.text).toContain("result");
    expect(msg.toolUses).toHaveLength(1);
    expect(msg.toolUses[0]!.name).toBe("Read");
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

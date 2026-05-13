// Verifies that claude-tmux-client wrappers forward the right Tauri command
// names and argument shapes. We re-mock `@tauri-apps/api/core` *for this file
// only* (tests/setup.ts installs a no-op mock; we replace it with one whose
// implementation captures calls). The replacement is restored in afterAll so
// the rest of the suite is unaffected.

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const calls: Array<{ cmd: string; args: unknown }> = [];

mock.module("@tauri-apps/api/core", () => ({
  invoke: mock(async (cmd: string, args?: unknown) => {
    calls.push({ cmd, args });
    return undefined;
  }),
  Resource: class Resource {
    close() {
      return Promise.resolve();
    }
  },
}));

afterAll(() => {
  // Restore the global no-op mock from tests/setup.ts so subsequent files
  // see the original behavior.
  mock.module("@tauri-apps/api/core", () => ({
    invoke: mock(() => Promise.resolve()),
    Resource: class Resource {
      close() {
        return Promise.resolve();
      }
    },
  }));
});

beforeEach(() => {
  calls.length = 0;
});

// Import after the mock is installed so the module captures our stub.
import {
  answerPreToolUse,
  capturePane,
  getStatus,
  replyHook,
  resize,
  sendKeys,
  sendText,
  startSession,
  stopSession,
  submit,
} from "./claude-tmux-client";

describe("claude-tmux-client invoke wrappers", () => {
  test("startSession forwards environmentId, initialPrompt, model", async () => {
    await startSession("env-1", { initialPrompt: "hi", model: "sonnet" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe("claude_tmux_start");
    expect(calls[0]!.args).toEqual({
      environmentId: "env-1",
      initialPrompt: "hi",
      model: "sonnet",
    });
  });

  test("startSession passes undefined when options are omitted", async () => {
    await startSession("env-1");
    expect(calls[0]!.args).toEqual({
      environmentId: "env-1",
      initialPrompt: undefined,
      model: undefined,
    });
  });

  test("stopSession invokes the stop command", async () => {
    await stopSession("env-1");
    expect(calls[0]!.cmd).toBe("claude_tmux_stop");
    expect(calls[0]!.args).toEqual({ environmentId: "env-1" });
  });

  test("getStatus invokes the status command", async () => {
    await getStatus("env-1");
    expect(calls[0]!.cmd).toBe("claude_tmux_status");
  });

  test("submit forwards text", async () => {
    await submit("env-1", "go");
    expect(calls[0]!.cmd).toBe("claude_tmux_submit");
    expect(calls[0]!.args).toEqual({ environmentId: "env-1", text: "go" });
  });

  test("sendText forwards text without auto-Enter", async () => {
    await sendText("env-1", "raw");
    expect(calls[0]!.cmd).toBe("claude_tmux_send_text");
    expect(calls[0]!.args).toEqual({ environmentId: "env-1", text: "raw" });
  });

  test("sendKeys forwards the key list", async () => {
    await sendKeys("env-1", ["C-c", "Enter"]);
    expect(calls[0]!.cmd).toBe("claude_tmux_send_keys");
    expect(calls[0]!.args).toEqual({
      environmentId: "env-1",
      keys: ["C-c", "Enter"],
    });
  });

  test("capturePane invokes the capture command", async () => {
    await capturePane("env-1");
    expect(calls[0]!.cmd).toBe("claude_tmux_capture_pane");
  });

  test("resize forwards cols/rows as numbers", async () => {
    await resize("env-1", 200, 50);
    expect(calls[0]!.cmd).toBe("claude_tmux_resize");
    expect(calls[0]!.args).toEqual({
      environmentId: "env-1",
      cols: 200,
      rows: 50,
    });
  });

  test("answerPreToolUse forwards decision and optional reason", async () => {
    await answerPreToolUse("env-1", "evt", "approve");
    expect(calls[0]!.args).toEqual({
      environmentId: "env-1",
      eventId: "evt",
      decision: "approve",
      reason: undefined,
    });
    await answerPreToolUse("env-1", "evt", "block", "no");
    expect(calls[1]!.args).toEqual({
      environmentId: "env-1",
      eventId: "evt",
      decision: "block",
      reason: "no",
    });
  });

  test("replyHook forwards arbitrary JSON response", async () => {
    await replyHook("env-1", "PostToolUse", "evt", { ok: true });
    expect(calls[0]!.cmd).toBe("claude_tmux_reply_hook");
    expect(calls[0]!.args).toEqual({
      environmentId: "env-1",
      eventKind: "PostToolUse",
      eventId: "evt",
      response: { ok: true },
    });
  });
});

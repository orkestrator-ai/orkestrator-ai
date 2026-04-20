import { describe, expect, test } from "bun:test";
import {
  ENVIRONMENT_ALREADY_READY_MARKER,
  ENVIRONMENT_SETUP_FAILED_MARKER,
  SETUP_DONE_OSC_DATA,
  SETUP_DONE_OSC_ID,
  SETUP_DONE_PRINTF_CMD,
  SETUP_FAILED_OSC_DATA,
  SETUP_FAILED_PRINTF_CMD,
  stripAnsi,
  tabTypeToSessionType,
} from "./terminal-utils";

describe("terminal-utils", () => {
  test("maps codex tabs to codex session type", () => {
    expect(tabTypeToSessionType("codex")).toBe("codex");
  });

  test("falls back to plain for non-terminal agent tabs", () => {
    expect(tabTypeToSessionType("plain")).toBe("plain");
    expect(tabTypeToSessionType("claude-native")).toBe("plain");
  });

  test("strips ANSI control sequences", () => {
    expect(stripAnsi("\u001b[31merror\u001b[0m")).toBe("error");
  });

  test("exports the setup-complete OSC printf command", () => {
    expect(SETUP_DONE_PRINTF_CMD).toContain(String(SETUP_DONE_OSC_ID));
    expect(SETUP_DONE_PRINTF_CMD).toContain(SETUP_DONE_OSC_DATA);
    expect(SETUP_DONE_PRINTF_CMD.startsWith("printf")).toBe(true);
  });

  test("exports a setup-failed OSC printf command with distinct payload", () => {
    expect(SETUP_FAILED_OSC_DATA).not.toBe(SETUP_DONE_OSC_DATA);
    expect(SETUP_FAILED_PRINTF_CMD).toContain(String(SETUP_DONE_OSC_ID));
    expect(SETUP_FAILED_PRINTF_CMD).toContain(SETUP_FAILED_OSC_DATA);
    expect(SETUP_FAILED_PRINTF_CMD.startsWith("printf")).toBe(true);
  });

  test("exports explicit reused and failed workspace markers", () => {
    expect(ENVIRONMENT_ALREADY_READY_MARKER).toBe("Workspace already set up.");
    expect(ENVIRONMENT_SETUP_FAILED_MARKER).toBe("=== Workspace Setup Failed ===");
  });
});

import { describe, expect, test } from "bun:test";
import { stripAnsi, tabTypeToSessionType } from "./terminal-utils";

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
});

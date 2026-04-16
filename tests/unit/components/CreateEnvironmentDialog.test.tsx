import { describe, test, expect } from "bun:test";
import { resolveAgentDefaults } from "../../../src/components/environments/CreateEnvironmentDialog";

describe("resolveAgentDefaults", () => {
  test("uses app-level defaults when no repo config provided", () => {
    const result = resolveAgentDefaults(
      { defaultAgent: "claude", claudeMode: "native", opencodeMode: "terminal", codexMode: "native" },
      undefined,
    );
    expect(result.defaultAgent).toBe("claude");
    expect(result.claudeMode).toBe("native");
    expect(result.opencodeMode).toBe("terminal");
    expect(result.codexMode).toBe("native");
  });

  test("uses app-level defaults when repo config has no overrides", () => {
    const result = resolveAgentDefaults(
      { defaultAgent: "opencode", claudeMode: "terminal", opencodeMode: "native", codexMode: "terminal" },
      { defaultBranch: "main", prBaseBranch: "main" } as { defaultAgent?: string; agentStyle?: string },
    );
    expect(result.defaultAgent).toBe("opencode");
    expect(result.claudeMode).toBe("terminal");
    expect(result.opencodeMode).toBe("native");
    expect(result.codexMode).toBe("terminal");
  });

  test("project-level defaultAgent overrides app-level", () => {
    const result = resolveAgentDefaults(
      { defaultAgent: "claude", claudeMode: "terminal", opencodeMode: "terminal" },
      { defaultAgent: "opencode" },
    );
    expect(result.defaultAgent).toBe("opencode");
  });

  test("project-level agentStyle overrides both claudeMode and opencodeMode", () => {
    const result = resolveAgentDefaults(
      { defaultAgent: "claude", claudeMode: "terminal", opencodeMode: "terminal", codexMode: "native" },
      { agentStyle: "native" },
    );
    expect(result.claudeMode).toBe("native");
    expect(result.opencodeMode).toBe("native");
    expect(result.codexMode).toBe("native");
  });

  test("project-level overrides take precedence over app-level for all fields", () => {
    const result = resolveAgentDefaults(
      { defaultAgent: "claude", claudeMode: "terminal", opencodeMode: "terminal", codexMode: "native" },
      { defaultAgent: "codex", agentStyle: "native" },
    );
    expect(result.defaultAgent).toBe("codex");
    expect(result.claudeMode).toBe("native");
    expect(result.opencodeMode).toBe("native");
    expect(result.codexMode).toBe("native");
  });

  test("falls back to hardcoded defaults when both levels are undefined", () => {
    const result = resolveAgentDefaults({}, undefined);
    expect(result.defaultAgent).toBe("claude");
    expect(result.claudeMode).toBe("terminal");
    expect(result.opencodeMode).toBe("terminal");
    expect(result.codexMode).toBe("native");
  });

  test("project agentStyle does not affect defaultAgent resolution", () => {
    const result = resolveAgentDefaults(
      { defaultAgent: "claude" },
      { agentStyle: "native" },
    );
    // defaultAgent should still come from app-level
    expect(result.defaultAgent).toBe("claude");
    expect(result.claudeMode).toBe("native");
    expect(result.codexMode).toBe("native");
  });

  test("project defaultAgent does not affect mode resolution", () => {
    const result = resolveAgentDefaults(
      { defaultAgent: "claude", claudeMode: "native", opencodeMode: "native", codexMode: "terminal" },
      { defaultAgent: "opencode" },
    );
    // Modes should still come from app-level since no agentStyle override
    expect(result.defaultAgent).toBe("opencode");
    expect(result.claudeMode).toBe("native");
    expect(result.opencodeMode).toBe("native");
    expect(result.codexMode).toBe("terminal");
  });
});

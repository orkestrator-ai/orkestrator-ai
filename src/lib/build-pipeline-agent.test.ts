import { describe, expect, test } from "bun:test";
import { resolveBuildPipelineAgent } from "./build-pipeline-agent";

describe("resolveBuildPipelineAgent", () => {
  test("prefers the repository default agent", () => {
    const agent = resolveBuildPipelineAgent({
      version: "1.0",
      global: {
        containerResources: { cpuCores: 2, memoryGb: 4 },
        envFilePatterns: [],
        allowedDomains: [],
        defaultAgent: "claude",
        opencodeModel: "anthropic/claude-sonnet-4",
        codexModel: "gpt-5.3-codex",
        codexReasoningEffort: "medium",
        opencodeMode: "native",
        claudeMode: "native",
        terminalAppearance: {
          fontFamily: "Fira Code",
          fontSize: 14,
          backgroundColor: "#000000",
        },
        terminalScrollback: 5000,
      },
      repositories: {
        "project-1": {
          defaultBranch: "main",
          prBaseBranch: "main",
          defaultAgent: "codex",
        },
      },
    }, "project-1");

    expect(agent).toBe("codex");
  });

  test("falls back to the global default agent", () => {
    const agent = resolveBuildPipelineAgent({
      version: "1.0",
      global: {
        containerResources: { cpuCores: 2, memoryGb: 4 },
        envFilePatterns: [],
        allowedDomains: [],
        defaultAgent: "opencode",
        opencodeModel: "anthropic/claude-sonnet-4",
        codexModel: "gpt-5.3-codex",
        codexReasoningEffort: "medium",
        opencodeMode: "native",
        claudeMode: "native",
        terminalAppearance: {
          fontFamily: "Fira Code",
          fontSize: 14,
          backgroundColor: "#000000",
        },
        terminalScrollback: 5000,
      },
      repositories: {},
    }, "project-1");

    expect(agent).toBe("opencode");
  });
});

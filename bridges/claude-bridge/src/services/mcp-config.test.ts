import { describe, expect, test } from "bun:test";

import { configToSdkFormat } from "./mcp-config.js";
import type { McpServerConfig } from "../types/mcp.js";

describe("configToSdkFormat", () => {
  test("converts an http server config", () => {
    const result = configToSdkFormat({
      type: "http",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer x" },
    });

    expect(result).toEqual({
      type: "http",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer x" },
    });
  });

  test("converts an explicit stdio server config", () => {
    const result = configToSdkFormat({
      type: "stdio",
      command: "my-server",
      args: ["--flag"],
      env: { KEY: "value" },
    });

    expect(result).toEqual({
      type: "stdio",
      command: "my-server",
      args: ["--flag"],
      env: { KEY: "value" },
    });
  });

  test("defaults to stdio when type is omitted but a command is present", () => {
    const result = configToSdkFormat({ command: "implicit-stdio" });

    expect(result).toEqual({
      type: "stdio",
      command: "implicit-stdio",
      args: undefined,
      env: undefined,
    });
  });

  test("returns null for an http config missing its url", () => {
    // Malformed config (http type without a url) — neither branch matches.
    const result = configToSdkFormat({ type: "http" } as McpServerConfig);
    expect(result).toBeNull();
  });

  test("returns null for a config that is neither http nor stdio", () => {
    const result = configToSdkFormat({} as McpServerConfig);
    expect(result).toBeNull();
  });
});

/**
 * Plugin configuration types.
 * These match the format used in ~/.claude.json and project plugin configs.
 */

/**
 * Plugin configuration entry
 */
export interface PluginConfig {
  type: "local";
  path: string;
}

/**
 * Structure of ~/.claude.json file (plugin-related fields)
 */
export interface ClaudeJsonPluginsConfig {
  plugins?: PluginConfig[];
  projects?: Record<
    string,
    {
      plugins?: PluginConfig[];
    }
  >;
}

/**
 * Plugin info for frontend display
 */
export interface PluginInfo {
  name: string;
  path: string;
  description?: string;
  source: "global" | "project" | "cli";
  enabled: boolean;
}

/**
 * Plugin status from SDK init message
 */
export interface PluginStatus {
  name: string;
  path: string;
  status: "loaded" | "failed";
  error?: string;
}

/**
 * MCP server status from SDK init message
 */
export interface McpServerStatus {
  name: string;
  status: "connected" | "failed";
  error?: string;
  tools?: string[];
}

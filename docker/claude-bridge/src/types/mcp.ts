/**
 * MCP (Model Context Protocol) server configuration types.
 * These match the format used in ~/.claude.json and .mcp.json files.
 */

/**
 * HTTP-based MCP server configuration
 */
export interface HttpMcpServerConfig {
  type: "http";
  url: string;
  headers?: Record<string, string>;
}

/**
 * stdio-based MCP server configuration (spawns a process)
 */
export interface StdioMcpServerConfig {
  type?: "stdio"; // Optional, defaults to stdio if command is present
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * MCP server configuration - can be HTTP or stdio type
 */
export type McpServerConfig = HttpMcpServerConfig | StdioMcpServerConfig;

/**
 * MCP servers configuration object (server name -> config)
 */
export type McpServersConfig = Record<string, McpServerConfig>;

/**
 * Structure of ~/.claude.json file (partial, only MCP-related fields)
 */
export interface ClaudeJsonConfig {
  mcpServers?: McpServersConfig;
  projects?: Record<
    string,
    {
      mcpServers?: McpServersConfig;
    }
  >;
}

/**
 * Structure of .mcp.json file
 */
export interface McpJsonConfig {
  mcpServers?: McpServersConfig;
}

/**
 * MCP server info for frontend display
 */
export interface McpServerInfo {
  name: string;
  type: "http" | "stdio";
  url?: string; // For HTTP servers
  command?: string; // For stdio servers
  source: "global" | "project"; // Where the config came from
}

/**
 * Extended tool use content with MCP metadata
 */
export interface McpToolMetadata {
  isMcpTool: boolean;
  mcpServerName?: string;
}

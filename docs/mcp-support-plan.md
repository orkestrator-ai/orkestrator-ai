# MCP Support Implementation Plan

## Overview
Add Model Context Protocol (MCP) server support to Claude native tabs, automatically loading servers from `~/.claude.json` (global) and `<project>/.mcp.json` (project-specific).

## Requirements
1. **Auto-load all MCP servers** from config files
2. **Visual distinction** for MCP tool invocations in the UI
3. **Load both global and project-specific** MCP server configs

## Implementation Steps

### Phase 1: Backend - MCP Config Loading

#### 1.1 Add MCP Types
**File**: `docker/claude-bridge/src/types/mcp.ts` (new file)

```typescript
// MCP server configuration types matching ~/.claude.json format
export interface McpServerConfig {
  type?: "http" | "stdio";
  // HTTP server config
  url?: string;
  headers?: Record<string, string>;
  // stdio server config
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpServersConfig {
  mcpServers?: Record<string, McpServerConfig>;
}
```

#### 1.2 Create MCP Config Service
**File**: `docker/claude-bridge/src/services/mcp-config.ts` (new file)

This service will:
- Read `~/.claude.json` for global MCP servers
- Read `<project>/.mcp.json` for project-specific servers (if exists)
- Merge configs (project overrides global for same server names)
- Transform configs to SDK-compatible format

Key functions:
- `loadGlobalMcpServers()` - Load from ~/.claude.json
- `loadProjectMcpServers(cwd: string)` - Load from <cwd>/.mcp.json
- `getMergedMcpServers(cwd: string)` - Merge global + project configs
- `mcpConfigToSdkFormat(config)` - Convert to SDK MCPServer format

#### 1.3 Update Session Manager
**File**: `docker/claude-bridge/src/services/session-manager.ts`

Modify `sendPrompt()` to:
1. Load MCP servers via the new config service
2. Pass `mcpServers` option to `query()`
3. Add `mcp:*` to `allowedTools` array to allow all MCP tools
4. Track which tools come from MCP servers (for UI distinction)

Changes to query options:
```typescript
const result = query({
  // ... existing options ...
  mcpServers: await getMergedMcpServers(cwd),
  allowedTools: [
    ...existingTools,
    "mcp:*"  // Allow all MCP tools
  ]
});
```

#### 1.4 Add MCP Info to Events
**File**: `docker/claude-bridge/src/services/session-manager.ts`

When emitting tool events, include MCP metadata:
- Add `isMcpTool: boolean` to tool event data
- Add `mcpServerName?: string` for MCP tools
- This allows frontend to visually distinguish MCP tools

### Phase 2: Frontend - MCP Tool Display

#### 2.1 Update Claude Message Types
**File**: `src/lib/claude-client.ts`

Add MCP metadata to tool types:
```typescript
interface ToolUseContent {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
  // New fields
  isMcpTool?: boolean;
  mcpServerName?: string;
}
```

#### 2.2 Update Tool Rendering
**File**: `src/components/claude/ClaudeMessage.tsx`

Modify tool rendering to show MCP badge:
- Add MCP icon/badge for tools where `isMcpTool === true`
- Show server name in tooltip (e.g., "from context7 server")
- Use a distinct color scheme (e.g., purple/cyan) for MCP tools

Visual design:
```
┌─────────────────────────────────────┐
│ 🔌 mcp_context7_resolve  [MCP]      │  <- Purple/cyan accent
│ library: @tanstack/react-query      │
│ topic: useQuery                     │
└─────────────────────────────────────┘
```

#### 2.3 Add MCP Status Indicator
**File**: `src/components/claude/ClaudeChatTab.tsx` (optional enhancement)

Consider adding a status indicator showing:
- Number of MCP servers connected
- Server names (on hover)
- Connection status (if SDK provides this)

### Phase 3: API Endpoints

#### 3.1 Add MCP Info Endpoint
**File**: `docker/claude-bridge/src/routes/session.ts`

Add endpoint to get current MCP server status:
```
GET /mcp/servers
```
Returns list of configured MCP servers with connection status.

### File Changes Summary

| File | Change Type | Description |
|------|-------------|-------------|
| `docker/claude-bridge/src/types/mcp.ts` | New | MCP config types |
| `docker/claude-bridge/src/services/mcp-config.ts` | New | Config loading service |
| `docker/claude-bridge/src/services/session-manager.ts` | Modify | Add MCP to query() |
| `docker/claude-bridge/src/routes/session.ts` | Modify | Add MCP endpoint |
| `src/lib/claude-client.ts` | Modify | Add MCP types |
| `src/components/claude/ClaudeMessage.tsx` | Modify | MCP tool rendering |

### Testing Plan

1. **Unit test**: MCP config loading from mock files
2. **Integration test**: Bridge server with MCP servers configured
3. **Manual test**:
   - Configure context7 MCP server in ~/.claude.json
   - Use Claude native tab to ask about a library
   - Verify MCP tool calls show visual distinction
   - Verify tools work correctly

### Risks & Considerations

1. **MCP server startup time**: stdio servers need to start up, may cause initial delay
2. **Error handling**: Need graceful handling if MCP server fails to connect
3. **Security**: MCP servers have access to local filesystem - same security model as Claude CLI
4. **Performance**: Many MCP servers may increase memory usage

### Rollout

1. Implement backend changes first (Phase 1)
2. Test with basic MCP server (context7)
3. Add frontend visual distinction (Phase 2)
4. Add optional status endpoint (Phase 3)

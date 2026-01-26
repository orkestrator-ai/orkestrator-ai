// Type definitions for Claude Bridge Server

/** Diff metadata for edit tool operations */
export interface ToolDiffMetadata {
  filePath?: string;
  additions?: number;
  deletions?: number;
  before?: string;
  after?: string;
  diff?: string;
}

/** Normalized message part */
export interface NormalizedPart {
  type: "text" | "thinking" | "tool-invocation" | "tool-result" | "file";
  content?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolState?: "success" | "failure" | "pending";
  toolTitle?: string;
  toolOutput?: string;
  toolError?: string;
  toolDiff?: ToolDiffMetadata;
  /** Tool use ID for tracking tool invocations across messages */
  toolUseId?: string;
  /** Internal: Message UUID for tracking thinking parts across streaming updates */
  _messageUuid?: string;
  /** Whether this tool is from an MCP server */
  isMcpTool?: boolean;
  /** The MCP server name if this is an MCP tool */
  mcpServerName?: string;
}

/** Normalized message format */
export interface NormalizedMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  parts: NormalizedPart[];
  timestamp: string;
}

/** Session state */
export interface SessionState {
  id: string;
  title?: string;
  messages: NormalizedMessage[];
  status: "idle" | "running" | "error";
  abortController?: AbortController;
  createdAt: Date;
  lastActivity: Date;
  error?: string;
  /** SDK session ID returned from Claude Agent SDK - used for resume */
  sdkSessionId?: string;
  /** Session initialization data (MCP servers, plugins, etc.) */
  initData?: SessionInitData;
}

/** Model info */
export interface ModelInfo {
  id: string;
  name: string;
  description?: string;
}

/** Question option for AskUserQuestion tool */
export interface QuestionOption {
  label: string;
  description?: string;
}

/** Question info structure */
export interface QuestionInfo {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

/** Question request from Claude */
export interface QuestionRequest {
  id: string;
  sessionId: string;
  questions: QuestionInfo[];
  toolUseId?: string;
}

/** SSE event types */
export type SSEEventType =
  | "session.updated"
  | "session.idle"
  | "session.error"
  | "session.init"
  | "message.updated"
  | "question.asked"
  | "question.answered"
  | "plan.enter-requested"
  | "plan.exit-requested";

/** MCP server status from SDK init message */
export interface McpServerRuntimeStatus {
  name: string;
  status: "connected" | "failed";
  error?: string;
  tools?: string[];
}

/** Plugin status from SDK init message */
export interface PluginRuntimeStatus {
  name: string;
  path?: string;
  status: "loaded" | "failed";
  error?: string;
}

/** Session initialization data (from SDK init message) */
export interface SessionInitData {
  mcpServers: McpServerRuntimeStatus[];
  plugins: PluginRuntimeStatus[];
  slashCommands?: string[];
}

/** SSE event */
export interface SSEEvent {
  type: SSEEventType;
  sessionId?: string;
  data?: unknown;
}

/** Permission mode for Claude Agent SDK */
export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan";

/** Prompt options */
export interface PromptOptions {
  model?: string;
  thinking?: boolean;
  permissionMode?: PermissionMode;
  attachments?: Array<{
    type: "file" | "image";
    path: string;
    dataUrl?: string;
    filename?: string;
  }>;
}

/** API responses */
export interface CreateSessionResponse {
  sessionId: string;
  title?: string;
}

export interface SessionListResponse {
  sessions: Array<{
    id: string;
    title?: string;
    status: "idle" | "running" | "error";
    createdAt: string;
    lastActivity: string;
  }>;
}

export interface MessagesResponse {
  messages: NormalizedMessage[];
}

export interface ModelsResponse {
  models: ModelInfo[];
}

export interface HealthResponse {
  status: "ok";
  version: string;
}

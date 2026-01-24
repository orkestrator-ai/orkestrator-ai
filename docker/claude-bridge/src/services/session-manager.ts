// Session Manager Service
// Handles session state and interacts with Claude Agent SDK

import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  SessionState,
  NormalizedMessage,
  NormalizedPart,
  ToolDiffMetadata,
  QuestionRequest,
  PromptOptions,
  SessionInitData,
  McpServerRuntimeStatus,
  PluginRuntimeStatus,
} from "../types/index.js";
import { eventEmitter } from "./event-emitter.js";
import { getMcpServersForSdk, getMcpServerNames } from "./mcp-config.js";
import { getPluginsForSdk } from "./plugin-config.js";
import type { McpToolMetadata } from "../types/mcp.js";

// Store for active sessions
const sessions = new Map<string, SessionState>();

// Pending questions waiting for answers
const pendingQuestions = new Map<string, QuestionRequest>();

// Question answer resolvers (for AskUserQuestion flow)
// Answers are Record<string, string> mapping question text to answer text
const questionResolvers = new Map<
  string,
  {
    resolve: (answers: Record<string, string>) => void;
    reject: (error: Error) => void;
  }
>();

/**
 * Generate a unique session ID using crypto.randomUUID for guaranteed uniqueness
 */
function generateSessionId(): string {
  return `session-${crypto.randomUUID()}`;
}

/**
 * Generate a unique message ID using crypto.randomUUID for guaranteed uniqueness
 */
function generateMessageId(): string {
  return `msg-${crypto.randomUUID()}`;
}

/**
 * Create a new session
 */
export function createSession(title?: string): SessionState {
  const id = generateSessionId();
  const now = new Date();

  const session: SessionState = {
    id,
    title: title || `Session ${id.slice(-6)}`,
    messages: [],
    status: "idle",
    createdAt: now,
    lastActivity: now,
  };

  sessions.set(id, session);

  eventEmitter.emit({
    type: "session.updated",
    sessionId: id,
    data: { status: "idle" },
  });

  return session;
}

/**
 * Get a session by ID
 */
export function getSession(sessionId: string): SessionState | undefined {
  return sessions.get(sessionId);
}

/**
 * List all sessions
 */
export function listSessions(): SessionState[] {
  return Array.from(sessions.values());
}

/**
 * Delete a session
 */
export function deleteSession(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (session) {
    // Abort any running query
    if (session.abortController) {
      session.abortController.abort();
    }
    sessions.delete(sessionId);
    return true;
  }
  return false;
}

/**
 * Get messages for a session
 */
export function getSessionMessages(sessionId: string): NormalizedMessage[] {
  const session = sessions.get(sessionId);
  return session?.messages || [];
}

/**
 * Abort a running session
 */
export function abortSession(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (session && session.abortController) {
    session.abortController.abort();
    session.status = "idle";
    session.abortController = undefined;

    eventEmitter.emit({
      type: "session.idle",
      sessionId,
      data: { aborted: true },
    });

    return true;
  }
  return false;
}

/**
 * Tool tracker for managing tool invocations across a conversation turn.
 * Tools are tracked by their ID and their results are merged in when received.
 */
class ToolTracker {
  private tools = new Map<string, NormalizedPart>();

  /** Add or update a tool invocation */
  addTool(toolUseId: string, part: NormalizedPart): void {
    // Only add if we don't have this tool yet, or update state if we do
    const existing = this.tools.get(toolUseId);
    if (!existing) {
      this.tools.set(toolUseId, { ...part, toolUseId });
    }
  }

  /** Update a tool with its result */
  updateToolResult(toolUseId: string, result: { output?: string; error?: string; state: "success" | "failure" }): void {
    const existing = this.tools.get(toolUseId);
    if (existing) {
      this.tools.set(toolUseId, {
        ...existing,
        toolState: result.state,
        toolOutput: result.output,
        toolError: result.error,
      });
    }
  }

  /** Get all tracked tools as an array, preserving insertion order */
  getTools(): NormalizedPart[] {
    return Array.from(this.tools.values());
  }

  /** Get a specific tool by its ID */
  getTool(toolUseId: string): NormalizedPart | undefined {
    return this.tools.get(toolUseId);
  }
}

/** Entry in the ordered parts sequence - either a thinking block or a tool reference */
interface OrderedPartEntry {
  type: "thinking" | "tool-ref";
  /** For thinking: the thinking content. For tool-ref: the tool use ID */
  value: string;
  /** Message UUID this part belongs to (for streaming updates) */
  messageUuid?: string;
}

/**
 * Check if a tool name is from an MCP server and extract server name
 * MCP tool names have format: mcp_servername_toolname
 *
 * @param toolName - The tool name to parse
 * @param knownServerNames - Set of known MCP server names for accurate matching
 *                           when server names contain underscores
 */
function parseMcpToolName(
  toolName: string,
  knownServerNames?: Set<string>
): McpToolMetadata {
  if (!toolName.startsWith("mcp_")) {
    return { isMcpTool: false };
  }

  // Remove the "mcp_" prefix
  const remainder = toolName.slice(4);

  // If we have known server names, find the longest matching prefix
  // This handles server names with underscores (e.g., "my_server")
  if (knownServerNames && knownServerNames.size > 0) {
    let matchedServer: string | undefined;
    let maxLength = 0;

    for (const serverName of knownServerNames) {
      // Check if remainder starts with "servername_"
      if (
        remainder.startsWith(serverName + "_") &&
        serverName.length > maxLength
      ) {
        matchedServer = serverName;
        maxLength = serverName.length;
      }
    }

    if (matchedServer) {
      return { isMcpTool: true, mcpServerName: matchedServer };
    }
  }

  // Fallback: assume server name is the first segment (no underscores in name)
  const parts = remainder.split("_");
  if (parts.length >= 2) {
    return { isMcpTool: true, mcpServerName: parts[0] };
  }

  return { isMcpTool: true };
}

/**
 * Parse SDK message content, extracting text/thinking parts, registering tools,
 * and tracking the order of non-text parts for chronological display
 *
 * @param message - The SDK message to parse
 * @param toolTracker - Tool tracker for managing tool invocations
 * @param mcpServerNames - Set of known MCP server names for accurate tool parsing
 */
function parseMessageContent(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  message: any,
  toolTracker?: ToolTracker,
  mcpServerNames?: Set<string>
): {
  content: string;
  textParts: NormalizedPart[];
  thinkingParts: NormalizedPart[];
  /** Ordered sequence of thinking blocks and tool references as they appeared */
  orderedParts: OrderedPartEntry[];
} {
  const textParts: NormalizedPart[] = [];
  const thinkingParts: NormalizedPart[] = [];
  const orderedParts: OrderedPartEntry[] = [];
  let textContent = "";

  const messageUuid = message.uuid as string | undefined;

  // Handle message.message.content array (from Anthropic SDK format)
  const contentBlocks = message.message?.content || [];

  for (const block of contentBlocks) {
    if (block.type === "text") {
      textContent += block.text || "";
      textParts.push({
        type: "text",
        content: block.text || "",
      });
    } else if (block.type === "thinking") {
      const thinkingContent = block.thinking || "";
      thinkingParts.push({
        type: "thinking",
        content: thinkingContent,
      });
      // Track order: add thinking entry
      orderedParts.push({
        type: "thinking",
        value: thinkingContent,
        messageUuid,
      });
    } else if (block.type === "tool_use" && toolTracker) {
      const toolName = block.name || "Unknown tool";
      const isEditTool =
        toolName === "Edit" ||
        toolName === "Write" ||
        toolName === "edit" ||
        toolName === "write";

      let toolDiff: ToolDiffMetadata | undefined;
      if (isEditTool && block.input) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const input = block.input as any;
        toolDiff = {
          filePath: input.file_path || input.filePath,
          before: input.old_string || input.oldString,
          after: input.new_string || input.newString,
        };
      }

      // Check if this is an MCP tool
      const { isMcpTool, mcpServerName } = parseMcpToolName(toolName, mcpServerNames);

      // Register tool with tracker
      if (block.id) {
        toolTracker.addTool(block.id, {
          type: "tool-invocation",
          content: toolName,
          toolName,
          toolArgs: block.input,
          toolState: "pending",
          toolDiff,
          toolUseId: block.id,
          // MCP tool metadata
          isMcpTool,
          mcpServerName,
        });
        // Track order: add tool reference
        orderedParts.push({
          type: "tool-ref",
          value: block.id,
          messageUuid,
        });
      }
    } else if (block.type === "tool_result" && toolTracker) {
      // Update tool tracker with result
      if (block.tool_use_id) {
        const resultContent = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
        toolTracker.updateToolResult(block.tool_use_id, {
          output: block.is_error ? undefined : resultContent,
          error: block.is_error ? resultContent : undefined,
          state: block.is_error ? "failure" : "success",
        });
      }
    }
  }

  return { content: textContent, textParts, thinkingParts, orderedParts };
}

/**
 * Build message parts from ordered sequence and text
 * Maintains chronological order of thinking blocks and tool invocations
 */
function buildMessageParts(
  orderedParts: OrderedPartEntry[],
  toolTracker: ToolTracker,
  textParts: NormalizedPart[]
): NormalizedPart[] {
  const result: NormalizedPart[] = [];

  // Build parts in chronological order
  for (const entry of orderedParts) {
    if (entry.type === "thinking") {
      result.push({
        type: "thinking",
        content: entry.value,
        _messageUuid: entry.messageUuid,
      });
    } else if (entry.type === "tool-ref") {
      // Look up the tool from the tracker
      const tool = toolTracker.getTool(entry.value);
      if (tool) {
        result.push(tool);
      }
    }
  }

  // Add text parts at the end
  result.push(...textParts);

  return result;
}

/**
 * Send a prompt to a session and process the response
 */
export async function sendPrompt(
  sessionId: string,
  prompt: string,
  options?: PromptOptions
): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  if (session.status === "running") {
    throw new Error("Session is already processing a prompt");
  }

  // Create abort controller for this query
  const abortController = new AbortController();
  session.abortController = abortController;
  session.status = "running";
  session.lastActivity = new Date();

  // Build the final prompt - append attachment references as XML tags
  // The model can use its Read tool to access these files
  // This must happen BEFORE creating the user message so the XML tags are included
  let finalPrompt = prompt;

  if (options?.attachments && options.attachments.length > 0) {
    const attachmentTags = options.attachments
      .map((att) => `<attachment type="${att.type}" path="${att.path}" filename="${att.filename || ""}" />`)
      .join("\n");
    finalPrompt = `${prompt}\n\n<attached-files>\n${attachmentTags}\n</attached-files>`;
  }

  // Add user message with finalPrompt (includes attachment XML tags)
  const userMessage: NormalizedMessage = {
    id: generateMessageId(),
    role: "user",
    content: finalPrompt,
    parts: [{ type: "text", content: finalPrompt }],
    timestamp: new Date().toISOString(),
  };
  session.messages.push(userMessage);

  eventEmitter.emit({
    type: "message.updated",
    sessionId,
    data: { message: userMessage },
  });

  eventEmitter.emit({
    type: "session.updated",
    sessionId,
    data: { status: "running" },
  });

  const startedAt = Date.now();
  let lastSdkMessageAt = Date.now();
  let sdkMessageCount = 0;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let earlyWarningTimeout: ReturnType<typeof setTimeout> | null = null;

  try {
    // Create the query with Claude Agent SDK
    // Extended thinking is enabled by default (thinking !== false)
    const thinkingEnabled = options?.thinking !== false;
    // Use CWD env var if set (for local environments where bridge runs from its own dir)
    // This allows the Claude SDK to operate on the actual project directory
    const cwd = process.env.CWD || process.cwd();

    // Load MCP servers from config files
    const mcpServers = await getMcpServersForSdk(cwd);
    const mcpServerNames = await getMcpServerNames(cwd);

    // Load plugins from config files
    const plugins = await getPluginsForSdk(cwd);

    const mcpServerCount = Object.keys(mcpServers).length;
    const pluginCount = plugins.length;
    console.log("[session-manager] Starting query", {
      sessionId,
      cwd,
      model: options?.model,
      resume: session.sdkSessionId ?? null,
      thinkingEnabled,
      mcpServerCount,
      mcpServerNames: Array.from(mcpServerNames),
      pluginCount,
      pluginPaths: plugins.map((p) => p.path),
    });
    const envPath = process.env.PATH;
    console.log("[session-manager] SDK env PATH", { path: envPath });
    const queryIterator = query({
      prompt: finalPrompt,
      options: {
        cwd,
        model: options?.model,
        permissionMode: "acceptEdits",
        // Enable extended thinking with up to 16K tokens (if enabled)
        ...(thinkingEnabled && { maxThinkingTokens: 16000 }),
        allowedTools: [
          "Read",
          "Edit",
          "Write",
          "Bash",
          "Glob",
          "Grep",
          "WebSearch",
          "WebFetch",
          "AskUserQuestion",
          "Task",
          "TodoWrite",
          // Allow all MCP tools
          "mcp:*",
        ],
        abortController,
        // Resume session if we have a previous SDK session ID
        resume: session.sdkSessionId,
        // Use Claude Code system prompt
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
        },
        // Load user settings (from ~/.claude.json including MCP servers) and project settings (CLAUDE.md files)
        // Using "user" lets the SDK handle MCP server loading natively, which supports all transport types
        settingSources: ["user", "project"],
        // Also pass MCP servers explicitly for any project-local .mcp.json overrides
        mcpServers: mcpServerCount > 0 ? mcpServers : undefined,
        // Load plugins from user config
        plugins: pluginCount > 0 ? plugins : undefined,
        // Handle AskUserQuestion tool to get user input
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        canUseTool: async (toolName: string, input: any) => {
          if (toolName === "AskUserQuestion") {
            // Create a question request and wait for user answer
            const questionId = generateMessageId();
            const questionRequest: QuestionRequest = {
              id: questionId,
              sessionId,
              questions: input.questions || [],
              toolUseId: questionId,
            };

            // Store the question
            pendingQuestions.set(questionId, questionRequest);

            // Emit event so frontend knows to show the question
            eventEmitter.emit({
              type: "question.asked",
              sessionId,
              data: questionRequest,
            });

            // Wait for answer with a Promise that can be resolved externally
            const answerPromise = new Promise<Record<string, string>>((resolve, reject) => {
              questionResolvers.set(questionId, { resolve, reject });
            });

            try {
              const answers = await answerPromise;
              console.log("[session-manager] Received answers for question:", questionId, answers);

              // Return the answers to the SDK
              return {
                behavior: "allow" as const,
                updatedInput: {
                  questions: input.questions,
                  answers,
                },
              };
            } catch (error) {
              console.error("[session-manager] Error waiting for answer:", error);
              // If rejected (e.g., dismissed), deny the tool use
              return { behavior: "deny" as const, message: "User dismissed the question" };
            } finally {
              // Cleanup
              pendingQuestions.delete(questionId);
              questionResolvers.delete(questionId);
            }
          }
          // Allow all other tools - pass input through unchanged
          return { behavior: "allow" as const, updatedInput: input };
        },
      },
    });

    // Log an early warning if SDK doesn't respond within 5 seconds
    earlyWarningTimeout = setTimeout(() => {
      if (sdkMessageCount === 0) {
        console.warn("[session-manager] SDK has not responded after 5 seconds", {
          sessionId,
          cwd,
          model: options?.model,
          status: session.status,
        });
      }
    }, 5000);

    heartbeat = setInterval(() => {
      const idleMs = Date.now() - lastSdkMessageAt;
      if (idleMs > 15000) {
        console.warn("[session-manager] No SDK messages yet", {
          sessionId,
          idleMs,
          sdkMessageCount,
          status: session.status,
        });
      }
    }, 15000);

    // Track current assistant message for updates
    let currentAssistantMessage: NormalizedMessage | null = null;

    // Tool tracker persists across all messages in this turn
    const toolTracker = new ToolTracker();

    // Track accumulated text parts and ordered non-text parts (thinking + tools in chronological order)
    let accumulatedTextParts: NormalizedPart[] = [];
    let accumulatedOrderedParts: OrderedPartEntry[] = [];

    // Track the last message UUID to detect when we're receiving a new assistant message
    // vs streaming updates to the same message. This allows us to:
    // - Replace parts during streaming (same UUID)
    // - Accumulate parts across multiple assistant messages in a turn (different UUID)
    let lastAssistantMessageUuid: string | null = null;

    // Process the async generator
    for await (const message of queryIterator) {
      if (abortController.signal.aborted) {
        break;
      }

      sdkMessageCount += 1;
      lastSdkMessageAt = Date.now();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const subtype = (message as any)?.subtype;
      console.debug("[session-manager] SDK event received", {
        sessionId,
        type: message.type,
        subtype,
        sdkMessageCount,
      });

      // Handle different message types from SDK
      if (message.type === "system" && message.subtype === "init") {
        // Store the SDK session ID for resume functionality
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const initMsg = message as any;
        const sdkSessionId = initMsg.session_id;
        if (sdkSessionId) {
          session.sdkSessionId = sdkSessionId;
          console.log("[session-manager] Session initialized, stored SDK session ID:", sdkSessionId);
        }

        // Capture MCP servers and plugins from init message
        // Note: Claude SDK sends MCP-provided plugins as MCP servers with "plugin:" prefix
        const allMcpServers = initMsg.mcp_servers || [];

        // Separate regular MCP servers from plugin-type MCP servers
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const regularMcpServers = allMcpServers.filter((s: any) => !s.name?.startsWith("plugin:"));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pluginMcpServers = allMcpServers.filter((s: any) => s.name?.startsWith("plugin:"));

        const mcpServerStatuses: McpServerRuntimeStatus[] = regularMcpServers.map(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (s: any) => ({
            name: s.name,
            status: s.status === "connected" ? "connected" : "failed",
            error: s.error,
            tools: s.tools,
          })
        );

        // Convert plugin-type MCP servers to plugin statuses
        // Also include any traditional plugins from initMsg.plugins
        const pluginStatuses: PluginRuntimeStatus[] = [
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ...pluginMcpServers.map((s: any) => ({
            name: s.name,
            path: undefined,
            status: (s.status === "connected" ? "loaded" : "failed") as "loaded" | "failed",
            error: s.error,
          })),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ...(initMsg.plugins || []).map((p: any) => ({
            name: p.name,
            path: p.path,
            status: (p.status === "loaded" ? "loaded" : "failed") as "loaded" | "failed",
            error: p.error,
          })),
        ];

        // Store init data in session
        session.initData = {
          mcpServers: mcpServerStatuses,
          plugins: pluginStatuses,
          slashCommands: initMsg.slash_commands,
        };

        console.log("[session-manager] Session init data captured", {
          sessionId,
          mcpServerCount: mcpServerStatuses.length,
          pluginCount: pluginStatuses.length,
          slashCommandCount: initMsg.slash_commands?.length ?? 0,
        });

        // Emit session.init event so frontend can update UI
        eventEmitter.emit({
          type: "session.init",
          sessionId,
          data: session.initData,
        });
      } else if (message.type === "assistant") {
        // Assistant message - parse content and register tools with tracker
        const { content, textParts, orderedParts } = parseMessageContent(message, toolTracker, mcpServerNames);

        // Get the message UUID to detect new messages vs streaming updates
        const messageUuid = message.uuid as string | undefined;

        // Update accumulated parts
        // For text: always replace (SDK sends full text content each time)
        accumulatedTextParts = textParts;

        // For ordered parts (thinking + tools): we need to handle two cases:
        // 1. Streaming update to same message (same UUID): replace parts from this message
        // 2. New assistant message (different UUID): accumulate parts
        // This preserves chronological order across think → tool → think sequences
        if (orderedParts.length > 0) {
          if (messageUuid && messageUuid === lastAssistantMessageUuid) {
            // Same message - replace (streaming update)
            // Keep parts from previous messages, replace parts from this message
            const previousParts = accumulatedOrderedParts.filter(
              (p) => p.messageUuid !== messageUuid
            );
            accumulatedOrderedParts = [...previousParts, ...orderedParts];
          } else {
            // New message - accumulate ordered parts
            accumulatedOrderedParts = [...accumulatedOrderedParts, ...orderedParts];
          }
        }

        // Update the last message UUID
        if (messageUuid) {
          lastAssistantMessageUuid = messageUuid;
        }

        // Build final parts maintaining chronological order
        const finalParts = buildMessageParts(accumulatedOrderedParts, toolTracker, accumulatedTextParts);

        if (!currentAssistantMessage) {
          currentAssistantMessage = {
            id: message.uuid || generateMessageId(),
            role: "assistant",
            content,
            parts: finalParts,
            timestamp: new Date().toISOString(),
          };
          session.messages.push(currentAssistantMessage);
          console.debug("[session-manager] Created assistant message", {
            sessionId,
            messageId: currentAssistantMessage.id,
          });
        } else {
          currentAssistantMessage.content = content;
          currentAssistantMessage.parts = finalParts;
          console.debug("[session-manager] Updated assistant message", {
            sessionId,
            messageId: currentAssistantMessage.id,
          });
        }

        eventEmitter.emit({
          type: "message.updated",
          sessionId,
          data: { message: currentAssistantMessage },
        });
      } else if (message.type === "user") {
        // User message with tool results - parse to update tool tracker
        parseMessageContent(message, toolTracker, mcpServerNames);

        // Rebuild message parts with updated tool results
        if (currentAssistantMessage) {
          const finalParts = buildMessageParts(accumulatedOrderedParts, toolTracker, accumulatedTextParts);
          currentAssistantMessage.parts = finalParts;

          eventEmitter.emit({
            type: "message.updated",
            sessionId,
            data: { message: currentAssistantMessage },
          });
        }
        // Skip adding user message replay as we already added it
      } else if (message.type === "result") {
        // Query completed
        if (message.subtype === "success") {
          console.log("[session-manager] Query completed successfully", { sessionId });
        } else {
          console.error("[session-manager] Query error:", message.subtype, { sessionId });
          if ("errors" in message && message.errors) {
            session.error = message.errors.join("\n");
          }
        }
      } else if (message.type === "stream_event") {
        // Streaming partial message - could handle for real-time updates
        // For now, we rely on full assistant messages
      }
      // Note: AskUserQuestion tool handling is done in the canUseTool callback above
    }

    session.status = "idle";
    session.abortController = undefined;

    eventEmitter.emit({
      type: "session.idle",
      sessionId,
      data: { success: true },
    });

    console.debug("[session-manager] Prompt completed", {
      sessionId,
      sdkMessageCount,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    console.error("[session-manager] Error processing prompt:", error);

    session.status = "error";
    session.error = error instanceof Error ? error.message : String(error);
    session.abortController = undefined;

    eventEmitter.emit({
      type: "session.error",
      sessionId,
      data: { error: session.error },
    });

    throw error;
  } finally {
    if (heartbeat) {
      clearInterval(heartbeat);
    }
    if (earlyWarningTimeout) {
      clearTimeout(earlyWarningTimeout);
    }
  }
}

/**
 * Answer a pending question
 * @param requestId - The question request ID
 * @param answers - Record mapping question text to selected answer text
 */
export function answerQuestion(
  requestId: string,
  answers: Record<string, string>
): boolean {
  const question = pendingQuestions.get(requestId);
  if (!question) {
    console.log("[session-manager] Question not found for requestId:", requestId);
    return false;
  }

  console.log("[session-manager] Answering question:", requestId, "with answers:", answers);

  const resolver = questionResolvers.get(requestId);
  if (resolver) {
    console.log("[session-manager] Resolving promise for question:", requestId);
    resolver.resolve(answers);
    questionResolvers.delete(requestId);
  } else {
    console.log("[session-manager] No resolver found for question:", requestId);
  }

  pendingQuestions.delete(requestId);

  eventEmitter.emit({
    type: "question.answered",
    sessionId: question.sessionId,
    data: { requestId, answers },
  });

  return true;
}

/**
 * Get pending questions for a session
 */
export function getPendingQuestions(
  sessionId?: string
): QuestionRequest[] {
  const questions = Array.from(pendingQuestions.values());
  if (sessionId) {
    return questions.filter((q) => q.sessionId === sessionId);
  }
  return questions;
}

/**
 * Get session initialization data (MCP servers, plugins, slash commands)
 */
export function getSessionInitData(sessionId: string): SessionInitData | undefined {
  const session = sessions.get(sessionId);
  return session?.initData;
}

/**
 * Get available models from the Claude Agent SDK
 * The supportedModels() method is available on the Query object returned by query()
 */
export async function getAvailableModels(): Promise<Array<{
  id: string;
  name: string;
  description?: string;
}>> {
  try {
    const cwd = process.env.CWD || process.cwd();
    console.log("[session-manager] Fetching supported models", { cwd });
    // Create a query object to access supportedModels()
    // We use maxTurns: 0 to prevent any actual processing
    const q = query({
      prompt: "",
      options: {
        maxTurns: 0,
        cwd,
      },
    });

    // Get supported models from the query object
    const models = await q.supportedModels();
    console.log("[session-manager] Supported models fetched", { count: models.length });

    // Clean up the query (don't consume the generator)
    if (q.return) {
      await q.return();
    }

    return models.map((model: { value: string; displayName: string; description?: string }) => ({
      id: model.value,
      name: model.displayName,
      description: model.description,
    }));
  } catch (error) {
    console.error("[session-manager] Error fetching supported models:", error);
    // Return fallback models if SDK call fails
    return [
      {
        id: "claude-sonnet-4-5-20250514",
        name: "Claude Sonnet 4.5",
        description: "Latest and most capable model",
      },
    ];
  }
}

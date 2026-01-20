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
} from "../types/index.js";
import { eventEmitter } from "./event-emitter.js";

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
 * Generate a unique session ID
 */
function generateSessionId(): string {
  return `session-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Generate a unique message ID
 */
function generateMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
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
}

/**
 * Parse SDK message content, extracting text/thinking parts and registering tools with tracker
 */
function parseMessageContent(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  message: any,
  toolTracker?: ToolTracker
): { content: string; textParts: NormalizedPart[]; thinkingParts: NormalizedPart[] } {
  const textParts: NormalizedPart[] = [];
  const thinkingParts: NormalizedPart[] = [];
  let textContent = "";

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
      thinkingParts.push({
        type: "thinking",
        content: block.thinking || "",
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

  return { content: textContent, textParts, thinkingParts };
}

/**
 * Build message parts from parsed content and tracked tools
 * Order: thinking → tools → text
 */
function buildMessageParts(
  thinkingParts: NormalizedPart[],
  toolTracker: ToolTracker,
  textParts: NormalizedPart[]
): NormalizedPart[] {
  return [...thinkingParts, ...toolTracker.getTools(), ...textParts];
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

  // Add user message
  const userMessage: NormalizedMessage = {
    id: generateMessageId(),
    role: "user",
    content: prompt,
    parts: [{ type: "text", content: prompt }],
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

  try {
    // Build prompt parts
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const promptParts: any[] = [{ type: "text", text: prompt }];

    if (options?.attachments) {
      for (const attachment of options.attachments) {
        let mime = "application/octet-stream";
        if (attachment.type === "image") {
          mime = "image/png";
        }
        promptParts.push({
          type: "file",
          mime,
          url: attachment.dataUrl || `file://${attachment.path}`,
          filename: attachment.filename,
        });
      }
    }

    // Create the query with Claude Agent SDK
    // Extended thinking is enabled by default (thinking !== false)
    const thinkingEnabled = options?.thinking !== false;
    const queryIterator = query({
      prompt,
      options: {
        cwd: "/workspace",
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
        ],
        abortController,
        // Resume session if we have a previous SDK session ID
        resume: session.sdkSessionId,
        // Use Claude Code system prompt
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
        },
        // Load project settings (CLAUDE.md files)
        settingSources: ["project"],
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

    // Track current assistant message for updates
    let currentAssistantMessage: NormalizedMessage | null = null;

    // Tool tracker persists across all messages in this turn
    const toolTracker = new ToolTracker();

    // Track accumulated text and thinking parts
    let accumulatedTextParts: NormalizedPart[] = [];
    let accumulatedThinkingParts: NormalizedPart[] = [];

    // Process the async generator
    for await (const message of queryIterator) {
      if (abortController.signal.aborted) {
        break;
      }

      // Handle different message types from SDK
      if (message.type === "system" && message.subtype === "init") {
        // Store the SDK session ID for resume functionality
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sdkSessionId = (message as any).session_id;
        if (sdkSessionId) {
          session.sdkSessionId = sdkSessionId;
          console.log("[session-manager] Session initialized, stored SDK session ID:", sdkSessionId);
        }
      } else if (message.type === "assistant") {
        // Assistant message - parse content and register tools with tracker
        const { content, textParts, thinkingParts } = parseMessageContent(message, toolTracker);

        // Update accumulated parts (replace, don't append - SDK sends full content each time)
        accumulatedTextParts = textParts;
        if (thinkingParts.length > 0) {
          accumulatedThinkingParts = thinkingParts;
        }

        // Build final parts: thinking → tools → text
        const finalParts = buildMessageParts(accumulatedThinkingParts, toolTracker, accumulatedTextParts);

        if (!currentAssistantMessage) {
          currentAssistantMessage = {
            id: message.uuid || generateMessageId(),
            role: "assistant",
            content,
            parts: finalParts,
            timestamp: new Date().toISOString(),
          };
          session.messages.push(currentAssistantMessage);
        } else {
          currentAssistantMessage.content = content;
          currentAssistantMessage.parts = finalParts;
        }

        eventEmitter.emit({
          type: "message.updated",
          sessionId,
          data: { message: currentAssistantMessage },
        });
      } else if (message.type === "user") {
        // User message with tool results - parse to update tool tracker
        parseMessageContent(message, toolTracker);

        // Rebuild message parts with updated tool results
        if (currentAssistantMessage) {
          const finalParts = buildMessageParts(accumulatedThinkingParts, toolTracker, accumulatedTextParts);
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
          console.log("[session-manager] Query completed successfully");
        } else {
          console.error("[session-manager] Query error:", message.subtype);
          if ("errors" in message && message.errors) {
            session.error = message.errors.join("\n");
          }
        }
      } else if (message.type === "stream_event") {
        // Streaming partial message - could handle for real-time updates
        // For now, we rely on full assistant messages
      }

      // Check for AskUserQuestion tool in assistant messages
      // This would require inspecting tool_use blocks
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const msgContent = (message as any).message?.content || [];
      for (const block of msgContent) {
        if (block.type === "tool_use" && block.name === "AskUserQuestion") {
          // Extract question info
          const questionRequest: QuestionRequest = {
            id: block.id || generateMessageId(),
            sessionId,
            questions: block.input?.questions || [],
            toolUseId: block.id,
          };

          pendingQuestions.set(questionRequest.id, questionRequest);

          eventEmitter.emit({
            type: "question.asked",
            sessionId,
            data: questionRequest,
          });

          // Wait for answer (this would need to be handled differently
          // in a real implementation with proper async handling)
        }
      }
    }

    session.status = "idle";
    session.abortController = undefined;

    eventEmitter.emit({
      type: "session.idle",
      sessionId,
      data: { success: true },
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
 * Get available models from the Claude Agent SDK
 * The supportedModels() method is available on the Query object returned by query()
 */
export async function getAvailableModels(): Promise<Array<{
  id: string;
  name: string;
  description?: string;
}>> {
  try {
    // Create a query object to access supportedModels()
    // We use maxTurns: 0 to prevent any actual processing
    const q = query({
      prompt: "",
      options: {
        maxTurns: 0,
        cwd: "/workspace",
      },
    });

    // Get supported models from the query object
    const models = await q.supportedModels();

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

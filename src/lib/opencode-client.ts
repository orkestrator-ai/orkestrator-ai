// OpenCode SDK client wrapper
// Provides typed functions for interacting with the OpenCode server

import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2/client";

export { type OpencodeClient };

const PREFERRED_VARIANT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface OpenCodeModel {
  id: string;
  name: string;
  provider: string;
  /** Available model variants (e.g., low/high/xhigh) */
  variants?: string[];
  /** Input cost per token (0 means free) */
  inputCost?: number;
  /** Output cost per token (0 means free) */
  outputCost?: number;
}

/** Diff metadata for edit tool operations */
export interface ToolDiffMetadata {
  /** File path that was edited */
  filePath?: string;
  /** Number of lines added */
  additions?: number;
  /** Number of lines removed */
  deletions?: number;
  /** Content before the edit (for diff view) */
  before?: string;
  /** Content after the edit (for diff view) */
  after?: string;
  /** Unified diff string (from metadata.diff) */
  diff?: string;
}

/** Part types for OpenCode messages */
export interface OpenCodeMessagePart {
  type: "text" | "thinking" | "tool-invocation" | "tool-result" | "file";
  content: string;
  /** For tool invocations - the tool name */
  toolName?: string;
  /** For tool invocations - the tool arguments */
  toolArgs?: Record<string, unknown>;
  /** For tool results - success/failure state */
  toolState?: "success" | "failure" | "pending";
  /** For tool invocations - human-readable title/description */
  toolTitle?: string;
  /** For tool invocations - the output/result when completed */
  toolOutput?: string;
  /** For tool invocations - the error message when failed */
  toolError?: string;
  /** For edit tools - diff metadata */
  toolDiff?: ToolDiffMetadata;
}

export interface OpenCodeMessage {
  id: string;
  role: "user" | "assistant";
  /** Raw text content (for backwards compatibility) */
  content: string;
  /** Structured parts with type information */
  parts: OpenCodeMessagePart[];
  createdAt: string;
}

export interface OpenCodeSession {
  id: string;
  title?: string;
  createdAt: string;
}

/** OpenCode conversation mode */
export type OpenCodeConversationMode = "plan" | "build";

/** Question option for multiple choice questions */
export interface QuestionOption {
  /** Display text (1-5 words, concise) */
  label: string;
  /** Longer description explaining the option */
  description?: string;
}

/** Question info structure */
export interface QuestionInfo {
  /** Complete question text */
  question: string;
  /** Very short label (max 12 chars) */
  header: string;
  /** Available choices */
  options: QuestionOption[];
  /** Allow selecting multiple choices */
  multiple?: boolean;
  /** Allow typing a custom answer (default: true) */
  custom?: boolean;
}

/** Question request from OpenCode */
export interface QuestionRequest {
  /** Request ID */
  id: string;
  /** Session ID */
  sessionID: string;
  /** Questions to ask */
  questions: QuestionInfo[];
  /** Associated tool info */
  tool?: {
    messageID: string;
    callID: string;
  };
}

/** Answer to a question (array of selected labels or typed text) */
export type QuestionAnswer = string[];

/** Prefix for client-side error message IDs (used to preserve errors across message refreshes) */
export const ERROR_MESSAGE_PREFIX = "error-";

/** Structure for filediff metadata from the SDK */
interface FileDiffMetadata {
  file?: string;
  before?: string;
  after?: string;
}

/**
 * Create an OpenCode SDK client connected to a server
 */
export function createClient(baseUrl: string): OpencodeClient {
  return createOpencodeClient({
    baseUrl,
  });
}

/**
 * Get available models/providers from the server
 */
export async function getModels(client: OpencodeClient): Promise<OpenCodeModel[]> {
  try {
    // Use config.providers() to get the list of configured providers and models
    const response = await client.config.providers();

    if (!response.data) return [];

    const models: OpenCodeModel[] = [];

    // Response structure: { providers: Provider[], default: {...} }
    // Each Provider has: { id, name, models: { [modelId]: Model } }
    // Each Model has: { id, name, providerID, ... }
    const providers = response.data.providers || [];
    for (const provider of providers) {
      if (provider && provider.id && provider.models) {
        // models is an object map, not an array
        for (const model of Object.values(provider.models)) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const m = model as any;
          // Cost fields may be in cost.input/cost.output or directly as inputCost/outputCost
          const inputCost = m.cost?.input ?? m.inputCost ?? m.input_cost;
          const outputCost = m.cost?.output ?? m.outputCost ?? m.output_cost;

          // Variants are provider/model specific (e.g. low/high/xhigh)
          // Response shape: variants: { [variantName]: { disabled?: boolean, ... } }
          const variantEntries = m.variants && typeof m.variants === "object"
            ? Object.entries(m.variants as Record<string, { disabled?: boolean }>)
            : [];

          const variants = variantEntries
            .filter(([, variantConfig]) => {
              if (!variantConfig || typeof variantConfig !== "object") return true;
              return variantConfig.disabled !== true;
            })
            .map(([variantName]) => variantName)
            .sort((a, b) => {
              const aIndex = PREFERRED_VARIANT_ORDER.indexOf(a);
              const bIndex = PREFERRED_VARIANT_ORDER.indexOf(b);

              if (aIndex >= 0 && bIndex >= 0) return aIndex - bIndex;
              if (aIndex >= 0) return -1;
              if (bIndex >= 0) return 1;

              return a.localeCompare(b);
            });

          models.push({
            id: `${provider.id}/${model.id}`,
            name: model.name || model.id,
            provider: provider.id,
            variants: variants.length > 0 ? variants : undefined,
            inputCost: typeof inputCost === "number" ? inputCost : undefined,
            outputCost: typeof outputCost === "number" ? outputCost : undefined,
          });
        }
      }
    }

    return models;
  } catch (error) {
    console.error("[opencode-client] Failed to get models:", error);
    return [];
  }
}

/**
 * Create a new chat session
 */
export async function createSession(
  client: OpencodeClient,
  title?: string
): Promise<OpenCodeSession | null> {
  try {
    const response = await client.session.create({
      title,
    });

    if (!response.data) return null;

    const createdTime = response.data.time?.created;
    const createdAt = typeof createdTime === "number"
      ? new Date(createdTime).toISOString()
      : createdTime || new Date().toISOString();

    return {
      id: response.data.id,
      title: response.data.title,
      createdAt,
    };
  } catch (error) {
    console.error("[opencode-client] Failed to create session:", error);
    return null;
  }
}

/**
 * Get messages for a session
 */
export async function getSessionMessages(
  client: OpencodeClient,
  sessionId: string
): Promise<OpenCodeMessage[]> {
  try {
    const response = await client.session.messages({
      sessionID: sessionId,
    });

    if (!response.data) return [];

    return response.data.map((msg) => {
      const info = msg.info;
      const createdTime = info?.time?.created;
      const createdAt = typeof createdTime === "number"
        ? new Date(createdTime).toISOString()
        : createdTime || new Date().toISOString();

      // Parse parts with type information
      // SDK part types: text, file, reasoning, compaction, subtask, tool, step-start, step-finish, snapshot, patch, agent, retry
      const parsedParts: OpenCodeMessagePart[] = [];
      let textContent = "";

      if (msg.parts) {
        for (const part of msg.parts) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const p = part as any;
          const partType = p.type;

          // REASONING: type === "reasoning" (from SDK ReasoningPart)
          // These have: id, sessionID, messageID, type, text, time: { start, end? }
          if (partType === "reasoning") {
            const reasoningContent = p.text || "";
            if (reasoningContent) {
              parsedParts.push({
                type: "thinking",
                content: reasoningContent,
              });
            }
          }
          // TEXT: type === "text" (from SDK TextPart)
          // These have: id, sessionID, messageID, type, text, time? (optional)
          else if (partType === "text" && typeof p.text === "string") {
            parsedParts.push({
              type: "text",
              content: p.text,
            });
            textContent += p.text;
          }
          // TOOL: type === "tool" (from SDK ToolPart)
          // These have: id, sessionID, messageID, type, callID, tool (string!), state: { status, input, title?, output?, error?, ... }
          else if (partType === "tool") {
            const toolName = typeof p.tool === "string" ? p.tool : "Unknown tool";
            const toolStatus = p.state?.status;

            // Map SDK status to our state type
            let mappedState: "success" | "failure" | "pending" | undefined;
            if (toolStatus === "completed") mappedState = "success";
            else if (toolStatus === "error") mappedState = "failure";
            else if (toolStatus === "pending" || toolStatus === "running") mappedState = "pending";

            // Extract additional fields from ToolState
            // title: available in ToolStateRunning and ToolStateCompleted
            // output: available in ToolStateCompleted
            // error: available in ToolStateError
            const toolTitle = p.state?.title as string | undefined;
            // Get output - try direct access always since status might vary
            // According to SDK types, output is in ToolStateCompleted when status === "completed"
            // But let's also try direct access as fallback
            let toolOutput: string | undefined;
            if (p.state?.output && typeof p.state.output === "string") {
              toolOutput = p.state.output;
            }
            const toolError = p.state?.error as string | undefined;

            // Extract diff metadata for edit tools
            // The metadata may contain file info and diff stats
            let toolDiff: import("./opencode-client").ToolDiffMetadata | undefined;
            const isEditTool = toolName === "edit" || toolName === "Edit" || toolName === "write" || toolName === "Write";

            if (isEditTool) {
              const input = p.state?.input || {};
              const meta = p.state?.metadata || {};

              // The SDK uses camelCase property names: filePath, oldString, newString
              // Get filediff metadata if available
              const filediff = meta.filediff as FileDiffMetadata | undefined;

              // Get file path - check camelCase first (SDK standard), then snake_case fallback
              const filePath = (input.filePath || input.file_path || input.path || input.file ||
                meta.file || meta.filePath || filediff?.file) as string | undefined;

              // Get oldString and newString from input (SDK uses camelCase)
              const oldString = typeof input.oldString === "string" ? input.oldString :
                typeof input.old_string === "string" ? input.old_string : undefined;
              const newString = typeof input.newString === "string" ? input.newString :
                typeof input.new_string === "string" ? input.new_string : undefined;
              const metaBefore = typeof filediff?.before === "string" ? filediff.before : undefined;
              const metaAfter = typeof filediff?.after === "string" ? filediff.after : undefined;

              // The metadata.diff contains the full unified diff string
              const unifiedDiff = typeof meta.diff === "string" ? meta.diff : undefined;

              // Use oldString/newString first, fall back to filediff before/after
              const beforeValue = oldString ?? metaBefore;
              const afterValue = newString ?? metaAfter;

              // Calculate additions/deletions
              let additions: number | undefined;
              let deletions: number | undefined;

              // Try to count from unified diff first (most accurate)
              if (unifiedDiff) {
                let addCount = 0;
                let delCount = 0;
                const lines = unifiedDiff.split("\n");
                for (const line of lines) {
                  if (line.startsWith("+") && !line.startsWith("+++")) addCount++;
                  else if (line.startsWith("-") && !line.startsWith("---")) delCount++;
                }
                additions = addCount;
                deletions = delCount;
              } else if (beforeValue !== undefined || afterValue !== undefined) {
                // Fall back to counting from before/after
                const oldLines = beforeValue ? beforeValue.split("\n").length : 0;
                const newLines = afterValue ? afterValue.split("\n").length : 0;
                if (beforeValue && afterValue) {
                  deletions = oldLines;
                  additions = newLines;
                } else if (afterValue) {
                  additions = newLines;
                  deletions = 0;
                } else if (beforeValue) {
                  additions = 0;
                  deletions = oldLines;
                }
              }

              toolDiff = {
                filePath,
                additions,
                deletions,
                before: beforeValue,
                after: afterValue,
                diff: unifiedDiff,
              };
            }

            parsedParts.push({
              type: "tool-invocation",
              content: toolName,
              toolName: toolName,
              toolArgs: p.state?.input,
              toolState: mappedState,
              toolDiff,
              toolTitle,
              toolOutput,
              toolError,
            });
          }
          // FILE: type === "file" (from SDK FilePart)
          // These have: id, sessionID, messageID, type, mime, filename?, url, source?
          else if (partType === "file") {
            const filePath = p.filename || p.url || "";
            parsedParts.push({
              type: "file",
              content: filePath,
            });
          }
          // SKIP: Internal/control parts that we don't need to display
          // Includes: step-start, step-finish, compaction, snapshot, patch, agent, retry, subtask
          // Any unrecognized part types are also silently ignored
        }
      }

      return {
        id: info?.id || crypto.randomUUID(),
        role: (info?.role as "user" | "assistant") || "assistant",
        content: textContent,
        parts: parsedParts,
        createdAt,
      };
    });
  } catch (error) {
    console.error("[opencode-client] Failed to get messages:", error);
    return [];
  }
}

/** Attachment input for sendPrompt */
export interface PromptAttachment {
  type: "file" | "image";
  path: string;
  /** Data URL for the content (e.g., base64 encoded image) */
  dataUrl?: string;
  /** Original filename */
  filename?: string;
}

/**
 * Send a prompt to a session
 */
export async function sendPrompt(
  client: OpencodeClient,
  sessionId: string,
  message: string,
  options?: {
    model?: string;
    variant?: string;
    mode?: OpenCodeConversationMode;
    attachments?: PromptAttachment[];
  }
): Promise<boolean> {
  try {
    // Build the parts array with proper typing
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parts: any[] = [
      { type: "text" as const, text: message },
    ];

    if (options?.attachments) {
      for (const attachment of options.attachments) {
        // SDK FilePartInput requires: type, mime, url
        // Determine MIME type based on attachment type and filename
        let mime = "application/octet-stream";
        if (attachment.type === "image") {
          mime = "image/png"; // Default for clipboard images
          if (attachment.filename?.endsWith(".jpg") || attachment.filename?.endsWith(".jpeg")) {
            mime = "image/jpeg";
          } else if (attachment.filename?.endsWith(".gif")) {
            mime = "image/gif";
          } else if (attachment.filename?.endsWith(".webp")) {
            mime = "image/webp";
          }
        } else if (attachment.filename) {
          // Try to infer MIME type from filename for files
          const ext = attachment.filename.split(".").pop()?.toLowerCase();
          if (ext === "txt") mime = "text/plain";
          else if (ext === "json") mime = "application/json";
          else if (ext === "js" || ext === "mjs") mime = "text/javascript";
          else if (ext === "ts" || ext === "tsx") mime = "text/typescript";
          else if (ext === "md") mime = "text/markdown";
          else if (ext === "html") mime = "text/html";
          else if (ext === "css") mime = "text/css";
          else if (ext === "py") mime = "text/x-python";
          else if (ext === "rs") mime = "text/x-rust";
        }

        // Use data URL if available, otherwise construct file:// URL
        const url = attachment.dataUrl || `file://${attachment.path}`;

        parts.push({
          type: "file" as const,
          mime,
          url,
          filename: attachment.filename,
        });
      }
    }

    await client.session.promptAsync({
      sessionID: sessionId,
      parts,
      model: options?.model ? {
        providerID: options.model.split("/")[0] || "",
        modelID: options.model.split("/")[1] || options.model,
      } : undefined,
      variant: options?.variant,
    });

    return true;
  } catch (error) {
    console.error("[opencode-client] Failed to send prompt:", error);
    return false;
  }
}

/** Event types from OpenCode SSE stream */
export interface OpenCodeEvent {
  type: "message.updated" | "session.updated" | "session.error" | "file.edited" | "file.watcher.updated" | "question.asked" | "question.replied" | "question.rejected" | string;
  properties?: {
    sessionID?: string;
    info?: {
      id?: string;
      role?: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [key: string]: any;
    };
    error?: string;
    /** For question.asked events - the question request */
    id?: string;
    questions?: QuestionInfo[];
    tool?: {
      messageID: string;
      callID: string;
    };
    /** For question.replied events */
    requestID?: string;
    answers?: QuestionAnswer[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
  };
}

/**
 * Subscribe to events from the server
 * Returns an async iterator for SSE events
 */
export async function subscribeToEvents(client: OpencodeClient): Promise<AsyncIterable<OpenCodeEvent> | null> {
  try {
    // event.subscribe() returns { stream: AsyncGenerator }
    const response = await client.event.subscribe();

    // The response has a stream property that is the async generator
    if (response && "stream" in response) {
      return response.stream as AsyncIterable<OpenCodeEvent>;
    }

    // Fallback - try to iterate the response directly
    if (response && Symbol.asyncIterator in Object(response)) {
      return response as unknown as AsyncIterable<OpenCodeEvent>;
    }

    return null;
  } catch (error) {
    console.error("[opencode-client] Failed to subscribe to events:", error);
    return null;
  }
}

/**
 * Get list of existing sessions
 */
export async function listSessions(client: OpencodeClient): Promise<OpenCodeSession[]> {
  try {
    const response = await client.session.list();
    if (!response.data) return [];

    return response.data.map((session): OpenCodeSession => {
      const createdTime = session.time?.created;
      const createdAt: string = typeof createdTime === "number"
        ? new Date(createdTime).toISOString()
        : createdTime || new Date().toISOString();

      return {
        id: session.id,
        title: session.title,
        createdAt,
      };
    });
  } catch (error) {
    console.error("[opencode-client] Failed to list sessions:", error);
    throw error instanceof Error
      ? error
      : new Error("Failed to list OpenCode sessions");
  }
}

/**
 * Delete a session
 */
export async function deleteSession(client: OpencodeClient, sessionId: string): Promise<boolean> {
  try {
    await client.session.delete({
      sessionID: sessionId,
    });
    return true;
  } catch (error) {
    console.error("[opencode-client] Failed to delete session:", error);
    return false;
  }
}

/**
 * Abort a running session/prompt
 */
export async function abortSession(client: OpencodeClient, sessionId: string): Promise<boolean> {
  try {
    await client.session.abort({
      sessionID: sessionId,
    });
    return true;
  } catch (error) {
    console.error("[opencode-client] Failed to abort session:", error);
    return false;
  }
}

/**
 * Get pending question requests
 */
export async function getPendingQuestions(client: OpencodeClient): Promise<QuestionRequest[]> {
  try {
    const response = await client.question.list();
    if (!response.data) return [];
    return response.data as QuestionRequest[];
  } catch (error) {
    console.error("[opencode-client] Failed to get pending questions:", error);
    return [];
  }
}

/**
 * Reply to a question request
 * @param client The SDK client
 * @param requestId The question request ID
 * @param answers Array of answers (each answer is an array of selected option labels or typed text)
 */
export async function replyToQuestion(
  client: OpencodeClient,
  requestId: string,
  answers: QuestionAnswer[]
): Promise<boolean> {
  try {
    await client.question.reply({
      requestID: requestId,
      answers,
    });
    return true;
  } catch (error) {
    console.error("[opencode-client] Failed to reply to question:", error);
    return false;
  }
}

/**
 * Reject/dismiss a question request
 */
export async function rejectQuestion(
  client: OpencodeClient,
  requestId: string
): Promise<boolean> {
  try {
    await client.question.reject({
      requestID: requestId,
    });
    return true;
  } catch (error) {
    console.error("[opencode-client] Failed to reject question:", error);
    return false;
  }
}

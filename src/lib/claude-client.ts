// Claude Bridge Server client wrapper
// Provides typed functions for interacting with the Claude bridge server

/** Diff metadata for edit tool operations */
export interface ToolDiffMetadata {
  filePath?: string;
  additions?: number;
  deletions?: number;
  before?: string;
  after?: string;
  diff?: string;
}

/** Part types for Claude messages */
export interface ClaudeMessagePart {
  type: "text" | "thinking" | "tool-invocation" | "tool-result" | "file";
  content?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolState?: "success" | "failure" | "pending";
  toolTitle?: string;
  toolOutput?: string;
  toolError?: string;
  toolDiff?: ToolDiffMetadata;
}

export interface ClaudeMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  parts: ClaudeMessagePart[];
  timestamp: string;
}

export interface ClaudeModel {
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
export interface ClaudeQuestionRequest {
  id: string;
  sessionId: string;
  questions: QuestionInfo[];
  toolUseId?: string;
}

/** SSE event from Claude bridge server */
export interface ClaudeEvent {
  type:
    | "connected"
    | "keepalive"
    | "session.updated"
    | "session.idle"
    | "session.error"
    | "message.updated"
    | "question.asked"
    | "question.answered";
  sessionId?: string;
  data?: unknown;
}

/** Attachment for prompts */
export interface ClaudeAttachment {
  type: "file" | "image";
  path: string;
  dataUrl?: string;
  filename?: string;
}

/** Prefix for client-side error message IDs */
export const ERROR_MESSAGE_PREFIX = "error-";

/** Claude Bridge Client */
export interface ClaudeClient {
  baseUrl: string;
}

/**
 * Create a Claude bridge client
 */
export function createClient(baseUrl: string): ClaudeClient {
  return { baseUrl };
}

/**
 * Check server health
 */
export async function checkHealth(client: ClaudeClient): Promise<boolean> {
  try {
    const response = await fetch(`${client.baseUrl}/global/health`);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Get available models
 */
export async function getModels(client: ClaudeClient): Promise<ClaudeModel[]> {
  try {
    const response = await fetch(`${client.baseUrl}/config/models`);
    if (!response.ok) return [];
    const data = await response.json();
    return data.models || [];
  } catch (error) {
    console.error("[claude-client] Failed to get models:", error);
    return [];
  }
}

/**
 * Create a new session
 */
export async function createSession(
  client: ClaudeClient,
  title?: string
): Promise<{ sessionId: string; title?: string } | null> {
  try {
    const response = await fetch(`${client.baseUrl}/session/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    console.error("[claude-client] Failed to create session:", error);
    return null;
  }
}

/**
 * List all sessions
 */
export async function listSessions(
  client: ClaudeClient
): Promise<
  Array<{
    id: string;
    title?: string;
    status: "idle" | "running" | "error";
    createdAt: string;
    lastActivity: string;
  }>
> {
  try {
    const response = await fetch(`${client.baseUrl}/session/list`);
    if (!response.ok) return [];
    const data = await response.json();
    return data.sessions || [];
  } catch (error) {
    console.error("[claude-client] Failed to list sessions:", error);
    return [];
  }
}

/**
 * Get session details
 */
export async function getSession(
  client: ClaudeClient,
  sessionId: string
): Promise<{
  id: string;
  title?: string;
  status: "idle" | "running" | "error";
  createdAt: string;
  lastActivity: string;
  error?: string;
} | null> {
  try {
    const response = await fetch(`${client.baseUrl}/session/${sessionId}`);
    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    console.error("[claude-client] Failed to get session:", error);
    return null;
  }
}

/**
 * Get messages for a session
 */
export async function getSessionMessages(
  client: ClaudeClient,
  sessionId: string
): Promise<ClaudeMessage[]> {
  try {
    const response = await fetch(`${client.baseUrl}/session/${sessionId}/messages`);
    if (!response.ok) return [];
    const data = await response.json();
    return data.messages || [];
  } catch (error) {
    console.error("[claude-client] Failed to get messages:", error);
    return [];
  }
}

/**
 * Send a prompt to a session (async - returns immediately, results via SSE)
 */
export async function sendPrompt(
  client: ClaudeClient,
  sessionId: string,
  prompt: string,
  options?: {
    model?: string;
    attachments?: ClaudeAttachment[];
    thinking?: boolean;
  }
): Promise<boolean> {
  try {
    const response = await fetch(`${client.baseUrl}/session/${sessionId}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        model: options?.model,
        attachments: options?.attachments,
        thinking: options?.thinking,
      }),
    });
    return response.ok;
  } catch (error) {
    console.error("[claude-client] Failed to send prompt:", error);
    return false;
  }
}

/**
 * Abort a running session
 */
export async function abortSession(
  client: ClaudeClient,
  sessionId: string
): Promise<boolean> {
  try {
    const response = await fetch(`${client.baseUrl}/session/${sessionId}/abort`, {
      method: "POST",
    });
    return response.ok;
  } catch (error) {
    console.error("[claude-client] Failed to abort session:", error);
    return false;
  }
}

/**
 * Delete a session
 */
export async function deleteSession(
  client: ClaudeClient,
  sessionId: string
): Promise<boolean> {
  try {
    const response = await fetch(`${client.baseUrl}/session/${sessionId}`, {
      method: "DELETE",
    });
    return response.ok;
  } catch (error) {
    console.error("[claude-client] Failed to delete session:", error);
    return false;
  }
}

/**
 * Get pending questions for a session
 */
export async function getPendingQuestions(
  client: ClaudeClient,
  sessionId: string
): Promise<ClaudeQuestionRequest[]> {
  try {
    const response = await fetch(`${client.baseUrl}/session/${sessionId}/questions`);
    if (!response.ok) return [];
    const data = await response.json();
    return data.questions || [];
  } catch (error) {
    console.error("[claude-client] Failed to get pending questions:", error);
    return [];
  }
}

/**
 * Answer a question
 */
export async function answerQuestion(
  client: ClaudeClient,
  sessionId: string,
  questionId: string,
  answers: string[][]
): Promise<boolean> {
  try {
    const response = await fetch(
      `${client.baseUrl}/session/${sessionId}/questions/${questionId}/answer`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers }),
      }
    );
    return response.ok;
  } catch (error) {
    console.error("[claude-client] Failed to answer question:", error);
    return false;
  }
}

/**
 * Subscribe to SSE events from the server
 * Returns an async iterator for events
 */
export function subscribeToEvents(
  client: ClaudeClient,
  signal?: AbortSignal
): AsyncIterable<ClaudeEvent> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<ClaudeEvent> {
      let eventSource: EventSource | null = null;
      let resolver: ((value: IteratorResult<ClaudeEvent>) => void) | null = null;
      let rejecter: ((error: Error) => void) | null = null;
      const eventQueue: ClaudeEvent[] = [];
      let done = false;

      const handleEvent = (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data);
          const claudeEvent: ClaudeEvent = {
            type: event.type as ClaudeEvent["type"],
            sessionId: data.sessionId,
            data,
          };

          if (resolver) {
            resolver({ value: claudeEvent, done: false });
            resolver = null;
            rejecter = null;
          } else {
            eventQueue.push(claudeEvent);
          }
        } catch (error) {
          console.error("[claude-client] Failed to parse SSE event:", error);
        }
      };

      const cleanup = () => {
        done = true;
        if (eventSource) {
          eventSource.close();
          eventSource = null;
        }
        if (resolver) {
          resolver({ value: undefined as unknown as ClaudeEvent, done: true });
        }
      };

      // Handle abort signal
      signal?.addEventListener("abort", cleanup);

      // Create EventSource
      eventSource = new EventSource(`${client.baseUrl}/event/subscribe`);

      // Listen for different event types
      const eventTypes = [
        "connected",
        "keepalive",
        "session.updated",
        "session.idle",
        "session.error",
        "message.updated",
        "question.asked",
        "question.answered",
      ];

      for (const eventType of eventTypes) {
        eventSource.addEventListener(eventType, handleEvent);
      }

      eventSource.onerror = () => {
        if (rejecter && !done) {
          rejecter(new Error("SSE connection error"));
          resolver = null;
          rejecter = null;
        }
        cleanup();
      };

      return {
        next(): Promise<IteratorResult<ClaudeEvent>> {
          if (done) {
            return Promise.resolve({ value: undefined as unknown as ClaudeEvent, done: true });
          }

          // If we have queued events, return one
          if (eventQueue.length > 0) {
            return Promise.resolve({ value: eventQueue.shift()!, done: false });
          }

          // Wait for next event
          return new Promise((resolve, reject) => {
            resolver = resolve;
            rejecter = reject;
          });
        },

        return(): Promise<IteratorResult<ClaudeEvent>> {
          cleanup();
          return Promise.resolve({ value: undefined as unknown as ClaudeEvent, done: true });
        },

        throw(error: Error): Promise<IteratorResult<ClaudeEvent>> {
          cleanup();
          return Promise.reject(error);
        },
      };
    },
  };
}

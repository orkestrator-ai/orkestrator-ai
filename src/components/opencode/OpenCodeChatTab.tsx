import { useEffect, useRef, useCallback, useState, useMemo } from "react";
import { Loader2, AlertCircle, RefreshCw, ArrowDown, History } from "lucide-react";
import { useScrollLock } from "@/hooks";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useOpenCodeStore, createOpenCodeSessionKey } from "@/stores/openCodeStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { useClaudeActivityStore } from "@/stores/claudeActivityStore";
import {
  createClient,
  getModels,
  createSession,
  getSessionMessages,
  sendPrompt,
  subscribeToEvents,
  ERROR_MESSAGE_PREFIX,
  type QuestionRequest,
} from "@/lib/opencode-client";
import {
  startOpenCodeServer,
  getOpenCodeServerStatus,
  getOpenCodeServerLog,
  startLocalOpencodeServer,
  getLocalOpencodeServerStatus,
} from "@/lib/tauri";
import { OpenCodeMessage } from "./OpenCodeMessage";
import { OpenCodeComposeBar } from "./OpenCodeComposeBar";
import { OpenCodeQuestionCard } from "./OpenCodeQuestionCard";
import { OpenCodeResumeSessionDialog } from "./OpenCodeResumeSessionDialog";
import type { OpenCodeNativeData } from "@/types/paneLayout";
import type { OpenCodeAttachment } from "@/stores/openCodeStore";

interface OpenCodeChatTabProps {
  tabId: string;
  data: OpenCodeNativeData;
  isActive: boolean;
  /** Initial prompt to send after session creation */
  initialPrompt?: string;
}

type ConnectionState = "connecting" | "connected" | "error";

export function OpenCodeChatTab({ tabId, data, isActive, initialPrompt }: OpenCodeChatTabProps) {
  const { containerId, environmentId, isLocal } = data;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [serverLog, setServerLog] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [resumeDialogOpen, setResumeDialogOpen] = useState(false);

  // Track this tab's session ID locally to prevent interference between tabs
  const tabSessionIdRef = useRef<string | null>(null);
  // Track if this tab has been initialized (to differentiate first mount vs re-activation)
  const isInitializedRef = useRef(false);
  // Track if initial prompt has been sent (to prevent duplicate sends)
  const initialPromptSentRef = useRef(false);
  // Ref to store handleSend for use in effects without causing re-runs
  const handleSendRef = useRef<((text: string, attachments: OpenCodeAttachment[]) => Promise<void>) | null>(null);

  const {
    setClient,
    models,
    setModels,
    setSession,
    addMessage,
    setMessages,
    setSessionLoading,
    setServerStatus,
    getSelectedModel,
    getSelectedVariant,
    getSelectedMode,
    addPendingQuestion,
    removePendingQuestion,
    // Event subscription management (shared per environment)
    getOrCreateEventSubscription,
    setEventStream,
    hasActiveEventSubscription,
    // Subscribe to Maps directly for proper reactivity (triggers re-render on changes)
    clients: clientsMap,
    sessions: sessionsMap,
    pendingQuestions: pendingQuestionsMap,
  } = useOpenCodeStore();

  // Activity state tracking - use environmentId as key for both local and container environments
  // Use reference counting to handle multiple tabs for the same environment
  const { setContainerState, incrementContainerRef, decrementContainerRef } = useClaudeActivityStore();
  const { clearTabInitialPrompt } = usePaneLayoutStore();

  // Create a unique session key that combines environmentId and tabId
  // This prevents session collisions when multiple environments use the same tab IDs (e.g., "default")
  const sessionKey = useMemo(() => createOpenCodeSessionKey(environmentId, tabId), [environmentId, tabId]);

  // Get client from Map (shared per environment) - subscribing to the Map ensures re-render on changes
  const client = useMemo(() => clientsMap.get(environmentId), [clientsMap, environmentId]);
  // Get session from Map keyed by sessionKey (each tab has its own session, scoped by environment)
  const session = useMemo(() => sessionsMap.get(sessionKey), [sessionsMap, sessionKey]);

  // Scroll lock - auto-scroll only when user is at bottom
  const { isAtBottom, scrollToBottom } = useScrollLock(scrollRef, {
    scrollTrigger: session?.messages,
  });

  // Get pending questions for this session - subscribe to the Map for reactivity
  const pendingQuestions = useMemo(() => {
    if (!session?.sessionId) return [];
    const questions: QuestionRequest[] = [];
    for (const question of pendingQuestionsMap.values()) {
      if (question.sessionID === session.sessionId) {
        questions.push(question);
      }
    }
    return questions;
  }, [session?.sessionId, pendingQuestionsMap]);

  // Track OpenCode activity state based on session loading - update the environment icon in sidebar
  // For native mode, we use environmentId as the key (works for both local and containerized)
  useEffect(() => {
    if (connectionState !== "connected") {
      // Not connected yet, show idle
      setContainerState(environmentId, "idle");
      return;
    }

    if (session?.isLoading) {
      // OpenCode is working on a response
      setContainerState(environmentId, "working");
    } else if (pendingQuestions.length > 0) {
      // OpenCode is waiting for user input (question)
      setContainerState(environmentId, "waiting");
    } else {
      // OpenCode is idle
      setContainerState(environmentId, "idle");
    }
  }, [connectionState, session?.isLoading, pendingQuestions.length, environmentId, setContainerState]);

  // Track container reference count for activity state management
  // Increment on mount, decrement on unmount - state is only removed when last tab closes
  useEffect(() => {
    incrementContainerRef(environmentId);
    return () => {
      decrementContainerRef(environmentId);
    };
  }, [environmentId, incrementContainerRef, decrementContainerRef]);

  // Track last initialization time to prevent rapid re-initialization
  const lastInitTimeRef = useRef<number>(0);
  const INIT_DEBOUNCE_MS = 1000; // Don't re-initialize within 1 second

  // Initialize connection on mount
  useEffect(() => {
    if (!isActive) {
      return;
    }

    // Debounce rapid re-initialization
    const now = Date.now();
    const timeSinceLastInit = now - lastInitTimeRef.current;
    if (timeSinceLastInit < INIT_DEBOUNCE_MS && isInitializedRef.current) {
      return;
    }

    let mounted = true;

    async function initialize() {
      try {
        lastInitTimeRef.current = Date.now();
        setConnectionState("connecting");
        setErrorMessage(null);

        let hostPort: number | null = null;

        if (isLocal) {
          // Local environment - use local server commands
          let localStatus = await getLocalOpencodeServerStatus(environmentId);

          if (!localStatus.running) {
            const result = await startLocalOpencodeServer(environmentId);
            localStatus = { running: true, port: result.port, pid: result.pid };
          }

          if (!mounted) return;

          if (!localStatus.port) {
            throw new Error("Local server started but no port available");
          }

          hostPort = localStatus.port;
        } else {
          // Containerized environment - use container server commands
          if (!containerId) {
            throw new Error("Container ID is required for containerized environments");
          }

          let status = await getOpenCodeServerStatus(containerId);

          if (!status.running) {
            const result = await startOpenCodeServer(containerId);
            status = { running: true, hostPort: result.hostPort };
          }

          if (!mounted) return;

          if (!status.hostPort) {
            throw new Error("Server started but no port available");
          }

          hostPort = status.hostPort;
        }

        if (!hostPort) {
          throw new Error("Failed to get server port");
        }

        setServerStatus(environmentId, {
          running: true,
          hostPort: hostPort,
        });

        // Create SDK client (shared per environment)
        const baseUrl = `http://127.0.0.1:${hostPort}`;
        console.debug("[OpenCodeChatTab] OpenCode server running at:", baseUrl);
        const sdkClient = createClient(baseUrl);
        setClient(environmentId, sdkClient);

        // Fetch available models
        const availableModels = await getModels(sdkClient);
        if (!mounted) return;
        setModels(availableModels);

        // Check for existing session - first from component ref, then from Zustand store
        // This handles reconnection after tab remount where refs are lost but store persists
        const existingSessionFromRef = tabSessionIdRef.current;
        const existingSessionFromStore = useOpenCodeStore.getState().sessions.get(sessionKey);
        const existingSessionId = existingSessionFromRef || existingSessionFromStore?.sessionId;

        if (existingSessionId) {
          // Restore session from store - component may have remounted
          tabSessionIdRef.current = existingSessionId;
          isInitializedRef.current = true;
          setConnectionState("connected");

          // Start shared event subscription if not already running
          startSharedEventSubscription(sdkClient);

          // Refresh messages from server to ensure latest state on reconnection
          if (existingSessionFromStore) {
            try {
              const messages = await getSessionMessages(sdkClient, existingSessionId);
              if (!mounted) return;

              // setMessages preserves client-side error messages (ERROR_MESSAGE_PREFIX)
              // from the existing session state when replacing server messages.
              setMessages(sessionKey, messages);
            } catch (err) {
              console.warn("[OpenCodeChatTab] Failed to refresh messages on reconnect:", err);
              // Keep existing messages from store if refresh fails
            }
          } else {
            // Session exists in ref but not in store, restore minimal state
            setSession(sessionKey, {
              sessionId: existingSessionId,
              messages: [],
              isLoading: false,
            });
          }
        } else {
          // First initialization - create a new session
          const newSession = await createSession(sdkClient);
          if (!mounted) return;

          if (!newSession) {
            throw new Error("Failed to create session");
          }

          // Store the session ID in the ref for future re-activations
          tabSessionIdRef.current = newSession.id;
          isInitializedRef.current = true;

          setSession(sessionKey, {
            sessionId: newSession.id,
            messages: [],
            isLoading: false,
          });

          setConnectionState("connected");

          // Start shared event subscription if not already running
          startSharedEventSubscription(sdkClient);
        }
      } catch (error) {
        console.error("[OpenCodeChatTab] Initialization failed:", error);
        if (!mounted) return;
        setConnectionState("error");
        // Extract error message - Tauri errors come as strings
        let message = "Connection failed";
        if (error instanceof Error) {
          message = error.message;
        } else if (typeof error === "string") {
          message = error;
        } else if (error && typeof error === "object" && "message" in error) {
          message = String(error.message);
        }
        // Add hint for port mapping issues
        if (message.includes("port") && message.includes("not mapped")) {
          message += ". Try recreating the environment to enable native mode support.";
        }
        setErrorMessage(message);

        // Try to fetch server log for debugging if timeout error (only for containerized environments)
        if (message.includes("timeout") && !isLocal && containerId) {
          try {
            const log = await getOpenCodeServerLog(containerId);
            if (log) {
              setServerLog(log);
            }
          } catch (logError) {
            console.error("[OpenCodeChatTab] Failed to fetch server log:", logError);
          }
        }
      }
    }

    initialize();

    return () => {
      mounted = false;
      // NOTE: We do NOT close the event subscription here - it's shared per environment
      // The subscription will be closed when the environment is cleaned up
      // We also don't clear the client - it's shared per environment
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerId, environmentId, tabId, isActive, isLocal]);

  // Start shared event subscription for the environment (only if not already running)
  const startSharedEventSubscription = useCallback(
    async (sdkClient: ReturnType<typeof createClient>) => {
      // Check if there's already an active subscription for this environment
      if (hasActiveEventSubscription(environmentId)) {
        return;
      }

      // Get or create subscription state from store
      const subscriptionState = getOrCreateEventSubscription(environmentId);
      if (!subscriptionState) {
        return;
      }

      const { abortController } = subscriptionState;

      try {
        const eventStream = await subscribeToEvents(sdkClient);
        if (!eventStream || abortController.signal.aborted) {
          return;
        }

        // Store stream reference in the store for cleanup
        setEventStream(environmentId, eventStream);

        // Track last reload time to debounce rapid updates per session
        const lastReloadTimeBySession = new Map<string, number>();
        const DEBOUNCE_MS = 200; // Debounce all message fetches
        const pendingReloads = new Map<string, NodeJS.Timeout>(); // Track pending debounced reloads

        // Helper to fetch messages with debouncing
        // Note: sessionKey is the session key from the sessions Map (e.g., "env-{envId}:{tabId}")
        const fetchMessagesDebounced = (sessionId: string, sessionKey: string, immediate = false) => {
          // Clear any pending reload for this session
          const pendingTimeout = pendingReloads.get(sessionId);
          if (pendingTimeout) {
            clearTimeout(pendingTimeout);
            pendingReloads.delete(sessionId);
          }

          const doFetch = async () => {
            const now = Date.now();
            lastReloadTimeBySession.set(sessionId, now);
            const messages = await getSessionMessages(sdkClient, sessionId);
            setMessages(sessionKey, messages);
          };

          if (immediate) {
            // For final events (session.idle), fetch immediately
            doFetch();
          } else {
            // For streaming events, debounce
            const now = Date.now();
            const lastTime = lastReloadTimeBySession.get(sessionId) || 0;
            if (now - lastTime > DEBOUNCE_MS) {
              // Enough time has passed, fetch now
              doFetch();
            } else {
              // Schedule a fetch after debounce period
              const timeout = setTimeout(doFetch, DEBOUNCE_MS);
              pendingReloads.set(sessionId, timeout);
            }
          }
        };

        for await (const event of eventStream) {
          if (abortController.signal.aborted) {
            // Clean up pending reloads on abort
            for (const timeout of pendingReloads.values()) {
              clearTimeout(timeout);
            }
            break;
          }

          // Handle different event types based on OpenCode SDK
          const eventType = event?.type;
          // SessionID can be in different places depending on event type:
          // - session events: properties.sessionID
          // - message part events: properties.part.sessionID
          // - message events: properties.info?.sessionID
          // - session.updated events: properties.info?.id (the session ID itself)
          const props = event?.properties;
          const eventSessionId = props?.sessionID
            || props?.part?.sessionID
            || props?.info?.sessionID
            || props?.info?.id
            || props?.message?.sessionID
            || (event as any)?.sessionID;

          // Skip events we don't care about (heartbeats, etc)
          if (!eventSessionId && !["question.asked", "question.replied", "question.rejected"].includes(eventType || "")) {
            continue;
          }

          // Find the tab that has this session
          const sessions = useOpenCodeStore.getState().sessions;

          // Handle events for all sessions in this environment
          for (const [sessionTabId, sessionState] of sessions) {
            if (sessionState.sessionId !== eventSessionId) continue;

            // Determine if this is a "final" event that should trigger immediate refresh
            const isFinalEvent = eventType === "session.idle"
              || (eventType === "session.status" && props?.status?.type === "idle");

            // Events that should trigger message refresh
            if (eventType === "message.part.updated"
                || eventType === "message.updated"
                || eventType === "session.updated"
                || isFinalEvent) {
              fetchMessagesDebounced(eventSessionId, sessionTabId, isFinalEvent);
            }

            // Clear loading state on final events
            if (isFinalEvent) {
              setSessionLoading(sessionTabId, false);
            }

            // Handle errors
            if (eventType === "session.error") {
              console.error("[OpenCodeChatTab] Session error:", props?.error);
              setSessionLoading(sessionTabId, false);
              // Extract error message - convert object to string if needed
              const rawError = props?.error as unknown;
              let errorMsg: string;
              if (typeof rawError === "string") {
                errorMsg = rawError;
              } else if (rawError && typeof rawError === "object") {
                // Error might be nested: { name: "APIError", data: { errorType: "...", message: "..." } }
                const errObj = rawError as Record<string, unknown>;
                // Check for nested data object first (common API error structure)
                const dataObj = errObj.data as Record<string, unknown> | undefined;
                if (dataObj && typeof dataObj === "object") {
                  errorMsg = String(
                    dataObj.errorType || dataObj.error || dataObj.message || dataObj.detail ||
                    errObj.detail || errObj.message || errObj.name ||
                    JSON.stringify(rawError)
                  );
                } else {
                  errorMsg = String(
                    errObj.detail || errObj.message || errObj.error || errObj.errorType ||
                    errObj.name || JSON.stringify(rawError)
                  );
                }
              } else {
                errorMsg = "An unknown error occurred";
              }
              // Add error as a message with special ID prefix so it persists
              // The setMessages function preserves messages with ERROR_MESSAGE_PREFIX
              const errorMessage = {
                id: `${ERROR_MESSAGE_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2)}`,
                role: "assistant" as const,
                content: errorMsg,
                parts: [{ type: "text" as const, content: errorMsg }],
                createdAt: new Date().toISOString(),
              };
              addMessage(sessionTabId, errorMessage);
            }
          }

          // Handle question events (not session-specific, need to match by sessionID in the event)
          if (eventType === "question.asked") {
            const questionProps = event.properties;
            if (questionProps?.id && questionProps?.questions) {
              const questionRequest: QuestionRequest = {
                id: questionProps.id,
                sessionID: questionProps.sessionID || "",
                questions: questionProps.questions,
                tool: questionProps.tool,
              };
              addPendingQuestion(questionRequest);
            }
          }
          // Handle question replied events (remove the question)
          else if (eventType === "question.replied") {
            if (event.properties?.requestID) {
              removePendingQuestion(event.properties.requestID);
            }
          }
          // Handle question rejected events (remove the question)
          else if (eventType === "question.rejected") {
            if (event.properties?.requestID) {
              removePendingQuestion(event.properties.requestID);
            }
          }
        }
      } catch (error) {
        if (!abortController.signal.aborted) {
          console.error("[OpenCodeChatTab] Event subscription error:", error);
        }
      } finally {
        // Clear the stream reference when loop ends
        setEventStream(environmentId, null);
      }
    },
    [environmentId, hasActiveEventSubscription, getOrCreateEventSubscription, setEventStream, setMessages, setSessionLoading, addMessage, addPendingQuestion, removePendingQuestion]
  );

  // Handle sending a message
  const handleSend = useCallback(
    async (text: string, attachments: OpenCodeAttachment[]) => {
      if (!client || !session) return;

      const selectedModel = getSelectedModel(environmentId);
      const selectedVariant = getSelectedVariant(environmentId);
      const selectedMode = getSelectedMode(environmentId);

      // Add user message optimistically
      const userMessage = {
        id: crypto.randomUUID(),
        role: "user" as const,
        content: text,
        parts: [{ type: "text" as const, content: text }],
        createdAt: new Date().toISOString(),
      };
      addMessage(sessionKey, userMessage);
      setSessionLoading(sessionKey, true);

      // Convert attachments to SDK format (include dataUrl for proper MIME/URL handling)
      const sdkAttachments = attachments.map((att) => ({
        type: att.type,
        path: att.path,
        dataUrl: att.previewUrl, // Data URL for images
        filename: att.name,
      }));

      // Send prompt
      const success = await sendPrompt(client, session.sessionId, text, {
        model: selectedModel,
        variant: selectedVariant,
        mode: selectedMode,
        attachments: sdkAttachments.length > 0 ? sdkAttachments : undefined,
      });

      if (!success) {
        console.error("[OpenCodeChatTab] Failed to send prompt");
        setSessionLoading(sessionKey, false);
      }
      // Response will come via SSE events
    },
    [client, session, sessionKey, environmentId, getSelectedModel, getSelectedVariant, getSelectedMode, addMessage, setSessionLoading]
  );

  // Keep handleSendRef updated with the latest handleSend
  handleSendRef.current = handleSend;

  // Send initial prompt after session is ready (for code review, PR creation, etc.)
  useEffect(() => {
    const sessionHasMessages = !!session?.messages.length;

    if (
      connectionState === "connected" &&
      client &&
      session &&
      initialPrompt &&
      !initialPromptSentRef.current &&
      !sessionHasMessages
    ) {
      initialPromptSentRef.current = true;
      // Clear from pane state so it can't be re-sent after remount
      clearTabInitialPrompt(tabId, environmentId);
      console.debug("[OpenCodeChatTab] Sending initial prompt for tab:", tabId);
      // Use ref to avoid effect re-running when handleSend changes
      handleSendRef.current?.(initialPrompt, []);
    }
  }, [connectionState, client, session, initialPrompt, tabId, clearTabInitialPrompt, environmentId]);

  // Handle retry connection
  const handleRetry = useCallback(() => {
    setConnectionState("connecting");
    setErrorMessage(null);
    // Reset initialization state to force new session creation
    tabSessionIdRef.current = null;
    isInitializedRef.current = false;
    // Trigger re-initialization by clearing client
    setClient(environmentId, null);
    setSession(sessionKey, null);
    setServerStatus(environmentId, { running: false, hostPort: null });
  }, [sessionKey, environmentId, setClient, setSession, setServerStatus]);

  const handleResumeSession = useCallback(
    async (sessionId: string) => {
      if (!client) return;

      try {
        const messages = await getSessionMessages(client, sessionId);

        tabSessionIdRef.current = sessionId;
        isInitializedRef.current = true;

        setSession(sessionKey, {
          sessionId,
          messages,
          isLoading: false,
        });

        setResumeDialogOpen(false);
      } catch (error) {
        console.error("[OpenCodeChatTab] Failed to resume session:", error);
      }
    },
    [client, sessionKey, setSession]
  );

  // Render loading state
  if (connectionState === "connecting") {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
        <Loader2 className="w-8 h-8 animate-spin" />
        <p className="text-sm">Connecting to OpenCode server...</p>
      </div>
    );
  }

  // Render error state
  if (connectionState === "error") {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-muted-foreground p-4">
        <AlertCircle className="w-10 h-10 text-destructive" />
        <div className="text-center">
          <p className="text-sm font-medium text-foreground">Connection Failed</p>
          <p className="text-xs mt-1">{errorMessage || "Unable to connect to OpenCode server"}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={handleRetry} className="gap-2">
            <RefreshCw className="w-4 h-4" />
            Retry
          </Button>
          {serverLog && (
            <Button variant="ghost" size="sm" onClick={() => setShowLog(!showLog)}>
              {showLog ? "Hide Log" : "Show Log"}
            </Button>
          )}
        </div>
        {showLog && serverLog && (
          <div className="w-full max-w-lg mt-2">
            <pre className="text-xs bg-muted p-3 rounded-md overflow-auto max-h-48 text-left whitespace-pre-wrap">
              {serverLog || "(empty log)"}
            </pre>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-background overflow-hidden">
      {/* Messages area - min-h-0 is critical for flexbox scrolling */}
      <ScrollArea ref={scrollRef} className="flex-1 min-h-0">
        <div className="py-4">
          {session?.messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full min-h-[200px] text-muted-foreground gap-3">
              <p className="text-sm">No messages yet. Start a conversation!</p>
              {client && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setResumeDialogOpen(true)}
                >
                  <History className="w-4 h-4 mr-2" />
                  Resume Session
                </Button>
              )}
            </div>
          ) : (
            session?.messages.map((message) => (
              <OpenCodeMessage key={message.id} message={message} />
            ))
          )}

          {/* Loading indicator */}
          {session?.isLoading && (
            <div className="px-4 py-3">
              <div className="max-w-3xl mx-auto">
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span className="text-xs">OpenCode is thinking...</span>
                </div>
              </div>
            </div>
          )}

          {/* Pending questions */}
          {session && client && pendingQuestions.length > 0 && (
            <div className="max-w-3xl mx-auto">
              {pendingQuestions.map((question) => (
                <OpenCodeQuestionCard
                  key={question.id}
                  question={question}
                  client={client}
                />
              ))}
            </div>
          )}
        </div>
      </ScrollArea>

      {/* Scroll to bottom button - positioned above compose bar */}
      {!isAtBottom && (
        <div className="flex justify-end px-4 py-1">
          <button
            onClick={scrollToBottom}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs bg-muted hover:bg-muted/80 text-muted-foreground hover:text-foreground transition-colors shadow-sm"
          >
            <ArrowDown className="w-3.5 h-3.5" />
            <span>Scroll down</span>
          </button>
        </div>
      )}

      {/* Compose bar */}
      <OpenCodeComposeBar
        environmentId={environmentId}
        tabId={tabId}
        containerId={containerId}
        models={models}
        onSend={handleSend}
        disabled={!client || !session || session.isLoading}
      />

      {client && (
        <OpenCodeResumeSessionDialog
          open={resumeDialogOpen}
          onOpenChange={setResumeDialogOpen}
          client={client}
          onResume={handleResumeSession}
          currentSessionId={session?.sessionId}
        />
      )}
    </div>
  );
}

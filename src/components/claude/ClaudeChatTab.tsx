import { useEffect, useRef, useCallback, useState, useMemo } from "react";
import { Loader2, AlertCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useClaudeStore } from "@/stores/claudeStore";
import {
  createClient,
  getModels,
  createSession,
  getSessionMessages,
  sendPrompt,
  subscribeToEvents,
  checkHealth,
  ERROR_MESSAGE_PREFIX,
  type ClaudeQuestionRequest,
} from "@/lib/claude-client";
import {
  startClaudeServer,
  getClaudeServerStatus,
  getClaudeServerLog,
  startLocalClaudeServer,
  getLocalClaudeServerStatus,
} from "@/lib/tauri";
import { ClaudeMessage } from "./ClaudeMessage";
import { ClaudeComposeBar } from "./ClaudeComposeBar";
import { ClaudeQuestionCard } from "./ClaudeQuestionCard";
import type { ClaudeNativeData } from "@/types/paneLayout";
import type { ClaudeAttachment } from "@/stores/claudeStore";

interface ClaudeChatTabProps {
  tabId: string;
  data: ClaudeNativeData;
  isActive: boolean;
  initialPrompt?: string;
}

type ConnectionState = "connecting" | "connected" | "error";

export function ClaudeChatTab({ tabId, data, isActive, initialPrompt }: ClaudeChatTabProps) {
  const { containerId, environmentId, isLocal } = data;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [serverLog, setServerLog] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);

  const tabSessionIdRef = useRef<string | null>(null);
  const isInitializedRef = useRef(false);
  const initialPromptSentRef = useRef(false);
  const handleSendRef = useRef<((text: string, attachments: ClaudeAttachment[], thinkingEnabled: boolean) => Promise<void>) | null>(null);

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
    setSelectedModel,
    addPendingQuestion,
    removePendingQuestion,
    getOrCreateEventSubscription,
    setEventStream,
    hasActiveEventSubscription,
    isThinkingEnabled,
    clients: clientsMap,
    sessions: sessionsMap,
    pendingQuestions: pendingQuestionsMap,
  } = useClaudeStore();

  const client = useMemo(() => clientsMap.get(environmentId), [clientsMap, environmentId]);
  const session = useMemo(() => sessionsMap.get(tabId), [sessionsMap, tabId]);

  const pendingQuestions = useMemo(() => {
    if (!session?.sessionId) return [];
    const questions: ClaudeQuestionRequest[] = [];
    for (const question of pendingQuestionsMap.values()) {
      if (question.sessionId === session.sessionId) {
        questions.push(question);
      }
    }
    return questions;
  }, [session?.sessionId, pendingQuestionsMap]);

  const lastInitTimeRef = useRef<number>(0);
  const INIT_DEBOUNCE_MS = 1000;

  useEffect(() => {
    if (!isActive) {
      return;
    }

    const now = Date.now();
    const timeSinceLastInit = now - lastInitTimeRef.current;
    if (timeSinceLastInit < INIT_DEBOUNCE_MS && isInitializedRef.current) {
      return;
    }

    let mounted = true;

    async function initialize() {
      try {
        console.debug("[ClaudeChatTab] Initializing", {
          tabId,
          environmentId,
          isLocal,
          containerId,
          connectionState,
        });
        lastInitTimeRef.current = Date.now();
        setConnectionState("connecting");
        setErrorMessage(null);

        let hostPort: number | null = null;

        if (isLocal) {
          // Local environment - use local server commands
          let localStatus = await getLocalClaudeServerStatus(environmentId);
          console.debug("[ClaudeChatTab] Local server status:", localStatus);

          if (!localStatus.running) {
            console.debug("[ClaudeChatTab] Starting local Claude server...");
            const result = await startLocalClaudeServer(environmentId);
            console.debug("[ClaudeChatTab] Local Claude server start result:", result);
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

          let status = await getClaudeServerStatus(containerId);
          console.debug("[ClaudeChatTab] Container server status:", status);

          if (!status.running) {
            console.debug("[ClaudeChatTab] Starting container Claude server...");
            const result = await startClaudeServer(containerId);
            console.debug("[ClaudeChatTab] Container Claude server start result:", result);
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

        const baseUrl = `http://127.0.0.1:${hostPort}`;
        console.debug("[ClaudeChatTab] Claude bridge server base URL:", baseUrl);
        const bridgeClient = createClient(baseUrl);
        setClient(environmentId, bridgeClient);

        const healthy = await checkHealth(bridgeClient);
        console.debug("[ClaudeChatTab] Claude bridge health:", healthy);
        const modelsStart = Date.now();
        const availableModels = await getModels(bridgeClient);
        if (!mounted) return;
        console.debug("[ClaudeChatTab] Available models:", availableModels, "durationMs:", Date.now() - modelsStart);
        setModels(availableModels);

        // Set default model if not already selected
        const currentSelectedModel = getSelectedModel(environmentId);
        const firstModel = availableModels[0];
        if (!currentSelectedModel && firstModel) {
          setSelectedModel(environmentId, firstModel.id);
        }

        const existingSessionId = tabSessionIdRef.current;
        if (existingSessionId && isInitializedRef.current) {
          setConnectionState("connected");
          startSharedEventSubscription(bridgeClient);
        } else {
          const newSession = await createSession(bridgeClient);
          if (!mounted) return;

          if (!newSession) {
            throw new Error("Failed to create session");
          }

          tabSessionIdRef.current = newSession.sessionId;
          isInitializedRef.current = true;

          console.debug("[ClaudeChatTab] Storing session in state", {
            tabId,
            sessionId: newSession.sessionId,
            environmentId,
          });

          setSession(tabId, {
            sessionId: newSession.sessionId,
            messages: [],
            isLoading: false,
          });

          setConnectionState("connected");
          startSharedEventSubscription(bridgeClient);
        }
      } catch (error) {
        console.error("[ClaudeChatTab] Initialization failed:", error);
        if (!mounted) return;
        setConnectionState("error");
        let message = "Connection failed";
        if (error instanceof Error) {
          message = error.message;
        } else if (typeof error === "string") {
          message = error;
        } else if (error && typeof error === "object" && "message" in error) {
          message = String((error as { message: unknown }).message);
        }
        if (message.includes("port") && message.includes("not mapped")) {
          message += ". Try recreating the environment to enable Claude native mode support.";
        }
        setErrorMessage(message);

        // Try to fetch server log for debugging if timeout error (only for containerized environments)
        if (message.includes("timeout") && !isLocal && containerId) {
          try {
            const log = await getClaudeServerLog(containerId);
            if (log) {
              setServerLog(log);
            }
          } catch (logError) {
            console.error("[ClaudeChatTab] Failed to fetch server log:", logError);
          }
        }
      }
    }

    initialize();

    return () => {
      mounted = false;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerId, environmentId, tabId, isActive, isLocal]);

  const startSharedEventSubscription = useCallback(
    async (bridgeClient: ReturnType<typeof createClient>) => {
      if (hasActiveEventSubscription(environmentId)) {
        return;
      }

      const subscriptionState = getOrCreateEventSubscription(environmentId);
      if (!subscriptionState) {
        return;
      }

      const { abortController } = subscriptionState;

      try {
        console.debug("[ClaudeChatTab] Starting shared event subscription", { environmentId });
        const eventStream = subscribeToEvents(bridgeClient, abortController.signal);
        setEventStream(environmentId, eventStream);

        const lastReloadTimeBySession = new Map<string, number>();
        const DEBOUNCE_MS = 200;
        const pendingReloads = new Map<string, NodeJS.Timeout>();

        const fetchMessagesDebounced = (sessionId: string, sessionTabId: string, immediate = false) => {
          const pendingTimeout = pendingReloads.get(sessionId);
          if (pendingTimeout) {
            clearTimeout(pendingTimeout);
            pendingReloads.delete(sessionId);
          }

          const doFetch = async () => {
            const now = Date.now();
            lastReloadTimeBySession.set(sessionId, now);
            console.debug("[ClaudeChatTab] Fetching session messages", { sessionId, sessionTabId });
            const messages = await getSessionMessages(bridgeClient, sessionId);
            setMessages(sessionTabId, messages);
          };

          if (immediate) {
            doFetch();
          } else {
            const now = Date.now();
            const lastTime = lastReloadTimeBySession.get(sessionId) || 0;
            if (now - lastTime > DEBOUNCE_MS) {
              doFetch();
            } else {
              const timeout = setTimeout(doFetch, DEBOUNCE_MS);
              pendingReloads.set(sessionId, timeout);
            }
          }
        };

        for await (const event of eventStream) {
          if (abortController.signal.aborted) {
            for (const timeout of pendingReloads.values()) {
              clearTimeout(timeout);
            }
            break;
          }

          const eventType = event?.type;
          const eventSessionId = event?.sessionId;
          console.debug("[ClaudeChatTab] SSE event", { eventType, eventSessionId });

          if (!eventSessionId && !["question.asked", "question.answered"].includes(eventType || "")) {
            continue;
          }

          const sessions = useClaudeStore.getState().sessions;

          // Debug: Log all stored sessions and whether we found a match
          const sessionIds = Array.from(sessions.entries()).map(([tabId, state]) => ({
            tabId,
            sessionId: state.sessionId,
          }));
          let foundMatch = false;

          for (const [sessionTabId, sessionState] of sessions) {
            if (sessionState.sessionId !== eventSessionId) continue;
            foundMatch = true;

            const isFinalEvent = eventType === "session.idle";

            if (eventType === "message.updated" || eventType === "session.updated" || isFinalEvent) {
              fetchMessagesDebounced(eventSessionId, sessionTabId, isFinalEvent);
            }

            if (isFinalEvent) {
              setSessionLoading(sessionTabId, false);
            }

            if (eventType === "session.error") {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const rawError = (event.data as any)?.error;
              console.error("[ClaudeChatTab] Session error:", rawError);
              setSessionLoading(sessionTabId, false);
              let errorMsg: string;
              if (typeof rawError === "string") {
                errorMsg = rawError;
              } else if (rawError && typeof rawError === "object") {
                const errObj = rawError as Record<string, unknown>;
                errorMsg = String(errObj.message || errObj.error || JSON.stringify(rawError));
              } else {
                errorMsg = "An unknown error occurred";
              }
              const errorMessage = {
                id: `${ERROR_MESSAGE_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2)}`,
                role: "assistant" as const,
                content: errorMsg,
                parts: [{ type: "text" as const, content: errorMsg }],
                timestamp: new Date().toISOString(),
              };
              addMessage(sessionTabId, errorMessage);
            }
          }

          // Debug: Warn if no session matched the event
          if (!foundMatch && eventSessionId && !["keepalive", "connected"].includes(eventType || "")) {
            console.warn("[ClaudeChatTab] No session matched event", {
              eventType,
              eventSessionId,
              storedSessions: sessionIds,
            });
          }

          if (eventType === "question.asked") {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const questionData = event.data as any;
            if (questionData?.id && questionData?.questions) {
              const questionRequest: ClaudeQuestionRequest = {
                id: questionData.id,
                sessionId: questionData.sessionId || eventSessionId || "",
                questions: questionData.questions,
                toolUseId: questionData.toolUseId,
              };
              addPendingQuestion(questionRequest);
            }
          } else if (eventType === "question.answered") {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const answerData = event.data as any;
            if (answerData?.requestId) {
              removePendingQuestion(answerData.requestId);
            }
          }
        }
      } catch (error) {
        if (!abortController.signal.aborted) {
          console.error("[ClaudeChatTab] Event subscription error:", error);
        }
      } finally {
        setEventStream(environmentId, null);
      }
    },
    [environmentId, hasActiveEventSubscription, getOrCreateEventSubscription, setEventStream, setMessages, setSessionLoading, addMessage, addPendingQuestion, removePendingQuestion]
  );

  useEffect(() => {
    if (scrollRef.current && session?.messages) {
      const scrollElement = scrollRef.current.querySelector("[data-radix-scroll-area-viewport]");
      if (scrollElement) {
        scrollElement.scrollTop = scrollElement.scrollHeight;
      }
    }
  }, [session?.messages]);

  const handleSend = useCallback(
    async (text: string, attachments: ClaudeAttachment[], thinkingEnabled: boolean) => {
      if (!client || !session) return;

      const selectedModel = getSelectedModel(environmentId);

      const userMessage = {
        id: crypto.randomUUID(),
        role: "user" as const,
        content: text,
        parts: [{ type: "text" as const, content: text }],
        timestamp: new Date().toISOString(),
      };
      addMessage(tabId, userMessage);
      setSessionLoading(tabId, true);

      const sdkAttachments = attachments.map((att) => ({
        type: att.type,
        path: att.path,
        dataUrl: att.previewUrl,
        filename: att.name,
      }));

      const success = await sendPrompt(client, session.sessionId, text, {
        model: selectedModel,
        attachments: sdkAttachments.length > 0 ? sdkAttachments : undefined,
        thinking: thinkingEnabled,
      });

      if (!success) {
        console.error("[ClaudeChatTab] Failed to send prompt");
        setSessionLoading(tabId, false);
      }
    },
    [client, session, tabId, environmentId, getSelectedModel, addMessage, setSessionLoading]
  );

  handleSendRef.current = handleSend;

  useEffect(() => {
    if (
      connectionState === "connected" &&
      client &&
      session &&
      initialPrompt &&
      !initialPromptSentRef.current
    ) {
      initialPromptSentRef.current = true;
      console.debug("[ClaudeChatTab] Sending initial prompt for tab:", tabId);
      // Use the user's thinking preference instead of hardcoding true
      const thinkingEnabled = isThinkingEnabled(environmentId);
      handleSendRef.current?.(initialPrompt, [], thinkingEnabled);
    }
  }, [connectionState, client, session, initialPrompt, tabId, environmentId, isThinkingEnabled]);

  const handleRetry = useCallback(() => {
    setConnectionState("connecting");
    setErrorMessage(null);
    tabSessionIdRef.current = null;
    isInitializedRef.current = false;
    setClient(environmentId, null);
    setSession(tabId, null);
    setServerStatus(environmentId, { running: false, hostPort: null });
  }, [tabId, environmentId, setClient, setSession, setServerStatus]);

  if (connectionState === "connecting") {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
        <Loader2 className="w-8 h-8 animate-spin" />
        <p className="text-sm">Connecting to Claude bridge server...</p>
      </div>
    );
  }

  if (connectionState === "error") {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-muted-foreground p-4">
        <AlertCircle className="w-10 h-10 text-destructive" />
        <div className="text-center">
          <p className="text-sm font-medium text-foreground">Connection Failed</p>
          <p className="text-xs mt-1">{errorMessage || "Unable to connect to Claude bridge server"}</p>
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
      <ScrollArea ref={scrollRef} className="flex-1 min-h-0">
        <div className="py-4">
          {session?.messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full min-h-[200px] text-muted-foreground">
              <p className="text-sm">No messages yet. Start a conversation with Claude!</p>
            </div>
          ) : (
            session?.messages.map((message) => (
              <ClaudeMessage key={message.id} message={message} />
            ))
          )}

          {session?.isLoading && (
            <div className="px-4 py-3">
              <div className="max-w-3xl mx-auto">
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span className="text-xs">Claude is thinking...</span>
                </div>
              </div>
            </div>
          )}

          {session && client && pendingQuestions.length > 0 && (
            <div className="max-w-3xl mx-auto">
              {pendingQuestions.map((question) => (
                <ClaudeQuestionCard
                  key={question.id}
                  question={question}
                  client={client}
                  sessionId={session.sessionId}
                />
              ))}
            </div>
          )}
        </div>
      </ScrollArea>

      <ClaudeComposeBar
        environmentId={environmentId}
        containerId={containerId}
        models={models}
        onSend={handleSend}
        disabled={!client || !session || session.isLoading}
      />
    </div>
  );
}

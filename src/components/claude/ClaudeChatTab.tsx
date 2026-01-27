import { useEffect, useRef, useCallback, useState, useMemo } from "react";
import { Loader2, AlertCircle, RefreshCw, ArrowDown, History } from "lucide-react";
import { useScrollLock } from "@/hooks";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useClaudeStore, createClaudeSessionKey } from "@/stores/claudeStore";
import { useClaudeActivityStore } from "@/stores/claudeActivityStore";
import {
  createClient,
  getModels,
  createSession,
  getSessionMessages,
  sendPrompt,
  subscribeToEvents,
  checkHealth,
  ERROR_MESSAGE_PREFIX,
  SYSTEM_MESSAGE_PREFIX,
  SessionNotFoundError,
  type ClaudeMessage as ClaudeMessageType,
  type ClaudeQuestionRequest,
  type ClaudePlanApprovalRequest,
  type PlanApprovalRequestedEventData,
  type PlanApprovalRespondedEventData,
  type SystemMessageEventData,
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
import { ClaudePlanApprovalCard } from "./ClaudePlanApprovalCard";
import { ResumeSessionDialog } from "./ResumeSessionDialog";
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
  const [resumeDialogOpen, setResumeDialogOpen] = useState(false);

  const tabSessionIdRef = useRef<string | null>(null);
  const isInitializedRef = useRef(false);
  const initialPromptSentRef = useRef(false);
  const handleSendRef = useRef<((text: string, attachments: ClaudeAttachment[], thinkingEnabled: boolean, planModeEnabled: boolean) => Promise<void>) | null>(null);

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
    addPendingPlanApproval,
    removePendingPlanApproval,
    getOrCreateEventSubscription,
    setEventStream,
    hasActiveEventSubscription,
    isThinkingEnabled,
    isPlanMode,
    setPlanMode,
    getSessionKeyBySdkSessionId,
    clients: clientsMap,
    sessions: sessionsMap,
    pendingQuestions: pendingQuestionsMap,
    pendingPlanApprovals: pendingPlanApprovalsMap,
  } = useClaudeStore();

  // Activity state tracking - use environmentId as key for both local and container environments
  const { setContainerState, removeContainerState } = useClaudeActivityStore();

  // Create a unique session key that combines environmentId and tabId
  // This prevents session collisions when multiple environments use the same tab IDs (e.g., "default")
  const sessionKey = useMemo(() => createClaudeSessionKey(environmentId, tabId), [environmentId, tabId]);

  const client = useMemo(() => clientsMap.get(environmentId), [clientsMap, environmentId]);
  const session = useMemo(() => sessionsMap.get(sessionKey), [sessionsMap, sessionKey]);

  // Scroll lock - auto-scroll only when user is at bottom
  // mountTrigger ensures we re-search for the viewport when connectionState changes
  // (since ScrollArea only renders after connection succeeds)
  const { isAtBottom, scrollToBottom } = useScrollLock(scrollRef, {
    scrollTrigger: session?.messages,
    mountTrigger: connectionState,
  });

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

  const pendingPlanApprovals = useMemo(() => {
    if (!session?.sessionId) return [];
    const approvals: ClaudePlanApprovalRequest[] = [];
    for (const approval of pendingPlanApprovalsMap.values()) {
      if (approval.sessionId === session.sessionId) {
        approvals.push(approval);
      }
    }
    return approvals;
  }, [session?.sessionId, pendingPlanApprovalsMap]);

  // Memoize messages separately to provide stable reference for child components
  // This prevents unnecessary recalculations when other session properties change
  const sessionMessages = useMemo(() => session?.messages ?? [], [session?.messages]);

  const lastInitTimeRef = useRef<number>(0);
  const INIT_DEBOUNCE_MS = 1000;

  // Track Claude activity state based on session loading - update the environment icon in sidebar
  // For native Claude mode, we use environmentId as the key (works for both local and containerized)
  useEffect(() => {
    if (connectionState !== "connected") {
      // Not connected yet, show idle
      setContainerState(environmentId, "idle");
      return;
    }

    if (session?.isLoading) {
      // Claude is working on a response
      setContainerState(environmentId, "working");
    } else if (pendingQuestions.length > 0) {
      // Claude is waiting for user input (question)
      setContainerState(environmentId, "waiting");
    } else {
      // Claude is idle
      setContainerState(environmentId, "idle");
    }
  }, [connectionState, session?.isLoading, pendingQuestions.length, environmentId, setContainerState]);

  // Cleanup activity state when tab unmounts
  useEffect(() => {
    return () => {
      removeContainerState(environmentId);
    };
  }, [environmentId, removeContainerState]);

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

        // Check for existing session - first from component ref, then from Zustand store
        // This handles reconnection after tab remount where refs are lost but store persists
        const existingSessionFromRef = tabSessionIdRef.current;
        const existingSessionFromStore = useClaudeStore.getState().sessions.get(sessionKey);
        const existingSessionId = existingSessionFromRef || existingSessionFromStore?.sessionId;

        if (existingSessionId) {
          // Restore session from store - component may have remounted
          tabSessionIdRef.current = existingSessionId;
          isInitializedRef.current = true;
          console.debug("[ClaudeChatTab] Reconnecting to existing session", {
            tabId,
            sessionKey,
            sessionId: existingSessionId,
            environmentId,
            fromRef: !!existingSessionFromRef,
            fromStore: !!existingSessionFromStore,
          });
          setConnectionState("connected");

          // Start SSE subscription BEFORE sending initial prompt to avoid race condition
          // where SSE events could wipe locally-added messages
          startSharedEventSubscription(bridgeClient);

          // Refresh messages from server to ensure we have latest state
          if (existingSessionFromStore) {
            try {
              const messages = await getSessionMessages(bridgeClient, existingSessionId);
              if (!mounted) return;
              // Preserve any client-side error messages that may not be on the server
              const currentMessages = existingSessionFromStore.messages || [];
              const errorMessages = currentMessages.filter((m) => m.id.startsWith(ERROR_MESSAGE_PREFIX));
              const serverMessageIds = new Set(messages.map((m) => m.id));
              const errorMessagesToKeep = errorMessages.filter((m) => !serverMessageIds.has(m.id));
              if (errorMessagesToKeep.length > 0) {
                setMessages(sessionKey, [...messages, ...errorMessagesToKeep]);
              } else {
                setMessages(sessionKey, messages);
              }
            } catch (err) {
              if (err instanceof SessionNotFoundError) {
                // Session expired on server - create a new one
                console.warn("[ClaudeChatTab] Session expired on server, creating new session");
                const newSession = await createSession(bridgeClient);
                if (!mounted) return;
                if (newSession) {
                  tabSessionIdRef.current = newSession.sessionId;
                  setSession(sessionKey, {
                    sessionId: newSession.sessionId,
                    messages: [],
                    isLoading: false,
                  });
                }
              } else {
                console.warn("[ClaudeChatTab] Failed to refresh messages on reconnect:", err);
                // Keep existing messages from store if refresh fails
              }
            }
          }
        } else {
          const newSession = await createSession(bridgeClient);
          if (!mounted) return;

          if (!newSession) {
            throw new Error("Failed to create session");
          }

          tabSessionIdRef.current = newSession.sessionId;
          isInitializedRef.current = true;

          console.debug("[ClaudeChatTab] Created new session", {
            tabId,
            sessionKey,
            sessionId: newSession.sessionId,
            environmentId,
          });

          // Check if we have an initial prompt to send
          // We send it BEFORE starting SSE to avoid race conditions where
          // SSE events could wipe locally-added messages before they're synced
          const shouldSendInitialPrompt = initialPrompt && !initialPromptSentRef.current;

          if (shouldSendInitialPrompt) {
            // Mark as sent immediately to prevent double-sending
            initialPromptSentRef.current = true;

            // Create user message
            const userMessage = {
              id: crypto.randomUUID(),
              role: "user" as const,
              content: initialPrompt,
              parts: [{ type: "text" as const, content: initialPrompt }],
              timestamp: new Date().toISOString(),
            };

            console.debug("[ClaudeChatTab] Sending initial prompt during initialization", {
              tabId,
              sessionId: newSession.sessionId,
              promptLength: initialPrompt.length,
            });

            // Set session with the user message already included and loading state
            setSession(sessionKey, {
              sessionId: newSession.sessionId,
              messages: [userMessage],
              isLoading: true,
            });

            setConnectionState("connected");

            // Send the prompt to the server
            const selectedModel = getSelectedModel(environmentId);
            const thinkingEnabled = isThinkingEnabled(environmentId);
            const planModeEnabled = isPlanMode(environmentId);
            const permissionMode = planModeEnabled ? "plan" : "bypassPermissions";

            // Start SSE subscription first so we can receive the response
            startSharedEventSubscription(bridgeClient);

            // Now send the prompt
            const success = await sendPrompt(bridgeClient, newSession.sessionId, initialPrompt, {
              model: selectedModel,
              thinking: thinkingEnabled,
              permissionMode,
            });

            if (!success) {
              console.error("[ClaudeChatTab] Failed to send initial prompt");
              setSessionLoading(sessionKey, false);
              // Show error message to user
              const errorMessage = {
                id: `${ERROR_MESSAGE_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2)}`,
                role: "assistant" as const,
                content: "Failed to send message. Please try again.",
                parts: [{ type: "text" as const, content: "Failed to send message. Please try again." }],
                timestamp: new Date().toISOString(),
              };
              addMessage(sessionKey, errorMessage);
            }
          } else {
            // No initial prompt - just set up the session normally
            setSession(sessionKey, {
              sessionId: newSession.sessionId,
              messages: [],
              isLoading: false,
            });

            setConnectionState("connected");
            startSharedEventSubscription(bridgeClient);
          }
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

        // Note: sessionKey is the session key from the sessions Map (e.g., "env-{envId}:{tabId}")
        const fetchMessagesDebounced = (sessionId: string, sessionKey: string, immediate = false) => {
          const pendingTimeout = pendingReloads.get(sessionId);
          if (pendingTimeout) {
            clearTimeout(pendingTimeout);
            pendingReloads.delete(sessionId);
          }

          const doFetch = async () => {
            const now = Date.now();
            lastReloadTimeBySession.set(sessionId, now);
            console.debug("[ClaudeChatTab] Fetching session messages", { sessionId, sessionKey });
            const messages = await getSessionMessages(bridgeClient, sessionId);
            setMessages(sessionKey, messages);
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

          if (!eventSessionId && !["question.asked", "question.answered", "plan.enter-requested", "plan.exit-requested", "plan.approval-requested", "plan.approval-responded"].includes(eventType || "")) {
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

          // Handle session.init outside the session loop - uses environmentId as key
          // regardless of whether a specific session matched (handles race conditions)
          if (eventType === "session.init") {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const initData = event.data as any;
            if (initData) {
              useClaudeStore.getState().setSessionInitData(environmentId, {
                mcpServers: initData.mcpServers || [],
                plugins: initData.plugins || [],
                slashCommands: initData.slashCommands || [],
              });
            }
          }

          // Debug: Warn if no session matched the event
          // Filter out events that are expected during initialization or are informational
          // Also filter message/session updates since they can arrive for old sessions during reconnects
          const ignoredEventTypes = ["keepalive", "connected", "session.init", "message.updated", "session.updated", "session.idle", "plan.enter-requested", "plan.exit-requested", "plan.approval-requested", "plan.approval-responded", "system.compact", "system.message"];
          if (!foundMatch && eventSessionId && !ignoredEventTypes.includes(eventType || "")) {
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
          } else if (eventType === "plan.enter-requested") {
            // Claude has entered plan mode - enable plan mode in the UI to sync state
            console.log("[ClaudeChatTab] Plan enter requested, enabling plan mode");
            setPlanMode(environmentId, true);
          } else if (eventType === "plan.exit-requested") {
            // Claude has requested to exit plan mode - disable plan mode for this environment
            console.log("[ClaudeChatTab] Plan exit requested, disabling plan mode");
            setPlanMode(environmentId, false);
          } else if (eventType === "plan.approval-requested") {
            // Claude is waiting for plan approval - show approval UI
            const approvalData = event.data as PlanApprovalRequestedEventData | undefined;
            if (approvalData?.id) {
              const approvalRequest: ClaudePlanApprovalRequest = {
                id: approvalData.id,
                sessionId: approvalData.sessionId || eventSessionId || "",
                toolUseId: approvalData.toolUseId,
              };
              console.log("[ClaudeChatTab] Plan approval requested:", approvalRequest);
              addPendingPlanApproval(approvalRequest);
            }
          } else if (eventType === "plan.approval-responded") {
            // Plan approval response received - remove the pending approval
            const responseData = event.data as PlanApprovalRespondedEventData | undefined;
            if (responseData?.requestId) {
              console.log("[ClaudeChatTab] Plan approval responded:", responseData);
              removePendingPlanApproval(responseData.requestId);
            }
          } else if (eventType === "system.compact") {
            // Show simple feedback for /compact command
            const matchedSessionKey = eventSessionId ? getSessionKeyBySdkSessionId(eventSessionId) : null;
            if (matchedSessionKey) {
              const systemMessage: ClaudeMessageType = {
                id: `${SYSTEM_MESSAGE_PREFIX}${crypto.randomUUID()}`,
                role: "system",
                content: "Conversation compacted.",
                parts: [{ type: "text", content: "Conversation compacted." }],
                timestamp: new Date().toISOString(),
              };
              addMessage(matchedSessionKey, systemMessage);
            }
          } else if (eventType === "system.message") {
            // Show feedback for specific system messages (not all subtypes)
            const sysData = event.data as SystemMessageEventData | undefined;
            // Only show user-facing messages, filter out informational subtypes like "status"
            const userFacingSubtypes = ["clear"];
            if (sysData?.subtype && userFacingSubtypes.includes(sysData.subtype)) {
              // Use the store helper to find the sessionKey for this SDK session ID
              const matchedSessionKey = eventSessionId ? getSessionKeyBySdkSessionId(eventSessionId) : null;
              if (matchedSessionKey) {
                let content = `System: ${sysData.subtype}`;

                // Format specific subtypes
                if (sysData.subtype === "clear") {
                  content = "Conversation cleared.";
                }

                const systemMessage: ClaudeMessageType = {
                  id: `${SYSTEM_MESSAGE_PREFIX}${crypto.randomUUID()}`,
                  role: "system",
                  content,
                  parts: [{ type: "text", content }],
                  timestamp: new Date().toISOString(),
                };
                addMessage(matchedSessionKey, systemMessage);
              } else {
                console.warn("[ClaudeChatTab] system.message: No matching session found for SDK session ID", eventSessionId);
              }
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
    [environmentId, hasActiveEventSubscription, getOrCreateEventSubscription, setEventStream, setMessages, setSessionLoading, addMessage, addPendingQuestion, removePendingQuestion, addPendingPlanApproval, removePendingPlanApproval, setPlanMode, getSessionKeyBySdkSessionId]
  );

  const handleSend = useCallback(
    async (text: string, attachments: ClaudeAttachment[], thinkingEnabled: boolean, planModeEnabled: boolean) => {
      if (!client || !session) return;

      const selectedModel = getSelectedModel(environmentId);

      const userMessage = {
        id: crypto.randomUUID(),
        role: "user" as const,
        content: text,
        parts: [{ type: "text" as const, content: text }],
        timestamp: new Date().toISOString(),
      };
      addMessage(sessionKey, userMessage);
      setSessionLoading(sessionKey, true);

      const sdkAttachments = attachments.map((att) => ({
        type: att.type,
        path: att.path,
        dataUrl: att.previewUrl,
        filename: att.name,
      }));

      // Map planMode to SDK permission mode:
      // - plan mode true -> "plan" (no tool execution)
      // - plan mode false -> "bypassPermissions" (all tools auto-approved)
      const permissionMode = planModeEnabled ? "plan" : "bypassPermissions";

      const success = await sendPrompt(client, session.sessionId, text, {
        model: selectedModel,
        attachments: sdkAttachments.length > 0 ? sdkAttachments : undefined,
        thinking: thinkingEnabled,
        permissionMode,
      });

      if (!success) {
        console.error("[ClaudeChatTab] Failed to send prompt");
        setSessionLoading(sessionKey, false);
      }
    },
    [client, session, sessionKey, environmentId, getSelectedModel, addMessage, setSessionLoading]
  );

  handleSendRef.current = handleSend;

  // Compute thinking and plan mode values outside useEffect to avoid function reference dependencies
  const thinkingEnabledValue = isThinkingEnabled(environmentId);
  const planModeEnabledValue = isPlanMode(environmentId);

  // Send initial prompt on RECONNECTION to existing session only.
  // New sessions handle initial prompt directly in initialize() to avoid race conditions.
  // This effect catches the case where we reconnect to an existing session that had an initial prompt.
  useEffect(() => {
    if (
      connectionState === "connected" &&
      client &&
      session &&
      initialPrompt &&
      !initialPromptSentRef.current
    ) {
      initialPromptSentRef.current = true;
      console.debug("[ClaudeChatTab] Sending initial prompt on reconnection for tab:", tabId);
      handleSendRef.current?.(initialPrompt, [], thinkingEnabledValue, planModeEnabledValue);
    }
  }, [connectionState, client, session, initialPrompt, tabId, thinkingEnabledValue, planModeEnabledValue]);

  const handleRetry = useCallback(() => {
    setConnectionState("connecting");
    setErrorMessage(null);
    tabSessionIdRef.current = null;
    isInitializedRef.current = false;
    setClient(environmentId, null);
    setSession(sessionKey, null);
    setServerStatus(environmentId, { running: false, hostPort: null });
  }, [sessionKey, environmentId, setClient, setSession, setServerStatus]);

  const handleResumeSession = useCallback(
    async (sessionId: string) => {
      if (!client) return;

      try {
        // Fetch messages for the selected session
        console.debug("[ClaudeChatTab] Resuming session:", sessionId);
        const messages = await getSessionMessages(client, sessionId);
        console.debug("[ClaudeChatTab] Fetched messages for resumed session:", {
          sessionId,
          messageCount: messages.length,
          messages,
        });

        // Update the component's session reference
        tabSessionIdRef.current = sessionId;

        // Update the store with the resumed session
        setSession(sessionKey, {
          sessionId,
          messages,
          isLoading: false,
        });

        console.debug("[ClaudeChatTab] Session state updated:", {
          sessionKey,
          sessionId,
          messageCount: messages.length,
        });

        setResumeDialogOpen(false);
      } catch (error) {
        console.error("[ClaudeChatTab] Failed to resume session:", error);
      }
    },
    [client, sessionKey, setSession]
  );

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
      {/* Messages area - flex-1 min-h-0 is critical for flexbox scrolling */}
      <ScrollArea ref={scrollRef} className="flex-1 min-h-0">
        <div className="py-4">
          {session?.messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full min-h-[200px] text-muted-foreground gap-3">
              <p className="text-sm">No messages yet. Start a conversation with Claude!</p>
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

          {session && client && pendingPlanApprovals.length > 0 && (
            <div className="max-w-3xl mx-auto">
              {pendingPlanApprovals.map((approval) => (
                <ClaudePlanApprovalCard
                  key={approval.id}
                  approval={approval}
                  client={client}
                  sessionId={session.sessionId}
                  messages={sessionMessages}
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
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-300 shadow-sm transition-colors"
            aria-label="Scroll to bottom of conversation"
          >
            <ArrowDown className="w-3.5 h-3.5" />
            <span>Scroll down</span>
          </button>
        </div>
      )}

      <ClaudeComposeBar
        environmentId={environmentId}
        tabId={tabId}
        containerId={containerId}
        models={models}
        onSend={handleSend}
        disabled={!client || !session || session.isLoading}
      />

      {client && (
        <ResumeSessionDialog
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

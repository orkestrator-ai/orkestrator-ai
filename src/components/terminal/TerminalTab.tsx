import { useEffect, useRef, useCallback, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SerializeAddon } from "@xterm/addon-serialize";
import "@xterm/xterm/css/xterm.css";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useTerminal } from "@/hooks/useTerminal";
import { useClaudeState } from "@/hooks/useClaudeState";
import { useClipboardImagePaste, processClipboardPaste } from "@/hooks/useClipboardImagePaste";
import { useTerminalSessionStore, createSessionKey, useConfigStore } from "@/stores";
import { useSessionStore } from "@/stores/sessionStore";
import { cn } from "@/lib/utils";
import { openInBrowser, loadSessionBuffer, setSessionHasLaunchedCommand } from "@/lib/tauri";
import type { TabType } from "@/contexts";
import { DEFAULT_TERMINAL_APPEARANCE, DEFAULT_TERMINAL_SCROLLBACK, ROOT_TERMINAL_USER } from "@/constants/terminal";
import { stripAnsi, tabTypeToSessionType, ENVIRONMENT_READY_MARKER, SHELL_PROMPT_PATTERNS } from "@/lib/terminal-utils";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

interface TerminalTabProps {
  tabId: string;
  tabType: TabType;
  containerId: string;
  environmentId: string;
  isActive: boolean;
  isFirstTab: boolean;
  initialPrompt?: string;
  initialCommands?: string[];
  onReady?: () => void;
  onWrite?: (write: (data: string) => Promise<void>) => void;
}

export function TerminalTab({
  tabId,
  tabType,
  containerId,
  environmentId,
  isActive,
  isFirstTab,
  initialPrompt,
  initialCommands,
  onReady,
  onWrite,
}: TerminalTabProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const serializeAddonRef = useRef<SerializeAddon | null>(null);
  const writeRef = useRef<(data: string) => Promise<void>>(() => Promise.resolve());
  const [isReady, setIsReady] = useState(false);
  const [isEnvironmentReady, setIsEnvironmentReady] = useState(false);
  const [hasSelection, setHasSelection] = useState(false);
  const dataBufferRef = useRef<string>("");
  const hasLaunchedCommandRef = useRef(false);
  const previousContainerIdRef = useRef<string>(containerId);

  // Get terminal appearance settings from config
  const terminalAppearance = useConfigStore(
    (state) => state.config.global.terminalAppearance
  ) || DEFAULT_TERMINAL_APPEARANCE;
  const terminalScrollback = useConfigStore(
    (state) => state.config.global.terminalScrollback
  ) ?? DEFAULT_TERMINAL_SCROLLBACK;

  // Create a container-scoped session key to avoid collisions across environments
  // This is critical because tabId (e.g., "default") is not unique across environments
  // For local environments (containerId is null), use environmentId to ensure uniqueness
  const sessionKey = createSessionKey(containerId, tabId, environmentId);

  // Session persistence - use selector for memoized session lookup
  // This prevents re-renders when other sessions in the store change
  const existingSession = useTerminalSessionStore((state) => state.sessions.get(sessionKey));
  const setSession = useTerminalSessionStore((state) => state.setSession);
  const setSerializedBuffer = useTerminalSessionStore((state) => state.setSerializedBuffer);
  const setHasLaunchedCommandStore = useTerminalSessionStore((state) => state.setHasLaunchedCommand);
  const existingSessionId = existingSession?.sessionId;
  const serializedBuffer = existingSession?.serializedBuffer;
  const existingHasLaunchedCommand = existingSession?.hasLaunchedCommand ?? false;
  const isReconnecting = !!existingSessionId;

  // If reconnecting to an existing session, consider environment already ready
  // (the command has already been launched, shell is already active)
  const [hasReconnected, setHasReconnected] = useState(false);

  // Clipboard image paste (right-click menu) - saves images to .orkestrator/clipboard/ and types path
  // Note: Keyboard paste (Cmd+V) is handled via xterm's attachCustomKeyEventHandler below
  const handleImageSaved = useCallback(async (filePath: string) => {
    // Type the path into the terminal (with a space suffix for readability)
    await writeRef.current(filePath + " ");
    // Ensure terminal has focus
    if (xtermRef.current) {
      xtermRef.current.focus();
    }
  }, []);

  const handleImageError = useCallback((error: string) => {
    console.error("[TerminalTab] Clipboard image error:", error);
  }, []);

  useClipboardImagePaste({
    containerId,
    isActive,
    onImageSaved: handleImageSaved,
    onError: handleImageError,
  });

  // Track selection state for clipboard actions
  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;
    const updateSelection = () => {
      setHasSelection(term.hasSelection());
    };
    updateSelection();
    const disposable = term.onSelectionChange(updateSelection);
    return () => disposable.dispose();
  }, [isReady]);

  const handleCopySelection = useCallback(async () => {
    const term = xtermRef.current;
    if (!term) return;
    const selection = term.getSelection();
    if (!selection) return;
    try {
      await writeText(selection);
    } catch (err) {
      console.error("[TerminalTab] Failed to copy selection:", err);
    }
  }, []);

  const handleSelectAll = useCallback(() => {
    const term = xtermRef.current;
    if (!term) return;
    term.selectAll();
    term.focus();
  }, []);

  const handlePaste = useCallback(() => {
    if (!containerId) return;
    const term = xtermRef.current;
    if (!term) return;
    processClipboardPaste(
      containerId,
      async (filePath) => {
        await writeRef.current(filePath + " ");
        term.focus();
      },
      async (text) => {
        await writeRef.current(text);
        term.focus();
      },
      (error) => {
        console.error("[TerminalTab] Clipboard paste error:", error);
      }
    );
  }, [containerId]);

  // Reset state when containerId changes (shouldn't happen normally, but handle gracefully)
  useEffect(() => {
    if (previousContainerIdRef.current !== containerId) {
      console.debug("[TerminalTab] ContainerId changed, resetting state for tab:", tabId);
      setIsEnvironmentReady(false);
      dataBufferRef.current = "";
      hasLaunchedCommandRef.current = false;
      previousContainerIdRef.current = containerId;
    }
  }, [containerId, tabId]);

  // Handle terminal data from backend
  const handleData = useCallback(
    (data: Uint8Array) => {
      if (xtermRef.current) {
        xtermRef.current.write(data);

        // Convert to string for processing
        const text = new TextDecoder().decode(data);

        // For first tab only: detect environment ready state
        if (isFirstTab && !isEnvironmentReady) {
          dataBufferRef.current += text;
          const strippedBuffer = stripAnsi(dataBufferRef.current);

          let readyDetected =
            strippedBuffer.includes(ENVIRONMENT_READY_MARKER) ||
            dataBufferRef.current.includes(ENVIRONMENT_READY_MARKER);

          if (!readyDetected) {
            for (const pattern of SHELL_PROMPT_PATTERNS) {
              if (typeof pattern === "string") {
                if (strippedBuffer.includes(pattern)) {
                  readyDetected = true;
                  break;
                }
              } else if (pattern.test(strippedBuffer)) {
                readyDetected = true;
                break;
              }
            }
          }

          // Fallback detection
          if (!readyDetected && strippedBuffer.length > 200) {
            const hasWorkspacePrompt =
              strippedBuffer.includes("workspace") &&
              (strippedBuffer.includes("main") || strippedBuffer.includes("master"));
            const hasZshPrompt = strippedBuffer.includes("➜") || strippedBuffer.includes("❯");
            const hasGitBranch = /git:\([^)]+\)/.test(strippedBuffer);
            const hasPowerlevel10k =
              strippedBuffer.includes("node") && strippedBuffer.includes("/workspace");

            if ((hasWorkspacePrompt && hasZshPrompt) || hasGitBranch || hasPowerlevel10k) {
              readyDetected = true;
            }
          }

          if (!readyDetected && strippedBuffer.length > 600) {
            const hasCloneComplete =
              strippedBuffer.includes("Cloning into") ||
              strippedBuffer.includes("100%") ||
              strippedBuffer.includes("Resolving deltas");
            const hasWorkspaceRef = strippedBuffer.includes("/workspace");

            if (hasCloneComplete && hasWorkspaceRef) {
              readyDetected = true;
            }
          }

          if (readyDetected) {
            console.debug("[TerminalTab] Environment ready detected for tab:", tabId);
            setIsEnvironmentReady(true);
            dataBufferRef.current = "";
            onReady?.();
          }

          if (dataBufferRef.current.length > 2048) {
            dataBufferRef.current = dataBufferRef.current.slice(-1024);
          }
        }

        // For non-first tabs, consider immediately ready once we see a shell prompt
        if (!isFirstTab && !isEnvironmentReady) {
          dataBufferRef.current += text;
          const strippedBuffer = stripAnsi(dataBufferRef.current);

          // Look for shell prompt indicators
          const hasZshPrompt = strippedBuffer.includes("➜") || strippedBuffer.includes("❯");
          const hasWorkspace = strippedBuffer.includes("/workspace");

          if (hasZshPrompt || hasWorkspace || strippedBuffer.length > 100) {
            console.debug("[TerminalTab] Shell ready for non-first tab:", tabId);
            setIsEnvironmentReady(true);
            dataBufferRef.current = "";
          }

          if (dataBufferRef.current.length > 1024) {
            dataBufferRef.current = dataBufferRef.current.slice(-512);
          }
        }
      }
    },
    [isFirstTab, isEnvironmentReady, tabId, onReady]
  );

  // Determine user based on tab type - root tabs connect as orkroot
  const terminalUser = tabType === "root" ? ROOT_TERMINAL_USER : undefined;

  const { sessionId, isConnected, isConnecting, connect, resize, write } =
    useTerminal({
      containerId,
      onData: handleData,
      existingSessionId,
      persistSession: true, // Keep session alive when component unmounts (for tab moves)
      user: terminalUser,
    });

  // Persistent session tracking for sidebar display
  const persistentSessionCreatedRef = useRef(false);
  const persistentSessionIdRef = useRef<string | null>(null);
  const {
    createSession: createPersistentSession,
    updateSessionActivity,
    getSessionsByEnvironment,
    updateSessionStatus,
    isLoadingEnvironment,
    loadSessionsForEnvironment,
  } = useSessionStore();
  const setPersistentSessionId = useTerminalSessionStore((state) => state.setPersistentSessionId);
  const isSessionsLoading = isLoadingEnvironment(environmentId);

  // Ensure sessions are loaded for this environment before we try to check for existing ones
  useEffect(() => {
    if (environmentId) {
      loadSessionsForEnvironment(environmentId);
    }
  }, [environmentId, loadSessionsForEnvironment]);

  // Track if we've already restored from persistent session to avoid duplicate work
  const hasRestoredFromPersistentRef = useRef(false);

  // CRITICAL: Load persistent session data BEFORE PTY is created
  // This ensures hasLaunchedCommand is correctly set to prevent re-launching Claude
  // on app restart. Without this, terminalSessionStore is empty on startup.
  useEffect(() => {
    // Skip if we don't have the necessary IDs yet
    if (!environmentId || !containerId) {
      return;
    }

    // Skip if we already have session data in the store (e.g., tab moved between panes)
    if (existingSession) {
      return;
    }

    // Skip if we've already attempted restoration for this tab
    if (hasRestoredFromPersistentRef.current) {
      return;
    }

    // Skip if sessions are still loading - wait for them
    if (isSessionsLoading) {
      return;
    }

    // Check if a persistent session exists for this tab
    const existingSessions = getSessionsByEnvironment(environmentId);
    const existingPersistentSession = existingSessions.find((s) => s.tabId === tabId);

    if (existingPersistentSession) {
      hasRestoredFromPersistentRef.current = true;

      console.debug(
        "[TerminalTab] Restoring from persistent session:",
        existingPersistentSession.id,
        "hasLaunchedCommand:",
        existingPersistentSession.hasLaunchedCommand
      );

      // Create an entry in terminalSessionStore with hasLaunchedCommand from persistent session
      // IMPORTANT: Do NOT set a sessionId here - let useTerminal create a new PTY session
      // We only set hasLaunchedCommand (to prevent re-launching Claude) and persistentSessionId
      setSession(sessionKey, {
        hasLaunchedCommand: existingPersistentSession.hasLaunchedCommand ?? false,
        persistentSessionId: existingPersistentSession.id,
      });

      // Also set hasLaunchedCommandRef directly for immediate use
      hasLaunchedCommandRef.current = existingPersistentSession.hasLaunchedCommand ?? false;

      // Load the serialized buffer from persistent storage (async)
      loadSessionBuffer(existingPersistentSession.id)
        .then((buffer) => {
          if (buffer) {
            console.debug("[TerminalTab] Loaded persistent buffer, length:", buffer.length);
            setSerializedBuffer(sessionKey, buffer);
          }
        })
        .catch((err) => {
          console.error("[TerminalTab] Failed to load persistent buffer:", err);
        });
    } else {
      // No persistent session - mark as attempted so we don't keep checking
      hasRestoredFromPersistentRef.current = true;
    }
  }, [
    environmentId,
    containerId,
    tabId,
    sessionKey,
    existingSession,
    isSessionsLoading,
    getSessionsByEnvironment,
    setSession,
    setSerializedBuffer,
  ]);

  // Store session ID when we get one (for future reconnects after tab moves)
  // Preserve any existing session data (like hasLaunchedCommand from persistent session)
  useEffect(() => {
    if (sessionId && !existingSessionId) {
      console.debug("[TerminalTab] Storing new session ID for sessionKey:", sessionKey, sessionId);
      // Preserve existing data when updating the sessionId
      const currentSession = useTerminalSessionStore.getState().sessions.get(sessionKey);
      setSession(sessionKey, {
        ...currentSession,
        sessionId,
      });
    }
  }, [sessionId, existingSessionId, sessionKey, setSession]);

  // Create persistent session for sidebar tracking when we have a session ID
  // Check if a session already exists for this tabId to avoid duplicates on remount
  // IMPORTANT: Wait for sessions to be loaded before checking to avoid creating duplicates
  // Track creation in progress to prevent race conditions
  const creationInProgressRef = useRef(false);

  useEffect(() => {
    // Don't create session if still loading - wait for sessions to be loaded first
    if (isSessionsLoading) {
      return;
    }

    // Guard against concurrent creation attempts
    if (!sessionId || !containerId || !environmentId) {
      return;
    }

    // Already created or creation in progress
    if (persistentSessionCreatedRef.current || creationInProgressRef.current) {
      return;
    }

    // First, check if we already have a persistent session for this tab (before setting any flags)
    const existingSessions = getSessionsByEnvironment(environmentId);
    const existingPersistentSession = existingSessions.find((s) => s.tabId === tabId);

    if (existingPersistentSession) {
      // Session already exists - just mark it as connected and store the ID
      console.debug("[TerminalTab] Found existing persistent session:", existingPersistentSession.id);
      persistentSessionCreatedRef.current = true;
      persistentSessionIdRef.current = existingPersistentSession.id;
      setPersistentSessionId(sessionKey, existingPersistentSession.id);
      // Update status to connected if it was disconnected
      if (existingPersistentSession.status === "disconnected") {
        updateSessionStatus(existingPersistentSession.id, "connected").catch((err) => {
          console.error("[TerminalTab] Failed to update session status:", err);
        });
      }
    } else {
      // No existing session - create new one
      // Set in-progress flag to prevent concurrent attempts
      creationInProgressRef.current = true;
      const sessionType = tabTypeToSessionType(tabType);

      console.debug("[TerminalTab] Creating persistent session:", { sessionId, environmentId, tabType: sessionType });
      createPersistentSession(environmentId, containerId, tabId, sessionType)
        .then((session) => {
          console.debug("[TerminalTab] Persistent session created:", session.id);
          persistentSessionIdRef.current = session.id;
          persistentSessionCreatedRef.current = true;
          setPersistentSessionId(sessionKey, session.id);
        })
        .catch((err) => {
          console.error("[TerminalTab] Failed to create persistent session:", err);
        })
        .finally(() => {
          creationInProgressRef.current = false;
        });
    }
  }, [sessionId, containerId, environmentId, tabId, tabType, sessionKey, createPersistentSession, getSessionsByEnvironment, setPersistentSessionId, updateSessionStatus, isSessionsLoading]);

  // Update session activity on user interaction (key/mouse input)
  // This is more efficient than periodic updates and only tracks actual usage
  const lastActivityUpdateRef = useRef<number>(0);
  const updateActivityThrottledRef = useRef<() => void>(() => {});

  // Keep the ref updated with the latest callback
  useEffect(() => {
    updateActivityThrottledRef.current = () => {
      const now = Date.now();
      const persistentId = persistentSessionIdRef.current;
      // Throttle to once per 30 seconds
      if (persistentId && now - lastActivityUpdateRef.current > 30000) {
        lastActivityUpdateRef.current = now;
        updateSessionActivity(persistentId).catch((err) => {
          console.debug("[TerminalTab] Failed to update session activity:", err);
        });
      }
    };
  }, [updateSessionActivity]);

  // When reconnecting, restore terminal buffer and mark environment as ready
  useEffect(() => {
    if (isReconnecting && isConnected && !hasReconnected && xtermRef.current) {
      console.debug("[TerminalTab] Reconnected to existing session for tab:", tabId, "hasLaunchedCommand:", existingHasLaunchedCommand);

      // Restore the serialized buffer if available
      // Note: serializedBuffer is destructured above to avoid stale closure issues
      if (serializedBuffer) {
        console.debug("[TerminalTab] Restoring serialized buffer for tab:", tabId, "length:", serializedBuffer.length);
        xtermRef.current.write(serializedBuffer);
      }

      setHasReconnected(true);
      setIsEnvironmentReady(true);
      // Only skip re-launching if the command was already launched in a previous session
      hasLaunchedCommandRef.current = existingHasLaunchedCommand;
      onReady?.();
    }
  }, [isReconnecting, isConnected, hasReconnected, tabId, onReady, serializedBuffer, existingHasLaunchedCommand]);

  // Monitor Claude activity state for all tabs (needed for sidebar indicator)
  // Even plain tabs should show activity state if Claude is running in the container
  useClaudeState(containerId, tabId);

  const scheduleFit = useCallback(() => {
    if (!fitAddonRef.current || !xtermRef.current) return;
    requestAnimationFrame(() => {
      if (!fitAddonRef.current || !xtermRef.current) return;
      fitAddonRef.current.fit();
      const { cols, rows } = xtermRef.current;
      resize(cols, rows);
    });
  }, [resize]);

  // Keep write ref up to date and notify parent
  useEffect(() => {
    writeRef.current = write;
  }, [write]);

  // Notify parent of write function changes (separate effect to avoid stale closure)
  useEffect(() => {
    if (isConnected) {
      onWrite?.(writeRef.current);
    }
  }, [isConnected, onWrite]);

  // Initialize xterm.js
  useEffect(() => {
    if (!terminalRef.current || xtermRef.current) return;

    console.debug("[TerminalTab] Initializing xterm.js for tab:", tabId);

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily:
        `"${terminalAppearance.fontFamily}", "Fira Code", "Menlo", "DejaVu Sans Mono", "Courier New", monospace`,
      fontSize: terminalAppearance.fontSize,
      lineHeight: 1.2,
      scrollback: terminalScrollback,
      theme: {
        background: terminalAppearance.backgroundColor,
        foreground: "#e4e4e7",
        cursor: "#e4e4e7",
        cursorAccent: terminalAppearance.backgroundColor,
        selectionBackground: "#4b4b4b",
        black: "#1e1e1e",
        red: "#f87171",
        green: "#4ade80",
        yellow: "#facc15",
        blue: "#60a5fa",
        magenta: "#c084fc",
        cyan: "#22d3ee",
        white: "#e4e4e7",
        brightBlack: "#71717a",
        brightRed: "#fca5a5",
        brightGreen: "#86efac",
        brightYellow: "#fde047",
        brightBlue: "#93c5fd",
        brightMagenta: "#d8b4fe",
        brightCyan: "#67e8f9",
        brightWhite: "#f4f4f5",
      },
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon((event: MouseEvent, uri: string) => {
      // Only open links when Cmd (macOS) or Ctrl (Windows/Linux) is pressed
      if (event.metaKey || event.ctrlKey) {
        openInBrowser(uri).catch((err) => {
          console.error("Failed to open URL:", err);
        });
      }
    });
    const serializeAddon = new SerializeAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.loadAddon(serializeAddon);

    term.open(terminalRef.current);
    fitAddon.fit();

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;
    serializeAddonRef.current = serializeAddon;
    setIsReady(true);

    scheduleFit();
    if (document?.fonts?.ready) {
      document.fonts.ready.then(() => scheduleFit()).catch(() => {});
    }
    setTimeout(() => scheduleFit(), 50);

    // Handle user input
    term.onData((data) => {
      writeRef.current(data);
      // Update activity timestamp on user input (throttled)
      updateActivityThrottledRef.current();
    });

    // Intercept clipboard shortcuts
    // This runs BEFORE xterm processes the key event
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;

      const key = event.key.toLowerCase();
      const isMeta = event.metaKey;
      const isCtrl = event.ctrlKey;
      const isAlt = event.altKey;
      const isShift = event.shiftKey;

      // Let Ctrl+digit keys pass through to global handler for tab switching
      // Return false to prevent xterm from handling, allowing event to bubble up
      if (isCtrl && !isMeta && !isAlt && !isShift && event.code?.startsWith("Digit")) {
        return false;
      }

      // Copy: Cmd+C (Mac) or Ctrl+Shift+C (Linux/Windows)
      // Only intercept when there's a selection to preserve Ctrl+C for SIGINT
      const isCopyShortcut =
        (isMeta && key === "c") || (isCtrl && isShift && key === "c");
      if (isCopyShortcut && term.hasSelection() && !isAlt) {
        void handleCopySelection();
        return false;
      }

      // Select All: Cmd+A (Mac only)
      // Avoid overriding Ctrl+A which is "go to beginning of line" in shells
      if (isMeta && key === "a" && !isAlt) {
        handleSelectAll();
        return false;
      }

      // Paste: Cmd+V / Ctrl+V (handles both text and images)
      const isPasteShortcut = (isCtrl || isMeta) && key === "v";
      if (isPasteShortcut && !isAlt) {
        // Prevent default to stop browser from firing a paste event
        // (which would cause xterm to paste a second time)
        event.preventDefault();
        handlePaste();
        return false;
      }

      return true;
    });

    return () => {
      console.debug("[TerminalTab] Disposing xterm.js for sessionKey:", sessionKey);
      // Serialize the terminal buffer before disposing so we can restore it on reconnect
      if (serializeAddon) {
        try {
          const serialized = serializeAddon.serialize();
          if (serialized) {
            console.debug("[TerminalTab] Serialized buffer for sessionKey:", sessionKey, "length:", serialized.length);
            // Use the store directly since this is in cleanup
            useTerminalSessionStore.getState().setSerializedBuffer(sessionKey, serialized);

            // Also save to persistent session storage for sidebar display/reconnection
            // Get the persistent session ID from the store since we can't use the ref in cleanup
            const termSession = useTerminalSessionStore.getState().sessions.get(sessionKey);
            if (termSession?.persistentSessionId) {
              console.debug("[TerminalTab] Saving buffer to persistent session:", termSession.persistentSessionId);
              useSessionStore.getState().saveSessionBuffer(termSession.persistentSessionId, serialized)
                .catch((err) => {
                  console.error("[TerminalTab] Failed to save persistent buffer:", err);
                });
            }
          }
        } catch (err) {
          console.error("[TerminalTab] Failed to serialize buffer:", err);
        }
      }
      term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
      serializeAddonRef.current = null;
      setIsReady(false);
    };
  }, [
    sessionKey,
    scheduleFit,
    handleCopySelection,
    handlePaste,
    handleSelectAll,
  ]);

  // Update terminal appearance when settings change
  useEffect(() => {
    if (!xtermRef.current) return;

    const term = xtermRef.current;
    term.options.fontFamily = `"${terminalAppearance.fontFamily}", "Fira Code", "Menlo", "DejaVu Sans Mono", "Courier New", monospace`;
    term.options.fontSize = terminalAppearance.fontSize;
    // Safely spread existing theme options (fallback to empty object if undefined)
    term.options.theme = {
      ...(term.options.theme || {}),
      background: terminalAppearance.backgroundColor,
      cursorAccent: terminalAppearance.backgroundColor,
    };
    term.options.scrollback = terminalScrollback;

    // Refit after font changes
    if (fitAddonRef.current) {
      fitAddonRef.current.fit();
    }
  }, [terminalAppearance.fontFamily, terminalAppearance.fontSize, terminalAppearance.backgroundColor, terminalScrollback]);

  // Handle resize
  useEffect(() => {
    if (!fitAddonRef.current || !xtermRef.current) return;

    const handleResize = () => {
      if (fitAddonRef.current && xtermRef.current) {
        fitAddonRef.current.fit();
        const { cols, rows } = xtermRef.current;
        resize(cols, rows);
      }
    };

    handleResize();

    const resizeObserver = new ResizeObserver(() => handleResize());
    if (terminalRef.current) {
      resizeObserver.observe(terminalRef.current);
    }

    window.addEventListener("resize", handleResize);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", handleResize);
    };
  }, [isReady, resize]);

  // Connect when ready
  useEffect(() => {
    if (isReady && !isConnected && !isConnecting) {
      console.debug("[TerminalTab] Connecting tab:", tabId);
      connect();
    }
  }, [isReady, isConnected, isConnecting, connect, tabId]);

  // IMPORTANT: We don't disconnect on unmount because persistSession is true.
  // This allows the PTY session to survive when tabs move between panes.
  //
  // Session cleanup happens in paneLayoutStore.ts:removeTab() which:
  // 1. Removes the session from terminalSessionStore
  // 2. Calls tauri.detachTerminal() to close the backend PTY
  //
  // INVARIANT: All tab removals MUST go through paneLayoutStore.removeTab() to
  // ensure proper session cleanup. If you add a new way to remove tabs, ensure
  // it also handles terminal session cleanup.

  // Launch command based on tab type once environment is ready
  useEffect(() => {
    if (isEnvironmentReady && isConnected && !hasLaunchedCommandRef.current) {
      hasLaunchedCommandRef.current = true;
      // Mark in the session store that we've handled the launch (so we don't re-launch on reconnect)
      setHasLaunchedCommandStore(sessionKey, true);

      // Also persist to the backend so it survives app restart
      const persistentId = persistentSessionIdRef.current;
      if (persistentId) {
        setSessionHasLaunchedCommand(persistentId, true).catch((err) => {
          console.error("[TerminalTab] Failed to persist hasLaunchedCommand:", err);
        });
      }

      // Delay to ensure shell is ready
      setTimeout(() => {
        if (tabType === "claude") {
          // Build the claude command with dangerously-skip-permissions (always enabled)
          let command = "claude --dangerously-skip-permissions";
          // If there's an initial prompt, add it in quotes
          if (initialPrompt) {
            // Escape shell-special characters within double quotes: \, ", $, `
            const escapedPrompt = initialPrompt
              .replace(/\\/g, '\\\\')
              .replace(/"/g, '\\"')
              .replace(/\$/g, '\\$')
              .replace(/`/g, '\\`');
            command += ` "${escapedPrompt}"`;
          }
          console.debug("[TerminalTab] Launching command for tab:", tabId, "command:", command);
          writeRef.current(command + "\n");
        } else if (tabType === "opencode") {
          // Build the opencode command with optional initial prompt
          let command = "opencode";
          if (initialPrompt) {
            // Escape shell-special characters within double quotes: \, ", $, `
            const escapedPrompt = initialPrompt
              .replace(/\\/g, '\\\\')
              .replace(/"/g, '\\"')
              .replace(/\$/g, '\\$')
              .replace(/`/g, '\\`');
            command += ` --prompt "${escapedPrompt}"`;
          }
          console.debug("[TerminalTab] Launching command for tab:", tabId, "command:", command);
          writeRef.current(command + "\n");
        } else if (tabType === "plain" && initialCommands && initialCommands.length > 0) {
          // For plain tabs with initial commands, execute them
          console.debug("[TerminalTab] Executing initial commands for tab:", tabId, "commands:", initialCommands);
          // Join all commands with && to run sequentially
          const combinedCommand = initialCommands.join(" && ");
          writeRef.current(combinedCommand + "\n");
        }
        // For "plain" type without initialCommands, do nothing - just leave the shell prompt
      }, 300);
    }
  }, [isEnvironmentReady, isConnected, tabType, tabId, initialPrompt, initialCommands, sessionKey, setHasLaunchedCommandStore]);

  // Focus when active
  useEffect(() => {
    if (isActive && isConnected && xtermRef.current) {
      xtermRef.current.focus();
      scheduleFit();
    }
  }, [isActive, isConnected, scheduleFit]);

  const handleTerminalClick = useCallback(() => {
    if (xtermRef.current && isActive) {
      xtermRef.current.focus();
    }
  }, [isActive]);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={terminalRef}
          onClick={handleTerminalClick}
          className={cn(
            "absolute inset-0",
            !isActive && "opacity-0 pointer-events-none"
          )}
          style={{ backgroundColor: terminalAppearance.backgroundColor }}
        />
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={() => void handleCopySelection()} disabled={!hasSelection}>
          Copy
        </ContextMenuItem>
        <ContextMenuItem onClick={() => handlePaste()} disabled={!containerId}>
          Paste
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={handleSelectAll}>
          Select All
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

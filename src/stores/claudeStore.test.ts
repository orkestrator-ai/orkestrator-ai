import { beforeEach, describe, expect, test } from "bun:test";
import { createClaudeSessionKey, useClaudeStore } from "./claudeStore";

const SESSION_KEY = createClaudeSessionKey("env-1", "tab-1");

function resetClaudeStore() {
  useClaudeStore.setState({
    serverStatus: new Map(),
    clients: new Map(),
    eventSubscriptions: new Map(),
    sessions: new Map(),
    attachments: new Map(),
    draftText: new Map(),
    draftMentions: new Map(),
    isComposing: new Map(),
    effort: new Map(),
    planMode: new Map(),
    selectedModel: new Map(),
    messageQueue: new Map(),
    sessionInitData: new Map(),
    contextUsage: new Map(),
    pendingQuestions: new Map(),
    pendingPlanApprovals: new Map(),
    models: [],
  });
}

describe("claudeStore timer metadata", () => {
  beforeEach(() => {
    resetClaudeStore();
    useClaudeStore.getState().setSession(SESSION_KEY, {
      sessionId: "session-1",
      messages: [],
      isLoading: false,
    });
  });

  test("preserves timer metadata across loading transitions", () => {
    const originalNow = Date.now;
    Date.now = () => 1000;

    try {
      const store = useClaudeStore.getState();
      store.setSessionLoading(SESSION_KEY, true);

      let session = store.getSession(SESSION_KEY);
      expect(session?.loadingStartedAt).toBe(1000);
      expect(session?.lastCompletedElapsedSeconds).toBeNull();

      Date.now = () => 6500;
      store.setSessionLoading(SESSION_KEY, false);

      session = store.getSession(SESSION_KEY);
      expect(session?.loadingStartedAt).toBeUndefined();
      expect(session?.lastCompletedElapsedSeconds).toBe(5);
    } finally {
      Date.now = originalNow;
    }
  });

  test("reconciles timer metadata when a loading session refreshes", () => {
    const originalNow = Date.now;
    Date.now = () => 1000;

    try {
      const store = useClaudeStore.getState();
      store.setSessionLoading(SESSION_KEY, true);

      Date.now = () => 6500;
      store.setSession(SESSION_KEY, {
        sessionId: "session-1",
        messages: [],
        isLoading: false,
      });

      const session = store.getSession(SESSION_KEY);
      expect(session?.loadingStartedAt).toBeUndefined();
      expect(session?.lastCompletedElapsedSeconds).toBe(5);
    } finally {
      Date.now = originalNow;
    }
  });

  test("does not carry timer metadata across session id changes", () => {
    const originalNow = Date.now;
    Date.now = () => 1000;

    try {
      const store = useClaudeStore.getState();
      store.setSessionLoading(SESSION_KEY, true);

      Date.now = () => 8000;
      store.setSession(SESSION_KEY, {
        sessionId: "session-2",
        messages: [],
        isLoading: true,
      });

      const session = store.getSession(SESSION_KEY);
      expect(session?.sessionId).toBe("session-2");
      expect(session?.loadingStartedAt).toBe(8000);
      expect(session?.lastCompletedElapsedSeconds).toBeNull();
    } finally {
      Date.now = originalNow;
    }
  });
});

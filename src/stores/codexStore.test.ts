import { beforeEach, describe, expect, test } from "bun:test";
import { createOptimisticNativeMessage } from "@/lib/chat/client-only-messages";
import {
  createCodexSessionKey,
  useCodexStore,
} from "./codexStore";

const SESSION_KEY = createCodexSessionKey("env-1", "tab-1");

function resetCodexStore() {
  useCodexStore.setState({
    models: [],
    serverStatus: new Map(),
    clients: new Map(),
    sessions: new Map(),
    slashCommands: new Map(),
    attachments: new Map(),
    draftText: new Map(),
    draftMentions: new Map(),
    messageQueue: new Map(),
    selectedModel: new Map(),
    selectedMode: new Map(),
    selectedReasoningEffort: new Map(),
  });
}

describe("codexStore message helpers", () => {
  beforeEach(() => {
    resetCodexStore();
    useCodexStore.getState().setSession(SESSION_KEY, {
      sessionId: "session-1",
      messages: [],
      isLoading: false,
    });
  });

  test("addMessage and removeMessage update the target session only", () => {
    const store = useCodexStore.getState();
    const optimistic = createOptimisticNativeMessage("optimistic-1", "Review this");

    store.addMessage(SESSION_KEY, optimistic);
    expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.messages).toHaveLength(1);

    store.removeMessage(SESSION_KEY, optimistic.id);
    expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.messages).toHaveLength(0);
  });

  test("setMessages preserves optimistic prompts until Codex echoes the matching attachment", () => {
    const store = useCodexStore.getState();
    const optimistic = createOptimisticNativeMessage("optimistic-2", "Check the screenshot", [
      { path: "/workspace/a.png", name: "a.png" },
    ]);

    store.addMessage(SESSION_KEY, optimistic);

    store.setMessages(SESSION_KEY, [
      {
        id: "server-1",
        role: "user",
        content: "Check the screenshot",
        parts: [
          { type: "text", content: "Check the screenshot" },
          { type: "file", content: "b.png", fileUrl: "file:///workspace/b.png" },
        ],
        createdAt: "2026-04-15T10:00:02.000Z",
      },
    ]);

    const messages = useCodexStore.getState().sessions.get(SESSION_KEY)?.messages ?? [];
    expect(messages).toHaveLength(2);
    expect(messages.some((message) => message.id === optimistic.id)).toBe(true);
  });

  test("setMessages drops optimistic prompts once Codex echoes the matching attachment", () => {
    const store = useCodexStore.getState();
    const optimistic = createOptimisticNativeMessage("optimistic-3", "Check the screenshot", [
      { path: "/workspace/a.png", name: "a.png" },
    ]);

    store.addMessage(SESSION_KEY, optimistic);

    store.setMessages(SESSION_KEY, [
      {
        id: "server-2",
        role: "user",
        content: "Check the screenshot",
        parts: [
          { type: "text", content: "Check the screenshot" },
          { type: "file", content: "a.png", fileUrl: "file:///workspace/a.png" },
        ],
        createdAt: "2026-04-15T10:00:02.000Z",
      },
    ]);

    const messages = useCodexStore.getState().sessions.get(SESSION_KEY)?.messages ?? [];
    expect(messages).toHaveLength(1);
    expect(messages[0]?.id).toBe("server-2");
  });
});

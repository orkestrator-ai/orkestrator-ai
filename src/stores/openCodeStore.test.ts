import { beforeEach, describe, expect, test } from "bun:test";
import { ERROR_MESSAGE_PREFIX, type OpenCodeMessage } from "../lib/opencode-client";
import { type OpenCodeAttachment, useOpenCodeStore } from "./openCodeStore";

function resetOpenCodeStore() {
  useOpenCodeStore.setState({
    serverStatus: new Map(),
    sessions: new Map(),
    clients: new Map(),
    models: [],
    selectedModel: new Map(),
    selectedVariant: new Map(),
    selectedMode: new Map(),
    attachments: new Map(),
    draftText: new Map(),
    isComposing: new Map(),
    pendingQuestions: new Map(),
    eventSubscriptions: new Map(),
  });
}

function createTextMessage(id: string, createdAt: string): OpenCodeMessage {
  return {
    id,
    role: "assistant",
    content: id,
    parts: [{ type: "text", content: id }],
    createdAt,
  };
}

describe("openCodeStore setMessages", () => {
  beforeEach(() => {
    resetOpenCodeStore();
  });

  test("preserves client-side error messages once during refresh", () => {
    const store = useOpenCodeStore.getState();
    const sessionKey = "env-env-1:tab-1";

    const serverMessage = createTextMessage("msg-1", "2026-02-11T00:00:00.000Z");
    const errorMessage = createTextMessage(
      `${ERROR_MESSAGE_PREFIX}msg-1`,
      "2026-02-11T00:01:00.000Z"
    );

    store.setSession(sessionKey, {
      sessionId: "session-1",
      messages: [serverMessage, errorMessage],
      isLoading: false,
    });

    store.setMessages(sessionKey, [serverMessage]);

    const messages = useOpenCodeStore.getState().getSession(sessionKey)?.messages ?? [];
    expect(messages).toHaveLength(2);
    expect(messages.filter((m) => m.id === errorMessage.id)).toHaveLength(1);
  });

  test("does not duplicate error messages already included in incoming payload", () => {
    const store = useOpenCodeStore.getState();
    const sessionKey = "env-env-2:tab-1";

    const serverMessage = createTextMessage("msg-2", "2026-02-11T00:00:00.000Z");
    const errorMessage = createTextMessage(
      `${ERROR_MESSAGE_PREFIX}msg-2`,
      "2026-02-11T00:01:00.000Z"
    );

    store.setSession(sessionKey, {
      sessionId: "session-2",
      messages: [serverMessage, errorMessage],
      isLoading: false,
    });

    store.setMessages(sessionKey, [serverMessage, errorMessage]);

    const messages = useOpenCodeStore.getState().getSession(sessionKey)?.messages ?? [];
    expect(messages.filter((m) => m.id === errorMessage.id)).toHaveLength(1);
  });
});

describe("openCodeStore attachment cleanup", () => {
  beforeEach(() => {
    resetOpenCodeStore();
  });

  test("clearEnvironment removes attachments for every tab in the environment", () => {
    const store = useOpenCodeStore.getState();

    const attachmentA: OpenCodeAttachment = {
      id: "att-a",
      type: "image",
      path: "/workspace/a.png",
      name: "a.png",
    };
    const attachmentB: OpenCodeAttachment = {
      id: "att-b",
      type: "image",
      path: "/workspace/b.png",
      name: "b.png",
    };
    const attachmentOther: OpenCodeAttachment = {
      id: "att-c",
      type: "image",
      path: "/workspace/c.png",
      name: "c.png",
    };

    store.addAttachment("env-env-123:tab-1", attachmentA);
    store.addAttachment("env-env-123:tab-2", attachmentB);
    store.addAttachment("env-env-999:tab-1", attachmentOther);

    store.clearEnvironment("env-123");

    expect(useOpenCodeStore.getState().getAttachments("env-env-123:tab-1")).toHaveLength(0);
    expect(useOpenCodeStore.getState().getAttachments("env-env-123:tab-2")).toHaveLength(0);
    expect(useOpenCodeStore.getState().getAttachments("env-env-999:tab-1")).toHaveLength(1);
  });
});

describe("openCodeStore draft text", () => {
  beforeEach(() => {
    resetOpenCodeStore();
  });

  test("setDraftText stores and clears draft text per tab session", () => {
    const store = useOpenCodeStore.getState();
    const sessionKey = "env-env-123:tab-1";

    store.setDraftText(sessionKey, "draft message");
    expect(useOpenCodeStore.getState().getDraftText(sessionKey)).toBe("draft message");

    store.setDraftText(sessionKey, "");
    expect(useOpenCodeStore.getState().getDraftText(sessionKey)).toBe("");
  });

  test("clearEnvironment removes draft text for every tab in the environment", () => {
    const store = useOpenCodeStore.getState();

    store.setDraftText("env-env-123:tab-1", "draft a");
    store.setDraftText("env-env-123:tab-2", "draft b");
    store.setDraftText("env-env-999:tab-1", "keep");

    store.clearEnvironment("env-123");

    expect(useOpenCodeStore.getState().getDraftText("env-env-123:tab-1")).toBe("");
    expect(useOpenCodeStore.getState().getDraftText("env-env-123:tab-2")).toBe("");
    expect(useOpenCodeStore.getState().getDraftText("env-env-999:tab-1")).toBe("keep");
  });
});

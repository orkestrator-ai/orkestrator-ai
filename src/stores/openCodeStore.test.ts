import { beforeEach, describe, expect, test } from "bun:test";
import { ERROR_MESSAGE_PREFIX, type OpenCodeMessage, type PermissionRequest } from "../lib/opencode-client";
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
    messageQueue: new Map(),
    isComposing: new Map(),
    pendingQuestions: new Map(),
    pendingPermissions: new Map(),
    eventSubscriptions: new Map(),
    contextUsage: new Map(),
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

describe("openCodeStore selected mode", () => {
  beforeEach(() => {
    resetOpenCodeStore();
  });

  test("stores mode per tab session key", () => {
    const store = useOpenCodeStore.getState();

    store.setSelectedMode("env-env-123:tab-1", "plan");
    store.setSelectedMode("env-env-123:tab-2", "build");

    expect(useOpenCodeStore.getState().getSelectedMode("env-env-123:tab-1")).toBe("plan");
    expect(useOpenCodeStore.getState().getSelectedMode("env-env-123:tab-2")).toBe("build");
    expect(useOpenCodeStore.getState().getSelectedMode("env-env-123:tab-3")).toBe("build");
  });

  test("clearEnvironment removes tab-scoped mode keys for the environment", () => {
    const store = useOpenCodeStore.getState();

    store.setSelectedMode("env-env-123:tab-1", "plan");
    store.setSelectedMode("env-env-123:tab-2", "plan");
    store.setSelectedMode("env-env-999:tab-1", "plan");

    store.clearEnvironment("env-123");

    expect(useOpenCodeStore.getState().getSelectedMode("env-env-123:tab-1")).toBe("build");
    expect(useOpenCodeStore.getState().getSelectedMode("env-env-123:tab-2")).toBe("build");
    expect(useOpenCodeStore.getState().getSelectedMode("env-env-999:tab-1")).toBe("plan");
  });
});

describe("openCodeStore queue", () => {
  beforeEach(() => {
    resetOpenCodeStore();
  });

  test("queues prompts per tab and dequeues in FIFO order", () => {
    const store = useOpenCodeStore.getState();
    const sessionKey = "env-env-123:tab-1";

    store.addToQueue(sessionKey, {
      id: "queue-1",
      text: "First prompt",
      attachments: [],
      mode: "build",
    });
    store.addToQueue(sessionKey, {
      id: "queue-2",
      text: "Second prompt",
      attachments: [],
      mode: "plan",
    });

    expect(useOpenCodeStore.getState().getQueueLength(sessionKey)).toBe(2);

    const first = store.removeFromQueue(sessionKey);
    const second = store.removeFromQueue(sessionKey);
    const third = store.removeFromQueue(sessionKey);

    expect(first?.id).toBe("queue-1");
    expect(second?.id).toBe("queue-2");
    expect(third).toBeUndefined();
    expect(useOpenCodeStore.getState().getQueueLength(sessionKey)).toBe(0);
  });

  test("clearEnvironment removes queued prompts for every tab session", () => {
    const store = useOpenCodeStore.getState();

    store.addToQueue("env-env-123:tab-1", {
      id: "queue-a",
      text: "A",
      attachments: [],
      mode: "build",
    });
    store.addToQueue("env-env-123:tab-2", {
      id: "queue-b",
      text: "B",
      attachments: [],
      mode: "build",
    });
    store.addToQueue("env-env-999:tab-1", {
      id: "queue-c",
      text: "C",
      attachments: [],
      mode: "build",
    });

    store.clearEnvironment("env-123");

    expect(useOpenCodeStore.getState().getQueueLength("env-env-123:tab-1")).toBe(0);
    expect(useOpenCodeStore.getState().getQueueLength("env-env-123:tab-2")).toBe(0);
    expect(useOpenCodeStore.getState().getQueueLength("env-env-999:tab-1")).toBe(1);
  });

  test("removeQueueItem removes only the targeted queued prompt", () => {
    const store = useOpenCodeStore.getState();
    const sessionKey = "env-env-123:tab-1";

    store.addToQueue(sessionKey, {
      id: "queue-1",
      text: "First",
      attachments: [],
      mode: "build",
    });
    store.addToQueue(sessionKey, {
      id: "queue-2",
      text: "Second",
      attachments: [],
      mode: "build",
    });

    store.removeQueueItem(sessionKey, "queue-1");

    expect(useOpenCodeStore.getState().getQueueLength(sessionKey)).toBe(1);
    expect(store.removeFromQueue(sessionKey)?.id).toBe("queue-2");
  });

  test("moveQueueItem reorders queued prompts", () => {
    const store = useOpenCodeStore.getState();
    const sessionKey = "env-env-123:tab-1";

    store.addToQueue(sessionKey, {
      id: "queue-1",
      text: "First",
      attachments: [],
      mode: "build",
    });
    store.addToQueue(sessionKey, {
      id: "queue-2",
      text: "Second",
      attachments: [],
      mode: "build",
    });
    store.addToQueue(sessionKey, {
      id: "queue-3",
      text: "Third",
      attachments: [],
      mode: "build",
    });

    store.moveQueueItem(sessionKey, 2, 0);

    expect(store.removeFromQueue(sessionKey)?.id).toBe("queue-3");
    expect(store.removeFromQueue(sessionKey)?.id).toBe("queue-1");
    expect(store.removeFromQueue(sessionKey)?.id).toBe("queue-2");
  });
});

describe("openCodeStore pending permissions", () => {
  beforeEach(() => {
    resetOpenCodeStore();
  });

  test("tracks pending permissions per session", () => {
    const store = useOpenCodeStore.getState();

    const permission: PermissionRequest = {
      id: "perm-1",
      sessionID: "session-1",
      permission: "read",
      patterns: ["/workspace/**"],
      metadata: {},
      always: ["/workspace/**"],
    };

    store.addPendingPermission(permission);

    const permissions = useOpenCodeStore
      .getState()
      .getPendingPermissionsForSession("session-1");

    expect(permissions).toHaveLength(1);
    expect(permissions[0]?.id).toBe("perm-1");
  });

  test("clearEnvironment removes pending permissions for every tab session", () => {
    const store = useOpenCodeStore.getState();

    store.setSession("env-env-123:tab-1", {
      sessionId: "session-1",
      messages: [],
      isLoading: false,
    });
    store.setSession("env-env-123:tab-2", {
      sessionId: "session-2",
      messages: [],
      isLoading: false,
    });
    store.setSession("env-env-999:tab-1", {
      sessionId: "session-3",
      messages: [],
      isLoading: false,
    });

    store.addPendingPermission({
      id: "perm-a",
      sessionID: "session-1",
      permission: "read",
      patterns: ["/workspace/a/**"],
      metadata: {},
      always: ["/workspace/a/**"],
    });
    store.addPendingPermission({
      id: "perm-b",
      sessionID: "session-2",
      permission: "bash",
      patterns: ["*"],
      metadata: {},
      always: [],
    });
    store.addPendingPermission({
      id: "perm-c",
      sessionID: "session-3",
      permission: "read",
      patterns: ["/workspace/c/**"],
      metadata: {},
      always: ["/workspace/c/**"],
    });

    store.clearEnvironment("env-123");

    expect(useOpenCodeStore.getState().getPendingPermission("perm-a")).toBeUndefined();
    expect(useOpenCodeStore.getState().getPendingPermission("perm-b")).toBeUndefined();
    expect(useOpenCodeStore.getState().getPendingPermission("perm-c")).toBeDefined();
  });
});

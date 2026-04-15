import { beforeEach, describe, expect, test } from "bun:test";
import { usePaneLayoutStore } from "./paneLayoutStore";

function resetPaneLayoutStore() {
  usePaneLayoutStore.setState({
    environments: new Map(),
    activeEnvironmentId: null,
  });
}

describe("paneLayoutStore environment scoping", () => {
  beforeEach(() => {
    resetPaneLayoutStore();
  });

  test("initializes a hidden environment without changing the active environment", () => {
    const store = usePaneLayoutStore.getState();

    store.setActiveEnvironment("env-visible");
    store.initialize("container-visible", "env-visible");
    store.initialize("container-hidden", "env-hidden");

    const state = usePaneLayoutStore.getState();
    expect(state.activeEnvironmentId).toBe("env-visible");
    expect(state.environments.get("env-visible")?.containerId).toBe("container-visible");
    expect(state.environments.get("env-hidden")?.containerId).toBe("container-hidden");
  });

  test("updates tabs for an explicit environment even when another environment is active", () => {
    const store = usePaneLayoutStore.getState();

    store.initialize("container-a", "env-a");
    store.initialize("container-b", "env-b");
    store.addTab("default", { id: "a-1", type: "plain" }, "env-a");
    store.addTab("default", { id: "a-2", type: "claude" }, "env-a");
    store.addTab("default", { id: "b-1", type: "plain" }, "env-b");
    store.setActiveEnvironment("env-b");

    store.setActiveTab("default", "a-1", "env-a");

    const envA = usePaneLayoutStore.getState().environments.get("env-a");
    expect(envA?.root.kind).toBe("leaf");
    if (!envA || envA.root.kind !== "leaf") {
      throw new Error("env-a root should be a leaf");
    }

    expect(envA.root.activeTabId).toBe("a-1");
    expect(usePaneLayoutStore.getState().activeEnvironmentId).toBe("env-b");
  });

  test("reads environment-scoped getters without relying on the active environment", () => {
    const store = usePaneLayoutStore.getState();

    store.initialize("container-a", "env-a");
    store.initialize("container-b", "env-b");
    store.addTab("default", {
      id: "file-a",
      type: "file",
      fileData: {
        filePath: "/tmp/env-a.txt",
        isLocalEnvironment: true,
      },
    }, "env-a");
    store.addTab("default", { id: "plain-b", type: "plain" }, "env-b");
    store.setActiveEnvironment("env-b");

    expect(store.getContainerId("env-a")).toBe("container-a");
    expect(store.getAllTabs("env-a").map((tab) => tab.id)).toEqual(["file-a"]);
    expect(store.getOpenFilePaths("env-a")).toEqual(["/tmp/env-a.txt"]);
    expect(store.findPaneWithTab("file-a", "env-a")?.id).toBe("default");
    expect(store.getPane("default", "env-a")?.id).toBe("default");
    expect(store.getActivePane("env-a")?.activeTabId).toBe("file-a");
    expect(store.getRoot("env-a").kind).toBe("leaf");
    expect(usePaneLayoutStore.getState().activeEnvironmentId).toBe("env-b");
  });

  test("sets and resets a hidden environment without changing the active environment", () => {
    usePaneLayoutStore.setState({
      environments: new Map([
        ["env-a", {
          root: {
            kind: "leaf",
            id: "pane-a",
            tabs: [{ id: "tab-a", type: "plain" }],
            activeTabId: "tab-a",
          },
          activePaneId: "stale-pane",
          containerId: "container-a",
        }],
        ["env-b", {
          root: {
            kind: "leaf",
            id: "default",
            tabs: [{ id: "tab-b", type: "plain" }],
            activeTabId: "tab-b",
          },
          activePaneId: "default",
          containerId: "container-b",
        }],
      ]),
      activeEnvironmentId: "env-b",
    });

    const store = usePaneLayoutStore.getState();
    store.setActivePane("pane-a", "env-a");

    expect(usePaneLayoutStore.getState().environments.get("env-a")?.activePaneId).toBe("pane-a");
    expect(usePaneLayoutStore.getState().activeEnvironmentId).toBe("env-b");

    store.reset("env-a");

    const envA = usePaneLayoutStore.getState().environments.get("env-a");
    expect(envA?.containerId).toBeNull();
    expect(envA?.activePaneId).toBe("default");
    expect(envA?.root.kind).toBe("leaf");
    if (!envA || envA.root.kind !== "leaf") {
      throw new Error("env-a root should be reset to a leaf");
    }

    expect(envA.root.tabs).toEqual([]);
    expect(envA.root.activeTabId).toBeNull();
    expect(usePaneLayoutStore.getState().activeEnvironmentId).toBe("env-b");
  });
});

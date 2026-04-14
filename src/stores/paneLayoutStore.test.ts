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
});

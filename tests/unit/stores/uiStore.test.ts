import { describe, test, expect, beforeEach } from "bun:test";
import { useUIStore } from "../../../src/stores/uiStore";

describe("uiStore", () => {
  beforeEach(() => {
    // Reset store between tests
    useUIStore.setState({
      sidebarView: "projects",
      selectedProjectId: null,
      selectedEnvironmentId: null,
      sidebarWidth: 280,
    });
  });

  test("initial state has correct defaults", () => {
    const state = useUIStore.getState();
    expect(state.sidebarView).toBe("projects");
    expect(state.selectedProjectId).toBeNull();
    expect(state.selectedEnvironmentId).toBeNull();
    expect(state.sidebarWidth).toBe(280);
  });

  test("setSidebarView updates the view", () => {
    useUIStore.getState().setSidebarView("environments");
    expect(useUIStore.getState().sidebarView).toBe("environments");

    useUIStore.getState().setSidebarView("projects");
    expect(useUIStore.getState().sidebarView).toBe("projects");
  });

  test("selectProject sets project and clears environment", () => {
    // First set an environment
    useUIStore.setState({ selectedEnvironmentId: "env-1" });

    useUIStore.getState().selectProject("project-1");

    const state = useUIStore.getState();
    expect(state.selectedProjectId).toBe("project-1");
    expect(state.selectedEnvironmentId).toBeNull();
  });

  test("selectProject with null clears selection", () => {
    useUIStore.setState({
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-1",
    });

    useUIStore.getState().selectProject(null);

    const state = useUIStore.getState();
    expect(state.selectedProjectId).toBeNull();
    expect(state.selectedEnvironmentId).toBeNull();
  });

  test("selectEnvironment sets environment id", () => {
    useUIStore.getState().selectEnvironment("env-1");
    expect(useUIStore.getState().selectedEnvironmentId).toBe("env-1");
  });

  test("selectEnvironment with null clears environment", () => {
    useUIStore.setState({ selectedEnvironmentId: "env-1" });

    useUIStore.getState().selectEnvironment(null);
    expect(useUIStore.getState().selectedEnvironmentId).toBeNull();
  });

  test("setSidebarWidth updates the width", () => {
    useUIStore.getState().setSidebarWidth(350);
    expect(useUIStore.getState().sidebarWidth).toBe(350);

    useUIStore.getState().setSidebarWidth(200);
    expect(useUIStore.getState().sidebarWidth).toBe(200);
  });

  test("navigateToEnvironments sets view, project, and clears environment", () => {
    useUIStore.setState({ selectedEnvironmentId: "env-1" });

    useUIStore.getState().navigateToEnvironments("project-1");

    const state = useUIStore.getState();
    expect(state.sidebarView).toBe("environments");
    expect(state.selectedProjectId).toBe("project-1");
    expect(state.selectedEnvironmentId).toBeNull();
  });

  test("navigateToProjects resets to projects view and clears selections", () => {
    useUIStore.setState({
      sidebarView: "environments",
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-1",
    });

    useUIStore.getState().navigateToProjects();

    const state = useUIStore.getState();
    expect(state.sidebarView).toBe("projects");
    expect(state.selectedProjectId).toBeNull();
    expect(state.selectedEnvironmentId).toBeNull();
  });

  test("navigation workflow: projects -> environments -> projects", () => {
    // Start at projects
    expect(useUIStore.getState().sidebarView).toBe("projects");

    // Navigate to environments for a project
    useUIStore.getState().navigateToEnvironments("project-1");
    let state = useUIStore.getState();
    expect(state.sidebarView).toBe("environments");
    expect(state.selectedProjectId).toBe("project-1");

    // Select an environment
    useUIStore.getState().selectEnvironment("env-1");
    expect(useUIStore.getState().selectedEnvironmentId).toBe("env-1");

    // Navigate back to projects
    useUIStore.getState().navigateToProjects();
    state = useUIStore.getState();
    expect(state.sidebarView).toBe("projects");
    expect(state.selectedProjectId).toBeNull();
    expect(state.selectedEnvironmentId).toBeNull();
  });
});

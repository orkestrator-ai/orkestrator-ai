import { describe, test, expect, beforeEach, mock } from "bun:test";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useEnvironmentStore } from "../../../src/stores/environmentStore";
import type { Environment, EnvironmentStatus } from "../../../src/types";
import { createMockEnvironment } from "../utils/testFactories";

// Mock tauri module BEFORE importing the hook
const mockGetEnvironments = mock<(projectId: string) => Promise<Environment[]>>(() => Promise.resolve([]));
const mockGetEnvironment = mock<(environmentId: string) => Promise<Environment | null>>(() => Promise.resolve(null));
const mockCreateEnvironment = mock<(projectId: string) => Promise<Environment>>((projectId) =>
  Promise.resolve(createMockEnvironment({ id: "new-env-id", projectId, name: "test-env" }))
);
const mockDeleteEnvironment = mock<(environmentId: string) => Promise<void>>(() => Promise.resolve());
const mockStartEnvironment = mock<(environmentId: string) => Promise<void>>(() => Promise.resolve());
const mockStopEnvironment = mock<(environmentId: string) => Promise<void>>(() => Promise.resolve());
const mockSyncEnvironmentStatus = mock<(environmentId: string) => Promise<Environment>>((environmentId) =>
  Promise.resolve(createMockEnvironment({ id: environmentId, containerId: "container-123", status: "running" }))
);

mock.module("@/lib/tauri", () => ({
  getEnvironments: mockGetEnvironments,
  getEnvironment: mockGetEnvironment,
  createEnvironment: mockCreateEnvironment,
  deleteEnvironment: mockDeleteEnvironment,
  startEnvironment: mockStartEnvironment,
  stopEnvironment: mockStopEnvironment,
  syncEnvironmentStatus: mockSyncEnvironmentStatus,
}));

// Import hook AFTER mocking
import { useEnvironments } from "../../../src/hooks/useEnvironments";

describe("useEnvironments", () => {
  beforeEach(() => {
    // Reset store between tests
    useEnvironmentStore.setState({
      environments: [],
      isLoading: false,
      error: null,
    });

    // Reset mocks
    mockGetEnvironments.mockClear();
    mockGetEnvironment.mockClear();
    mockCreateEnvironment.mockClear();
    mockDeleteEnvironment.mockClear();
    mockStartEnvironment.mockClear();
    mockStopEnvironment.mockClear();
    mockSyncEnvironmentStatus.mockClear();

    // Reset to default implementations
    mockGetEnvironments.mockImplementation(() => Promise.resolve([]));
    mockGetEnvironment.mockImplementation(() => Promise.resolve(null));
    mockCreateEnvironment.mockImplementation((projectId) =>
      Promise.resolve(createMockEnvironment({ id: "new-env-id", projectId, name: "test-env" }))
    );
    mockDeleteEnvironment.mockImplementation(() => Promise.resolve());
    mockStartEnvironment.mockImplementation(() => Promise.resolve());
    mockStopEnvironment.mockImplementation(() => Promise.resolve());
    mockSyncEnvironmentStatus.mockImplementation((environmentId) =>
      Promise.resolve(createMockEnvironment({ id: environmentId, containerId: "container-123", status: "running" }))
    );
  });

  test("returns empty environments when no projectId", () => {
    const { result } = renderHook(() => useEnvironments(null));

    expect(result.current.environments).toEqual([]);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  test("loads environments when projectId is provided", async () => {
    const mockEnvs: Environment[] = [
      createMockEnvironment({ id: "env-1", projectId: "project-1", name: "test-env-1" }),
    ];
    mockGetEnvironments.mockImplementation(() => Promise.resolve(mockEnvs));

    const { result } = renderHook(() => useEnvironments("project-1"));

    await waitFor(() => {
      expect(result.current.environments).toHaveLength(1);
    });

    expect(mockGetEnvironments).toHaveBeenCalledWith("project-1");
    expect(result.current.environments[0]?.id).toBe("env-1");
  });

  test("createEnvironment creates an environment successfully", async () => {
    const { result } = renderHook(() => useEnvironments("project-1"));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    let createdEnv: Environment | undefined;
    await act(async () => {
      createdEnv = await result.current.createEnvironment("project-1");
    });

    expect(mockCreateEnvironment).toHaveBeenCalledWith("project-1", undefined);
    expect(createdEnv?.id).toBe("new-env-id");
    expect(result.current.allEnvironments).toHaveLength(1);
    expect(result.current.error).toBeNull();
  });

  test("createEnvironment sets error on failure", async () => {
    const expectedError = new Error("Failed to create");
    mockCreateEnvironment.mockImplementation(() => Promise.reject(expectedError));

    const { result } = renderHook(() => useEnvironments("project-1"));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    let thrownError: Error | undefined;
    try {
      await act(async () => {
        await result.current.createEnvironment("project-1");
      });
    } catch (error) {
      thrownError = error as Error;
    }

    // Verify the correct error was thrown
    expect(thrownError).toBeDefined();
    expect(thrownError?.message).toBe("Failed to create");

    expect(result.current.error).toBe("Failed to create");
  });

  test("deleteEnvironment deletes an environment successfully", async () => {
    const existingEnv = createMockEnvironment({ id: "env-1", projectId: "project-1", name: "test-env" });

    useEnvironmentStore.setState({
      environments: [existingEnv],
      isLoading: false,
      error: null,
    });

    mockGetEnvironments.mockImplementation(() => Promise.resolve([existingEnv]));

    const { result } = renderHook(() => useEnvironments("project-1"));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    await act(async () => {
      await result.current.deleteEnvironment("env-1");
    });

    expect(mockDeleteEnvironment).toHaveBeenCalledWith("env-1");
    expect(result.current.allEnvironments).toHaveLength(0);
    expect(result.current.error).toBeNull();
  });

  test("deleteEnvironment sets error on failure", async () => {
    const expectedError = new Error("Failed to delete");
    mockDeleteEnvironment.mockImplementation(() => Promise.reject(expectedError));

    const existingEnv = createMockEnvironment({ id: "env-1", projectId: "project-1", name: "test-env" });

    useEnvironmentStore.setState({
      environments: [existingEnv],
      isLoading: false,
      error: null,
    });

    mockGetEnvironments.mockImplementation(() => Promise.resolve([existingEnv]));

    const { result } = renderHook(() => useEnvironments("project-1"));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    let thrownError: Error | undefined;
    try {
      await act(async () => {
        await result.current.deleteEnvironment("env-1");
      });
    } catch (error) {
      thrownError = error as Error;
    }

    // Verify the correct error was thrown
    expect(thrownError).toBeDefined();
    expect(thrownError?.message).toBe("Failed to delete");

    expect(result.current.error).toBe("Failed to delete");
    expect(result.current.allEnvironments).toHaveLength(1);
  });

  test("startEnvironment starts an environment and updates status", async () => {
    const existingEnv = createMockEnvironment({
      id: "env-1",
      projectId: "project-1",
      name: "test-env",
      containerId: "container-123",
      status: "stopped",
    });

    useEnvironmentStore.setState({
      environments: [existingEnv],
      isLoading: false,
      error: null,
    });

    mockGetEnvironments.mockImplementation(() => Promise.resolve([existingEnv]));
    mockGetEnvironment.mockImplementation(() =>
      Promise.resolve(createMockEnvironment({ ...existingEnv, status: "running" }))
    );

    const { result } = renderHook(() => useEnvironments("project-1"));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    await act(async () => {
      await result.current.startEnvironment("env-1");
    });

    expect(mockStartEnvironment).toHaveBeenCalledWith("env-1");
    expect(mockGetEnvironment).toHaveBeenCalledWith("env-1");
  });

  test("startEnvironment sets error on failure", async () => {
    const expectedError = new Error("Failed to start");
    mockStartEnvironment.mockImplementation(() => Promise.reject(expectedError));

    const existingEnv = createMockEnvironment({
      id: "env-1",
      projectId: "project-1",
      name: "test-env",
      containerId: "container-123",
      status: "stopped",
    });

    useEnvironmentStore.setState({
      environments: [existingEnv],
      isLoading: false,
      error: null,
    });

    mockGetEnvironments.mockImplementation(() => Promise.resolve([existingEnv]));

    const { result } = renderHook(() => useEnvironments("project-1"));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    let thrownError: Error | undefined;
    try {
      await act(async () => {
        await result.current.startEnvironment("env-1");
      });
    } catch (error) {
      thrownError = error as Error;
    }

    // Verify the correct error was thrown
    expect(thrownError).toBeDefined();
    expect(thrownError?.message).toBe("Failed to start");

    expect(result.current.error).toBe("Failed to start");
    // Status should be set to error
    expect(result.current.allEnvironments[0]?.status).toBe("error");
  });

  test("stopEnvironment stops an environment and updates status", async () => {
    const existingEnv = createMockEnvironment({
      id: "env-1",
      projectId: "project-1",
      name: "test-env",
      containerId: "container-123",
      status: "running",
    });

    useEnvironmentStore.setState({
      environments: [existingEnv],
      isLoading: false,
      error: null,
    });

    mockGetEnvironments.mockImplementation(() => Promise.resolve([existingEnv]));

    const { result } = renderHook(() => useEnvironments("project-1"));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    await act(async () => {
      await result.current.stopEnvironment("env-1");
    });

    expect(mockStopEnvironment).toHaveBeenCalledWith("env-1");
    expect(result.current.allEnvironments[0]?.status).toBe("stopped");
  });

  test("stopEnvironment sets error on failure", async () => {
    const expectedError = new Error("Failed to stop");
    mockStopEnvironment.mockImplementation(() => Promise.reject(expectedError));

    const existingEnv = createMockEnvironment({
      id: "env-1",
      projectId: "project-1",
      name: "test-env",
      containerId: "container-123",
      status: "running",
    });

    useEnvironmentStore.setState({
      environments: [existingEnv],
      isLoading: false,
      error: null,
    });

    mockGetEnvironments.mockImplementation(() => Promise.resolve([existingEnv]));

    const { result } = renderHook(() => useEnvironments("project-1"));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    let thrownError: Error | undefined;
    try {
      await act(async () => {
        await result.current.stopEnvironment("env-1");
      });
    } catch (error) {
      thrownError = error as Error;
    }

    // Verify the correct error was thrown
    expect(thrownError).toBeDefined();
    expect(thrownError?.message).toBe("Failed to stop");

    expect(result.current.error).toBe("Failed to stop");
  });

  test("syncEnvironmentStatus updates environment data", async () => {
    const existingEnv = createMockEnvironment({
      id: "env-1",
      projectId: "project-1",
      name: "test-env",
      containerId: null,
      status: "stopped",
    });

    useEnvironmentStore.setState({
      environments: [existingEnv],
      isLoading: false,
      error: null,
    });

    mockGetEnvironments.mockImplementation(() => Promise.resolve([existingEnv]));

    const { result } = renderHook(() => useEnvironments("project-1"));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    await act(async () => {
      await result.current.syncEnvironmentStatus("env-1");
    });

    expect(mockSyncEnvironmentStatus).toHaveBeenCalledWith("env-1");
    // The mock returns a running status with containerId
    expect(result.current.allEnvironments[0]?.status).toBe("running");
    expect(result.current.allEnvironments[0]?.containerId).toBe("container-123");
  });

  test("getEnvironmentsByProjectId filters environments correctly", async () => {
    const envs: Environment[] = [
      createMockEnvironment({ id: "env-1", projectId: "project-1", name: "test-env-1" }),
      createMockEnvironment({ id: "env-2", projectId: "project-2", name: "test-env-2" }),
    ];

    useEnvironmentStore.setState({
      environments: envs,
      isLoading: false,
      error: null,
    });

    mockGetEnvironments.mockImplementation((projectId) =>
      Promise.resolve(envs.filter((e) => e.projectId === projectId))
    );

    const { result } = renderHook(() => useEnvironments("project-1"));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    // environments should only show project-1's environments
    expect(result.current.environments).toHaveLength(1);
    expect(result.current.environments[0]?.projectId).toBe("project-1");

    // allEnvironments should show all
    expect(result.current.allEnvironments).toHaveLength(2);

    // getEnvironmentsByProjectId should filter correctly
    const project1Envs = result.current.getEnvironmentsByProjectId("project-1");
    expect(project1Envs).toHaveLength(1);
    expect(project1Envs[0]?.id).toBe("env-1");
  });

  test("handles load error gracefully", async () => {
    mockGetEnvironments.mockImplementation(() => Promise.reject(new Error("Network error")));

    const { result } = renderHook(() => useEnvironments("project-1"));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.error).toBe("Network error");
    expect(result.current.environments).toEqual([]);
  });
});

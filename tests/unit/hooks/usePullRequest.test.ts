import { describe, test, expect, beforeEach, mock } from "bun:test";
import { renderHook, act } from "@testing-library/react";
import { useEnvironmentStore } from "../../../src/stores/environmentStore";
import type { Environment, EnvironmentStatus } from "../../../src/types";
import { createMockEnvironment } from "../utils/testFactories";

// Mock tauri module BEFORE importing the hook
const mockGetEnvironmentPrUrl = mock<(environmentId: string) => Promise<string | null>>(() => Promise.resolve(null));
const mockClearEnvironmentPr = mock<(environmentId: string) => Promise<void>>(() => Promise.resolve());
const mockSetEnvironmentPr = mock<(environmentId: string, prUrl: string) => Promise<Environment>>(
  (environmentId, prUrl) =>
    Promise.resolve(createMockEnvironment({ id: environmentId, containerId: "container-123", status: "running", prUrl }))
);
const mockOpenInBrowser = mock<(url: string) => Promise<void>>(() => Promise.resolve());

mock.module("@/lib/tauri", () => ({
  getEnvironmentPrUrl: mockGetEnvironmentPrUrl,
  clearEnvironmentPr: mockClearEnvironmentPr,
  setEnvironmentPr: mockSetEnvironmentPr,
  openInBrowser: mockOpenInBrowser,
}));

// Import hook AFTER mocking
import { usePullRequest } from "../../../src/hooks/usePullRequest";

describe("usePullRequest", () => {
  beforeEach(() => {
    // Reset store between tests
    useEnvironmentStore.setState({
      environments: [],
      isLoading: false,
      error: null,
    });

    // Reset mocks
    mockGetEnvironmentPrUrl.mockClear();
    mockClearEnvironmentPr.mockClear();
    mockSetEnvironmentPr.mockClear();
    mockOpenInBrowser.mockClear();

    // Reset to default implementations
    mockGetEnvironmentPrUrl.mockImplementation(() => Promise.resolve(null));
    mockClearEnvironmentPr.mockImplementation(() => Promise.resolve());
    mockSetEnvironmentPr.mockImplementation((environmentId, prUrl) =>
      Promise.resolve(createMockEnvironment({ id: environmentId, containerId: "container-123", status: "running", prUrl }))
    );
    mockOpenInBrowser.mockImplementation(() => Promise.resolve());
  });

  test("returns initial state with no environment", () => {
    const { result } = renderHook(() => usePullRequest({ environmentId: null }));

    expect(result.current.prUrl).toBeNull();
    expect(result.current.isCreating).toBe(false);
    expect(result.current.error).toBeNull();
  });

  test("returns prUrl from environment store", () => {
    const env = createMockEnvironment({
      id: "env-1",
      containerId: "container-123",
      status: "running",
      prUrl: "https://github.com/test/repo/pull/123",
    });

    useEnvironmentStore.setState({
      environments: [env],
      isLoading: false,
      error: null,
    });

    const { result } = renderHook(() => usePullRequest({ environmentId: "env-1" }));

    expect(result.current.prUrl).toBe("https://github.com/test/repo/pull/123");
  });

  test("createPR sets error when no terminal write function", async () => {
    const { result } = renderHook(() => usePullRequest({ environmentId: "env-1" }));

    await act(async () => {
      await result.current.createPR();
    });

    expect(result.current.error).toBe("Cannot create PR: no active terminal session");
  });

  test("createPR calls terminalWrite with gh pr create command", async () => {
    const mockTerminalWrite = mock<(data: string) => Promise<void>>(() => Promise.resolve());

    const { result } = renderHook(() =>
      usePullRequest({
        environmentId: "env-1",
        terminalWrite: mockTerminalWrite,
      })
    );

    await act(async () => {
      await result.current.createPR();
    });

    expect(mockTerminalWrite).toHaveBeenCalledWith("gh pr create\n");
    expect(result.current.error).toBeNull();
  });

  test("viewPR opens browser with prUrl", async () => {
    const env = createMockEnvironment({
      id: "env-1",
      containerId: "container-123",
      status: "running",
      prUrl: "https://github.com/test/repo/pull/123",
    });

    useEnvironmentStore.setState({
      environments: [env],
      isLoading: false,
      error: null,
    });

    const { result } = renderHook(() => usePullRequest({ environmentId: "env-1" }));

    await act(async () => {
      await result.current.viewPR();
    });

    expect(mockOpenInBrowser).toHaveBeenCalledWith("https://github.com/test/repo/pull/123");
  });

  test("viewPR fetches prUrl from backend when not in store", async () => {
    mockGetEnvironmentPrUrl.mockImplementation(() =>
      Promise.resolve("https://github.com/test/repo/pull/456")
    );

    const env = createMockEnvironment({
      id: "env-1",
      containerId: "container-123",
      status: "running",
      prUrl: null,
    });

    useEnvironmentStore.setState({
      environments: [env],
      isLoading: false,
      error: null,
    });

    const { result } = renderHook(() => usePullRequest({ environmentId: "env-1" }));

    await act(async () => {
      await result.current.viewPR();
    });

    expect(mockGetEnvironmentPrUrl).toHaveBeenCalledWith("env-1");
    expect(mockOpenInBrowser).toHaveBeenCalledWith("https://github.com/test/repo/pull/456");
  });

  test("viewPR sets error when no prUrl available", async () => {
    const env = createMockEnvironment({
      id: "env-1",
      containerId: "container-123",
      status: "running",
      prUrl: null,
    });

    useEnvironmentStore.setState({
      environments: [env],
      isLoading: false,
      error: null,
    });

    const { result } = renderHook(() => usePullRequest({ environmentId: "env-1" }));

    await act(async () => {
      await result.current.viewPR();
    });

    expect(result.current.error).toBe("No PR URL available");
  });

  test("viewPR sets error on browser open failure", async () => {
    mockOpenInBrowser.mockImplementation(() => Promise.reject(new Error("Failed to open browser")));

    const env = createMockEnvironment({
      id: "env-1",
      containerId: "container-123",
      status: "running",
      prUrl: "https://github.com/test/repo/pull/123",
    });

    useEnvironmentStore.setState({
      environments: [env],
      isLoading: false,
      error: null,
    });

    const { result } = renderHook(() => usePullRequest({ environmentId: "env-1" }));

    await act(async () => {
      await result.current.viewPR();
    });

    expect(result.current.error).toBe("Failed to open browser");
  });

  test("resetPR clears the PR URL", async () => {
    const env = createMockEnvironment({
      id: "env-1",
      containerId: "container-123",
      status: "running",
      prUrl: "https://github.com/test/repo/pull/123",
    });

    useEnvironmentStore.setState({
      environments: [env],
      isLoading: false,
      error: null,
    });

    const { result } = renderHook(() => usePullRequest({ environmentId: "env-1" }));

    expect(result.current.prUrl).toBe("https://github.com/test/repo/pull/123");

    await act(async () => {
      await result.current.resetPR();
    });

    expect(mockClearEnvironmentPr).toHaveBeenCalledWith("env-1");
    // The store should be updated to clear the PR
    expect(useEnvironmentStore.getState().environments[0]?.prUrl).toBe("");
  });

  test("resetPR does nothing when no environmentId", async () => {
    const { result } = renderHook(() => usePullRequest({ environmentId: null }));

    await act(async () => {
      await result.current.resetPR();
    });

    expect(mockClearEnvironmentPr).not.toHaveBeenCalled();
  });

  test("setPRUrl sets the PR URL", async () => {
    const env = createMockEnvironment({
      id: "env-1",
      containerId: "container-123",
      status: "running",
      prUrl: null,
    });

    useEnvironmentStore.setState({
      environments: [env],
      isLoading: false,
      error: null,
    });

    const { result } = renderHook(() => usePullRequest({ environmentId: "env-1" }));

    await act(async () => {
      await result.current.setPRUrl("https://github.com/test/repo/pull/789");
    });

    expect(mockSetEnvironmentPr).toHaveBeenCalledWith("env-1", "https://github.com/test/repo/pull/789");
    expect(useEnvironmentStore.getState().environments[0]?.prUrl).toBe(
      "https://github.com/test/repo/pull/789"
    );
  });

  test("setPRUrl does nothing when no environmentId", async () => {
    const { result } = renderHook(() => usePullRequest({ environmentId: null }));

    await act(async () => {
      await result.current.setPRUrl("https://github.com/test/repo/pull/789");
    });

    expect(mockSetEnvironmentPr).not.toHaveBeenCalled();
  });

  test("setPRUrl sets error on failure", async () => {
    mockSetEnvironmentPr.mockImplementation(() => Promise.reject(new Error("Failed to set PR")));

    const env = createMockEnvironment({
      id: "env-1",
      containerId: "container-123",
      status: "running",
      prUrl: null,
    });

    useEnvironmentStore.setState({
      environments: [env],
      isLoading: false,
      error: null,
    });

    const { result } = renderHook(() => usePullRequest({ environmentId: "env-1" }));

    await act(async () => {
      await result.current.setPRUrl("https://github.com/test/repo/pull/789");
    });

    expect(result.current.error).toBe("Failed to set PR");
  });
});

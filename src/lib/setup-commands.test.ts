import { beforeEach, describe, expect, test } from "bun:test";
import { invoke } from "@tauri-apps/api/core";
import { waitFor } from "@testing-library/react";
import { useEnvironmentStore } from "@/stores/environmentStore";
import type { Environment } from "@/types";
import {
  isSetupPending,
  markSetupScriptsComplete,
  shouldAutoResolveSetupCommands,
} from "./setup-commands";

const invokeMock = invoke as unknown as {
  mockReset: () => void;
  mockResolvedValue: (value: unknown) => void;
  mockRejectedValue: (value: unknown) => void;
  mockImplementation: (implementation: (...args: unknown[]) => unknown) => void;
  mock: { calls: unknown[][] };
};

function createEnvironment(overrides: Partial<Environment> = {}): Environment {
  return {
    id: "env-1",
    projectId: "project-1",
    name: "test-env",
    branch: "main",
    containerId: null,
    status: "stopped",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date().toISOString(),
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "local",
    ...overrides,
  };
}

describe("setup-commands", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);

    useEnvironmentStore.setState({
      environments: [createEnvironment()],
      isLoading: false,
      error: null,
      workspaceReadyEnvironments: new Set<string>(),
      deletingEnvironments: new Set<string>(),
      pendingSetupCommands: new Map<string, string[]>(),
      setupCommandsResolved: new Set<string>(),
      setupScriptsRunning: new Set<string>(),
      sessionActivated: new Set<string>(),
    });
  });

  test("auto-resolves only when a ready local environment has no pending commands", () => {
    expect(
      shouldAutoResolveSetupCommands({
        isLocalEnvironment: true,
        isLocalEnvironmentReady: true,
        setupCommandsResolved: false,
        hasPendingCommands: false,
      })
    ).toBe(true);

    expect(
      shouldAutoResolveSetupCommands({
        isLocalEnvironment: true,
        isLocalEnvironmentReady: true,
        setupCommandsResolved: false,
        hasPendingCommands: true,
      })
    ).toBe(false);

    expect(
      shouldAutoResolveSetupCommands({
        isLocalEnvironment: false,
        isLocalEnvironmentReady: true,
        setupCommandsResolved: false,
        hasPendingCommands: false,
      })
    ).toBe(false);
  });

  test("treats local setup as pending until commands are resolved and no setup is running", () => {
    expect(
      isSetupPending({
        isLocal: true,
        setupCommandsResolved: false,
        hasPendingSetupCommands: false,
        setupScriptsRunning: false,
        workspaceReady: true,
      })
    ).toBe(true);

    expect(
      isSetupPending({
        isLocal: true,
        setupCommandsResolved: true,
        hasPendingSetupCommands: true,
        setupScriptsRunning: false,
        workspaceReady: true,
      })
    ).toBe(true);

    expect(
      isSetupPending({
        isLocal: true,
        setupCommandsResolved: true,
        hasPendingSetupCommands: false,
        setupScriptsRunning: false,
        workspaceReady: false,
      })
    ).toBe(false);
  });

  test("uses workspace readiness for containerized environments", () => {
    expect(
      isSetupPending({
        isLocal: false,
        setupCommandsResolved: true,
        hasPendingSetupCommands: false,
        setupScriptsRunning: false,
        workspaceReady: false,
      })
    ).toBe(true);

    expect(
      isSetupPending({
        isLocal: false,
        setupCommandsResolved: false,
        hasPendingSetupCommands: true,
        setupScriptsRunning: true,
        workspaceReady: true,
      })
    ).toBe(false);
  });

  test("persists setup completion before updating store state", async () => {
    const updatedEnvironment = createEnvironment({ setupScriptsComplete: true });
    invokeMock.mockResolvedValue(updatedEnvironment);

    markSetupScriptsComplete("env-1");

    await Promise.resolve();
    await Promise.resolve();

    expect(invokeMock.mock.calls).toEqual([
      ["set_environment_setup_complete", { environmentId: "env-1", complete: true }],
    ]);
    await waitFor(() => {
      expect(useEnvironmentStore.getState().getEnvironmentById("env-1")?.setupScriptsComplete).toBe(true);
    });
  });

  test("keeps setup incomplete in memory when persistence fails", async () => {
    invokeMock.mockRejectedValue(new Error("disk full"));

    markSetupScriptsComplete("env-1");

    await Promise.resolve();
    await Promise.resolve();

    expect(useEnvironmentStore.getState().getEnvironmentById("env-1")?.setupScriptsComplete).toBeUndefined();
  });

  test("deduplicates concurrent completion writes", async () => {
    let resolveInvoke: ((value: unknown) => void) | undefined;
    const pendingInvoke = new Promise((resolve) => {
      resolveInvoke = resolve;
    });
    invokeMock.mockImplementation(() => pendingInvoke);

    markSetupScriptsComplete("env-1");
    markSetupScriptsComplete("env-1");

    expect(invokeMock.mock.calls).toHaveLength(1);

    resolveInvoke?.(createEnvironment({ setupScriptsComplete: true }));
    await pendingInvoke;

    await waitFor(() => {
      expect(useEnvironmentStore.getState().getEnvironmentById("env-1")?.setupScriptsComplete).toBe(true);
    });
  });
});

import { describe, expect, test } from "bun:test";
import type { Environment } from "../types";
import {
  shouldAutoResolveSetupCommands,
  shouldResolveSetupCommandsOnSelection,
} from "./setup-commands";

const createEnvironment = (
  overrides: Partial<Environment> = {}
): Environment => ({
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
});

describe("shouldResolveSetupCommandsOnSelection", () => {
  test("returns true for local environments with an existing worktree", () => {
    const environment = createEnvironment({
      environmentType: "local",
      worktreePath: "/tmp/worktrees/test-env",
    });

    expect(shouldResolveSetupCommandsOnSelection(environment)).toBe(true);
  });

  test("returns false for local environments without a worktree", () => {
    const environment = createEnvironment({
      environmentType: "local",
      worktreePath: undefined,
    });

    expect(shouldResolveSetupCommandsOnSelection(environment)).toBe(false);
  });

  test("returns false for containerized environments", () => {
    const environment = createEnvironment({
      environmentType: "containerized",
      worktreePath: "/tmp/worktrees/test-env",
    });

    expect(shouldResolveSetupCommandsOnSelection(environment)).toBe(false);
  });
});

describe("shouldAutoResolveSetupCommands", () => {
  test("returns true when local environment is ready and no commands are pending", () => {
    expect(
      shouldAutoResolveSetupCommands({
        isLocalEnvironment: true,
        isLocalEnvironmentReady: true,
        setupCommandsResolved: false,
        hasPendingCommands: false,
      })
    ).toBe(true);
  });

  test("returns false when pending setup commands still exist", () => {
    expect(
      shouldAutoResolveSetupCommands({
        isLocalEnvironment: true,
        isLocalEnvironmentReady: true,
        setupCommandsResolved: false,
        hasPendingCommands: true,
      })
    ).toBe(false);
  });

  test("returns false when setup commands are already resolved", () => {
    expect(
      shouldAutoResolveSetupCommands({
        isLocalEnvironment: true,
        isLocalEnvironmentReady: true,
        setupCommandsResolved: true,
        hasPendingCommands: false,
      })
    ).toBe(false);
  });

  test("returns false for non-local environments", () => {
    expect(
      shouldAutoResolveSetupCommands({
        isLocalEnvironment: false,
        isLocalEnvironmentReady: true,
        setupCommandsResolved: false,
        hasPendingCommands: false,
      })
    ).toBe(false);
  });
});

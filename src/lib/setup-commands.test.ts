import { describe, expect, test } from "bun:test";
import { shouldAutoResolveSetupCommands } from "./setup-commands";

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

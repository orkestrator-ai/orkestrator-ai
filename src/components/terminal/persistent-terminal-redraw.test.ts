import { describe, expect, it, mock } from "bun:test";
import {
  forceTerminalVisibilityRedraw,
  getTerminalResizeBounceDimensions,
  shouldTriggerEnvironmentVisibilityRedraw,
} from "./persistent-terminal-redraw";

describe("persistent terminal redraw helpers", () => {
  it("detects when an environment switch should force a redraw", () => {
    expect(shouldTriggerEnvironmentVisibilityRedraw({
      isEnvironmentVisible: true,
      wasEnvironmentVisible: false,
      isActive: true,
      terminalIsOpened: true,
      isConnected: true,
    })).toBe(true);

    expect(shouldTriggerEnvironmentVisibilityRedraw({
      isEnvironmentVisible: true,
      wasEnvironmentVisible: true,
      isActive: true,
      terminalIsOpened: true,
      isConnected: true,
    })).toBe(false);

    expect(shouldTriggerEnvironmentVisibilityRedraw({
      isEnvironmentVisible: true,
      wasEnvironmentVisible: false,
      isActive: false,
      terminalIsOpened: true,
      isConnected: true,
    })).toBe(false);
  });

  it("nudges rows first when computing a resize bounce", () => {
    expect(getTerminalResizeBounceDimensions(120, 40)).toEqual({ cols: 120, rows: 41 });
  });

  it("falls back to nudging columns when rows cannot grow", () => {
    expect(getTerminalResizeBounceDimensions(120, 65535)).toEqual({ cols: 121, rows: 65535 });
  });

  it("forces a bounce resize and refresh sequence", async () => {
    const fit = mock(() => {});
    const refresh = mock(() => {});
    const resize = mock(async () => {});
    const scheduledTimeouts: Array<() => void> = [];

    await forceTerminalVisibilityRedraw({
      terminal: {
        cols: 100,
        rows: 30,
        refresh,
      },
      fitAddon: { fit },
      resize,
      requestAnimationFrameFn: (callback) => {
        callback(0);
        return 1;
      },
      setTimeoutFn: (((callback: TimerHandler) => {
        scheduledTimeouts.push(callback as () => void);
        return 1 as unknown as ReturnType<typeof setTimeout>;
      }) as unknown) as typeof setTimeout,
    });

    expect(resize).toHaveBeenNthCalledWith(1, 100, 31);
    expect(resize).toHaveBeenNthCalledWith(2, 100, 30);
    expect(fit).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(2);

    expect(scheduledTimeouts).toHaveLength(1);
    scheduledTimeouts[0]?.();

    expect(fit).toHaveBeenCalledTimes(3);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("stops before resizing when cancelled after the first frame", async () => {
    const resize = mock(async () => {});

    await forceTerminalVisibilityRedraw({
      terminal: {
        cols: 100,
        rows: 30,
        refresh: mock(() => {}),
      },
      fitAddon: { fit: mock(() => {}) },
      resize,
      isCancelled: () => true,
      requestAnimationFrameFn: (callback) => {
        callback(0);
        return 1;
      },
    });

    expect(resize).not.toHaveBeenCalled();
  });
});

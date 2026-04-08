import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { renderHook, act } from "@testing-library/react";
import { useElapsedTimer } from "@/hooks/useElapsedTimer";

describe("useElapsedTimer", () => {
  let dateNowSpy: ReturnType<typeof import("bun:test")["spyOn"]> | undefined;

  afterEach(() => {
    dateNowSpy?.mockRestore();
  });

  describe("initial state", () => {
    test("both values are null when not loading", () => {
      const { result } = renderHook(() => useElapsedTimer(false, "session-1"));
      expect(result.current.elapsedSeconds).toBeNull();
      expect(result.current.finalElapsedSeconds).toBeNull();
    });

    test("both values are null when loading is undefined", () => {
      const { result } = renderHook(() => useElapsedTimer(undefined, "session-1"));
      expect(result.current.elapsedSeconds).toBeNull();
      expect(result.current.finalElapsedSeconds).toBeNull();
    });
  });

  describe("loading transitions", () => {
    test("elapsedSeconds is null before interval fires", () => {
      const now = 1000000;
      dateNowSpy = spyOn(Date, "now").mockReturnValue(now);

      const { result, rerender } = renderHook(
        ({ isLoading, sessionId }) => useElapsedTimer(isLoading, sessionId),
        { initialProps: { isLoading: false, sessionId: "session-1" } },
      );

      // Start loading — interval hasn't fired yet
      rerender({ isLoading: true, sessionId: "session-1" });

      expect(result.current.elapsedSeconds).toBeNull();
      expect(result.current.finalElapsedSeconds).toBeNull();
    });

    test("finalElapsedSeconds is set when loading ends", () => {
      const startTime = 1000000;
      dateNowSpy = spyOn(Date, "now").mockReturnValue(startTime);

      const { result, rerender } = renderHook(
        ({ isLoading, sessionId }) => useElapsedTimer(isLoading, sessionId),
        { initialProps: { isLoading: false, sessionId: "session-1" } },
      );

      // Start loading
      rerender({ isLoading: true, sessionId: "session-1" });

      // Stop loading after 5 seconds
      dateNowSpy.mockReturnValue(startTime + 5000);
      rerender({ isLoading: false, sessionId: "session-1" });

      expect(result.current.elapsedSeconds).toBeNull();
      expect(result.current.finalElapsedSeconds).toBe(5);
    });

    test("finalElapsedSeconds clears when loading starts again", () => {
      const startTime = 1000000;
      dateNowSpy = spyOn(Date, "now").mockReturnValue(startTime);

      const { result, rerender } = renderHook(
        ({ isLoading, sessionId }) => useElapsedTimer(isLoading, sessionId),
        { initialProps: { isLoading: true, sessionId: "session-1" } },
      );

      // Stop loading
      dateNowSpy.mockReturnValue(startTime + 3000);
      rerender({ isLoading: false, sessionId: "session-1" });
      expect(result.current.finalElapsedSeconds).toBe(3);

      // Start loading again
      dateNowSpy.mockReturnValue(startTime + 4000);
      rerender({ isLoading: true, sessionId: "session-1" });
      expect(result.current.finalElapsedSeconds).toBeNull();
    });

    test("does not set finalElapsedSeconds if was never loading", () => {
      const { result, rerender } = renderHook(
        ({ isLoading, sessionId }) => useElapsedTimer(isLoading, sessionId),
        { initialProps: { isLoading: false, sessionId: "session-1" } },
      );

      // Re-render with same false state
      rerender({ isLoading: false, sessionId: "session-1" });
      expect(result.current.finalElapsedSeconds).toBeNull();
    });
  });

  describe("session changes", () => {
    test("resets all timer state when sessionId changes", () => {
      const startTime = 1000000;
      dateNowSpy = spyOn(Date, "now").mockReturnValue(startTime);

      const { result, rerender } = renderHook(
        ({ isLoading, sessionId }) => useElapsedTimer(isLoading, sessionId),
        { initialProps: { isLoading: true, sessionId: "session-1" } },
      );

      // Stop loading to get a finalElapsedSeconds
      dateNowSpy.mockReturnValue(startTime + 10000);
      rerender({ isLoading: false, sessionId: "session-1" });
      expect(result.current.finalElapsedSeconds).toBe(10);

      // Change session
      rerender({ isLoading: false, sessionId: "session-2" });
      expect(result.current.elapsedSeconds).toBeNull();
      expect(result.current.finalElapsedSeconds).toBeNull();
    });

    test("resets when sessionId changes to undefined", () => {
      const startTime = 1000000;
      dateNowSpy = spyOn(Date, "now").mockReturnValue(startTime);

      const { result, rerender } = renderHook(
        ({ isLoading, sessionId }) => useElapsedTimer(isLoading, sessionId),
        { initialProps: { isLoading: true as boolean | undefined, sessionId: "session-1" as string | undefined } },
      );

      dateNowSpy.mockReturnValue(startTime + 5000);
      rerender({ isLoading: false, sessionId: "session-1" });
      expect(result.current.finalElapsedSeconds).toBe(5);

      rerender({ isLoading: false, sessionId: undefined });
      expect(result.current.finalElapsedSeconds).toBeNull();
    });
  });
});

function spyOn<T extends object, K extends keyof T>(obj: T, method: K) {
  const original = obj[method];
  let mockFn: ((...args: any[]) => any) | undefined;

  const spy = {
    mockReturnValue(value: any) {
      mockFn = () => value;
      (obj as any)[method] = mockFn;
      return spy;
    },
    mockRestore() {
      (obj as any)[method] = original;
    },
  };

  return spy;
}

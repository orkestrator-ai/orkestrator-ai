import { describe, expect, test } from "bun:test";
import { renderHook } from "@testing-library/react";
import { TerminalProvider, useOptionalTerminalContext, useTerminalContext } from "../../../src/contexts/TerminalContext";

describe("TerminalContext", () => {
  test("useOptionalTerminalContext returns null outside a provider", () => {
    const { result } = renderHook(() => useOptionalTerminalContext());

    expect(result.current).toBeNull();
  });

  test("useTerminalContext throws outside a provider", () => {
    expect(() => renderHook(() => useTerminalContext())).toThrow(
      "useTerminalContext must be used within a TerminalProvider",
    );
  });

  test("TerminalProvider supplies the terminal context value", () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <TerminalProvider>{children}</TerminalProvider>
    );

    const { result } = renderHook(() => useOptionalTerminalContext(), { wrapper });

    expect(result.current).not.toBeNull();
    expect(result.current?.createTab).toBeNull();
    expect(result.current?.tabCount).toBe(0);
    expect(result.current?.openFilePaths).toEqual([]);
  });
});

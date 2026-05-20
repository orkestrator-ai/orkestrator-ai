import { describe, expect, mock, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { useFileMentions } from "@/hooks/useFileMentions";
import type { FileCandidate } from "@/types";
import type { KeyboardEvent } from "react";

const files: FileCandidate[] = [
  { filename: "alpha.ts", relativePath: "src/alpha.ts", isDirectory: false },
  { filename: "beta.ts", relativePath: "src/beta.ts", isDirectory: false },
  { filename: "gamma.ts", relativePath: "src/gamma.ts", isDirectory: false },
];

function keyEvent(key: string) {
  return {
    key,
    preventDefault: mock(() => {}),
  } as unknown as KeyboardEvent;
}

describe("useFileMentions", () => {
  test("navigates file suggestions with arrow keys and selects with Enter", () => {
    const onSelect = mock(() => {});
    const { result } = renderHook(() =>
      useFileMentions({
        searchFiles: () => files,
      }),
    );

    act(() => {
      result.current.handleCursorChange(1, "@");
    });

    expect(result.current.isMenuOpen).toBe(true);
    expect(result.current.selectedIndex).toBe(0);

    const downEvent = keyEvent("ArrowDown");
    act(() => {
      expect(result.current.handleKeyDown(downEvent, onSelect)).toBe(true);
    });

    expect(downEvent.preventDefault).toHaveBeenCalled();
    expect(result.current.selectedIndex).toBe(1);

    const upEvent = keyEvent("ArrowUp");
    act(() => {
      expect(result.current.handleKeyDown(upEvent, onSelect)).toBe(true);
    });

    expect(upEvent.preventDefault).toHaveBeenCalled();
    expect(result.current.selectedIndex).toBe(0);

    const enterEvent = keyEvent("Enter");
    act(() => {
      expect(result.current.handleKeyDown(enterEvent, onSelect)).toBe(true);
    });

    expect(enterEvent.preventDefault).toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledWith(files[0]);
    expect(result.current.isMenuOpen).toBe(false);
  });

  test("wraps arrow navigation at menu boundaries", () => {
    const { result } = renderHook(() =>
      useFileMentions({
        searchFiles: () => files,
      }),
    );

    act(() => {
      result.current.handleCursorChange(1, "@");
    });

    act(() => {
      result.current.handleKeyDown(keyEvent("ArrowUp"), () => {});
    });
    expect(result.current.selectedIndex).toBe(files.length - 1);

    act(() => {
      result.current.handleKeyDown(keyEvent("ArrowDown"), () => {});
    });
    expect(result.current.selectedIndex).toBe(0);
  });
});

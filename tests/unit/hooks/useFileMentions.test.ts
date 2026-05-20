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

  test("selects with Tab and resets menu state", () => {
    const onSelect = mock(() => {});
    const { result } = renderHook(() =>
      useFileMentions({
        searchFiles: () => files,
      }),
    );

    act(() => {
      result.current.handleCursorChange(3, "@be");
    });

    const tabEvent = keyEvent("Tab");
    act(() => {
      expect(result.current.handleKeyDown(tabEvent, onSelect)).toBe(true);
    });

    expect(tabEvent.preventDefault).toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledWith(files[0]);
    expect(result.current.isMenuOpen).toBe(false);
    expect(result.current.searchQuery).toBe("");
    expect(result.current.selectedIndex).toBe(0);
  });

  test("closes and resets selection with Escape", () => {
    const { result } = renderHook(() =>
      useFileMentions({
        searchFiles: () => files,
      }),
    );

    act(() => {
      result.current.handleCursorChange(1, "@");
      result.current.setSelectedIndex(2);
    });

    const escapeEvent = keyEvent("Escape");
    act(() => {
      expect(result.current.handleKeyDown(escapeEvent, () => {})).toBe(true);
    });

    expect(escapeEvent.preventDefault).toHaveBeenCalled();
    expect(result.current.isMenuOpen).toBe(false);
    expect(result.current.searchQuery).toBe("");
    expect(result.current.selectedIndex).toBe(0);
  });

  test("handles empty suggestion lists without falling through handled keys", () => {
    const onSelect = mock(() => {});
    const { result } = renderHook(() =>
      useFileMentions({
        searchFiles: () => [],
      }),
    );

    act(() => {
      result.current.handleCursorChange(1, "@");
    });

    const enterEvent = keyEvent("Enter");
    act(() => {
      expect(result.current.handleKeyDown(enterEvent, onSelect)).toBe(true);
    });

    expect(enterEvent.preventDefault).toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    expect(result.current.isMenuOpen).toBe(true);

    act(() => {
      result.current.handleKeyDown(keyEvent("Escape"), onSelect);
    });
    expect(result.current.isMenuOpen).toBe(false);
  });

  test("resets selection when the search query changes", () => {
    const { result } = renderHook(() =>
      useFileMentions({
        searchFiles: () => files,
      }),
    );

    act(() => {
      result.current.handleCursorChange(1, "@");
      result.current.setSelectedIndex(2);
    });
    expect(result.current.selectedIndex).toBe(2);

    act(() => {
      result.current.handleCursorChange(2, "@b");
    });

    expect(result.current.searchQuery).toBe("b");
    expect(result.current.selectedIndex).toBe(0);
  });

  test("closes through the explicit close callback", () => {
    const { result } = renderHook(() =>
      useFileMentions({
        searchFiles: () => files,
      }),
    );

    act(() => {
      result.current.handleCursorChange(1, "@");
      result.current.setSelectedIndex(1);
      result.current.closeMenu();
    });

    expect(result.current.isMenuOpen).toBe(false);
    expect(result.current.searchQuery).toBe("");
    expect(result.current.selectedIndex).toBe(0);
  });

  test("serializes mentions and creates mention metadata", () => {
    const { result } = renderHook(() =>
      useFileMentions({
        searchFiles: () => files,
      }),
    );

    const created = result.current.createMention(files[0]);

    expect(created.id).toBeTruthy();
    expect(created.filename).toBe("alpha.ts");
    expect(created.relativePath).toBe("src/alpha.ts");
    expect(
      result.current.serializeForLLM("Read @alpha.ts and @beta.ts", [
        created,
        { id: "mention-2", filename: "beta.ts", relativePath: "src/beta.ts" },
      ]),
    ).toBe("Read [@alpha.ts](src/alpha.ts) and [@beta.ts](src/beta.ts)");
  });
});

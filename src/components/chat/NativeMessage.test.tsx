import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { NativeMessage } from "./NativeMessage";

describe("NativeMessage task list rendering", () => {
  afterEach(() => {
    cleanup();
  });

  test("renders markdown task lists in thinking parts with checkbox styling", () => {
    const message = {
      id: "assistant-1",
      role: "assistant" as const,
      content: "",
      createdAt: "2026-03-21T10:00:00.000Z",
      parts: [
        {
          type: "thinking" as const,
          content: "- [x] Finished task\n- [ ] Next task",
        },
      ],
    };

    const { container } = render(<NativeMessage message={message} />);

    expect(container.textContent).not.toContain("[x]");
    expect(container.textContent).not.toContain("[ ]");

    const completedTask = screen.getByText("Finished task");
    expect(completedTask.className).toContain("line-through");

    const checkboxIcons = container.querySelectorAll(
      "[data-task-list-icon=\"true\"]",
    );
    expect(checkboxIcons).toHaveLength(2);
    expect(checkboxIcons[0]?.getAttribute("data-state")).toBe("checked");
    expect(checkboxIcons[1]?.getAttribute("data-state")).toBe("unchecked");
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { MentionableInput } from "./MentionableInput";

describe("MentionableInput", () => {
  afterEach(() => {
    cleanup();
  });

  test("restores draft text into the DOM on first render", () => {
    const draftText = "Hello, this is my draft";
    const { container } = render(
      <MentionableInput
        value={draftText}
        mentions={[]}
        onChange={() => {}}
      />,
    );

    const input = container.querySelector("[contenteditable]");
    expect(input).not.toBeNull();
    expect(input!.textContent).toBe(draftText);
  });

  test("renders empty when value is empty string", () => {
    const { container } = render(
      <MentionableInput
        value=""
        mentions={[]}
        onChange={() => {}}
      />,
    );

    const input = container.querySelector("[contenteditable]");
    expect(input).not.toBeNull();
    expect(input!.textContent).toBe("");
  });

  test("restores draft text with mentions on first render", () => {
    const draftText = "Check @utils.ts for details";
    const mentions = [
      { id: "1", filename: "utils.ts", relativePath: "src/utils.ts" },
    ];
    const { container } = render(
      <MentionableInput
        value={draftText}
        mentions={mentions}
        onChange={() => {}}
      />,
    );

    const input = container.querySelector("[contenteditable]");
    expect(input).not.toBeNull();
    expect(input!.textContent).toBe(draftText);

    const mentionSpan = input!.querySelector("[data-mention='true']");
    expect(mentionSpan).not.toBeNull();
    expect(mentionSpan!.textContent).toBe("@utils.ts");
  });
});

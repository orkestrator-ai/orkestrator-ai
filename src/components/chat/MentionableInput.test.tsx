import { createRef } from "react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { MentionableInput, type MentionableInputRef } from "./MentionableInput";

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

  test("reports the current editable text with cursor changes after input", () => {
    let cursorText = "";
    const { container } = render(
      <MentionableInput
        value=""
        mentions={[]}
        onChange={() => {}}
        onCursorChange={(_, text) => {
          cursorText = text;
        }}
      />,
    );

    const input = container.querySelector("[contenteditable]");
    expect(input).not.toBeNull();

    input!.textContent = "@utils";
    fireEvent.input(input!);

    expect(cursorText).toBe("@utils");
  });

  test("inserts a mention at the last known cursor position when focus moved outside", () => {
    const onChange = mock(() => {});
    const inputRef = createRef<MentionableInputRef>();

    render(
      <MentionableInput
        ref={inputRef}
        value="Review @ut"
        mentions={[]}
        onChange={onChange}
      />,
    );

    inputRef.current!.insertMention({
      id: "mention-1",
      filename: "utils.ts",
      relativePath: "src/utils.ts",
    });

    expect(onChange).toHaveBeenCalledWith(
      "Review @utils.ts ",
      [{ id: "mention-1", filename: "utils.ts", relativePath: "src/utils.ts" }],
    );
  });

  test("replaces the full active mention token when the cursor is inside the query", () => {
    const onChange = mock(() => {});
    const inputRef = createRef<MentionableInputRef>();
    const { container } = render(
      <MentionableInput
        ref={inputRef}
        value="Review @ut"
        mentions={[]}
        onChange={onChange}
      />,
    );

    const input = container.querySelector("[contenteditable]")!;
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.setStart(input.firstChild!, "Review @".length);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);

    inputRef.current!.insertMention({
      id: "mention-1",
      filename: "utils.ts",
      relativePath: "src/utils.ts",
    });

    expect(onChange).toHaveBeenCalledWith(
      "Review @utils.ts ",
      [{ id: "mention-1", filename: "utils.ts", relativePath: "src/utils.ts" }],
    );
  });

  test("pastes plain text at the current selection", () => {
    const onChange = mock(() => {});
    const { container } = render(
      <MentionableInput
        value="Hello "
        mentions={[]}
        onChange={onChange}
      />,
    );

    const input = container.querySelector("[contenteditable]")!;
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.setStart(input.firstChild!, "Hello ".length);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);

    fireEvent.paste(input, {
      clipboardData: {
        getData: () => "world",
      },
    });

    expect(onChange).toHaveBeenCalledWith("Hello world", []);
  });

  test("defers input updates until IME composition ends", () => {
    const onChange = mock(() => {});
    const { container } = render(
      <MentionableInput
        value=""
        mentions={[]}
        onChange={onChange}
      />,
    );

    const input = container.querySelector("[contenteditable]")!;
    fireEvent.compositionStart(input);
    input.textContent = "あ";
    fireEvent.input(input);
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.compositionEnd(input);
    expect(onChange).toHaveBeenCalledWith("あ", []);
  });

  test("removes mention metadata when the rendered mention text is deleted", () => {
    const onChange = mock(() => {});
    const mentions = [
      { id: "1", filename: "utils.ts", relativePath: "src/utils.ts" },
    ];
    const { container } = render(
      <MentionableInput
        value="Check @utils.ts"
        mentions={mentions}
        onChange={onChange}
      />,
    );

    const input = container.querySelector("[contenteditable]")!;
    input.textContent = "Check utils.ts";
    fireEvent.input(input);

    expect(onChange).toHaveBeenCalledWith("Check utils.ts", []);
  });
});

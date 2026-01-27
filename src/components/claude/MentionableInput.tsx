import {
  useRef,
  useEffect,
  useCallback,
  forwardRef,
  useImperativeHandle,
  type KeyboardEvent,
  type ClipboardEvent,
} from "react";
import { cn } from "@/lib/utils";
import type { FileMention } from "@/types";

interface MentionableInputProps {
  /** Current text value (includes @filename for mentions) */
  value: string;
  /** Current mentions in the text */
  mentions: FileMention[];
  /** Called when text changes */
  onChange: (text: string, mentions: FileMention[]) => void;
  /** Called when cursor position changes */
  onCursorChange?: (position: number) => void;
  /** Called on key down (for send, menu navigation, etc.) */
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  /** Placeholder text */
  placeholder?: string;
  /** Whether input is disabled */
  disabled?: boolean;
  /** Additional CSS classes */
  className?: string;
  /** Min height in px */
  minHeight?: number;
  /** Max height in px */
  maxHeight?: number;
}

export interface MentionableInputRef {
  focus: () => void;
  blur: () => void;
  getCursorPosition: () => number;
  insertMention: (mention: FileMention) => void;
}

/**
 * Extracts plain text from contenteditable element.
 * Mention spans are converted to @filename format.
 */
function extractText(element: HTMLElement): string {
  let text = "";
  for (const node of element.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent || "";
    } else if (node instanceof HTMLElement) {
      if (node.dataset.mention === "true") {
        // This is a mention span - extract the @filename
        text += node.textContent || "";
      } else if (node.tagName === "BR") {
        text += "\n";
      } else {
        text += extractText(node);
      }
    }
  }
  return text;
}

/**
 * Gets cursor position as text offset within the contenteditable.
 */
function getCursorOffset(element: HTMLElement): number {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return 0;
  }

  const range = selection.getRangeAt(0);
  const preCaretRange = range.cloneRange();
  preCaretRange.selectNodeContents(element);
  preCaretRange.setEnd(range.startContainer, range.startOffset);

  // Count text length including mention text
  const fragment = preCaretRange.cloneContents();
  const div = document.createElement("div");
  div.appendChild(fragment);
  return extractText(div).length;
}

/**
 * Sets cursor position at a text offset.
 */
function setCursorOffset(element: HTMLElement, offset: number): void {
  const selection = window.getSelection();
  if (!selection) return;

  let currentOffset = 0;
  const walker = document.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT,
    null
  );

  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    const nodeLength = node.textContent?.length || 0;
    if (currentOffset + nodeLength >= offset) {
      const range = document.createRange();
      range.setStart(node, offset - currentOffset);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    currentOffset += nodeLength;
  }

  // If offset is beyond content, place cursor at end
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * Renders text with mentions as HTML.
 * Mentions are wrapped in styled spans.
 */
function renderContent(text: string, mentions: FileMention[]): string {
  if (mentions.length === 0) {
    // Escape HTML and convert newlines
    return escapeHtml(text).replace(/\n/g, "<br>");
  }

  // Build a map of @filename -> mention data
  const mentionMap = new Map<string, FileMention>();
  for (const m of mentions) {
    mentionMap.set(`@${m.filename}`, m);
  }

  // Sort by filename length descending to avoid partial replacements
  const sortedPatterns = Array.from(mentionMap.keys()).sort(
    (a, b) => b.length - a.length
  );

  let result = escapeHtml(text);

  for (const pattern of sortedPatterns) {
    const mention = mentionMap.get(pattern)!;
    const escapedPattern = escapeHtml(pattern);
    const mentionHtml = `<span class="text-blue-500 font-medium" data-mention="true" data-id="${mention.id}" data-filename="${escapeAttr(mention.filename)}" data-path="${escapeAttr(mention.relativePath)}" contenteditable="false">${escapedPattern}</span>`;
    result = result.replace(new RegExp(escapeRegExp(escapedPattern), "g"), mentionHtml);
  }

  return result.replace(/\n/g, "<br>");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(text: string): string {
  return text.replace(/"/g, "&quot;");
}

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * MentionableInput is a contenteditable div that supports @mentions.
 * Mentions are displayed in blue and stored separately from text.
 */
export const MentionableInput = forwardRef<MentionableInputRef, MentionableInputProps>(
  function MentionableInput(
    {
      value,
      mentions,
      onChange,
      onCursorChange,
      onKeyDown,
      placeholder = "Type a message...",
      disabled = false,
      className,
      minHeight = 28,
      maxHeight = 216,
    },
    ref
  ) {
    const inputRef = useRef<HTMLDivElement>(null);
    const lastValueRef = useRef(value);
    const lastMentionsRef = useRef(mentions);
    const isComposingRef = useRef(false);

    // Expose methods via ref
    useImperativeHandle(ref, () => ({
      focus: () => inputRef.current?.focus(),
      blur: () => inputRef.current?.blur(),
      getCursorPosition: () =>
        inputRef.current ? getCursorOffset(inputRef.current) : 0,
      insertMention: (mention: FileMention) => {
        if (!inputRef.current) return;

        const cursorPos = getCursorOffset(inputRef.current);
        const currentText = extractText(inputRef.current);

        // Find the @ trigger position (looking backwards from cursor)
        const textBefore = currentText.slice(0, cursorPos);
        const atMatch = textBefore.match(/@([^\s@]*)$/);

        if (atMatch) {
          const atStart = textBefore.length - atMatch[0].length;
          const newText =
            currentText.slice(0, atStart) +
            `@${mention.filename}` +
            " " +
            currentText.slice(cursorPos);

          const newMentions = [...mentions, mention];
          onChange(newText, newMentions);

          // Set cursor after the inserted mention + space
          requestAnimationFrame(() => {
            if (inputRef.current) {
              setCursorOffset(inputRef.current, atStart + mention.filename.length + 2);
            }
          });
        }
      },
    }));

    // Update DOM when value/mentions change externally
    useEffect(() => {
      if (!inputRef.current) return;

      // Skip if this change came from user input (to avoid cursor jumping)
      if (
        value === lastValueRef.current &&
        JSON.stringify(mentions) === JSON.stringify(lastMentionsRef.current)
      ) {
        return;
      }

      lastValueRef.current = value;
      lastMentionsRef.current = mentions;

      // Save cursor position
      const cursorPos = getCursorOffset(inputRef.current);

      // Update content
      inputRef.current.innerHTML = renderContent(value, mentions);

      // Restore cursor position
      setCursorOffset(inputRef.current, cursorPos);
    }, [value, mentions]);

    // Handle input
    const handleInput = useCallback(() => {
      if (!inputRef.current || isComposingRef.current) return;

      const newText = extractText(inputRef.current);

      // Check if any mentions were deleted (by comparing with current mentions)
      const remainingMentions = mentions.filter((m) =>
        newText.includes(`@${m.filename}`)
      );

      lastValueRef.current = newText;
      lastMentionsRef.current = remainingMentions;

      onChange(newText, remainingMentions);

      // Report cursor position
      if (onCursorChange) {
        onCursorChange(getCursorOffset(inputRef.current));
      }
    }, [mentions, onChange, onCursorChange]);

    // Handle composition (for IME input)
    const handleCompositionStart = useCallback(() => {
      isComposingRef.current = true;
    }, []);

    const handleCompositionEnd = useCallback(() => {
      isComposingRef.current = false;
      handleInput();
    }, [handleInput]);

    // Handle selection change for cursor position tracking
    useEffect(() => {
      const handleSelectionChange = () => {
        if (!inputRef.current || !onCursorChange) return;

        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return;

        // Check if selection is within our input
        const range = selection.getRangeAt(0);
        if (!inputRef.current.contains(range.commonAncestorContainer)) return;

        onCursorChange(getCursorOffset(inputRef.current));
      };

      document.addEventListener("selectionchange", handleSelectionChange);
      return () =>
        document.removeEventListener("selectionchange", handleSelectionChange);
    }, [onCursorChange]);

    // Handle paste - strip HTML and insert plain text
    const handlePaste = useCallback(
      (event: ClipboardEvent<HTMLDivElement>) => {
        event.preventDefault();
        const text = event.clipboardData.getData("text/plain");
        document.execCommand("insertText", false, text);
      },
      []
    );

    // Handle key down
    const handleKeyDown = useCallback(
      (event: KeyboardEvent<HTMLDivElement>) => {
        // Handle Enter for newlines (Shift+Enter) vs submit (Enter)
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          onKeyDown?.(event);
          return;
        }

        onKeyDown?.(event);
      },
      [onKeyDown]
    );

    // Show placeholder
    const showPlaceholder = !value;

    return (
      <div className="relative">
        <div
          ref={inputRef}
          contentEditable={!disabled}
          suppressContentEditableWarning
          onInput={handleInput}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          onPaste={handlePaste}
          onKeyDown={handleKeyDown}
          className={cn(
            "w-full bg-transparent border-none px-1 py-1",
            "text-sm text-foreground",
            "resize-none outline-none overflow-y-auto",
            "transition-colors",
            "[&:empty]:before:content-[attr(data-placeholder)]",
            "[&:empty]:before:text-muted-foreground",
            "[&:empty]:before:pointer-events-none",
            disabled && "opacity-50 cursor-not-allowed",
            className
          )}
          style={{
            minHeight,
            maxHeight,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
          data-placeholder={placeholder}
        />
        {/* Hidden placeholder for accessibility */}
        {showPlaceholder && (
          <div
            className="absolute top-1 left-1 text-sm text-muted-foreground pointer-events-none"
            aria-hidden="true"
          >
            {placeholder}
          </div>
        )}
      </div>
    );
  }
);

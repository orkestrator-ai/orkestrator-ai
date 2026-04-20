import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import {
  MessageShell,
  MessageErrorAlert,
} from "../../../src/components/chat/MessageShell";

describe("MessageShell", () => {
  test("renders children and header by default", () => {
    const { container } = render(
      <MessageShell
        isUser={false}
        authorLabel="Claude"
        timestampLabel="12:00 PM"
      >
        <p>Hello world</p>
      </MessageShell>,
    );

    expect(container.textContent).toContain("Claude");
    expect(container.textContent).toContain("12:00 PM");
    expect(container.textContent).toContain("Hello world");
  });

  test("hides header when showHeader is false", () => {
    const { container } = render(
      <MessageShell
        isUser={false}
        authorLabel="Claude"
        timestampLabel="12:00 PM"
        showHeader={false}
      >
        <p>Content only</p>
      </MessageShell>,
    );

    expect(container.textContent).not.toContain("Claude");
    expect(container.textContent).not.toContain("12:00 PM");
    expect(container.textContent).toContain("Content only");
  });

  test("applies user background styling for user messages", () => {
    const { container } = render(
      <MessageShell isUser={true} authorLabel="You" timestampLabel="1:00 PM">
        <p>User message</p>
      </MessageShell>,
    );

    const outerDiv = container.firstElementChild as HTMLElement;
    expect(outerDiv.className).toContain("bg-muted/30");
  });

  test("applies transparent background for non-user messages", () => {
    const { container } = render(
      <MessageShell
        isUser={false}
        authorLabel="Claude"
        timestampLabel="1:00 PM"
      >
        <p>Assistant message</p>
      </MessageShell>,
    );

    const outerDiv = container.firstElementChild as HTMLElement;
    expect(outerDiv.className).toContain("bg-transparent");
  });

  test("applies responsive padding classes", () => {
    const { container } = render(
      <MessageShell isUser={false} authorLabel="Claude" timestampLabel="1:00 PM">
        <p>Test</p>
      </MessageShell>,
    );

    const outerDiv = container.firstElementChild as HTMLElement;
    expect(outerDiv.className).toContain("px-2");
    expect(outerDiv.className).toContain("@sm:px-4");
  });

  test("applies min-w-0 and break-words for text wrapping", () => {
    const { container } = render(
      <MessageShell isUser={false} authorLabel="Claude" timestampLabel="1:00 PM">
        <p>Long text content</p>
      </MessageShell>,
    );

    const contentDiv = container.querySelector(".max-w-3xl") as HTMLElement;
    expect(contentDiv.className).toContain("min-w-0");

    const childrenDiv = contentDiv.querySelector(".space-y-2") as HTMLElement;
    expect(childrenDiv.className).toContain("break-words");
  });

  test("merges custom className and contentClassName", () => {
    const { container } = render(
      <MessageShell
        isUser={false}
        authorLabel="Claude"
        timestampLabel="1:00 PM"
        className="custom-outer"
        contentClassName="custom-inner"
      >
        <p>Test</p>
      </MessageShell>,
    );

    const outerDiv = container.firstElementChild as HTMLElement;
    expect(outerDiv.className).toContain("custom-outer");

    const contentDiv = container.querySelector(".max-w-3xl") as HTMLElement;
    expect(contentDiv.className).toContain("custom-inner");
  });
});

describe("MessageErrorAlert", () => {
  test("renders error content and timestamp", () => {
    const { container } = render(
      <MessageErrorAlert
        content="Something went wrong"
        timestampLabel="2:00 PM"
      />,
    );

    expect(container.textContent).toContain("Something went wrong");
    expect(container.textContent).toContain("2:00 PM");
  });

  test("applies responsive padding and min-w-0", () => {
    const { container } = render(
      <MessageErrorAlert content="Error" timestampLabel="2:00 PM" />,
    );

    const outerDiv = container.firstElementChild as HTMLElement;
    expect(outerDiv.className).toContain("px-2");
    expect(outerDiv.className).toContain("@sm:px-4");

    const contentDiv = outerDiv.querySelector(".max-w-3xl") as HTMLElement;
    expect(contentDiv.className).toContain("min-w-0");
  });

  test("renders with break-words for long error messages", () => {
    const { container } = render(
      <MessageErrorAlert
        content="A very long error message that should wrap properly at narrow widths"
        timestampLabel="2:00 PM"
      />,
    );

    const errorText = container.querySelector(
      ".text-destructive.break-words",
    ) as HTMLElement;
    expect(errorText).not.toBeNull();
    expect(errorText.textContent).toContain("A very long error message");
  });

  test("renders optional details and action content", () => {
    render(
      <MessageErrorAlert
        content="Authentication failed"
        details="Original API error details"
        action={<button type="button">Retry login</button>}
        timestampLabel="2:00 PM"
      />,
    );

    expect(screen.getByText("Authentication failed")).toBeTruthy();
    expect(screen.getByText("Original API error details")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry login" })).toBeTruthy();
  });
});

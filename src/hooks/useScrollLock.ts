import { useEffect, useState, useCallback, useRef, type RefObject } from "react";

/** Pixels from bottom to consider "at bottom" */
const SCROLL_THRESHOLD = 50;

interface UseScrollLockOptions {
  /** Dependency array that triggers auto-scroll when changed (e.g., messages array) */
  scrollTrigger?: unknown;
}

interface UseScrollLockReturn {
  /** Whether the user is currently at the bottom of the scroll area */
  isAtBottom: boolean;
  /** Whether auto-scroll is enabled (user is following new content) */
  isScrollLocked: boolean;
  /** Scroll to bottom and re-enable scroll lock */
  scrollToBottom: () => void;
}

/**
 * Hook to manage scroll lock behavior for chat-like interfaces.
 *
 * When the user is at the bottom, new content will auto-scroll into view.
 * When the user scrolls up to read history, auto-scroll is disabled.
 * A "scroll to bottom" action re-enables auto-scroll.
 *
 * Works with Radix ScrollArea components by querying for the viewport element.
 */
export function useScrollLock(
  scrollRef: RefObject<HTMLDivElement | null>,
  options: UseScrollLockOptions = {}
): UseScrollLockReturn {
  const { scrollTrigger } = options;

  const [isScrollLocked, setIsScrollLocked] = useState(true);
  const [isAtBottom, setIsAtBottom] = useState(true);

  // Use a ref to track scroll lock for sync access in effects
  // This prevents race conditions where state hasn't updated yet
  const isScrollLockedRef = useRef(true);

  // Check initial scroll position on mount
  useEffect(() => {
    const scrollElement = scrollRef.current?.querySelector(
      "[data-radix-scroll-area-viewport]"
    );
    if (!scrollElement) return;

    const { scrollTop, scrollHeight, clientHeight } = scrollElement;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    const atBottom = distanceFromBottom <= SCROLL_THRESHOLD;

    setIsAtBottom(atBottom);
    setIsScrollLocked(atBottom);
    isScrollLockedRef.current = atBottom;
  }, [scrollRef]);

  // Track scroll position to manage scroll lock
  useEffect(() => {
    const scrollElement = scrollRef.current?.querySelector(
      "[data-radix-scroll-area-viewport]"
    );
    if (!scrollElement) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = scrollElement;
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
      const atBottom = distanceFromBottom <= SCROLL_THRESHOLD;

      setIsAtBottom(atBottom);

      // Auto-enable scroll lock when user scrolls to bottom manually
      if (atBottom) {
        setIsScrollLocked(true);
        isScrollLockedRef.current = true;
      } else {
        // User scrolled up - disable scroll lock
        setIsScrollLocked(false);
        isScrollLockedRef.current = false;
      }
    };

    scrollElement.addEventListener("scroll", handleScroll, { passive: true });
    return () => scrollElement.removeEventListener("scroll", handleScroll);
  }, [scrollRef]);

  // Auto-scroll to bottom when trigger changes (only if scroll-locked)
  // Uses instant scrolling to keep up with rapid message streaming
  // Uses ref instead of state to avoid race conditions with scroll events
  useEffect(() => {
    if (!isScrollLockedRef.current) return;

    const scrollElement = scrollRef.current?.querySelector(
      "[data-radix-scroll-area-viewport]"
    );
    if (scrollElement) {
      scrollElement.scrollTop = scrollElement.scrollHeight;
    }
  }, [scrollTrigger, scrollRef]);

  // Handle scroll to bottom button click
  const scrollToBottom = useCallback(() => {
    const scrollElement = scrollRef.current?.querySelector(
      "[data-radix-scroll-area-viewport]"
    );
    if (scrollElement) {
      scrollElement.scrollTo({
        top: scrollElement.scrollHeight,
        behavior: "smooth",
      });
      // Update both state and ref immediately for sync behavior
      setIsScrollLocked(true);
      isScrollLockedRef.current = true;
    }
  }, [scrollRef]);

  return {
    isAtBottom,
    isScrollLocked,
    scrollToBottom,
  };
}

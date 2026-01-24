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
  // Track the viewport element in state to trigger re-renders when it becomes available
  const [viewportElement, setViewportElement] = useState<HTMLElement | null>(null);
  // Counter to trigger re-checking for the ref after initial render
  const [mountCount, setMountCount] = useState(0);

  // Use a ref to track scroll lock for sync access in effects
  // This prevents race conditions where state hasn't updated yet
  const isScrollLockedRef = useRef(true);

  // Trigger a re-render after mount to re-check for the ref
  useEffect(() => {
    // Small delay to ensure the DOM has been committed
    const timer = setTimeout(() => {
      setMountCount((c) => c + 1);
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  // Find the viewport element when the ref changes or after mount
  useEffect(() => {
    const findViewport = (): HTMLElement | null => {
      if (!scrollRef.current) return null;
      // Try Radix's internal attribute first, then fall back to data-slot
      return (
        scrollRef.current.querySelector("[data-radix-scroll-area-viewport]") ||
        scrollRef.current.querySelector('[data-slot="scroll-area-viewport"]')
      ) as HTMLElement | null;
    };

    // Try immediately
    const viewport = findViewport();
    if (viewport) {
      setViewportElement(viewport);
      return;
    }

    // If not found, poll a few times (handles async rendering)
    let attempts = 0;
    const maxAttempts = 20;
    const interval = setInterval(() => {
      attempts++;
      const vp = findViewport();
      if (vp) {
        setViewportElement(vp);
        clearInterval(interval);
      } else if (attempts >= maxAttempts) {
        console.warn("[useScrollLock] Failed to find viewport after", maxAttempts, "attempts");
        clearInterval(interval);
      }
    }, 50);

    return () => clearInterval(interval);
  }, [scrollRef, mountCount]);

  // Check initial scroll position when viewport becomes available
  useEffect(() => {
    if (!viewportElement) return;

    const { scrollTop, scrollHeight, clientHeight } = viewportElement;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    const atBottom = distanceFromBottom <= SCROLL_THRESHOLD;

    setIsAtBottom(atBottom);
    setIsScrollLocked(atBottom);
    isScrollLockedRef.current = atBottom;
  }, [viewportElement]);

  // Track scroll position to manage scroll lock
  useEffect(() => {
    if (!viewportElement) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = viewportElement;
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

    viewportElement.addEventListener("scroll", handleScroll, { passive: true });
    return () => viewportElement.removeEventListener("scroll", handleScroll);
  }, [viewportElement]);

  // Auto-scroll to bottom when trigger changes (only if scroll-locked)
  // Uses instant scrolling to keep up with rapid message streaming
  // Uses ref instead of state to avoid race conditions with scroll events
  useEffect(() => {
    if (!isScrollLockedRef.current || !viewportElement) return;

    viewportElement.scrollTop = viewportElement.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Using ref instead of state to avoid race condition
  }, [scrollTrigger, viewportElement]);

  // Handle scroll to bottom button click
  const scrollToBottom = useCallback(() => {
    if (!viewportElement) return;

    viewportElement.scrollTo({
      top: viewportElement.scrollHeight,
      behavior: "smooth",
    });
    // Update both state and ref immediately for sync behavior
    setIsAtBottom(true);
    setIsScrollLocked(true);
    isScrollLockedRef.current = true;
  }, [viewportElement]);

  return {
    isAtBottom,
    isScrollLocked,
    scrollToBottom,
  };
}

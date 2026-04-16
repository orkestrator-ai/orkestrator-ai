import { useEffect, useState, useCallback, useRef } from "react";
import type { VirtuosoHandle, StateSnapshot } from "react-virtuoso";

/** Pixels from bottom to consider "at bottom" */
const AT_BOTTOM_THRESHOLD = 50;

/** Maximum persisted scroll states to retain (LRU eviction) */
const MAX_PERSISTED_STATES = 200;

/**
 * Large value used with scrollTo({ top }) to scroll past the last data item
 * into the footer. The browser clamps this to scrollHeight - clientHeight.
 */
const SCROLL_TO_ABSOLUTE_BOTTOM = 10_000_000;

const persistedStates = new Map<string, StateSnapshot>();

function setPersistedState(key: string, state: StateSnapshot) {
  persistedStates.delete(key);
  persistedStates.set(key, state);

  if (persistedStates.size > MAX_PERSISTED_STATES) {
    const oldestKey = persistedStates.keys().next().value;
    if (oldestKey) {
      persistedStates.delete(oldestKey);
    }
  }
}

export function clearPersistedVirtuosoState(persistKey: string) {
  persistedStates.delete(persistKey);
}

interface UseVirtuosoScrollStateOptions {
  /** Whether the host view is currently active/visible */
  isActive?: boolean;
  /** Optional persistence key for retaining scroll state across tab switches */
  persistKey?: string;
}

interface UseVirtuosoScrollStateReturn {
  /** Whether the user is currently at the bottom of the scroll area */
  isAtBottom: boolean;
  /** Ref that tracks at-bottom state without triggering re-renders (for use in effects) */
  isAtBottomRef: React.RefObject<boolean>;
  /** Scroll to bottom and re-enable follow mode */
  scrollToBottom: () => void;
  /** Ref to attach to the Virtuoso component */
  virtuosoRef: React.RefObject<VirtuosoHandle | null>;
  /** Props to spread onto the Virtuoso component */
  scrollProps: {
    followOutput: (isAtBottom: boolean) => "smooth" | false;
    atBottomStateChange: (atBottom: boolean) => void;
    atBottomThreshold: number;
    restoreStateFrom: StateSnapshot | undefined;
  };
}

/**
 * Hook to manage scroll state for a react-virtuoso Virtuoso component.
 *
 * Replaces useScrollLock for virtualized chat lists. Provides:
 * - Auto-follow when user is at bottom (via followOutput)
 * - "At bottom" state tracking (via atBottomStateChange)
 * - Scroll position persistence across tab switches
 * - Smooth scroll-to-bottom action
 */
export function useVirtuosoScrollState(
  options: UseVirtuosoScrollStateOptions = {}
): UseVirtuosoScrollStateReturn {
  const { isActive = true, persistKey } = options;

  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const isAtBottomRef = useRef(true);

  // Resolve initial restore state once on mount
  const [restoreState] = useState<StateSnapshot | undefined>(() =>
    persistKey ? persistedStates.get(persistKey) : undefined
  );

  // Persist state when tab becomes inactive
  useEffect(() => {
    if (isActive || !persistKey) return;

    virtuosoRef.current?.getState((snapshot) => {
      setPersistedState(persistKey, snapshot);
    });
  }, [isActive, persistKey]);

  const atBottomStateChange = useCallback(
    (atBottom: boolean) => {
      setIsAtBottom(atBottom);
      isAtBottomRef.current = atBottom;
    },
    []
  );

  const followOutput = useCallback(
    (isAtBottom: boolean): "smooth" | false => {
      return isAtBottom ? "smooth" : false;
    },
    []
  );

  const scrollToBottom = useCallback(() => {
    const handle = virtuosoRef.current;
    if (!handle) return;

    // Two-phase scroll to handle both long conversations and footer content.
    //
    // Phase 1: Jump (instant) to the last data item via scrollToIndex.
    // Virtuoso's virtual scrollHeight is based on estimated heights for items
    // that haven't been rendered. On long conversations, these estimates can
    // be far too small, causing scrollTo with a large pixel value to fall
    // short of the actual bottom. scrollToIndex forces Virtuoso to render and
    // measure items at the end, correcting the virtual scroll height.
    handle.scrollToIndex({
      index: "LAST",
      align: "end",
    });

    // Phase 2: Smooth-scroll past the last data item to reveal footer content
    // (thinking indicator, question cards, elapsed time). scrollToIndex only
    // targets the last data item; footer content renders below it and needs
    // an additional scroll. requestAnimationFrame ensures Virtuoso has
    // processed height corrections from Phase 1 before we scroll.
    requestAnimationFrame(() => {
      handle.scrollTo({
        top: SCROLL_TO_ABSOLUTE_BOTTOM,
        behavior: "smooth",
      });
    });
    // Don't optimistically set isAtBottom — let Virtuoso's atBottomStateChange
    // fire when the scroll actually reaches the bottom.
  }, []);

  return {
    isAtBottom,
    isAtBottomRef,
    scrollToBottom,
    virtuosoRef,
    scrollProps: {
      followOutput,
      atBottomStateChange,
      atBottomThreshold: AT_BOTTOM_THRESHOLD,
      restoreStateFrom: restoreState,
    },
  };
}

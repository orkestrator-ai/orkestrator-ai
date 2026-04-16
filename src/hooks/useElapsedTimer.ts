import { useEffect, useState } from "react";

interface UseElapsedTimerReturn {
  /** Seconds elapsed since loading started, or null when not loading */
  elapsedSeconds: number | null;
  /** Seconds the last loading period took, or null before the first completion */
  finalElapsedSeconds: number | null;
}

/**
 * Tracks how long an agent has been working (loading).
 *
 * - While `isLoading` is true, `elapsedSeconds` ticks up every second.
 * - When `isLoading` transitions to false, `finalElapsedSeconds` captures the
 *   total duration and `elapsedSeconds` resets to null.
 * - When `sessionId` changes, all timer state resets.
 */
export function useElapsedTimer(
  isLoading: boolean | undefined,
  sessionId: string | undefined,
  loadingStartedAt?: number,
  storedFinalElapsedSeconds?: number | null,
): UseElapsedTimerReturn {
  const [elapsedSeconds, setElapsedSeconds] = useState<number | null>(null);

  // Reset timer state when session changes (e.g. resume session)
  useEffect(() => {
    setElapsedSeconds(null);
  }, [sessionId]);

  useEffect(() => {
    if (!isLoading || loadingStartedAt === undefined) {
      setElapsedSeconds(null);
      return;
    }

    const updateElapsed = () => {
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - loadingStartedAt) / 1000)));
    };

    updateElapsed();
    const interval = setInterval(updateElapsed, 1000);

    return () => clearInterval(interval);
  }, [isLoading, loadingStartedAt]);

  return {
    elapsedSeconds,
    finalElapsedSeconds: isLoading ? null : (storedFinalElapsedSeconds ?? null),
  };
}

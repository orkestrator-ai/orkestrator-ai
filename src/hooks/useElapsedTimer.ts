import { useEffect, useRef, useState } from "react";

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
): UseElapsedTimerReturn {
  const loadingStartTimeRef = useRef<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState<number | null>(null);
  const [finalElapsedSeconds, setFinalElapsedSeconds] = useState<number | null>(null);

  // Reset timer state when session changes (e.g. resume session)
  useEffect(() => {
    loadingStartTimeRef.current = null;
    setElapsedSeconds(null);
    setFinalElapsedSeconds(null);
  }, [sessionId]);

  useEffect(() => {
    if (isLoading) {
      if (loadingStartTimeRef.current === null) {
        loadingStartTimeRef.current = Date.now();
      }
      setFinalElapsedSeconds(null);

      const interval = setInterval(() => {
        if (loadingStartTimeRef.current !== null) {
          setElapsedSeconds(Math.floor((Date.now() - loadingStartTimeRef.current) / 1000));
        }
      }, 1000);

      return () => clearInterval(interval);
    } else {
      if (loadingStartTimeRef.current !== null) {
        const finalTime = Math.floor((Date.now() - loadingStartTimeRef.current) / 1000);
        setFinalElapsedSeconds(finalTime);
        loadingStartTimeRef.current = null;
      }
      setElapsedSeconds(null);
    }
  }, [isLoading]);

  return { elapsedSeconds, finalElapsedSeconds };
}

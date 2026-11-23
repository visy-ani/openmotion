import { useEffect, useRef } from 'react';

export interface VisibilityPollingOptions {
  enabled?: boolean;
  intervalMs: number;
  maxBackoffMs?: number;
  immediate?: boolean;
  runWhenHidden?: boolean;
  resetKey?: unknown;
}

/**
 * Visibility-aware polling hook with single-flight overlap prevention,
 * AbortController cancellation, and exponential error backoff.
 */
export function useVisibilityPolling(
  task: (signal: AbortSignal) => Promise<void> | void,
  {
    enabled = true,
    intervalMs,
    maxBackoffMs = Math.max(intervalMs * 4, 30_000),
    immediate = true,
    runWhenHidden = false,
    resetKey,
  }: VisibilityPollingOptions,
): void {
  const taskRef = useRef(task);
  taskRef.current = task;

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failureCount = 0;
    const controller = new AbortController();

    const clearTimer = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };

    const nextDelay = () => {
      if (failureCount <= 0) return intervalMs;
      return Math.min(intervalMs * (2 ** Math.min(failureCount, 5)), maxBackoffMs);
    };

    const schedule = () => {
      clearTimer();
      if (!active) return;
      if (!runWhenHidden && typeof document !== 'undefined' && document.hidden) return;
      timer = setTimeout(() => void run(), nextDelay());
    };

    const run = async () => {
      if (!active || controller.signal.aborted) return;
      if (!runWhenHidden && typeof document !== 'undefined' && document.hidden) return;
      if (inFlight) {
        schedule();
        return;
      }
      inFlight = true;
      try {
        await taskRef.current(controller.signal);
        failureCount = 0;
      } catch {
        failureCount += 1;
      } finally {
        inFlight = false;
        schedule();
      }
    };

    const onVisibilityChange = () => {
      if (!active || controller.signal.aborted) return;
      if (!document.hidden) {
        clearTimer();
        void run();
      } else if (!runWhenHidden) {
        clearTimer();
      }
    };

    if (!runWhenHidden && typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }

    if (immediate) {
      void run();
    } else {
      schedule();
    }

    return () => {
      active = false;
      clearTimer();
      controller.abort();
      if (!runWhenHidden && typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
    };
  }, [enabled, intervalMs, maxBackoffMs, immediate, runWhenHidden, resetKey]);
}

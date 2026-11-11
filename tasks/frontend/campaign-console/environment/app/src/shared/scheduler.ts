// Time is injected everywhere it matters (probe loops, retries, token expiry, the breaker), so
// tests can drive it with a fake clock instead of waiting.
export interface Scheduler {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realScheduler: Scheduler = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

/** Resolves after `ms` on the scheduler's clock. */
export function sleep(scheduler: Scheduler, ms: number): Promise<void> {
  return new Promise((resolve) => {
    scheduler.setTimeout(resolve, ms);
  });
}

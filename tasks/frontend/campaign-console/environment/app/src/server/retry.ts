// Retries with exponential backoff and full jitter: after failed attempt n we wait
// random() * min(maxMs, baseMs * 2 ** (n - 1)). Full jitter spreads out the retries of many runs
// hitting the same platform, which plain exponential backoff keeps in lockstep.
// https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/

export interface RetryOptions {
  /** Total attempts, including the first. */
  attempts: number;
  baseMs: number;
  maxMs: number;
  sleep: (ms: number) => Promise<void>;
  /** In [0, 1). */
  random: () => number;
  /** Whether `error`, thrown by attempt `attempt` (1-based), is worth another attempt. */
  shouldRetry: (error: unknown, attempt: number) => boolean;
  /** Called before waiting `delayMs` for the next attempt. */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

export function backoffDelay(attempt: number, options: Pick<RetryOptions, "baseMs" | "maxMs" | "random">): number {
  const ceiling = Math.min(options.maxMs, options.baseMs * 2 ** (attempt - 1));
  return Math.floor(options.random() * ceiling);
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt >= options.attempts || !options.shouldRetry(error, attempt)) throw error;
      const delayMs = backoffDelay(attempt, options);
      options.onRetry?.(error, attempt, delayMs);
      await options.sleep(delayMs);
    }
  }
}

// A Scheduler whose clock only moves when a test says so. Share ONE instance between createApp and
// the client under test, so the browser's confirmation timers and the server's probe loops, retry
// sleeps, breaker windows and token expiry all run on the same clock.

interface Timer {
  id: number;
  at: number;
  fn: () => void;
}

/** Yields one macrotask: lets resolved promises, socket reads and writes make progress. */
export const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export class FakeScheduler {
  private time: number;
  private nextId = 1;
  private timers: Timer[] = [];
  /** Every setTimeout call, for assertions on what was scheduled ({ ms, at }). */
  readonly scheduled: { ms: number; at: number }[] = [];

  constructor(start = 1_800_000_000_000) {
    this.time = start;
  }

  now(): number {
    return this.time;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const delay = Math.max(0, Number.isFinite(ms) ? ms : 0);
    const timer = { id: this.nextId++, at: this.time + delay, fn };
    this.timers.push(timer);
    this.scheduled.push({ ms: delay, at: this.time });
    return timer.id;
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((t) => t.id !== handle);
  }

  /** Timers not fired or cleared yet. */
  get pending(): number {
    return this.timers.length;
  }

  /** When the next timer is due, or undefined. */
  nextDue(): number | undefined {
    return this.timers.reduce<number | undefined>((min, t) => (min === undefined || t.at < min ? t.at : min), undefined);
  }

  /**
   * Moves the clock forward by `ms`: fires every timer due on the way, in order, yielding a
   * macrotask after each (so promise chains and socket I/O they start can run and schedule more
   * timers), until nothing is due at or before the target. Ends at exactly now + ms.
   */
  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    for (;;) {
      await tick();
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.time = Math.max(this.time, due.at);
      due.fn();
    }
    this.time = target;
    await tick();
  }

  /** Lets in-flight work settle without moving the clock. */
  async settle(rounds = 5): Promise<void> {
    for (let i = 0; i < rounds; i++) await tick();
  }
}

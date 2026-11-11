// A Scheduler whose clock only moves when a test says so.
import type { Scheduler } from "../../src/shared/scheduler.ts";

interface Timer {
  id: number;
  at: number;
  fn: () => void;
}

export class FakeScheduler implements Scheduler {
  private time: number;
  private nextId = 1;
  private timers: Timer[] = [];

  constructor(start = 1_700_000_000_000) {
    this.time = start;
  }

  now(): number {
    return this.time;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const timer = { id: this.nextId++, at: this.time + Math.max(0, ms), fn };
    this.timers.push(timer);
    return timer.id;
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((t) => t.id !== handle);
  }

  get pending(): number {
    return this.timers.length;
  }

  /** Moves the clock forward, firing due timers in order (timers they schedule included). */
  advance(ms: number): void {
    const until = this.time + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.time = due.at;
      due.fn();
    }
    this.time = until;
  }
}

/** Lets pending promise callbacks run. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

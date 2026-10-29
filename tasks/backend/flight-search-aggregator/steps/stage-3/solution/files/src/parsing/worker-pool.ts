// A fixed-size pool of parser threads with a FIFO queue.
//
// - Workers start lazily, on the first job that needs one.
// - A worker holds the process open only while it has a job (it is unref'd when idle), and
//   close() terminates them all.
// - If a worker dies (error or exit), its in-flight job is rejected and the slot is refilled on
//   demand, so one bad payload can't hang a search or shrink the pool.
import { Worker } from "node:worker_threads";
import { SupplierPayloadError } from "../errors.ts";
import type { Itinerary, SupplierFormat } from "../types.ts";

export interface ParseJob {
  id: number;
  format: SupplierFormat;
  raw: string;
  supplier: string;
}

export type ParseReply =
  | { id: number; ok: true; itineraries: Itinerary[] }
  | { id: number; ok: false; error: { name: string; message: string } };

interface Task {
  job: ParseJob;
  resolve: (itineraries: Itinerary[]) => void;
  reject: (err: Error) => void;
}

interface Slot {
  worker: Worker;
  task?: Task;
}

const WORKER_URL = new URL("./parse-worker.ts", import.meta.url);

export class WorkerPool {
  readonly #size: number;
  readonly #slots: Slot[] = [];
  readonly #queue: Task[] = [];
  #nextId = 1;
  #closed = false;

  constructor(size: number) {
    this.#size = size;
  }

  parse(format: SupplierFormat, raw: string, supplier: string): Promise<Itinerary[]> {
    if (this.#closed) return Promise.reject(new Error("parser pool is closed"));
    return new Promise((resolve, reject) => {
      this.#queue.push({ job: { id: this.#nextId++, format, raw, supplier }, resolve, reject });
      this.#dispatch();
    });
  }

  /** Rejects queued and in-flight jobs and terminates every thread. Safe to call repeatedly. */
  async close(): Promise<void> {
    this.#closed = true;
    for (const task of this.#queue.splice(0)) task.reject(new Error("parser pool is closed"));
    const slots = this.#slots.splice(0);
    for (const slot of slots) {
      slot.task?.reject(new Error("parser pool is closed"));
      slot.task = undefined;
    }
    await Promise.all(slots.map((s) => s.worker.terminate()));
  }

  #dispatch(): void {
    while (this.#queue.length > 0 && !this.#closed) {
      let slot = this.#slots.find((s) => !s.task);
      if (!slot) {
        if (this.#slots.length >= this.#size) return;
        slot = this.#spawn();
      }
      const task = this.#queue.shift() as Task;
      slot.task = task;
      slot.worker.ref();
      slot.worker.postMessage(task.job);
    }
  }

  #spawn(): Slot {
    const slot: Slot = { worker: new Worker(WORKER_URL) };
    slot.worker.on("message", (reply: ParseReply) => {
      const task = slot.task;
      if (!task || task.job.id !== reply.id) return;
      slot.task = undefined;
      slot.worker.unref();
      if (reply.ok) task.resolve(reply.itineraries);
      else task.reject(new SupplierPayloadError(reply.error.message));
      this.#dispatch();
    });
    const fail = (err: Error) => {
      const i = this.#slots.indexOf(slot);
      if (i === -1) return; // already removed (close() or an earlier event)
      this.#slots.splice(i, 1);
      slot.task?.reject(err);
      slot.task = undefined;
      void slot.worker.terminate();
      this.#dispatch(); // replaces the worker if jobs are waiting
    };
    slot.worker.on("error", (err) => fail(err instanceof Error ? err : new Error(String(err))));
    slot.worker.on("exit", (code) => fail(new Error(`parser thread exited with code ${code}`)));
    this.#slots.push(slot);
    return slot;
  }
}

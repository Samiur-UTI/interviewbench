// Runs in a worker thread: parses and normalises one supplier payload at a time, so the
// JSON.parse of a 100 MB response never blocks the service's event loop.
import { parentPort } from "node:worker_threads";
import { parsePayload } from "../suppliers/index.ts";
import type { ParseJob, ParseReply } from "./worker-pool.ts";

const port = parentPort;
if (!port) throw new Error("parse-worker.ts must run in a worker thread");

port.on("message", (job: ParseJob) => {
  let reply: ParseReply;
  try {
    reply = { id: job.id, ok: true, itineraries: parsePayload(job.format, job.raw, job.supplier) };
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    reply = { id: job.id, ok: false, error: { name: e.name, message: e.message } };
  }
  port.postMessage(reply);
});

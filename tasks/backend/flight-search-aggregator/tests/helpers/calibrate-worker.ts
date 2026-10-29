// Measures how long JSON.parse of a payload takes on this machine, off the main thread, so the
// measurement neither blocks nor fills the heap of the thread whose responsiveness is tested.
// Receives a raw string, posts back the minimum of two runs in milliseconds.
import { parentPort } from "node:worker_threads";

parentPort!.on("message", (raw: string) => {
  let best = Infinity;
  for (let i = 0; i < 2; i++) {
    const start = performance.now();
    JSON.parse(raw);
    best = Math.min(best, performance.now() - start);
  }
  parentPort!.postMessage(best);
});

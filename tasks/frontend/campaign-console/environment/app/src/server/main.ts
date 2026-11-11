// npm start: serves the console with the data in data/seed.json (or SEED_PATH).
//   PORT              default 3000; 0 picks a free port
//   SEED_PATH         JSON file with the Seed shape (src/server/store.ts)
//   RELAY_PLATFORMS   "live" for the real integrations (see src/server/platforms/index.ts);
//                     anything else uses the sandbox platforms
//   RELAY_SANDBOX_LATENCY_MS, RELAY_SANDBOX_FAILURE_RATE   sandbox tuning ("80,600", 0.03)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.ts";
import { platformsFromEnv } from "./platforms/index.ts";
import { createStore } from "./store.ts";
import type { Seed } from "./store.ts";

const seedPath = process.env.SEED_PATH ?? fileURLToPath(new URL("../../data/seed.json", import.meta.url));
const seed = JSON.parse(readFileSync(seedPath, "utf8")) as Seed;
const store = createStore(seed);
const app = createApp({ store, platforms: platformsFromEnv(process.env) });

const { url } = await app.listen(Number(process.env.PORT ?? 3000));
console.log(`listening on ${url}`);

// Runs that were in flight when the server stopped carry on from where they were.
for (const run of store.listRuns()) {
  if (run.status === "running" || run.status === "queued") {
    app.runner.start(run.id).catch((error: unknown) => console.error(`run ${run.id} stopped:`, error));
  }
}

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await app.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

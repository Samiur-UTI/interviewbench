// Stage 3 hidden tests (part 2): the event loop stays responsive while a very large payload is
// parsed, and the deadline still covers waiting only.
//
// How the responsiveness bound works:
// - J = time JSON.parse of the big payload takes on this machine, measured in a separate worker
//   (helpers/calibrate-worker.ts), so the measurement neither blocks nor fills this thread's heap.
// - The payload (about 2,600 offers x 30 KB, ~77 MB) grows until J >= 150 ms, capped at 128 MB.
// - A 5 ms heartbeat runs during one search over that payload; its longest gap must be under
//   max(50, 0.5 * J). Any approach that runs JSON.parse over the whole payload on the main thread
//   blocks for at least J, so it can't pass; off-thread parsing leaves only the copy to the
//   worker and the (small) result on this thread.
//
// Merge-gate measurements (record J, maxGap, maxGap/J, payload size, pass/fail):
// - Host (Windows 11, 16 cores, Node 24.13.1, local runner), 76.3 MB / 2600 offers:
//   stage-3 reference 20/20 pass: J 237-279 ms, maxGap 17.0-23.8 ms, maxGap/J 0.068-0.098
//   (worst 0.098 <= 0.35 target). Stage-2 reference (main-thread parse) 3/3 fail:
//   maxGap 271-273 ms, maxGap/J 1.11-1.13. Peak RSS ~480-560 MB.
// - Docker --cpus=2 / --cpus=1: NOT YET MEASURED (Docker daemon unavailable when the task was
//   written). Run before merging; see the spec's merge gate.
//
// performance.now and setInterval are captured before the app is imported, so code under test
// can't replace the measuring tools.
const now = performance.now.bind(performance);
const every = setInterval;
const stopEvery = clearInterval;

import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { after, before, test } from "node:test";
import { loadApp } from "./helpers/app.ts";
import { neverResolving, resolving } from "./helpers/fakes.ts";
import { ANY_REQUEST, aeroLinkRaw, genMarket, skyMeshRaw, toItineraries } from "./helpers/payloads.ts";
import type { GenOffer } from "./helpers/payloads.ts";
import { referenceSearch } from "./helpers/reference.ts";

const START_OFFERS = 2600;
const BULK_BYTES = 30_000;
const TARGET_J_MS = 150;
const MAX_BYTES = 128 * 1024 * 1024;

const services: { close?: () => Promise<void> }[] = [];
after(async () => {
  for (const s of services) if (typeof s.close === "function") await s.close();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Big {
  raw: string;
  offers: number;
  J: number;
  mb: number;
  smallRaw: string;
  bigSmallRaw: string; // same format as the big supplier, but tiny: for the warm-up search
  expectedCount: number;
}

let big: Big;

before(async () => {
  const calibrator = new Worker(new URL("./helpers/calibrate-worker.ts", import.meta.url));
  const calibrate = (raw: string) =>
    new Promise<number>((resolve, reject) => {
      calibrator.once("message", resolve);
      calibrator.once("error", reject);
      calibrator.postMessage(raw);
    });
  let n = START_OFFERS;
  let raw = "";
  let offers: GenOffer[] = [];
  let J = 0;
  for (;;) {
    [offers] = genMarket(401, n, 1, { dupRatio: 0, seats: [1, 9] });
    raw = aeroLinkRaw(offers, { seed: 401, bulkBytes: BULK_BYTES });
    J = await calibrate(raw);
    if (J >= TARGET_J_MS || raw.length >= MAX_BYTES * 0.97) break;
    n = Math.floor(n * Math.min(1.5, (MAX_BYTES * 0.97) / raw.length));
  }
  await calibrator.terminate();
  const [small] = genMarket(402, 40, 1);
  const [tiny] = genMarket(403, 20, 1);
  const expectedCount = referenceSearch(
    [
      { name: "aerolink", itineraries: toItineraries(offers, "aerolink") },
      { name: "skymesh", itineraries: toItineraries(small, "skymesh") },
    ],
    1,
  ).length;
  big = {
    raw,
    offers: n,
    J,
    mb: raw.length / 1024 / 1024,
    smallRaw: skyMeshRaw(small),
    bigSmallRaw: aeroLinkRaw(tiny),
    expectedCount,
  };
  await sleep(200); // let this thread's GC settle before measuring
}, { timeout: 60_000 });

test("s3 event loop stays responsive while parsing", { timeout: 60_000 }, async (t) => {
  const app = await loadApp();
  let raw = big.bigSmallRaw;
  const svc = new app.FlightSearchService(
    [resolving("aerolink", "aerolink", () => raw), resolving("skymesh", "skymesh", big.smallRaw)],
    { parserThreads: 1 },
  );
  services.push(svc);
  await svc.searchWithStatus(ANY_REQUEST); // warm-up: start threads, compile code paths
  raw = big.raw;
  await sleep(50);

  let last = now();
  let maxGap = 0;
  const heartbeat = every(() => {
    const t1 = now();
    maxGap = Math.max(maxGap, t1 - last);
    last = t1;
  }, 5);
  let result;
  try {
    result = await svc.searchWithStatus(ANY_REQUEST);
    await sleep(30);
  } finally {
    stopEvery(heartbeat);
  }
  maxGap = Math.max(maxGap, now() - last);

  const bound = Math.max(50, 0.5 * big.J);
  t.diagnostic(
    `payload ${big.mb.toFixed(1)} MB (${big.offers} offers), J ${big.J.toFixed(1)} ms, maxGap ${maxGap.toFixed(1)} ms, ` +
      `maxGap/J ${(maxGap / big.J).toFixed(3)}, bound ${bound.toFixed(1)} ms, ` +
      `peak RSS ${(process.resourceUsage().maxRSS / 1024).toFixed(0)} MB`,
  );
  assert.deepEqual(
    result.suppliers.map((s: { status: string }) => s.status),
    ["ok", "ok"],
  );
  assert.equal(result.itineraries.length, big.expectedCount);
  assert.ok(
    maxGap < bound,
    `the event loop was blocked for ${maxGap.toFixed(0)} ms; the limit is ${bound.toFixed(0)} ms ` +
      `(half of the ${big.J.toFixed(0)} ms JSON.parse of this ${big.mb.toFixed(0)} MB payload takes here)`,
  );
});

test("s3 deadline covers waiting, not parsing", { timeout: 60_000 }, async (t) => {
  const app = await loadApp();
  // The big supplier answers at once; parsing it off-thread takes at least J > 3 x timeoutMs.
  const timeoutMs = Math.max(20, Math.floor(big.J / 3));
  const svc = new app.FlightSearchService(
    [
      resolving("aerolink", "aerolink", big.raw),
      resolving("skymesh", "skymesh", big.smallRaw),
      neverResolving("hanging", "skymesh"),
    ],
    { parserThreads: 1 },
  );
  services.push(svc);
  const result = await svc.searchWithStatus(ANY_REQUEST, { timeoutMs });
  t.diagnostic(`timeoutMs ${timeoutMs}`);
  assert.deepEqual(
    result.suppliers.map((s: { supplier: string; status: string }) => `${s.supplier}:${s.status}`),
    ["aerolink:ok", "skymesh:ok", "hanging:timeout"],
  );
});

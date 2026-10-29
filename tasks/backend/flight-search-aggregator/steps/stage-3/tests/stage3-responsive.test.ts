// Stage 3 hidden tests (part 2): parsing stays off the event loop, and the deadline covers
// waiting only. Its own file, so its own process: nothing else disturbs the measurements.
//
// How the responsiveness bound works:
// - The big payload is a Caravel response whose per-traveller, per-segment amenity lists make it
//   large while its offers stay few, so returning parsed offers from a thread stays cheap.
// - J = how long JSON.parse of that payload takes on this machine, measured in a separate worker
//   (helpers/calibrate-worker.ts), so the measurement neither blocks nor fills this thread's heap.
//   The payload grows by 1.25x until J >= 150 ms, capped at 128 MB.
// - A 5 ms heartbeat runs during one search over that payload. Writing to the database on the main
//   thread is allowed, so only the gaps before the first main-thread write to an offers table
//   count (the gap containing that write counts up to the write). The longest counted gap must be
//   under max(50, 0.5 * J). Any JSON.parse of the whole payload on the main thread happens before
//   any write and blocks for at least J, so it can't pass.
//
// Host measurements (Windows 11, 16 cores, Node 24.13.1), 5 runs of the stage-3 reference:
// 67.5 MB / 3,125 offers, J 165-167 ms, maxGap 18.6-24.9 ms (maxGap/J 0.11-0.15, bound ~83 ms),
// peak RSS ~760 MB. The stage-2 reference (main-thread parse): maxGap 256 ms, fails.
// Docker (--cpus=2 / --cpus=1): not yet measured; the Docker daemon was unavailable.
//
// performance.now, setInterval and the statement methods are captured before the app is imported,
// so code under test can't replace the measuring tools.
const now = performance.now.bind(performance);
const every = setInterval;
const stopEvery = clearInterval;

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { after, before, test } from "node:test";
import { loadApp } from "./helpers/app.ts";
import { neverResolving, resolving } from "./helpers/fakes.ts";
import { caravelPayload, createWorld, keystonePayload, tesseraPayload } from "./helpers/payloads.ts";
import type { SearchRequest } from "./helpers/payloads.ts";
import { referenceOffers } from "./helpers/reference.ts";

const START_OFFERS = 2000;
const AMENITIES = 12;
const TARGET_J_MS = 150;
const MAX_BYTES = 128 * 1024 * 1024;

// ---- the main-thread write marker ------------------------------------------------------------

const OFFER_WRITE = /^\s*(INSERT|REPLACE|UPDATE)\b[\s\S]*\b(offers|offer_segments|offer_prices)\b/i;
let armed = false;
let firstWriteAt: number | undefined;
const mark = (sql: unknown) => {
  if (armed && firstWriteAt === undefined && OFFER_WRITE.test(String(sql))) firstWriteAt = now();
};
{
  const run = StatementSync.prototype.run;
  StatementSync.prototype.run = function (this: StatementSync, ...args: any[]) {
    mark(this.sourceSQL);
    return run.apply(this, args as never);
  };
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (this: DatabaseSync, sql: string) {
    mark(sql);
    return exec.call(this, sql);
  };
  // Every tag store has its own prototype, so patch each one as it is created.
  const createTagStore = DatabaseSync.prototype.createTagStore;
  DatabaseSync.prototype.createTagStore = function (this: DatabaseSync, ...args: any[]) {
    const store = createTagStore.apply(this, args as never);
    const proto = Object.getPrototypeOf(store);
    const original = proto.run;
    proto.run = function (strings: TemplateStringsArray, ...values: unknown[]) {
      mark(Array.from(strings).join("?"));
      return original.call(this, strings, ...values);
    };
    return store;
  };
}

// ---- data --------------------------------------------------------------------------------------

const services: { close?: () => Promise<void> }[] = [];
after(async () => {
  for (const s of services) if (typeof s.close === "function") await s.close();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const freshDbPath = (): string => join(mkdtempSync(join(tmpdir(), "ib-s3r-")), "search.db");

interface Big {
  request: SearchRequest;
  caravel: string; // the big payload
  tessera: string;
  keystone: string;
  warmCaravel: string; // a small Caravel payload, for the warm-up search
  offers: number;
  J: number;
  mb: number;
  expectedTotal: number;
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
  let world = createWorld({ seed: 401, offersPerSupplier: n });
  let payload = caravelPayload(world, { amenities: AMENITIES });
  let J = await calibrate(payload.raw);
  while (J < TARGET_J_MS && payload.raw.length * 1.25 < MAX_BYTES) {
    n = Math.round(n * 1.25);
    world = createWorld({ seed: 401, offersPerSupplier: n });
    payload = caravelPayload(world, { amenities: AMENITIES });
    J = await calibrate(payload.raw);
  }
  await calibrator.terminate();
  // Suppliers B and C are normal size: the same request, another world.
  const normal = createWorld({ seed: 402, offersPerSupplier: 250 });
  const tessera = tesseraPayload(normal);
  const keystone = keystonePayload(normal);
  big = {
    request: world.request,
    caravel: payload.raw,
    tessera: tessera.raw,
    keystone: keystone.raw,
    warmCaravel: caravelPayload(createWorld({ seed: 403, offersPerSupplier: 50 })).raw,
    offers: payload.expected.length,
    J,
    mb: payload.raw.length / 1024 / 1024,
    expectedTotal: referenceOffers(
      [
        { name: "caravel", itineraries: payload.expected },
        { name: "tessera", itineraries: tessera.expected },
        { name: "keystone", itineraries: keystone.expected },
      ],
      world.request.passengers,
    ).length,
  };
  await sleep(200); // let this thread's GC settle before measuring
}, { timeout: 60_000 });

test("s3 parsing stays off the event loop", { timeout: 60_000 }, async (t) => {
  const app = await loadApp();
  let caravel = big.warmCaravel;
  const svc = new app.FlightSearchService(
    [resolving("caravel", "caravel", () => caravel), resolving("tessera", "tessera", big.tessera), resolving("keystone", "keystone", big.keystone)],
    { dbPath: freshDbPath(), parserThreads: 1 },
  );
  services.push(svc);
  await svc.searchWithStatus(big.request); // warm-up: start threads, compile code paths
  caravel = big.caravel;
  await sleep(50);

  const gaps: [start: number, end: number][] = [];
  let last = now();
  const heartbeat = every(() => {
    const t1 = now();
    gaps.push([last, t1]);
    last = t1;
  }, 5);
  let result;
  firstWriteAt = undefined;
  armed = true;
  try {
    result = await svc.searchWithStatus(big.request);
    await sleep(30);
  } finally {
    armed = false;
    stopEvery(heartbeat);
  }
  gaps.push([last, now()]);

  const writeAt = firstWriteAt;
  let maxGap = 0;
  for (const [start, end] of gaps) {
    if (writeAt === undefined || end <= writeAt) maxGap = Math.max(maxGap, end - start);
    else if (start < writeAt) maxGap = Math.max(maxGap, writeAt - start);
  }
  const bound = Math.max(50, 0.5 * big.J);
  t.diagnostic(
    `payload ${big.mb.toFixed(1)} MB (${big.offers} offers), J ${big.J.toFixed(1)} ms, maxGap ${maxGap.toFixed(1)} ms, ` +
      `maxGap/J ${(maxGap / big.J).toFixed(3)}, bound ${bound.toFixed(1)} ms, main-thread write ${writeAt === undefined ? "none" : "seen"}, ` +
      `peak RSS ${(process.resourceUsage().maxRSS / 1024).toFixed(0)} MB`,
  );
  assert.deepEqual(
    result.suppliers.map((s: { status: string }) => s.status),
    ["ok", "ok", "ok"],
  );
  assert.equal(result.total, big.expectedTotal);
  assert.ok(
    maxGap < bound,
    `the event loop was blocked for ${maxGap.toFixed(0)} ms before the search started writing; the limit is ` +
      `${bound.toFixed(0)} ms (half of the ${big.J.toFixed(0)} ms JSON.parse of this ${big.mb.toFixed(0)} MB payload takes here)`,
  );
});

test("s3 deadline covers waiting, not parsing", { timeout: 60_000 }, async (t) => {
  const app = await loadApp();
  // The big supplier answers at once; parsing it off-thread takes at least J > 3 x timeoutMs.
  const timeoutMs = Math.max(20, Math.floor(big.J / 3));
  const svc = new app.FlightSearchService(
    [
      resolving("caravel", "caravel", big.caravel),
      resolving("tessera", "tessera", big.tessera),
      resolving("keystone", "keystone", big.keystone),
      neverResolving("hanging", "keystone"),
    ],
    { dbPath: freshDbPath(), parserThreads: 1 },
  );
  services.push(svc);
  const result = await svc.searchWithStatus(big.request, { timeoutMs });
  t.diagnostic(`timeoutMs ${timeoutMs}`);
  assert.deepEqual(
    result.suppliers.map((s: { supplier: string; status: string }) => `${s.supplier}:${s.status}`),
    ["caravel:ok", "tessera:ok", "keystone:ok", "hanging:timeout"],
  );
});

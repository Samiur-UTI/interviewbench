// Child process for "s2 nothing keeps the process alive after a search". Runs three searches
// (all fast, one supplier timing out, caller abort), prints "done" and returns without calling
// process.exit. The parent requires this process to exit on its own, soon.
import { loadApp } from "./app.ts";
import { neverResolving, resolving } from "./fakes.ts";
import { ANY_REQUEST, aeroLinkRaw, genMarket, skyMeshRaw } from "./payloads.ts";

const app = await loadApp();
const [al, sm] = genMarket(11, 40, 2);
const services: { close?: () => Promise<void> }[] = [];
const service = (clients: unknown[]) => {
  const svc = new app.FlightSearchService(clients);
  services.push(svc);
  return svc;
};

// (a) everyone answers at once; the 30 s deadline must not keep the process alive.
const a = await service([resolving("aerolink", "aerolink", aeroLinkRaw(al)), resolving("skymesh", "skymesh", skyMeshRaw(sm))])
  .searchWithStatus(ANY_REQUEST, { timeoutMs: 30_000 });
if (a.partial) throw new Error("(a) expected every supplier ok");

// (b) one supplier never answers and times out.
const b = await service([resolving("aerolink", "aerolink", aeroLinkRaw(al)), neverResolving("slow", "skymesh")])
  .searchWithStatus(ANY_REQUEST, { timeoutMs: 100 });
if (b.suppliers[1].status !== "timeout") throw new Error("(b) expected a timeout");

// (c) the caller gives up while both suppliers hang.
const controller = new AbortController();
const c = service([neverResolving("x", "aerolink"), neverResolving("y", "skymesh")])
  .searchWithStatus(ANY_REQUEST, { timeoutMs: 30_000, signal: controller.signal });
setImmediate(() => controller.abort(new Error("user left")));
await c.then(
  () => {
    throw new Error("(c) expected a rejection");
  },
  () => {},
);

for (const svc of services) if (typeof svc.close === "function") await svc.close();
console.log("done");

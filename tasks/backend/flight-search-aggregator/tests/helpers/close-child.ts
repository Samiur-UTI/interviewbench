// Child process for "s3 process exits after close()": parserThreads 2, one big search, close()
// twice, print "done" and return without process.exit. Leaked threads keep the process alive.
import { loadApp } from "./app.ts";
import { resolving } from "./fakes.ts";
import { ANY_REQUEST, aeroLinkRaw, genMarket, skyMeshRaw } from "./payloads.ts";

const app = await loadApp();
const [al, sm] = genMarket(21, 6000, 2);
const svc = new app.FlightSearchService(
  [resolving("aerolink", "aerolink", aeroLinkRaw(al, { bulkBytes: 2000 })), resolving("skymesh", "skymesh", skyMeshRaw(sm))],
  { parserThreads: 2 },
);
const result = await svc.searchWithStatus(ANY_REQUEST);
if (result.partial) throw new Error(`expected every supplier ok: ${JSON.stringify(result.suppliers)}`);
await svc.close();
await svc.close();
console.log("done");

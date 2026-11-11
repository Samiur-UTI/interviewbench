// HTTP routes: the dashboard page, the JSON API (docs/protocol.md) and the browser's modules.
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { extname, resolve, sep } from "node:path";
import { NotFoundError } from "./errors.ts";
import { renderDashboardPage } from "./pages/dashboard.ts";
import { toDashboardState, toPublicConnection } from "./views.ts";
import type { Store } from "./store.ts";
import type { Hub } from "./ws.ts";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface HttpDeps {
  store: Store;
  hub: Hub;
  /** The app folder; static files are served from its vendor/ and src/ folders. */
  root: string;
}

export type RequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/** Folders the browser may load modules from. Everything else under src/ is server code. */
const STATIC_PREFIXES = ["/vendor/", "/src/client/", "/src/shared/"];

const CONTENT_TYPES: Record<string, string> = {
  ".ts": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function sendText(res: ServerResponse, status: number, contentType: string, text: string): void {
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
  });
  res.end(text);
}

const notFound = (res: ServerResponse) => sendJson(res, 404, { error: "not_found" });

function decodeSegment(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

export function createRequestHandler(deps: HttpDeps): RequestHandler {
  const { store, hub } = deps;
  const root = resolve(deps.root);

  async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
    const decoded = decodeSegment(pathname);
    if (decoded === undefined) return notFound(res);
    const file = resolve(root, `.${decoded}`);
    const allowed = STATIC_PREFIXES.some((prefix) => file.startsWith(resolve(root, `.${prefix}`) + sep));
    const contentType = CONTENT_TYPES[extname(file)];
    if (!allowed || !contentType) return notFound(res);
    let source: string;
    try {
      source = await readFile(file, "utf8");
    } catch {
      return notFound(res);
    }
    // Browsers can't run TypeScript: erase the types (same rules as Node's own type stripping).
    const body = extname(file) === ".ts" ? stripTypeScriptTypes(source, { mode: "strip" }) : source;
    sendText(res, 200, contentType, body);
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const { pathname } = url;
    const method = req.method ?? "GET";

    if (method === "GET" && (pathname === "/" || pathname === "/dashboard")) {
      const page = renderDashboardPage(toDashboardState(store));
      return sendText(res, 200, "text/html; charset=utf-8", page);
    }

    if (method === "GET" && pathname === "/api/dashboard") {
      return sendJson(res, 200, toDashboardState(store));
    }

    const connection = /^\/api\/connections\/([^/]+)$/.exec(pathname);
    if (method === "GET" && connection) {
      const record = store.getConnection(decodeSegment(connection[1]) ?? "");
      if (!record) return notFound(res);
      return sendJson(res, 200, toPublicConnection(record));
    }

    const probe = /^\/api\/connections\/([^/]+)\/probe$/.exec(pathname);
    if (method === "POST" && probe) {
      const id = decodeSegment(probe[1]) ?? "";
      if (!store.getConnection(id)) return notFound(res);
      return sendJson(res, 200, await hub.requestProbe(id));
    }

    if (method === "GET" && STATIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
      return serveStatic(pathname, res);
    }

    return notFound(res);
  }

  // Node's http server doesn't catch a rejected handler: the rejection would end the process.
  return async function handleRequest(req, res) {
    try {
      await route(req, res);
    } catch (error) {
      if (error instanceof NotFoundError) {
        if (!res.headersSent) notFound(res);
        return;
      }
      console.error(`${req.method} ${req.url} failed`, error);
      if (!res.headersSent) sendJson(res, 500, { error: "internal" });
      else res.destroy();
    }
  };
}

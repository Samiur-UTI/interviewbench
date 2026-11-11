// HTTP routes: the dashboard page, the JSON API (docs/protocol.md) and the browser's modules.
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { extname, resolve, sep } from "node:path";
import { NotFoundError, ValidationError } from "./errors.ts";
import { renderDashboardPage } from "./pages/dashboard.ts";
import { toDashboardState, toPublicConnection, toPublicEvent } from "./views.ts";
import type { ReconnectService } from "./reconnect.ts";
import type { Store } from "./store.ts";
import type { Hub } from "./ws.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "../shared/config.ts";
import type { EventPage } from "../shared/types.ts";

export interface HttpDeps {
  store: Store;
  hub: Hub;
  reconnects: ReconnectService;
  config: Config;
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

/** Request bodies are a few hundred bytes (a credential); anything far bigger is not one. */
export const MAX_BODY_BYTES = 64 * 1024;

class BodyError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

/** The request's body as a JSON object. BodyError for one that is too large, not JSON, or not an object. */
async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  const text = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk); // past the limit: drained, not kept
    });
    req.on("end", () => (size > MAX_BODY_BYTES ? reject(new BodyError(413, "too_large")) : resolve(Buffer.concat(chunks).toString("utf8"))));
    req.on("error", reject);
  });
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new BodyError(400, "invalid_json");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new BodyError(400, "invalid_json");
  return value as Record<string, unknown>;
}

/** GET /api/runs/:id/events: `limit` when absent, and the largest one accepted. */
export const EVENT_PAGE = { defaultLimit: 50, maxLimit: 200 } as const;

class QueryError extends Error {
  readonly field: string;

  constructor(field: string) {
    super(`invalid ${field}`);
    this.field = field;
  }
}

/** A query parameter that must be a positive integer written in decimal digits, or absent. */
function positiveInteger(params: URLSearchParams, field: string, max = Number.MAX_SAFE_INTEGER): number | undefined {
  const raw = params.get(field);
  if (raw === null) return undefined;
  if (!/^[0-9]+$/.test(raw)) throw new QueryError(field);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new QueryError(field);
  return value;
}

function decodeSegment(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

export function createRequestHandler(deps: HttpDeps): RequestHandler {
  const { store, hub, reconnects, config } = deps;
  const dashboardState = () => toDashboardState(store, { recentEvents: config.dashboard.recentEvents });
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
      const page = renderDashboardPage(dashboardState());
      return sendText(res, 200, "text/html; charset=utf-8", page);
    }

    if (method === "GET" && pathname === "/api/dashboard") {
      return sendJson(res, 200, dashboardState());
    }

    // Older events of a run, a page at a time, newest pages first: the state only has the newest.
    const runEvents = /^\/api\/runs\/([^/]+)\/events$/.exec(pathname);
    if (method === "GET" && runEvents) {
      const runId = decodeSegment(runEvents[1]) ?? "";
      if (!store.getRun(runId)) return notFound(res);
      let before: number | undefined;
      let limit: number;
      try {
        before = positiveInteger(url.searchParams, "before");
        limit = positiveInteger(url.searchParams, "limit", EVENT_PAGE.maxLimit) ?? EVENT_PAGE.defaultLimit;
      } catch (error) {
        if (error instanceof QueryError) return sendJson(res, 400, { error: "invalid_query", field: error.field });
        throw error;
      }
      const events = store.listEvents(runId, { before, limit });
      const oldest = events[0];
      const older = oldest !== undefined && store.listEvents(runId, { before: oldest.id, limit: 1 }).length > 0;
      const body: EventPage = { events: events.map(toPublicEvent), nextBefore: older ? oldest.id : null };
      return sendJson(res, 200, body);
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

    const credentials = /^\/api\/connections\/([^/]+)\/credentials$/.exec(pathname);
    if (method === "POST" && credentials) {
      const id = decodeSegment(credentials[1]) ?? "";
      if (!store.getConnection(id)) return notFound(res);
      let body: Record<string, unknown>;
      try {
        body = await readJsonObject(req);
      } catch (error) {
        if (!(error instanceof BodyError)) throw error;
        return sendJson(res, error.status, { error: error.code });
      }
      try {
        return sendJson(res, 200, await reconnects.reconnect(id, body));
      } catch (error) {
        if (error instanceof ValidationError) return sendJson(res, 400, { error: "invalid_credential", field: error.field });
        throw error;
      }
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

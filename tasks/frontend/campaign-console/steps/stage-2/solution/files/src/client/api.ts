// The console's HTTP API (docs/protocol.md). `fetch` is injectable for tests.
import type { DashboardState, ProbeResult, ReconnectRequest, ReconnectResponse } from "../shared/types.ts";

export interface ApiOptions {
  fetch?: typeof fetch;
  /** Prefix for every path; "" (same origin) in the browser. */
  baseUrl?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    super(`HTTP ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

async function request<T>(method: "GET" | "POST", path: string, options: ApiOptions, body?: unknown): Promise<T> {
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const response = await doFetch(`${options.baseUrl ?? ""}${path}`, {
    method,
    headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, parsed);
  return parsed as T;
}

export function dashboard(options: ApiOptions = {}): Promise<DashboardState> {
  return request("GET", "/api/dashboard", options);
}

/** Checks a connection now. The server also pushes the result to every open dashboard. */
export function probe(connectionId: string, options: ApiOptions = {}): Promise<ProbeResult> {
  return request("POST", `/api/connections/${encodeURIComponent(connectionId)}/probe`, options);
}

/**
 * What a reconnect came to. `ok: false` carries the server's error code (`invalid_credential` with
 * the `field` to fix, `invalid_json`, `not_found`, ...), or `network` when no answer arrived.
 */
export type ReconnectOutcome =
  | ({ ok: true } & Pick<ReconnectResponse, "resumed" | "probe" | "connection">)
  | { ok: false; error: string; field?: string };

/** Replaces the connection's credential (docs/protocol.md). Never rejects: failures are outcomes. */
export async function reconnect(connectionId: string, body: ReconnectRequest, options: ApiOptions = {}): Promise<ReconnectOutcome> {
  let answer: ReconnectResponse;
  try {
    answer = await request<ReconnectResponse>("POST", `/api/connections/${encodeURIComponent(connectionId)}/credentials`, options, body);
  } catch (error) {
    if (!(error instanceof ApiError)) return { ok: false, error: "network" };
    const parsed = (typeof error.body === "object" && error.body !== null ? error.body : {}) as { error?: unknown; field?: unknown };
    const code = typeof parsed.error === "string" ? parsed.error : `http_${error.status}`;
    return typeof parsed.field === "string" ? { ok: false, error: code, field: parsed.field } : { ok: false, error: code };
  }
  if (!answer || typeof answer !== "object" || !answer.probe || !answer.connection) return { ok: false, error: "bad_response" };
  return { ok: true, resumed: Array.isArray(answer.resumed) ? answer.resumed : [], probe: answer.probe, connection: answer.connection };
}

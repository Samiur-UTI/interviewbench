// The console's HTTP API (docs/protocol.md). `fetch` is injectable for tests.
import type { DashboardState, ProbeResult } from "../shared/types.ts";

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

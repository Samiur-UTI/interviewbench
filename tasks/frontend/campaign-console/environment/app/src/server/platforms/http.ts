// The HTTP plumbing every live adapter shares: timeouts, and turning status codes into
// PlatformError causes.
import { PlatformError } from "../errors.ts";
import type { PlatformErrorCause } from "../errors.ts";

export interface HttpOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface PlatformRequest {
  method: "GET" | "HEAD" | "POST";
  url: string;
  /** The header (or cookie) that authenticates the call. */
  authorization: string;
  headers?: Record<string, string>;
  body?: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export function causeForStatus(status: number): PlatformErrorCause {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 429 || status === 999) return "rate_limited"; // 999 is LinkedIn's "slow down"
  // A redirect on an API call means the session was bounced to a login or challenge page.
  if (status >= 300 && status < 400) return "unauthorized";
  return "unreachable";
}

/** Sends the request and returns the parsed JSON body (null for an empty body). */
export async function requestJson(platform: string, req: PlatformRequest, options: HttpOptions = {}): Promise<any> {
  const doFetch = options.fetch ?? fetch;
  // Kept on every error so support can see which request, and which token, the platform rejected.
  const request = { url: req.url, method: req.method, authorization: req.authorization };
  let response: Response;
  try {
    response = await doFetch(req.url, {
      method: req.method,
      headers: { accept: "application/json", ...req.headers },
      body: req.body,
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    throw new PlatformError("unreachable", `${platform}: ${(error as Error).message}`, { request });
  }
  const text = req.method === "HEAD" ? "" : await response.text().catch(() => "");
  if (!response.ok) {
    throw new PlatformError(causeForStatus(response.status), `${platform}: HTTP ${response.status}`, {
      request,
      status: response.status,
      body: text.slice(0, 2_000),
    });
  }
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new PlatformError("unreachable", `${platform}: response is not JSON`, { request, body: text.slice(0, 2_000) });
  }
}

export function formBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

export const FORM_HEADERS = { "content-type": "application/x-www-form-urlencoded" };
export const JSON_HEADERS = { "content-type": "application/json" };

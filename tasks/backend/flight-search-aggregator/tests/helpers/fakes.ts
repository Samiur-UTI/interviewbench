// Controllable fake SupplierClients. None of them use timers: a test decides when (and whether)
// each call settles. Every fake records the request and AbortSignal of each call.

export type Format = "caravel" | "tessera" | "keystone";

export interface Call {
  req: unknown;
  signal: AbortSignal | undefined;
}

export interface FakeClient {
  readonly name: string;
  readonly format: Format;
  readonly calls: Call[];
  search(req: unknown, signal?: AbortSignal): Promise<string>;
}

function fake(name: string, format: Format, respond: (call: Call) => Promise<string>): FakeClient {
  const calls: Call[] = [];
  return {
    name,
    format,
    calls,
    search(req: unknown, signal?: AbortSignal): Promise<string> {
      const call = { req, signal };
      calls.push(call);
      return respond(call);
    },
  };
}

/** Resolves (in a microtask) with `raw`, or with whatever `raw()` returns at call time. */
export function resolving(name: string, format: Format, raw: string | (() => string)): FakeClient {
  return fake(name, format, async () => (typeof raw === "function" ? raw() : raw));
}

export function rejecting(name: string, format: Format, error: unknown): FakeClient {
  return fake(name, format, async () => {
    throw error;
  });
}

/** Never settles, and ignores its AbortSignal: the service must not depend on suppliers behaving. */
export function neverResolving(name: string, format: Format): FakeClient {
  return fake(name, format, () => new Promise<string>(() => {}));
}

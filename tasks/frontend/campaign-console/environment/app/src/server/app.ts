// Wires the console together. One scheduler drives everything timed (probe loops, retry sleeps,
// breaker windows, token expiry), so tests can run the whole app on a fake clock.
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { CircuitBreaker } from "./breaker.ts";
import { ProbeService } from "./connectivity.ts";
import { createRequestHandler } from "./http.ts";
import { CampaignRunner } from "./runner.ts";
import { TokenCache } from "./tokens.ts";
import { Hub, acceptWebSocket } from "./ws.ts";
import { config as defaultConfig } from "../shared/config.ts";
import { realScheduler } from "../shared/scheduler.ts";
import type { PlatformRegistry } from "./platforms/types.ts";
import type { Store } from "./store.ts";
import type { Config } from "../shared/config.ts";
import type { Scheduler } from "../shared/scheduler.ts";

export interface AppOptions {
  store: Store;
  platforms: PlatformRegistry;
  scheduler?: Scheduler;
  config?: Config;
  /** In [0, 1); retry jitter. */
  random?: () => number;
}

export interface App {
  listen(port: number): Promise<{ port: number; url: string }>;
  /** Stops the server, drops every WebSocket and cancels every timer. Safe to call more than once. */
  close(): Promise<void>;
  store: Store;
  config: Config;
  tokens: TokenCache;
  breakers: CircuitBreaker;
  probes: ProbeService;
  runner: CampaignRunner;
  hub: Hub;
}

const APP_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Wraps a scheduler so every timer the app sets can be cancelled on close. */
function trackTimers(scheduler: Scheduler): { scheduler: Scheduler; clearAll(): void } {
  const pending = new Set<unknown>();
  return {
    scheduler: {
      now: () => scheduler.now(),
      setTimeout(fn, ms) {
        const handle = scheduler.setTimeout(() => {
          pending.delete(handle);
          fn();
        }, ms);
        pending.add(handle);
        return handle;
      },
      clearTimeout(handle) {
        pending.delete(handle);
        scheduler.clearTimeout(handle);
      },
    },
    clearAll() {
      for (const handle of pending) scheduler.clearTimeout(handle);
      pending.clear();
    },
  };
}

export function createApp(options: AppOptions): App {
  const { store, platforms } = options;
  const config = options.config ?? defaultConfig;
  const random = options.random ?? Math.random;
  const timers = trackTimers(options.scheduler ?? realScheduler);
  const scheduler = timers.scheduler;

  const tokens = new TokenCache(store, platforms, scheduler, config.tokens);
  const breakers = new CircuitBreaker(scheduler, config.breaker);
  const probes = new ProbeService({ store, platforms, tokens, breaker: breakers, scheduler });
  const hub = new Hub({ store, probes, scheduler, config });
  const runner = new CampaignRunner({ store, platforms, tokens, breakers, scheduler, config, random });

  const server = createServer(createRequestHandler({ store, hub, root: APP_ROOT }));
  server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/ws") {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const connection = acceptWebSocket(req, socket, head);
    if (connection) hub.attach(connection);
  });

  let closing: Promise<void> | undefined;

  return {
    store,
    config,
    tokens,
    breakers,
    probes,
    runner,
    hub,

    listen(port) {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.off("error", reject);
          const address = server.address();
          const actual = typeof address === "object" && address ? address.port : port;
          resolve({ port: actual, url: `http://127.0.0.1:${actual}` });
        });
      });
    },

    close() {
      closing ??= (async () => {
        runner.stop();
        hub.close();
        timers.clearAll();
        if (!server.listening) return;
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
      })();
      return closing;
    },
  };
}

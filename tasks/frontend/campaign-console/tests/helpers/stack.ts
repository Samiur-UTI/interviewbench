// The whole console in-process, for full-stack tests: createApp with fake platforms and ONE fake
// scheduler, listening on a free port, plus dashboards that are the app's own
// createDashboardClient wired to a real WebSocket and driven by the same scheduler.
//
//   const stack = await createStack({ seed: buildSeed() });
//   after(() => stack.close());
//   const dash = await stack.dashboard();                  // waits for the snapshot
//   dash.ws.send({ type: "probe", connectionId: "conn_twilio" });
//   await dash.nextProbe("conn_twilio");                    // the pushed result, within 2 s
//   assert.equal(dash.status("conn_twilio"), "checking");
//   await stack.scheduler.advance(2_000);                   // then await the next message again
import { loadApp, loadClient } from "./app.ts";
import { FakeScheduler } from "./fake-scheduler.ts";
import { createFakePlatforms } from "./fake-platforms.ts";
import { DERIVED_SECRETS, NOW, buildSeed, ALL_SECRETS } from "./seed.ts";
import { DEFAULT_DEADLINE_MS, WsClient } from "./ws-client.ts";
import type { Module } from "./app.ts";
import type { FakeOptions, FakePlatforms } from "./fake-platforms.ts";

export interface Dashboard {
  ws: WsClient;
  /** The app's DashboardClient (handle, state, statusOf, stop, ...). */
  client: any;
  /** The first snapshot message (undefined when created with awaitSnapshot: false). */
  snapshot: any;
  /** Every distinct status each connection went through, in order, sampled after each message. */
  history: Map<string, string[]>;
  status(connectionId: string): string;
  statuses(connectionId: string): string[];
  /** `probe` requests this dashboard sent for the connection. */
  probesSent(connectionId: string): number;
  /** The next pushed probe result for the connection (the `probe` message). */
  nextProbe(connectionId: string, deadlineMs?: number): Promise<any>;
  /**
   * Waits (real time, deadline 2 s) until every `snapshot` this dashboard asked for has arrived,
   * plus a few event-loop turns: the client's state then reflects everything the server sent.
   */
  settle(deadlineMs?: number): Promise<void>;
  close(): Promise<void>;
}

export interface Stack {
  app: Module;
  client: Module;
  scheduler: FakeScheduler;
  fakes: FakePlatforms;
  store: any;
  /** The App returned by createApp. */
  server: any;
  url: string;
  dashboard(options?: { awaitSnapshot?: boolean }): Promise<Dashboard>;
  /** Every secret the browser must never see: the seed's, derived forms, and tokens the fakes issued. */
  secrets(): string[];
  close(): Promise<void>;
}

export interface StackOptions {
  seed?: any;
  now?: number;
  /** Retry jitter (default () => 0: retries don't wait). */
  random?: () => number;
  fakes?: FakeOptions;
  /** Passed to createApp (default: the app's own config). */
  config?: any;
  /**
   * Called with the fakes before the server starts listening: for behaviour the very first
   * platform calls must already see (a server may check every connection as soon as it listens).
   */
  setup?: (fakes: FakePlatforms) => void;
}

export async function createStack(options: StackOptions = {}): Promise<Stack> {
  const app = await loadApp();
  const client = await loadClient();
  const scheduler = new FakeScheduler(options.now ?? NOW);
  const fakes = createFakePlatforms(app, { clock: scheduler, ...options.fakes });
  const store = app.createStore(options.seed ?? buildSeed());
  options.setup?.(fakes);
  const config = options.config ?? app.config;
  const server = app.createApp({ store, platforms: fakes.registry, scheduler, config, random: options.random ?? (() => 0) });
  const { url } = await server.listen(0);
  // Whatever the server starts on listen (checks with fake platforms settle without the clock)
  // is over before the test goes on, so counts taken from here on are the test's own.
  await scheduler.settle(10);
  const dashboards: Dashboard[] = [];

  async function dashboard({ awaitSnapshot = true } = {}): Promise<Dashboard> {
    let ws: WsClient | undefined;
    const history = new Map<string, string[]>();
    // baseUrl: the client's HTTP calls (check, reconnect) go to this server with the real fetch.
    const dc = client.createDashboardClient({ config, scheduler, send: (m: unknown) => ws?.send(m), baseUrl: url });
    const record = () => {
      for (const id of Object.keys(dc.state().connections ?? {})) {
        let status: string;
        try {
          status = dc.statusOf(id);
        } catch {
          continue;
        }
        const list = history.get(id) ?? [];
        if (list[list.length - 1] !== status) list.push(status);
        history.set(id, list);
      }
    };
    ws = await WsClient.open(`${url}/ws`, {
      onMessage: (m) => {
        dc.handle(m);
        record();
      },
    });
    const socket = ws;
    const snapshot = awaitSnapshot ? await socket.next("snapshot") : undefined;
    const d: Dashboard = {
      ws: socket,
      client: dc,
      snapshot,
      history,
      status: (id) => dc.statusOf(id),
      statuses: (id) => history.get(id) ?? [],
      probesSent: (id) => socket.sent.filter((m: any) => m?.type === "probe" && m.connectionId === id).length,
      nextProbe: (id, deadlineMs = DEFAULT_DEADLINE_MS) => socket.next((m) => m?.type === "probe" && m.result?.connectionId === id, deadlineMs),
      async settle(deadlineMs = DEFAULT_DEADLINE_MS) {
        const deadline = Date.now() + deadlineMs;
        const count = (list: unknown[]) => list.filter((m: any) => m?.type === "snapshot").length;
        for (let quiet = 0; quiet < 5; ) {
          await new Promise((resolve) => setImmediate(resolve));
          const answered = count(socket.messages) >= count(socket.sent) + (awaitSnapshot ? 1 : 0);
          quiet = answered ? quiet + 1 : 0;
          if (!answered && Date.now() > deadline) {
            throw new Error(`${count(socket.sent)} snapshot requests, ${count(socket.messages)} snapshots received within ${deadlineMs} ms`);
          }
        }
      },
      async close() {
        dc.stop();
        await socket.close();
      },
    };
    dashboards.push(d);
    return d;
  }

  let closing: Promise<void> | undefined;
  return {
    app,
    client,
    scheduler,
    fakes,
    store,
    server,
    url,
    dashboard,
    secrets: () => [...ALL_SECRETS, ...DERIVED_SECRETS, ...fakes.all.flatMap((f) => f.issued)],
    close() {
      closing ??= (async () => {
        for (const d of dashboards) await d.close();
        await server.close();
        await handlesSettled();
      })();
      return closing;
    },
  };
}

/**
 * Waits (a bounded number of event-loop turns) until TCP handles stop closing: the server and its
 * sockets finish closing one turn after close() resolves, and on Windows a process that exits
 * while a handle is closing aborts (libuv: "!(handle->flags & UV_HANDLE_CLOSING)"), which the
 * test runner's --test-force-exit would turn into a failed file.
 */
export async function handlesSettled(maxTurns = 200): Promise<void> {
  let last = -1;
  let stable = 0;
  for (let i = 0; i < maxTurns; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    const open = process.getActiveResourcesInfo().filter((r) => r.startsWith("TCP")).length;
    if (open === 0) return;
    stable = open === last ? stable + 1 : 0;
    last = open;
    if (stable >= 5) return; // idle keep-alive sockets: open, not closing
  }
}

/**
 * Advances the fake clock in steps until `promise` settles (a run waiting on retry sleeps, for
 * example), and returns its outcome. Throws if it hasn't settled after maxSteps.
 */
export async function runUntilSettled<T>(
  promise: Promise<T>,
  scheduler: FakeScheduler,
  { stepMs = 1_000, maxSteps = 600 } = {},
): Promise<{ value?: T; error?: unknown }> {
  let outcome: { value?: T; error?: unknown } | undefined;
  promise.then(
    (value) => (outcome = { value }),
    (error: unknown) => (outcome = { error }),
  );
  for (let i = 0; i < maxSteps && !outcome; i++) await scheduler.advance(stepMs);
  if (!outcome) throw new Error(`still pending after ${(stepMs * maxSteps) / 1000} s of fake time`);
  return outcome;
}

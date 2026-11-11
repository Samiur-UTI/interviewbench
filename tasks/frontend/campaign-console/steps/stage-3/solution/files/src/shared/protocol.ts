// Messages on the dashboard WebSocket (/ws). See docs/protocol.md.
import type { DashboardState, ProbeResult, PublicConnection, PublicEvent, PublicRun } from "./types.ts";

/** What the server broadcasts to every dashboard. Each one is numbered (`seq`) when it is sent. */
export type Broadcast =
  | { type: "probe"; result: ProbeResult }
  | { type: "run"; run: PublicRun }
  | { type: "event"; runId: string; event: PublicEvent }
  /** A connection's credential was replaced (a reconnect): its public identifiers and last check. */
  | { type: "connection"; connection: PublicConnection };

/**
 * `seq` numbers the server's broadcasts: hub-wide, 1, 2, 3, ... with no gaps. A `snapshot`
 * carries the `seq` of the last broadcast its state reflects; every broadcast a dashboard gets
 * after it has a higher one. `error` is an answer to one dashboard and has none. The fields are
 * optional so that state from elsewhere (the page, an HTTP answer) can be fed in the same way.
 */
export type ServerMessage =
  | { type: "snapshot"; state: DashboardState; seq?: number }
  | (Broadcast & { seq?: number })
  | { type: "error"; code: "bad_message" | "not_found"; message: string };

export type ClientMessage = { type: "probe"; connectionId: string } | { type: "snapshot" };

// Messages on the dashboard WebSocket (/ws). See docs/protocol.md.
import type { DashboardState, ProbeResult, PublicEvent, PublicRun } from "./types.ts";

export type ServerMessage =
  | { type: "snapshot"; state: DashboardState }
  | { type: "probe"; result: ProbeResult }
  | { type: "run"; run: PublicRun }
  | { type: "event"; runId: string; event: PublicEvent }
  | { type: "error"; code: "bad_message" | "not_found"; message: string };

export type ClientMessage = { type: "probe"; connectionId: string } | { type: "snapshot" };

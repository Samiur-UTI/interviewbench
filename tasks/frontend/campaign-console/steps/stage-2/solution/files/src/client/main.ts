// Browser entry: hydrates the server-rendered dashboard, then keeps it live over the WebSocket.
import { hydrate, render } from "../../vendor/preact/preact.mjs";
import { Dashboard } from "./components/Dashboard.ts";
import { html } from "./components/html.ts";
import { createDashboardClient } from "./dashboard-client.ts";
import { config } from "../shared/config.ts";
import { realScheduler } from "../shared/scheduler.ts";
import type { ClientMessage, ServerMessage } from "../shared/protocol.ts";
import type { DashboardState } from "../shared/types.ts";

const root = document.getElementById("app")!;
const embedded = JSON.parse(document.getElementById("__STATE__")?.textContent ?? "null") as DashboardState;

let socket: WebSocket | undefined;
let hydrated = false;

function send(message: ClientMessage): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

const client = createDashboardClient({ config, scheduler: realScheduler, send, onState: () => paint() });

function view() {
  return html`<${Dashboard}
    state=${client.state()}
    statusOf=${client.statusOf}
    onCheck=${(id: string) => void client.check(id)}
    onReconnect=${client.reconnect}
  />`;
}

function paint(): void {
  if (hydrated) render(view(), root);
}

function connect(attempt: number): void {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`);
  socket = ws;
  ws.addEventListener("open", () => {
    attempt = 0;
  });
  ws.addEventListener("message", (event) => {
    client.handle(JSON.parse(String(event.data)) as ServerMessage);
  });
  ws.addEventListener("close", () => {
    if (socket === ws) socket = undefined;
    setTimeout(() => connect(attempt + 1), Math.min(30_000, 1_000 * 2 ** attempt));
  });
}

client.handle({ type: "snapshot", state: embedded });
hydrate(view(), root);
hydrated = true;
connect(0);

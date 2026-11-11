// The dashboard's live channel: a small RFC 6455 WebSocket server (text messages only, no
// extensions, no fragmentation) and the Hub that speaks our protocol over it (docs/protocol.md).
// https://www.rfc-editor.org/rfc/rfc6455
import { createHash } from "node:crypto";
import { toDashboardState, toPublicEvent, toPublicRun } from "./views.ts";
import type { ProbeService } from "./connectivity.ts";
import type { Store, StoreChange } from "./store.ts";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import type { Config } from "../shared/config.ts";
import type { ClientMessage, ServerMessage } from "../shared/protocol.ts";
import type { Scheduler } from "../shared/scheduler.ts";
import type { ProbeResult } from "../shared/types.ts";

// --- Frames -------------------------------------------------------------------------------------

export const OPCODES = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa } as const;

export const CLOSE_CODES = {
  normal: 1000,
  goingAway: 1001,
  protocolError: 1002,
  unsupportedData: 1003,
  messageTooBig: 1009,
} as const;

/** Largest message we accept from a browser. Client messages are a few dozen bytes. */
export const MAX_PAYLOAD_BYTES = 1024 * 1024;

const KNOWN_OPCODES = new Set<number>(Object.values(OPCODES));
const HANDSHAKE_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** A frame the peer must not send. `closeCode` is the close code to answer it with. */
export class FrameError extends Error {
  readonly closeCode: number;

  constructor(closeCode: number, message: string) {
    super(message);
    this.name = "FrameError";
    this.closeCode = closeCode;
  }
}

export interface Frame {
  fin: boolean;
  opcode: number;
  masked: boolean;
  payload: Buffer;
}

export interface DecodeOptions {
  /** Clients must mask every frame (RFC 6455 5.1); servers must not. Default true. */
  requireMask?: boolean;
  maxPayloadBytes?: number;
}

/**
 * Decodes the frame at the start of `buffer`. Returns null until the whole frame has arrived, and
 * the number of bytes it used otherwise. Throws FrameError (1002) for frames that break the RFC:
 * reserved bits set, unknown opcodes, fragmented or oversized control frames, unmasked client
 * frames; and FrameError (1009) as soon as the header announces more than `maxPayloadBytes`.
 */
export function decodeFrame(buffer: Buffer, options: DecodeOptions = {}): { frame: Frame; bytes: number } | null {
  const requireMask = options.requireMask ?? true;
  const maxPayloadBytes = options.maxPayloadBytes ?? MAX_PAYLOAD_BYTES;
  if (buffer.length < 2) return null;

  const fin = (buffer[0] & 0x80) !== 0;
  if ((buffer[0] & 0x70) !== 0) throw new FrameError(CLOSE_CODES.protocolError, "reserved bits set");
  const opcode = buffer[0] & 0x0f;
  if (!KNOWN_OPCODES.has(opcode)) throw new FrameError(CLOSE_CODES.protocolError, `unknown opcode ${opcode}`);
  const masked = (buffer[1] & 0x80) !== 0;
  if (requireMask && !masked) throw new FrameError(CLOSE_CODES.protocolError, "client frames must be masked");
  const shortLength = buffer[1] & 0x7f;
  if (opcode >= OPCODES.close && (!fin || shortLength > 125)) {
    throw new FrameError(CLOSE_CODES.protocolError, "control frames must be final and at most 125 bytes");
  }

  let offset = 2;
  let length = shortLength;
  if (shortLength === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (shortLength === 127) {
    if (buffer.length < 10) return null;
    const long = buffer.readBigUInt64BE(2);
    length = long > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(long);
    offset = 10;
  }
  if (length > maxPayloadBytes) {
    throw new FrameError(CLOSE_CODES.messageTooBig, `frame of ${length} bytes exceeds ${maxPayloadBytes}`);
  }

  const maskOffset = offset;
  if (masked) offset += 4;
  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (masked) {
    for (let i = 0; i < payload.length; i++) payload[i] ^= buffer[maskOffset + (i & 3)];
  }
  return { frame: { fin, opcode, masked, payload }, bytes: offset + length };
}

/** Encodes one frame. Servers send unmasked frames; pass `mask` (4 bytes) to encode as a client. */
export function encodeFrame(
  opcode: number,
  payload: Buffer | string = Buffer.alloc(0),
  options: { mask?: Buffer; fin?: boolean } = {},
): Buffer {
  const data = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const fin = options.fin ?? true;
  let header: Buffer;
  if (data.length < 126) {
    header = Buffer.alloc(2);
    header[1] = data.length;
  } else if (data.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  header[0] = (fin ? 0x80 : 0) | opcode;
  if (!options.mask) return Buffer.concat([header, data]);
  header[1] |= 0x80;
  const masked = Buffer.from(data);
  for (let i = 0; i < masked.length; i++) masked[i] ^= options.mask[i & 3];
  return Buffer.concat([header, options.mask, masked]);
}

function closePayload(code: number, reason: string): Buffer {
  const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
  payload.writeUInt16BE(code, 0);
  payload.write(reason, 2);
  return payload;
}

// --- Connections --------------------------------------------------------------------------------

export class WebSocketConnection {
  onMessage: (text: string) => void = () => {};
  onClose: () => void = () => {};
  private readonly socket: Duplex;
  private buffer = Buffer.alloc(0);
  private closing = false;
  private closed = false;

  constructor(socket: Duplex, head?: Buffer) {
    this.socket = socket;
    (socket as Socket).setNoDelay?.(true);
    socket.on("data", (chunk: Buffer) => this.receive(chunk));
    socket.on("error", () => socket.destroy());
    socket.on("end", () => socket.end());
    socket.on("close", () => {
      this.closed = true;
      this.onClose();
    });
    // Bytes that arrived with the upgrade request: handle them once the owner has subscribed.
    if (head && head.length > 0) queueMicrotask(() => this.receive(head));
  }

  get isOpen(): boolean {
    return !this.closed && !this.closing;
  }

  send(text: string): void {
    if (this.isOpen) this.socket.write(encodeFrame(OPCODES.text, text));
  }

  /** Starts the closing handshake; the socket is destroyed if the peer doesn't finish it. */
  close(code: number = CLOSE_CODES.normal, reason = ""): void {
    if (this.closed || this.closing) return;
    this.closing = true;
    this.socket.end(encodeFrame(OPCODES.close, closePayload(code, reason)));
    setTimeout(() => this.socket.destroy(), 1_000).unref();
  }

  /** Drops the connection without the closing handshake (shutdown). */
  terminate(): void {
    this.closing = true;
    this.socket.destroy();
  }

  private receive(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    while (!this.closed) {
      const decoded = decodeFrame(this.buffer);
      if (!decoded) return;
      this.buffer = this.buffer.subarray(decoded.bytes);
      this.handleFrame(decoded.frame);
    }
  }

  private handleFrame(frame: Frame): void {
    if (!frame.fin || frame.opcode === OPCODES.continuation) {
      throw new FrameError(CLOSE_CODES.protocolError, "fragmented messages are not supported");
    }
    switch (frame.opcode) {
      case OPCODES.text:
        if (!this.closing) this.onMessage(frame.payload.toString("utf8"));
        return;
      case OPCODES.binary:
        this.close(CLOSE_CODES.unsupportedData, "text messages only");
        return;
      case OPCODES.ping:
        if (!this.closing) this.socket.write(encodeFrame(OPCODES.pong, frame.payload));
        return;
      case OPCODES.pong:
        return;
      case OPCODES.close: {
        const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : CLOSE_CODES.normal;
        if (!this.closing) {
          this.closing = true;
          this.socket.end(encodeFrame(OPCODES.close, closePayload(code, "")));
        } else {
          this.socket.end();
        }
        return;
      }
    }
  }
}

/**
 * Completes the upgrade handshake for a request on the WebSocket path. Answers 400 and returns
 * null when the request isn't a valid version 13 upgrade.
 */
export function acceptWebSocket(req: IncomingMessage, socket: Duplex, head: Buffer): WebSocketConnection | null {
  const key = req.headers["sec-websocket-key"];
  const upgrade = String(req.headers.upgrade ?? "").toLowerCase();
  if (req.method !== "GET" || typeof key !== "string" || upgrade !== "websocket" || req.headers["sec-websocket-version"] !== "13") {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    return null;
  }
  const accept = createHash("sha1").update(key + HANDSHAKE_GUID).digest("base64");
  socket.write(
    ["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${accept}`, "", ""].join("\r\n"),
  );
  return new WebSocketConnection(socket, head);
}

// --- Hub ----------------------------------------------------------------------------------------

export interface HubOptions {
  store: Store;
  probes: ProbeService;
  scheduler: Scheduler;
  config: Config;
}

interface Client {
  socket: WebSocketConnection;
  closed: boolean;
  probeTimer?: unknown;
}

/**
 * Every open dashboard. A dashboard gets a snapshot when it connects, then probe results and every
 * run change as it happens.
 */
export class Hub {
  /** Dashboards that receive broadcasts. */
  private readonly clients = new Set<Client>();
  /** Every socket we hold, including dashboards still being set up. */
  private readonly sockets = new Set<Client>();
  private readonly options: HubOptions;
  private readonly unsubscribe: () => void;

  constructor(options: HubOptions) {
    this.options = options;
    this.unsubscribe = options.store.on((change) => this.onStoreChange(change));
  }

  get size(): number {
    return this.clients.size;
  }

  attach(socket: WebSocketConnection): void {
    const client: Client = { socket, closed: false };
    this.sockets.add(client);
    socket.onMessage = (text) => this.receive(client, text);
    socket.onClose = () => this.detach(client);
    void this.welcome(client);
  }

  broadcast(message: ServerMessage): void {
    const text = JSON.stringify(message);
    for (const client of this.clients) client.socket.send(text);
  }

  /** Checks a connection now (one platform call) and pushes the result to every dashboard. */
  async requestProbe(connectionId: string): Promise<ProbeResult> {
    const result = await this.options.probes.probe(connectionId);
    this.broadcast({ type: "probe", result });
    return result;
  }

  close(): void {
    this.unsubscribe();
    for (const client of [...this.sockets]) {
      this.detach(client);
      client.socket.terminate();
    }
  }

  /**
   * A new dashboard: the state as of the moment it connected, with every card freshly checked
   * (a page that sat in a background tab can carry results from hours ago), then live updates.
   */
  private async welcome(client: Client): Promise<void> {
    const state = toDashboardState(this.options.store);
    for (const id of Object.keys(state.connections)) {
      if (client.closed) return;
      const lastProbe = await this.options.probes.probe(id);
      state.connections[id] = { ...state.connections[id], lastProbe };
    }
    if (client.closed) return;
    this.send(client, { type: "snapshot", state });
    this.clients.add(client);
    this.scheduleProbeRound(client);
  }

  private scheduleProbeRound(client: Client): void {
    const { scheduler, config } = this.options;
    client.probeTimer = scheduler.setTimeout(() => void this.probeRound(client), config.connectivity.probeIntervalMs);
  }

  /** The dashboard's periodic check of every connection. */
  private async probeRound(client: Client): Promise<void> {
    for (const connection of this.options.store.listConnections()) {
      if (client.closed) return;
      const result = await this.options.probes.probe(connection.id);
      this.send(client, { type: "probe", result });
    }
    if (!client.closed) this.scheduleProbeRound(client);
  }

  private receive(client: Client, text: string): void {
    const message = JSON.parse(text) as ClientMessage;
    switch (message.type) {
      case "probe":
        void this.requestProbe(message.connectionId);
        return;
      case "snapshot":
        this.sendSnapshot(client);
        return;
    }
  }

  private onStoreChange(change: StoreChange): void {
    if (change.kind === "run") this.broadcast({ type: "run", run: toPublicRun(change.run) });
    else if (change.kind === "event") this.broadcast({ type: "event", runId: change.runId, event: toPublicEvent(change.event) });
  }

  private sendSnapshot(client: Client): void {
    this.send(client, { type: "snapshot", state: toDashboardState(this.options.store) });
  }

  private send(client: Client, message: ServerMessage): void {
    client.socket.send(JSON.stringify(message));
  }

  private detach(client: Client): void {
    client.closed = true;
    if (client.probeTimer !== undefined) this.options.scheduler.clearTimeout(client.probeTimer);
    client.probeTimer = undefined;
    this.clients.delete(client);
    this.sockets.delete(client);
  }
}

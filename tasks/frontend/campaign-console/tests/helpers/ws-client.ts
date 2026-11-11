// WebSocket clients for the hidden tests.
//
// WsClient: a browser-like client over Node's global WebSocket. Messages are queued as they arrive;
// `next(type, deadlineMs)` takes the oldest unconsumed message of that type, waiting for one up to
// the deadline (real time), and rejects with what did arrive.
//
//   const ws = await WsClient.open(`${url.replace("http", "ws")}/ws`);
//   const snapshot = await ws.next("snapshot");          // within 2 s, or the test fails
//
// RawWsClient: does the handshake itself over node:net, so a test can send frames a browser never
// would (unmasked, fragmented, oversized, garbage). Socket errors (ECONNRESET, EPIPE) are recorded,
// never thrown: a server that drops the connection is a result, not a crash of the test.
//
//   const raw = await RawWsClient.connect(`${url}/ws`);
//   raw.sendText("hi", { mask: false });                 // an unmasked client frame
//   const closed = await raw.waitClosed();               // { closeCode?, error? }
import { randomBytes } from "node:crypto";
import { connect as netConnect } from "node:net";
import type { Socket } from "node:net";

export const DEFAULT_DEADLINE_MS = 2_000;

type Matcher = string | ((message: any) => boolean);

function matches(matcher: Matcher | undefined, message: any): boolean {
  if (matcher === undefined) return true;
  return typeof matcher === "string" ? message?.type === matcher : matcher(message);
}

function describe(matcher: Matcher | undefined): string {
  return matcher === undefined ? "message" : typeof matcher === "string" ? `"${matcher}" message` : "matching message";
}

/** A queue of parsed JSON messages with deadline-bound waits. Shared by both clients. */
class Inbox {
  /** Every message received, in order (consumed or not). */
  readonly all: any[] = [];
  private readonly unconsumed: any[] = [];
  private waiters: { matcher?: Matcher; resolve: (m: any) => void }[] = [];
  private readonly listeners = new Set<(m: any) => void>();
  private ended: Error | undefined;

  push(message: any): void {
    this.all.push(message);
    for (const listener of [...this.listeners]) listener(message);
    const waiter = this.waiters.find((w) => matches(w.matcher, message));
    if (waiter) {
      this.waiters = this.waiters.filter((w) => w !== waiter);
      waiter.resolve(message);
      return;
    }
    this.unconsumed.push(message);
  }

  end(reason: Error): void {
    this.ended = reason;
  }

  subscribe(listener: (m: any) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  next(matcher: Matcher | undefined, deadlineMs: number): Promise<any> {
    const index = this.unconsumed.findIndex((m) => matches(matcher, m));
    if (index >= 0) return Promise.resolve(this.unconsumed.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = {
        matcher,
        resolve: (m: any) => {
          clearTimeout(timer);
          resolve(m);
        },
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        const seen = this.all.map((m) => m?.type ?? typeof m).join(", ") || "nothing";
        const why = this.ended ? ` (connection ended: ${this.ended.message})` : "";
        reject(new Error(`no ${describe(matcher)} within ${deadlineMs} ms${why}; received so far: ${seen}`));
      }, deadlineMs);
      this.waiters.push(waiter);
    });
  }

  /** Unconsumed messages (optionally of one type), removing them from the queue. */
  drain(matcher?: Matcher): any[] {
    const taken = this.unconsumed.filter((m) => matches(matcher, m));
    for (const m of taken) this.unconsumed.splice(this.unconsumed.indexOf(m), 1);
    return taken;
  }
}

function parse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return { type: "<non-json>", text };
  }
}

// --- WsClient ------------------------------------------------------------------------------------

export class WsClient {
  readonly socket: WebSocket;
  /** Messages this client sent, as objects (or the raw text). */
  readonly sent: unknown[] = [];
  /** Resolves when the socket closes. */
  readonly closed: Promise<{ code: number; reason: string }>;
  private readonly inbox = new Inbox();

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => this.inbox.push(parse(String(event.data))));
    this.closed = new Promise((resolve) => {
      socket.addEventListener("close", (event) => {
        this.inbox.end(new Error(`closed ${event.code}`));
        resolve({ code: event.code, reason: event.reason });
      });
    });
    socket.addEventListener("error", () => {}); // a failed or dropped socket ends in "close"
  }

  /** Opens `url` (ws://...) and resolves once the handshake is done. */
  static open(url: string, options: { deadlineMs?: number; onMessage?: (m: any) => void } = {}): Promise<WsClient> {
    const wsUrl = url.replace(/^http/, "ws");
    const socket = new WebSocket(wsUrl);
    const client = new WsClient(socket);
    if (options.onMessage) client.subscribe(options.onMessage);
    const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error(`WebSocket ${wsUrl} not open within ${deadlineMs} ms`));
      }, deadlineMs);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(client);
      });
      socket.addEventListener("close", () => {
        clearTimeout(timer);
        reject(new Error(`WebSocket ${wsUrl} closed before it opened`));
      });
    });
  }

  get isOpen(): boolean {
    return this.socket.readyState === WebSocket.OPEN;
  }

  /** Every message received so far, in order. */
  get messages(): any[] {
    return this.inbox.all;
  }

  /** Sends `message` as JSON (a string is sent as is). Ignored once the socket is closed. */
  send(message: unknown): void {
    this.sent.push(message);
    if (this.isOpen) this.socket.send(typeof message === "string" ? message : JSON.stringify(message));
  }

  /** The oldest unconsumed message of `type` (or matching the predicate), waiting up to deadlineMs. */
  next(type?: Matcher, deadlineMs = DEFAULT_DEADLINE_MS): Promise<any> {
    return this.inbox.next(type, deadlineMs);
  }

  /** Takes every unconsumed message (of `type`) without waiting. */
  drain(type?: Matcher): any[] {
    return this.inbox.drain(type);
  }

  /** Calls `listener` with every message from now on (e.g. a DashboardClient's handle). */
  subscribe(listener: (m: any) => void): () => void {
    return this.inbox.subscribe(listener);
  }

  /** Closes and waits (up to deadlineMs) for the close to complete. */
  async close(deadlineMs = DEFAULT_DEADLINE_MS): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    this.socket.close();
    await Promise.race([this.closed, new Promise((resolve) => setTimeout(resolve, deadlineMs).unref())]);
  }
}

// --- RawWsClient ---------------------------------------------------------------------------------

export interface RawFrameOptions {
  /** A 4-byte mask, or false to send the frame unmasked (default: a random mask). */
  mask?: Buffer | false;
  fin?: boolean;
  /** The RSV1-3 bits as a number 0..7 (default 0). */
  rsv?: number;
  /** Announce this payload length in the header instead of the real one. */
  announcedLength?: number;
}

export const OP = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa } as const;

/** Builds one client frame, valid or not. */
export function buildFrame(opcode: number, payload: Buffer | string = Buffer.alloc(0), options: RawFrameOptions = {}): Buffer {
  const data = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const length = options.announcedLength ?? data.length;
  const mask = options.mask === false ? undefined : (options.mask ?? randomBytes(4));
  let header: Buffer;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = ((options.fin ?? true) ? 0x80 : 0) | (((options.rsv ?? 0) & 7) << 4) | (opcode & 0x0f);
  if (!mask) return Buffer.concat([header, data]);
  header[1] |= 0x80;
  const masked = Buffer.from(data);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

export interface ServerFrame {
  opcode: number;
  payload: Buffer;
}

export interface RawClosed {
  /** The code of the server's close frame, if it sent one. */
  closeCode?: number;
  /** A socket error (ECONNRESET, EPIPE, ...) if the connection ended with one. */
  error?: NodeJS.ErrnoException;
}

export class RawWsClient {
  readonly socket: Socket;
  /** Every frame the server sent after the handshake. */
  readonly frames: ServerFrame[] = [];
  /** Socket errors seen (recorded, never thrown). */
  readonly errors: NodeJS.ErrnoException[] = [];
  /** Resolves when the TCP connection is closed, by either side. */
  readonly closed: Promise<RawClosed>;
  private readonly inbox = new Inbox();
  private buffer = Buffer.alloc(0);
  private closeCode: number | undefined;
  private ended = false;

  private constructor(socket: Socket, leftover: Buffer) {
    this.socket = socket;
    this.closed = new Promise((resolve) => {
      socket.on("close", () => {
        this.ended = true;
        this.inbox.end(new Error("socket closed"));
        resolve({ closeCode: this.closeCode, error: this.errors[0] });
      });
    });
    socket.on("data", (chunk: Buffer) => this.receive(chunk));
    if (leftover.length > 0) this.receive(leftover);
  }

  /** Connects to `url` (http:// or ws://, path /ws) and completes the upgrade handshake. */
  static connect(url: string, options: { deadlineMs?: number } = {}): Promise<RawWsClient> {
    const target = new URL(url.replace(/^ws/, "http"));
    const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
    return new Promise((resolve, reject) => {
      const socket = netConnect({ host: target.hostname, port: Number(target.port) });
      const errors: NodeJS.ErrnoException[] = [];
      let head = Buffer.alloc(0);
      let done = false;
      const fail = (error: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      };
      const timer = setTimeout(() => fail(new Error(`no upgrade from ${url} within ${deadlineMs} ms`)), deadlineMs);
      socket.on("error", (error: NodeJS.ErrnoException) => {
        errors.push(error);
        fail(error);
      });
      socket.on("close", () => fail(new Error(`connection to ${url} closed during the handshake`)));
      const onData = (chunk: Buffer) => {
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf("\r\n\r\n");
        if (end < 0) return;
        const statusLine = head.subarray(0, head.indexOf("\r\n")).toString("latin1");
        if (!/^HTTP\/1\.1 101\b/.test(statusLine)) return fail(new Error(`upgrade refused: ${statusLine}`));
        done = true;
        clearTimeout(timer);
        socket.off("data", onData);
        socket.removeAllListeners("close");
        socket.removeAllListeners("error");
        const client = new RawWsClient(socket, head.subarray(end + 4));
        socket.on("error", (error: NodeJS.ErrnoException) => client.errors.push(error));
        resolve(client);
      };
      socket.on("data", onData);
      socket.on("connect", () => {
        const key = randomBytes(16).toString("base64");
        socket.write(
          [
            `GET ${target.pathname}${target.search} HTTP/1.1`,
            `Host: ${target.host}`,
            "Upgrade: websocket",
            "Connection: Upgrade",
            `Sec-WebSocket-Key: ${key}`,
            "Sec-WebSocket-Version: 13",
            "",
            "",
          ].join("\r\n"),
        );
      });
    });
  }

  /** True until the TCP connection is closed. */
  get isOpen(): boolean {
    return !this.ended && !this.socket.destroyed;
  }

  /** Every JSON text message received so far. */
  get messages(): any[] {
    return this.inbox.all;
  }

  /** Writes raw bytes. Errors (the server already hung up) are recorded, not thrown. */
  write(bytes: Buffer): void {
    if (!this.isOpen) return;
    this.socket.write(bytes, (error) => {
      if (error) this.errors.push(error as NodeJS.ErrnoException);
    });
  }

  sendFrame(opcode: number, payload?: Buffer | string, options?: RawFrameOptions): void {
    this.write(buildFrame(opcode, payload, options));
  }

  /** A text frame; `{ mask: false }` makes it unmasked. */
  sendText(text: string, options?: RawFrameOptions): void {
    this.sendFrame(OP.text, text, options);
  }

  /** A JSON message in a well-formed (masked) text frame. */
  send(message: unknown): void {
    this.sendText(typeof message === "string" ? message : JSON.stringify(message));
  }

  next(type?: Matcher, deadlineMs = DEFAULT_DEADLINE_MS): Promise<any> {
    return this.inbox.next(type, deadlineMs);
  }

  drain(type?: Matcher): any[] {
    return this.inbox.drain(type);
  }

  /** Waits until the connection is closed; rejects if it is still open after deadlineMs. */
  waitClosed(deadlineMs = DEFAULT_DEADLINE_MS): Promise<RawClosed> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`connection still open after ${deadlineMs} ms`)), deadlineMs);
      void this.closed.then((closed) => {
        clearTimeout(timer);
        resolve(closed);
      });
    });
  }

  destroy(): void {
    this.socket.destroy();
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const frame = this.decode();
      if (!frame) return;
      this.frames.push(frame);
      if (frame.opcode === OP.text) this.inbox.push(parse(frame.payload.toString("utf8")));
      else if (frame.opcode === OP.close && frame.payload.length >= 2) this.closeCode = frame.payload.readUInt16BE(0);
      else if (frame.opcode === OP.ping) this.sendFrame(OP.pong, frame.payload);
    }
  }

  /** Decodes one server frame (unmasked by the RFC; a masked one is unmasked anyway). */
  private decode(): ServerFrame | null {
    const b = this.buffer;
    if (b.length < 2) return null;
    const masked = (b[1] & 0x80) !== 0;
    let length = b[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (b.length < 4) return null;
      length = b.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (b.length < 10) return null;
      length = Number(b.readBigUInt64BE(2));
      offset = 10;
    }
    const maskAt = offset;
    if (masked) offset += 4;
    if (b.length < offset + length) return null;
    const payload = Buffer.from(b.subarray(offset, offset + length));
    if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= b[maskAt + (i & 3)];
    this.buffer = b.subarray(offset + length);
    return { opcode: b[0] & 0x0f, payload };
  }
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { CLOSE_CODES, FrameError, OPCODES, decodeFrame, encodeFrame } from "../src/index.ts";

const MASK = Buffer.from([0x12, 0x34, 0x56, 0x78]);

test("decodes a masked text frame from a client", () => {
  const bytes = encodeFrame(OPCODES.text, '{"type":"snapshot"}', { mask: MASK });
  const decoded = decodeFrame(bytes);
  assert.ok(decoded);
  assert.equal(decoded.bytes, bytes.length);
  assert.equal(decoded.frame.opcode, OPCODES.text);
  assert.equal(decoded.frame.fin, true);
  assert.equal(decoded.frame.payload.toString(), '{"type":"snapshot"}');
});

test("server frames are unmasked and round-trip at every length encoding", () => {
  for (const size of [0, 125, 126, 65_535, 65_536, 300_000]) {
    const payload = Buffer.alloc(size, "x");
    const bytes = encodeFrame(OPCODES.text, payload);
    assert.equal(bytes[1] & 0x80, 0, "unmasked");
    const decoded = decodeFrame(bytes, { requireMask: false });
    assert.ok(decoded, `size ${size}`);
    assert.equal(decoded.frame.payload.length, size);
    assert.equal(decoded.bytes, bytes.length);
  }
});

test("returns null until the whole frame has arrived", () => {
  const bytes = encodeFrame(OPCODES.text, "x".repeat(200), { mask: MASK });
  for (const cut of [1, 2, 3, 7, bytes.length - 1]) assert.equal(decodeFrame(bytes.subarray(0, cut)), null, `cut ${cut}`);
  assert.ok(decodeFrame(bytes));
});

test("two frames in one buffer decode one at a time", () => {
  const first = encodeFrame(OPCODES.text, "one", { mask: MASK });
  const second = encodeFrame(OPCODES.ping, "two", { mask: MASK });
  const both = Buffer.concat([first, second]);
  const a = decodeFrame(both);
  assert.ok(a);
  const b = decodeFrame(both.subarray(a.bytes));
  assert.ok(b);
  assert.deepEqual([a.frame.payload.toString(), b.frame.opcode], ["one", OPCODES.ping]);
});

test("frames a server must refuse raise FrameError with the close code to answer with", () => {
  const cases: [string, Buffer, number][] = [
    ["unmasked client frame", encodeFrame(OPCODES.text, "hi"), CLOSE_CODES.protocolError],
    ["reserved bits", Buffer.from([0xc1, 0x80, 0, 0, 0, 0]), CLOSE_CODES.protocolError],
    ["unknown opcode", Buffer.from([0x83, 0x80, 0, 0, 0, 0]), CLOSE_CODES.protocolError],
    ["fragmented ping", encodeFrame(OPCODES.ping, "", { mask: MASK, fin: false }), CLOSE_CODES.protocolError],
  ];
  for (const [name, bytes, code] of cases) {
    assert.throws(() => decodeFrame(bytes), (e: unknown) => e instanceof FrameError && e.closeCode === code, name);
  }
});

test("an oversized frame is refused from its header alone", () => {
  const header = Buffer.from([0x81, 0xff, 0, 0, 0, 0, 0, 0x20, 0, 0]); // 2 MiB announced, nothing sent
  assert.throws(
    () => decodeFrame(header, { maxPayloadBytes: 1024 * 1024 }),
    (e: unknown) => e instanceof FrameError && e.closeCode === CLOSE_CODES.messageTooBig,
  );
});

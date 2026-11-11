// Stage 1, "the console went down for every user": the real server (src/server/main.ts) in a
// child process, so a crash ends that process and not the test runner. Each test gets its own
// server and ends by checking it still answers, then that it is gone after kill().
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { startServer } from "./helpers/child.ts";
import { buildSeed } from "./helpers/seed.ts";
import { OP, RawWsClient, WsClient } from "./helpers/ws-client.ts";
import type { ServerProcess } from "./helpers/child.ts";

const servers: ServerProcess[] = [];
after(async () => {
  for (const s of servers) await s.kill();
});
async function server(): Promise<ServerProcess> {
  const s = await startServer({ seed: buildSeed({ lastProbeOk: true }) });
  servers.push(s);
  return s;
}

/** The server still serves other users, then exits when killed. */
async function stillServing(s: ServerProcess): Promise<void> {
  const r = await fetch(`${s.url}/api/dashboard`);
  assert.equal(r.status, 200, "GET /api/dashboard after the hostile input");
  await r.arrayBuffer();
  const other = await WsClient.open(`${s.url}/ws`);
  await other.next("snapshot");
  await other.close();
  assert.equal(s.alive(), true, `the server process is still running\n${s.stderr.slice(-1500)}`);
  await s.kill();
  assert.equal(s.alive(), false, "the server exits after kill()");
}

test("messages a dashboard should never send (not JSON, not an object, unknown type, missing fields) get a bad_message error and the socket stays open", async () => {
  const s = await server();
  const ws = await WsClient.open(`${s.url}/ws`);
  await ws.next("snapshot");
  const bad = ["this is not json", "null", "42", "[]", "{}", '{"type":"probe"}', '{"type":"probe","connectionId":7}', '{"type":"launch"}', '"snapshot"'];
  for (const text of bad) {
    ws.send(text);
    const reply = await ws.next("error");
    assert.equal(reply.code, "bad_message", `reply to ${text}`);
    assert.equal(typeof reply.message, "string");
  }
  ws.send({ type: "snapshot" });
  await ws.next("snapshot");
  assert.equal(ws.isOpen, true);
  await ws.close();
  await stillServing(s);
});

test("asking to check a connection that doesn't exist gets a not_found error, the socket stays open and real checks still work", async () => {
  const s = await server();
  const ws = await WsClient.open(`${s.url}/ws`);
  await ws.next("snapshot");
  for (const id of ["conn_nope", "__proto__", "constructor", ""]) {
    ws.send({ type: "probe", connectionId: id });
    const reply = await ws.next("error");
    assert.equal(reply.code, "not_found", `reply for ${JSON.stringify(id)}`);
  }
  ws.send({ type: "probe", connectionId: "conn_meta" });
  const result = await ws.next((m) => m?.type === "probe" && m.result?.connectionId === "conn_meta");
  assert.equal(typeof result.result.ok, "boolean");
  assert.equal(ws.isOpen, true);
  await ws.close();
  await stillServing(s);
});

test("a frame no browser sends (unmasked) closes that socket only; fragmented and oversized frames don't stop the server either", async () => {
  const s = await server();
  const unmasked = await RawWsClient.connect(`${s.url}/ws`);
  unmasked.sendText('{"type":"snapshot"}', { mask: false });
  await unmasked.waitClosed();

  const fragmented = await RawWsClient.connect(`${s.url}/ws`);
  fragmented.sendFrame(OP.text, '{"type":', { fin: false });
  fragmented.sendFrame(OP.continuation, '"snapshot"}');
  const oversized = await RawWsClient.connect(`${s.url}/ws`);
  oversized.sendFrame(OP.text, "x", { announcedLength: 64 * 1024 * 1024 });

  await stillServing(s);
  fragmented.destroy();
  oversized.destroy();
});

test("HTTP requests for a connection that doesn't exist answer 404 not_found and the server keeps serving", async () => {
  const s = await server();
  const post = await fetch(`${s.url}/api/connections/conn_nope/probe`, { method: "POST" });
  assert.equal(post.status, 404);
  assert.deepEqual(await post.json(), { error: "not_found" });
  const get = await fetch(`${s.url}/api/connections/conn_nope`);
  assert.equal(get.status, 404);
  assert.deepEqual(await get.json(), { error: "not_found" });
  const ok = await fetch(`${s.url}/api/connections/conn_twilio/probe`, { method: "POST" });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).connectionId, "conn_twilio");
  await stillServing(s);
});

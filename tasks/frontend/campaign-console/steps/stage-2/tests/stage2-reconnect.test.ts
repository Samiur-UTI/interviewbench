// Stage 2, server half: POST /api/connections/:id/credentials over real HTTP, with fake platforms on
// a fake clock (helpers/stack.ts). What is checked: validation (order, units, immutable fields),
// the effects (token cache, circuit, one check, which runs resume), and what reaches the browser.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { leaks } from "./helpers/browser.ts";
import { PUBLIC, SECRETS, buildSeed, makeRun } from "./helpers/seed.ts";
import { NEW, NEW_SECRETS, acceptOnly, linkfolioBody, postCredentials, twilioBody, until } from "./helpers/reconnect.ts";
import { createStack, runUntilSettled } from "./helpers/stack.ts";
import type { Stack } from "./helpers/stack.ts";

const stacks: Stack[] = [];
after(async () => {
  for (const s of stacks) await s.close();
});
async function stack(seed: any = buildSeed()): Promise<Stack> {
  const s = await createStack({ seed });
  stacks.push(s);
  return s;
}

const post = (s: Stack, id: string, body: unknown) => postCredentials(s.url, id, body);
const stored = (s: Stack, id: string) => structuredClone(s.store.getConnection(id).credential);
const items = (runId: string, from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `${runId}_item_${from + i}`);

/** Each body must be refused with invalid_credential naming `field`, before anything is stored or called. */
async function expectRefused(s: Stack, id: string, cases: [body: unknown, field: string][]): Promise<void> {
  const before = stored(s, id);
  const calls = s.fakes.count();
  for (const [body, field] of cases) {
    const r = await post(s, id, body);
    const shown = typeof body === "string" ? body : JSON.stringify(body);
    assert.equal(r.status, 400, `${id} ${shown}: answered ${r.status} ${r.text}`);
    assert.equal(r.body?.error, "invalid_credential", `${id} ${shown}: ${r.text}`);
    assert.equal(r.body?.field, field, `${id} ${shown}: ${r.text}`);
  }
  assert.deepEqual(stored(s, id), before, `${id}: a refused reconnect stores nothing`);
  assert.equal(s.fakes.count(), calls, `${id}: a refused reconnect calls no platform`);
}

test("a reconnect of an unknown connection is a 404, and a body that isn't a JSON object is invalid_json", async () => {
  const s = await stack();
  const calls = s.fakes.count(); // a server may check every connection when it starts
  const missing = await post(s, "conn_nope", twilioBody());
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, { error: "not_found" });
  for (const body of ["{not json", "", "[]", "null", '"text"', "42"]) {
    const r = await post(s, "conn_twilio", body);
    assert.equal(r.status, 400, `${JSON.stringify(body)}: ${r.status} ${r.text}`);
    assert.equal(r.body?.error, "invalid_json", `${JSON.stringify(body)}: ${r.text}`);
  }
  assert.equal(s.fakes.count(), calls, "nothing was called");
  assert.equal((await fetch(`${s.url}/api/dashboard`)).status, 200, "the console still answers");
});

test("Google and Meta: the first missing or invalid field is named, in the order accessToken, refreshToken, expiresIn", async () => {
  const s = await stack();
  await expectRefused(s, "conn_google", [
    [{}, "accessToken"],
    [{ accessToken: 42, refreshToken: 7, expiresIn: "soon" }, "accessToken"],
    [{ accessToken: "", expiresIn: 3600 }, "accessToken"],
    [{ accessToken: NEW.googleAccessToken, refreshToken: 7, expiresIn: -1 }, "refreshToken"],
    [{ accessToken: NEW.googleAccessToken }, "expiresIn"],
    [{ accessToken: NEW.googleAccessToken, expiresIn: "3600" }, "expiresIn"],
    [{ accessToken: NEW.googleAccessToken, expiresIn: 0 }, "expiresIn"],
    [{ accessToken: NEW.googleAccessToken, expiresIn: -3600 }, "expiresIn"],
    [`{"accessToken":"${NEW.googleAccessToken}","expiresIn":1e400}`, "expiresIn"], // JSON.parse: Infinity
  ]);
  await expectRefused(s, "conn_meta", [
    [{}, "accessToken"],
    [{ accessToken: NEW.metaAccessToken }, "expiresIn"],
  ]);
});

test("Twilio: the first missing or invalid field is named, in the order accountSid, apiKeySid, apiKeySecret, and another account's SID is refused", async () => {
  const s = await stack();
  await expectRefused(s, "conn_twilio", [
    [{}, "accountSid"],
    [{ accountSid: 5, apiKeySid: 5, apiKeySecret: 5 }, "accountSid"],
    [twilioBody({ accountSid: "AC99999999999999999999999999999999" }), "accountSid"],
    [{ accountSid: PUBLIC.twilioAccountSid }, "apiKeySid"],
    [{ accountSid: PUBLIC.twilioAccountSid, apiKeySid: "", apiKeySecret: NEW.twilioApiKeySecret }, "apiKeySid"],
    [{ accountSid: PUBLIC.twilioAccountSid, apiKeySid: NEW.twilioApiKeySid }, "apiKeySecret"],
    [twilioBody({ apiKeySecret: 12345 }), "apiKeySecret"],
  ]);
});

test("Linkfolio: the first missing or invalid field is named, in the order cookies, cookies.lf_session, cookies.lf_csrf, userAgent", async () => {
  const s = await stack();
  await expectRefused(s, "conn_linkfolio", [
    [{}, "cookies"],
    [{ cookies: "lf_session=abc", userAgent: NEW.linkfolioUserAgent }, "cookies"],
    [{ cookies: {}, userAgent: 5 }, "cookies.lf_session"],
    [linkfolioBody({ cookies: { lf_session: 7, lf_csrf: NEW.linkfolioCsrf } }), "cookies.lf_session"],
    [linkfolioBody({ cookies: { lf_session: NEW.linkfolioSession } }), "cookies.lf_csrf"],
    [linkfolioBody({ userAgent: undefined }), "userAgent"],
    [linkfolioBody({ userAgent: "" }), "userAgent"],
  ]);
});

test("Google: expiresIn is seconds; the new token is used until a minute before it expires, then refreshed with the refresh token we already had", async () => {
  const s = await stack();
  s.fakes.google.resetCalls(); // only the calls from the reconnect on (a server may check connections when it starts)
  const t0 = s.scheduler.now();
  const r = await post(s, "conn_google", { accessToken: NEW.googleAccessToken, expiresIn: 3599 });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.connection?.public?.expiresAt, t0 + 3_599_000, "expiresAt is a ms epoch: now + expiresIn * 1000");
  assert.equal(r.body.probe?.ok, true, r.text);
  const probes = () => s.fakes.google.calls.filter((c) => c.method === "probe");
  assert.deepEqual(
    probes().map((c) => c.token),
    [NEW.googleAccessToken],
    "one check, with the token the user brought (not a refreshed one)",
  );
  assert.equal(s.fakes.google.count("refresh"), 0);

  await s.scheduler.advance(3_538_000);
  await s.server.probes.probe("conn_google");
  assert.equal(probes().at(-1)?.token, NEW.googleAccessToken, "59 min later the token is still used as it is");
  assert.equal(s.fakes.google.count("refresh"), 0);

  await s.scheduler.advance(2_000); // a minute before it expires
  await s.server.probes.probe("conn_google");
  assert.equal(s.fakes.google.count("refresh"), 1, "refreshed within refreshMarginMs of expiry");
  const refreshed = s.fakes.google.credentials("refresh")[0];
  assert.equal(refreshed.refreshToken, SECRETS.googleRefreshToken, "no refresh token in the reconnect: the stored one is kept (Google issues one only on a new consent)");
  assert.ok(s.fakes.google.issued.includes(probes().at(-1)!.token), "the check used the refreshed token");
  assert.deepEqual(leaks(r.text, [...s.secrets(), ...NEW_SECRETS]), [], "the answer carries no secret");
});

test("Google: a refresh token in the reconnect replaces the stored one; Meta never stores one", async () => {
  const s = await stack();
  const google = await post(s, "conn_google", { accessToken: NEW.googleAccessToken, refreshToken: NEW.googleRefreshToken, expiresIn: 120 });
  assert.equal(google.status, 200, google.text);
  await s.scheduler.advance(61_000);
  await s.server.probes.probe("conn_google");
  assert.equal(s.fakes.google.credentials("refresh").at(-1)?.refreshToken, NEW.googleRefreshToken);

  const meta = await post(s, "conn_meta", { accessToken: NEW.metaAccessToken, expiresIn: 5_184_000 });
  assert.equal(meta.status, 200, meta.text);
  assert.equal(stored(s, "conn_meta").refreshToken, undefined);
  const withOne = await post(s, "conn_meta", { accessToken: NEW.metaAccessToken, refreshToken: NEW.metaRefreshToken, expiresIn: 5_184_000 });
  if (withOne.status === 400) {
    assert.equal(withOne.body?.field, "refreshToken", withOne.text);
  } else {
    assert.equal(withOne.status, 200, withOne.text);
  }
  assert.equal(stored(s, "conn_meta").refreshToken, undefined, "Meta issues no refresh tokens: none is ever stored");
  assert.deepEqual(leaks([google.text, meta.text, withOne.text], [...s.secrets(), ...NEW_SECRETS]), []);
});

test("a reconnect keeps what can't change (the Twilio account, the Linkfolio profile) and stores only the credential's own fields", async () => {
  const s = await stack();
  const twilio = await post(s, "conn_twilio", twilioBody({ method: "session", profileUrl: "https://evil.example", isAdmin: true }));
  assert.equal(twilio.status, 200, twilio.text);
  assert.deepEqual(stored(s, "conn_twilio"), {
    method: "api_key",
    accountSid: PUBLIC.twilioAccountSid,
    apiKeySid: NEW.twilioApiKeySid,
    apiKeySecret: NEW.twilioApiKeySecret,
  });
  assert.deepEqual(twilio.body.connection?.public, { method: "api_key", accountSid: PUBLIC.twilioAccountSid, apiKeySid: NEW.twilioApiKeySid });

  const linkfolio = await post(
    s,
    "conn_linkfolio",
    linkfolioBody({ cookies: { lf_session: NEW.linkfolioSession, lf_csrf: NEW.linkfolioCsrf, lf_device: "x" }, profileUrl: "https://app.linkfolio.example/in/someone-else" }),
  );
  assert.equal(linkfolio.status, 200, linkfolio.text);
  assert.deepEqual(stored(s, "conn_linkfolio"), {
    method: "session",
    cookies: { lf_session: NEW.linkfolioSession, lf_csrf: NEW.linkfolioCsrf },
    userAgent: NEW.linkfolioUserAgent,
    profileUrl: PUBLIC.linkfolioProfileUrl,
  });
  assert.deepEqual(linkfolio.body.connection?.public, { method: "session", userAgent: NEW.linkfolioUserAgent, profileUrl: PUBLIC.linkfolioProfileUrl });
  assert.deepEqual(leaks([twilio.text, linkfolio.text], [...s.secrets(), ...NEW_SECRETS]), []);
});

test("only this connection's runs paused for a rejected credential resume: an operator's pause and other connections' runs stay as they are", async () => {
  const s = await stack(
    buildSeed({
      runs: [
        makeRun({ id: "run_a", platform: "twilio", items: 3, status: "paused", pausedReason: "unauthorized", nextIndex: 1 }),
        makeRun({ id: "run_b", platform: "twilio", items: 3, status: "paused", pausedReason: "user", nextIndex: 1 }),
        makeRun({ id: "run_c", platform: "google", items: 2, status: "paused", pausedReason: "unauthorized", nextIndex: 0 }),
        makeRun({ id: "run_d", platform: "twilio", items: 2, status: "completed", nextIndex: 2 }),
      ],
    }),
  );
  const sends = acceptOnly(s.fakes.twilio, [NEW.twilioApiKeySecret]);
  const r = await post(s, "conn_twilio", twilioBody());
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.probe?.ok, true, r.text);
  assert.deepEqual(r.body.resumed, ["run_a"]);
  await until(() => s.store.getRun("run_a").status === "completed", s.scheduler, { what: "run_a completed" });

  assert.deepEqual(sends.accepted, items("run_a", 2, 3), "run_a continued from its checkpoint; nothing else was sent on Twilio");
  const b = s.store.getRun("run_b");
  assert.deepEqual([b.status, b.pausedReason, b.progress.nextIndex], ["paused", "user", 1], "an operator's pause is not lifted by a reconnect");
  const c = s.store.getRun("run_c");
  assert.deepEqual([c.status, c.pausedReason], ["paused", "unauthorized"], "another connection's run waits for its own reconnect");
  assert.equal(s.fakes.google.count("send"), 0);
  assert.equal(s.store.getRun("run_d").status, "completed");
});

test("after a reconnect the run uses the new token at once: the token cached for the old credential is dropped", async () => {
  const s = await stack(buildSeed({ runs: [makeRun({ id: "run_g", platform: "google", items: 4, status: "running" })] }));
  const sends = acceptOnly(s.fakes.google, [SECRETS.googleAccessToken], { revokeAfter: 2 });
  const started = await runUntilSettled(s.server.runner.start("run_g"), s.scheduler);
  assert.equal(started.error, undefined, String(started.error));
  assert.equal(s.store.getRun("run_g").status, "paused");

  sends.allow(NEW.googleAccessToken);
  const callsBefore = s.fakes.google.calls.length;
  const r = await post(s, "conn_google", { accessToken: NEW.googleAccessToken, expiresIn: 3600 });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.probe?.ok, true, `the check after the reconnect: ${JSON.stringify(r.body.probe)}`);
  assert.deepEqual(r.body.resumed, ["run_g"]);
  await until(() => ["completed", "paused"].includes(s.store.getRun("run_g").status), s.scheduler, { what: "run_g ended" });

  assert.equal(s.store.getRun("run_g").status, "completed", "the resumed run didn't pause again");
  const used = s.fakes.google.calls.slice(callsBefore).filter((c) => c.method !== "refresh").map((c) => c.token);
  assert.ok(used.length >= 3 && used.every((t) => t === NEW.googleAccessToken), `tokens used after the reconnect: ${used.map((t) => t.slice(0, 12)).join(", ")}`);
  assert.deepEqual(sends.accepted, items("run_g", 1, 4));
});

test("a reconnect checks the platform even when the connection's circuit is open, and the paused run resumes", async () => {
  const s = await stack(
    buildSeed({ runs: [makeRun({ id: "run_p", platform: "twilio", items: 2, status: "paused", pausedReason: "unauthorized", nextIndex: 1 })] }),
  );
  s.fakes.twilio.script("probe", "unreachable", "unreachable", "unreachable", "unreachable", "unreachable");
  for (let i = 0; i < 5; i++) await s.server.probes.probe("conn_twilio");
  assert.equal((await s.server.probes.probe("conn_twilio")).cause, "circuit_open", "the circuit is open");
  const sends = acceptOnly(s.fakes.twilio, [NEW.twilioApiKeySecret]);

  const before = s.fakes.twilio.count("probe");
  const r = await post(s, "conn_twilio", twilioBody());
  assert.equal(r.status, 200, r.text);
  assert.equal(s.fakes.twilio.count("probe"), before + 1, "exactly one platform check for the new key");
  assert.equal(r.body.probe?.ok, true, `probe: ${JSON.stringify(r.body.probe)}`);
  assert.deepEqual(r.body.resumed, ["run_p"]);
  await until(() => s.store.getRun("run_p").status === "completed", s.scheduler, { what: "run_p completed" });
  assert.deepEqual(sends.accepted, ["run_p_item_2"]);
});

test("when the check made with the new credential fails, nothing resumes, and the new credential is kept for the next try", async () => {
  const s = await stack(
    buildSeed({ runs: [makeRun({ id: "run_p", platform: "twilio", items: 3, status: "paused", pausedReason: "unauthorized", nextIndex: 1 })] }),
  );
  acceptOnly(s.fakes.twilio, ["aKeyNobodyHas0123456789abcdefghijklmnopqrstuv"]);
  s.fakes.twilio.resetCalls(); // only the calls from the reconnect on (a server may check connections when it starts)
  const rejected = await post(s, "conn_twilio", twilioBody());
  assert.equal(rejected.status, 200, rejected.text);
  assert.deepEqual([rejected.body.probe?.ok, rejected.body.probe?.cause], [false, "unauthorized"]);
  assert.deepEqual(rejected.body.resumed, []);
  assert.equal(s.fakes.twilio.count("probe"), 1, "one check");

  s.fakes.twilio.script("probe", "unreachable");
  const unreachable = await post(s, "conn_twilio", twilioBody({ apiKeySecret: NEW.twilioApiKeySecret }));
  assert.deepEqual([unreachable.status, unreachable.body.probe?.ok, unreachable.body.probe?.cause], [200, false, "unreachable"]);
  assert.deepEqual(unreachable.body.resumed, [], "an unverified credential resumes nothing either");

  await s.scheduler.advance(10_000);
  const run = s.store.getRun("run_p");
  assert.deepEqual([run.status, run.pausedReason, run.progress.nextIndex], ["paused", "unauthorized", 1]);
  assert.equal(s.fakes.twilio.count("send"), 0, "nothing was sent");
  const one = await (await fetch(`${s.url}/api/connections/conn_twilio`)).json();
  assert.equal(one.public?.apiKeySid, NEW.twilioApiKeySid, "the new key is stored even though its check failed");
  assert.equal(one.lastProbe?.cause, "unreachable", "and its last check is the one just made");
});

test("another open dashboard sees the reconnect live (probe, connection, run), and neither the answer nor any live message carries a secret, old or new", async () => {
  const s = await stack(buildSeed({ runs: [makeRun({ id: "run_t", platform: "twilio", items: 4, status: "running" })] }));
  const sends = acceptOnly(s.fakes.twilio, [SECRETS.twilioApiKeySecret], { revokeAfter: 2 });
  const watcher = await s.dashboard();
  const started = await runUntilSettled(s.server.runner.start("run_t"), s.scheduler);
  assert.equal(started.error, undefined, String(started.error));
  await watcher.ws.next((m) => m?.type === "run" && m.run?.id === "run_t" && m.run.status === "paused");
  await watcher.ws.next((m) => m?.type === "event" && m.event?.type === "paused");
  watcher.ws.drain();

  sends.allow(NEW.twilioApiKeySecret);
  const r = await post(s, "conn_twilio", twilioBody());
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.resumed, ["run_t"]);
  assert.equal(r.body.probe?.ok, true);
  assert.deepEqual(r.body.connection?.lastProbe, r.body.probe, "the answer's connection is as stored after the check");

  const probe = await watcher.ws.next((m) => m?.type === "probe" && m.result?.connectionId === "conn_twilio");
  assert.deepEqual(probe.result, r.body.probe, "the check is pushed to every dashboard");
  // (Extra connection messages, e.g. one per store change, are tolerated: this is the one after the check.)
  const connection = await watcher.ws.next(
    (m) => m?.type === "connection" && m.connection?.id === "conn_twilio" && m.connection.lastProbe?.checkedAt === r.body.probe?.checkedAt,
  );
  assert.equal(connection.connection.public?.apiKeySid, NEW.twilioApiKeySid);
  assert.deepEqual(connection.connection, r.body.connection, "the connection message is the public connection after the check");
  const resumed = await watcher.ws.next((m) => m?.type === "run" && m.run?.id === "run_t" && m.run.status !== "paused");
  assert.equal(resumed.run.pausedReason, undefined);
  await watcher.ws.next((m) => m?.type === "run" && m.run?.id === "run_t" && m.run.status === "completed");
  await watcher.settle();

  assert.deepEqual(sends.accepted, items("run_t", 1, 4));
  const secrets = [...s.secrets(), ...NEW_SECRETS];
  assert.deepEqual(leaks(r.text, secrets), [], "the answer");
  assert.deepEqual(leaks(watcher.ws.messages, secrets), [], `live messages: ${watcher.ws.messages.map((m) => m.type).join(",")}`);
  assert.deepEqual(leaks(await (await fetch(`${s.url}/api/dashboard`)).text(), secrets), [], "/api/dashboard");
});

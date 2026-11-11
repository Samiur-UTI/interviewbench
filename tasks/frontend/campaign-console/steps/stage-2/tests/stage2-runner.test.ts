// Stage 2, server half: a rejected credential pauses the run at its checkpoint, and resume(runId)
// continues it. createApp with fake platforms on a fake clock (helpers/stack.ts); the fakes
// record which items the platform accepted.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { leaks } from "./helpers/browser.ts";
import { PUBLIC, SECRETS, buildSeed, makeRun } from "./helpers/seed.ts";
import { NEW, acceptOnly, until, within } from "./helpers/reconnect.ts";
import { createStack, runUntilSettled } from "./helpers/stack.ts";
import type { Stack } from "./helpers/stack.ts";

const stacks: Stack[] = [];
after(async () => {
  for (const s of stacks) await s.close();
});
async function stack(seed: any): Promise<Stack> {
  const s = await createStack({ seed });
  stacks.push(s);
  return s;
}

const items = (runId: string, from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `${runId}_item_${from + i}`);

/** What a reconnect does to the stored credential, without the endpoint: the runner alone is under test. */
function rotateTwilioKey(s: Stack): void {
  s.store.updateConnection("conn_twilio", {
    credential: { method: "api_key", accountSid: PUBLIC.twilioAccountSid, apiKeySid: NEW.twilioApiKeySid, apiKeySecret: NEW.twilioApiKeySecret },
  });
  s.server.tokens.invalidate("conn_twilio");
}

test("a Twilio key deleted mid-campaign pauses the run at the rejected message, and resuming sends the rest exactly once, in order", async () => {
  const s = await stack(buildSeed({ runs: [makeRun({ id: "run_t", platform: "twilio", items: 5, status: "running" })] }));
  const sends = acceptOnly(s.fakes.twilio, [SECRETS.twilioApiKeySecret], { revokeAfter: 2 });

  const started = await runUntilSettled(s.server.runner.start("run_t"), s.scheduler);
  assert.equal(started.error, undefined, String(started.error));
  const paused = s.store.getRun("run_t");
  assert.equal(paused.status, "paused", "a dead credential pauses the run instead of failing it");
  assert.equal(paused.pausedReason, "unauthorized");
  assert.deepEqual(paused.progress, { nextIndex: 2, sent: 2, total: 5 }, "the checkpoint is the first message not sent");
  const events = s.store.listEvents("run_t");
  assert.ok(events.some((e: any) => e.type === "paused"), `events: ${events.map((e: any) => e.type).join(",")}`);
  assert.ok(!events.some((e: any) => e.type === "failed"), "no failed event: the run isn't over");

  rotateTwilioKey(s);
  sends.allow(NEW.twilioApiKeySecret);
  await within(s.server.runner.resume("run_t"), 2_000, "resume()");
  await until(() => s.store.getRun("run_t").status === "completed", s.scheduler, { what: "run_t completed" });

  assert.deepEqual(sends.accepted, items("run_t", 1, 5), "every message accepted exactly once, in order: none skipped, none twice");
  const done = s.store.getRun("run_t");
  assert.deepEqual(done.progress, { nextIndex: 5, sent: 5, total: 5 });
  const after = s.store.listEvents("run_t");
  const sentTo = after.filter((e: any) => e.type === "sent").map((e: any) => e.target?.name);
  assert.deepEqual(sentTo, ["Target 1", "Target 2", "Target 3", "Target 4", "Target 5"], "one sent event per target");
  assert.equal(after.filter((e: any) => e.type === "resumed").length, 1, "the resume is recorded once");
});

test("a Google run whose token is still rejected after the forced refresh pauses with its place kept, and says so in our own words", async () => {
  const s = await stack(buildSeed({ runs: [makeRun({ id: "run_g", platform: "google", items: 3, status: "running" })] }));
  acceptOnly(s.fakes.google, [SECRETS.googleAccessToken], { revokeAfter: 1 });

  const started = await runUntilSettled(s.server.runner.start("run_g"), s.scheduler);
  assert.equal(started.error, undefined, String(started.error));
  assert.equal(s.fakes.google.count("refresh"), 1, "one forced refresh before giving up on the credential");
  const run = s.store.getRun("run_g");
  assert.deepEqual([run.status, run.pausedReason, run.progress.nextIndex, run.progress.sent], ["paused", "unauthorized", 1, 1]);
  const pausedEvent = s.store.listEvents("run_g").find((e: any) => e.type === "paused");
  assert.ok(pausedEvent && typeof pausedEvent.message === "string" && pausedEvent.message.length > 0, "the pause is explained");
  assert.deepEqual(leaks(pausedEvent.message, s.secrets()), [], "the message never quotes the adapter (which names the rejected token)");
});

test("resume refuses a run that isn't paused, and an unknown run", async () => {
  const s = await stack(
    buildSeed({
      runs: [
        makeRun({ id: "run_r", platform: "twilio", items: 3, status: "running", nextIndex: 1 }),
        makeRun({ id: "run_c", platform: "twilio", items: 2, status: "completed", nextIndex: 2 }),
      ],
    }),
  );
  const { ValidationError, NotFoundError } = s.app;
  await assert.rejects(within(s.server.runner.resume("run_r"), 2_000, "resume(running)"), (e: unknown) => e instanceof ValidationError);
  await assert.rejects(within(s.server.runner.resume("run_c"), 2_000, "resume(completed)"), (e: unknown) => e instanceof ValidationError);
  await assert.rejects(within(s.server.runner.resume("run_nope"), 2_000, "resume(unknown)"), (e: unknown) => e instanceof NotFoundError);
  assert.equal(s.store.getRun("run_c").status, "completed");
  assert.equal(s.fakes.twilio.count("send"), 0);
});

test("resume answers as soon as the run is running again, while the rest is still being sent", async () => {
  const s = await stack(
    buildSeed({ runs: [makeRun({ id: "run_p", platform: "twilio", items: 3, status: "paused", pausedReason: "unauthorized", nextIndex: 1 })] }),
  );
  const gate = s.fakes.twilio.defer("send");

  await within(s.server.runner.resume("run_p"), 2_000, "resume() while the first send is held by the platform");
  const running = s.store.getRun("run_p");
  assert.equal(running.status, "running");
  assert.equal(running.pausedReason, undefined, "a running run has no pause reason");
  assert.ok(
    s.store.listEvents("run_p").some((e: any) => e.type === "resumed"),
    "a resumed event is recorded",
  );
  const first = await within(gate.started, 2_000, "the first send after resume");
  assert.equal(first.item?.id, "run_p_item_2", "it continues from the checkpoint");
  gate.release();
  await until(() => s.store.getRun("run_p").status === "completed", s.scheduler, { what: "run_p completed" });
  assert.deepEqual(
    s.fakes.twilio.sentItems.map((i: any) => i.id),
    items("run_p", 2, 3),
  );
});

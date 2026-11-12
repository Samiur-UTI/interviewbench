// Stage 2, browser half: the Reconnect button and ReconnectForm, rendered with the vendored
// render-to-string and read the way assistive technology reads them (helpers/markup.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadClient, loadRender } from "./helpers/app.ts";
import { byId, elements, hasFlag, labelFor, textOf, textOfIds } from "./helpers/markup.ts";
import { ALL_SECRETS, NOW, PUBLIC } from "./helpers/seed.ts";

const CONNECTIONS: Record<string, any> = {
  google: {
    id: "conn_google",
    platform: "google",
    method: "oauth",
    label: "Google Ads",
    accountName: "Test Outdoor",
    public: { method: "oauth", scope: PUBLIC.googleScope, expiresAt: NOW + 3_600_000 },
  },
  meta: {
    id: "conn_meta",
    platform: "meta",
    method: "oauth",
    label: "Meta",
    accountName: "Test Outdoor (act_1)",
    public: { method: "oauth", scope: PUBLIC.metaScope, expiresAt: NOW + 40 * 86_400_000 },
  },
  twilio: {
    id: "conn_twilio",
    platform: "twilio",
    method: "api_key",
    label: "Twilio",
    accountName: "Test SMS",
    public: { method: "api_key", accountSid: PUBLIC.twilioAccountSid, apiKeySid: PUBLIC.twilioApiKeySid },
  },
  linkfolio: {
    id: "conn_linkfolio",
    platform: "linkfolio",
    method: "session",
    label: "Linkfolio",
    accountName: "Test Sender",
    public: { method: "session", userAgent: PUBLIC.linkfolioUserAgent, profileUrl: PUBLIC.linkfolioProfileUrl },
  },
};

/** The fields each form must have (by `name`) and how each must be typed in. */
const EXPECTED: Record<string, Record<string, "password" | "text" | "number">> = {
  google: { accessToken: "password", refreshToken: "password", expiresIn: "number" },
  meta: { accessToken: "password", expiresIn: "number" },
  twilio: { accountSid: "text", apiKeySid: "text", apiKeySecret: "password" },
  linkfolio: { "cookies.lf_session": "password", "cookies.lf_csrf": "password", userAgent: "text" },
};

async function render(platform: string, props: Record<string, unknown> = {}): Promise<string> {
  const client = await loadClient();
  const { renderToString } = await loadRender();
  return renderToString(client.html`<${client.ReconnectForm} connection=${CONNECTIONS[platform]} ...${props} />`);
}

/** Inputs a user types into (hidden inputs are not fields). */
const fields = (markup: string) => elements(markup, "input").filter((e) => (e.attrs.type ?? "text") !== "hidden");
const field = (markup: string, name: string) => fields(markup).find((e) => e.attrs.name === name);

test("the Reconnect button of a disconnected card is described by the card's status text", async () => {
  const client = await loadClient();
  const { renderToString } = await loadRender();
  for (const platform of Object.keys(CONNECTIONS)) {
    const markup = renderToString(client.html`<${client.ConnectionCard} connection=${CONNECTIONS[platform]} status="disconnected" />`);
    const button = elements(markup, "button").find((b) => /reconnect/i.test(textOf(markup, b)));
    assert.ok(button, `${platform}: a Reconnect button`);
    const described = button.attrs["aria-describedby"];
    assert.ok(described, `${platform}: the button has aria-describedby`);
    assert.match(textOfIds(markup, described), /disconnected/i, `${platform}: it points at the status text`);
  }
});

test("every field of every reconnect form has a label, ids don't collide between cards, and the form is labelled", async () => {
  const client = await loadClient();
  const { renderToString } = await loadRender();
  for (const platform of Object.keys(CONNECTIONS)) {
    const markup = await render(platform);
    const form = elements(markup, "form")[0];
    assert.ok(form, `${platform}: a <form>`);
    assert.ok(textOfIds(markup, form.attrs["aria-labelledby"]).length > 0, `${platform}: the form has aria-labelledby pointing at a visible title`);
    const names = fields(markup).map((f) => f.attrs.name);
    for (const name of Object.keys(EXPECTED[platform])) assert.ok(names.includes(name), `${platform}: a field named ${name} (found ${names.join(", ")})`);
    for (const f of fields(markup)) {
      assert.ok(f.attrs.id, `${platform} ${f.attrs.name}: has an id`);
      assert.ok(labelFor(markup, f.attrs.id).length > 0, `${platform} ${f.attrs.name}: has a <label for>`);
    }
  }
  const both = renderToString(
    client.html`<div><${client.ReconnectForm} connection=${CONNECTIONS.google} /><${client.ReconnectForm} connection=${CONNECTIONS.meta} /></div>`,
  );
  const ids = elements(both)
    .map((e) => e.attrs.id)
    .filter(Boolean);
  assert.deepEqual(
    ids.filter((id, i) => ids.indexOf(id) !== i),
    [],
    "two forms on one page don't share ids",
  );
});

test("secrets are typed into password fields and never prefilled; public identifiers are prefilled, and the Twilio account SID is read-only", async () => {
  for (const platform of Object.keys(CONNECTIONS)) {
    const markup = await render(platform);
    for (const [name, type] of Object.entries(EXPECTED[platform])) {
      const f = field(markup, name);
      assert.ok(f, `${platform}: field ${name}`);
      assert.equal(f.attrs.type ?? "text", type, `${platform} ${name}: type`);
      if (type === "password") assert.ok(!f.attrs.value, `${platform} ${name}: a secret field starts empty`);
    }
    for (const secret of ALL_SECRETS) assert.ok(!markup.includes(secret), `${platform}: no secret in the form`);
  }
  const twilio = await render("twilio");
  const accountSid = field(twilio, "accountSid");
  assert.equal(accountSid?.attrs.value, PUBLIC.twilioAccountSid, "the account SID is shown");
  assert.ok(hasFlag(accountSid, "readonly"), "the account SID can't be edited: a different account is a new connection");
  const apiKeySid = field(twilio, "apiKeySid");
  assert.equal(apiKeySid?.attrs.value, PUBLIC.twilioApiKeySid, "the API key SID is prefilled");
  assert.ok(!hasFlag(apiKeySid, "readonly") && !hasFlag(apiKeySid, "disabled"), "a new key pair is normal: the key SID can change");
  const linkfolio = await render("linkfolio");
  assert.equal(field(linkfolio, "userAgent")?.attrs.value, PUBLIC.linkfolioUserAgent, "the user agent is prefilled");
});

test("Google offers an optional refresh token and the expiry in seconds (3600); Meta, which has no refresh token, doesn't ask for one", async () => {
  const google = await render("google");
  const expires = field(google, "expiresIn");
  assert.equal(expires?.attrs.type, "number");
  assert.equal(expires?.attrs.value, "3600", "Google access tokens live 3600 s");
  assert.ok(/second/i.test(labelFor(google, expires?.attrs.id)), `the label says the unit: "${labelFor(google, expires?.attrs.id)}"`);
  assert.ok(!hasFlag(field(google, "refreshToken"), "required"), "the refresh token is optional");
  const meta = await render("meta");
  assert.equal(field(meta, "refreshToken"), undefined, "no refresh token field for Meta");
  assert.equal(field(meta, "expiresIn")?.attrs.type, "number");
});

test("a field the server refused is marked invalid and described by its message, and submit is disabled while a reconnect is in flight", async () => {
  const cases: [string, string][] = [
    ["twilio", "apiKeySecret"],
    ["google", "expiresIn"],
    ["linkfolio", "cookies.lf_csrf"],
  ];
  for (const [platform, name] of cases) {
    const markup = await render(platform, { error: { error: "invalid_credential", field: name } });
    const f = field(markup, name);
    assert.equal(f?.attrs["aria-invalid"], "true", `${platform} ${name}: aria-invalid="true"`);
    const message = textOfIds(markup, f?.attrs["aria-describedby"]);
    assert.ok(message.length > 0, `${platform} ${name}: aria-describedby points at the message`);
    for (const other of fields(markup).filter((o) => o.attrs.name !== name)) {
      assert.notEqual(other.attrs["aria-invalid"], "true", `${platform}: only ${name} is marked invalid, not ${other.attrs.name}`);
    }
  }
  const idle = await render("twilio");
  // A <button> without a type submits its form, like type="submit".
  const submitOf = (markup: string) =>
    elements(markup, "button").find((b) => (b.attrs.type ?? "submit").toLowerCase() === "submit") ??
    elements(markup, "input").find((i) => i.attrs.type === "submit");
  assert.ok(submitOf(idle), "a submit button");
  assert.ok(!hasFlag(submitOf(idle), "disabled"), "enabled when idle");
  const pending = await render("twilio", { pending: true });
  assert.ok(hasFlag(submitOf(pending), "disabled"), "disabled while in flight");
  const cancel = elements(idle, "button").find((b) => /cancel/i.test(textOf(idle, b)));
  assert.ok(cancel && cancel.attrs.type === "button", "a Cancel button that doesn't submit");
  assert.ok(byId(idle, elements(idle, "form")[0].attrs["aria-labelledby"]?.split(/\s+/)[0] ?? ""), "the title element exists");
});

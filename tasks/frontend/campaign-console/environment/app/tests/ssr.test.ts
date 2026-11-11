import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createStore, renderDashboardPage, toDashboardState } from "../src/index.ts";
import type { Seed } from "../src/index.ts";

const seed = (): Seed => JSON.parse(readFileSync(new URL("../data/seed.json", import.meta.url), "utf8")) as Seed;

function embeddedState(page: string): unknown {
  const match = /<script id="__STATE__" type="application\/json">([\s\S]*?)<\/script>/.exec(page);
  assert.ok(match, "state script present");
  return JSON.parse(match[1]);
}

test("renders every connection and campaign of the seed", () => {
  const page = renderDashboardPage(toDashboardState(createStore(seed())));
  for (const text of ["Google Ads", "Meta", "Twilio", "LinkedIn", "Spring reactivation", "Founders outreach", "Winter search refresh"]) {
    assert.ok(page.includes(text), text);
  }
});

test("the page embeds the state it was rendered from, and loads the client after it", () => {
  const state = toDashboardState(createStore(seed()));
  const page = renderDashboardPage(state);
  assert.deepEqual(embeddedState(page), JSON.parse(JSON.stringify(state)));
  assert.ok(page.indexOf('id="__STATE__"') < page.indexOf('src="/src/client/main.ts"'));
});

test("lead names are rendered as text", () => {
  const page = renderDashboardPage(toDashboardState(createStore(seed())));
  assert.ok(page.includes("Connection request sent to Ana &lt;Lima>"));
  assert.ok(page.includes("O&#39;Brien &amp; Sons") || page.includes("O'Brien &amp; Sons"));
});

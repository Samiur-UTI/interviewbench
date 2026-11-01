import assert from "node:assert/strict";
import { test } from "node:test";

import { HOME, NAV, parseRoute, roundHref } from "../../src/interviewbench/ui/static/js/core/routes.js";

test("plain screens", () => {
  for (const { name, href } of NAV) {
    assert.deepEqual(parseRoute(href).name, name);
    assert.equal(parseRoute(href).key, name);
  }
  assert.equal(parseRoute(HOME).name, "tasks");
});

test("a round keeps one key across its panels", () => {
  const tests = parseRoute("#/rounds/rate-limiter-2/tests");
  const grade = parseRoute("#/rounds/rate-limiter-2/grade");
  assert.equal(tests.name, "round");
  assert.equal(tests.nav, "rounds");
  assert.deepEqual(grade.params, { id: "rate-limiter-2", panel: "grade" });
  assert.equal(tests.key, grade.key);
});

test("round ids round-trip through their address", () => {
  const id = "odd name/with%things";
  assert.equal(parseRoute(roundHref(id, "break")).params.id, id);
});

test("what isn't a route", () => {
  for (const hash of ["", "#", "#/", "#/nope", "#/tasks/extra", "#/settings/x", "#/constructor", "#/__proto__", "#/rounds/%E0%A4%A"]) {
    assert.equal(parseRoute(hash), null, hash);
  }
});

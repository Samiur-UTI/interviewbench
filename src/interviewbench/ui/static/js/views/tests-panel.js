// Tests panel: the candidate's own tests. Hidden tests never run here.

import { api } from "../api.js";
import { formatDate, parseTime } from "../format.js";
import { icon } from "../icons.js";
import { button, emptyBlock, h, notice } from "../ui.js";

function failureList(failures) {
  return h("ul", { class: "failures" }, failures.map((failure) => h("li", null,
    h("p", { class: "failure-name" }, icon("cross"), h("code", null, failure.name)),
    failure.message && h("pre", { class: "output" }, failure.message))));
}

// Also used by the Grade panel for the tests the AI review ran.
export function testSummary(result, what = "of your tests passed") {
  const clean = result.total > 0 && result.passed === result.total && !result.error;
  return h("p", { class: `result-line ${clean ? "ok" : "fail"}` },
    icon(clean ? "check" : "cross"),
    h("span", { class: "result-count" }, `${result.passed} of ${result.total}`), ` ${what}`);
}

export function testDetails(result) {
  return [
    result.error && h("div", { class: "stack" },
      notice("fail", "Your tests could not run. This is what they printed:"),
      h("pre", { class: "output" }, result.error)),
    result.failures?.length > 0 && failureList(result.failures),
  ];
}

function result(last, running) {
  const finished = parseTime(last.finished_at);
  return h("div", { class: "stack" },
    running && h("p", { class: "meta" }, "Showing your last run until this one finishes."),
    testSummary(last),
    h("p", { class: "meta" }, [last.runner && `${last.runner} runner`, finished && `finished ${formatDate(finished)}`].filter(Boolean).join(" · ")),
    !last.error && last.total === 0 && notice("warn", "No tests ran. Add tests to your project, then run them again."),
    testDetails(last));
}

export function render(ctx) {
  const last = ctx.round.last?.test;
  const running = ctx.job?.kind === "test";
  return h("div", { class: "stack" },
    h("div", { class: "panel-head" },
      h("div", null,
        h("h2", null, "Your tests"),
        h("p", null, "Runs the tests in your project, the way the grader runs them. The hidden tests stay hidden, so this can't spoil a stage.")),
      button(last ? "Run tests again" : "Run my tests", {
        icon: "play",
        kind: "primary",
        "data-fk": "run-tests",
        blocked: ctx.blocked,
        onClick: () => ctx.runJob(() => api.runTests(ctx.round.id)),
      })),
    ctx.failure("test") && notice("fail", ["The test run failed. ", ctx.failure("test"), " Fix that, then run them again."]),
    running && ctx.jobLog(),
    last ? result(last, running)
      : !running && emptyBlock("No test run yet", "Run your tests whenever you like. Results show up here."));
}

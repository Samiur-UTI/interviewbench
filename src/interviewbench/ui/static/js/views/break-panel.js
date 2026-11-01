// Break it: an LLM writes attack tests, refereed by the reference solution.

import { api } from "../api.js";
import { formatDate, formatTokens, parseTime } from "../format.js";
import { icon } from "../icons.js";
import { badge, button, copyButton, emptyBlock, h, notice, setBlocked } from "../ui.js";

const VERDICTS = {
  "real break": { kind: "fail", icon: "crack", label: "Real break", meaning: "Fails on your code but passes on the reference. This is a bug worth fixing." },
  survived: { kind: "ok", icon: "check", label: "Survived", meaning: "Passes on both. Your code held up." },
  "bad test": { kind: "", icon: "ring", label: "Bad test", meaning: "Fails on the reference too, so the test is wrong. It's ignored." },
};
const ORDER = ["real break", "survived", "bad test"];

function legend() {
  return h("dl", { class: "verdicts" }, ORDER.map((name) => {
    const verdict = VERDICTS[name];
    return h("div", null, h("dt", null, badge(verdict.kind, verdict.label, verdict.icon)), h("dd", null, verdict.meaning));
  }));
}

function count(number, label) {
  return h("li", null, h("span", { class: "result-count" }, number), ` ${label}`);
}

function results(last, running) {
  const finished = parseTime(last.finished_at);
  const attacks = [...last.attacks].sort((a, b) => ORDER.indexOf(a.verdict) - ORDER.indexOf(b.verdict));
  return h("section", { class: "stack" },
    h("h3", null, "Results"),
    running && h("p", { class: "meta" }, "Showing your last attack until this one finishes."),
    h("ul", { class: "break-counts" },
      count(last.counts.real_break, last.counts.real_break === 1 ? "real break" : "real breaks"),
      count(last.counts.survived, "survived"),
      count(last.counts.bad_test, last.counts.bad_test === 1 ? "bad test ignored" : "bad tests ignored")),
    h("p", { class: "meta" }, [last.runner && `${last.runner} runner`, finished && `finished ${formatDate(finished)}`].filter(Boolean).join(" · ")),
    h("ul", { class: "attacks" }, attacks.map((attack) => {
      const verdict = VERDICTS[attack.verdict] ?? VERDICTS["bad test"];
      return h("li", null,
        h("p", { class: "attack-head" }, badge(verdict.kind, verdict.label, verdict.icon), h("code", null, attack.name)),
        attack.detail && h("pre", { class: "output" }, attack.detail));
    })));
}

export function render(ctx) {
  const { drafts, round } = ctx;
  const running = ctx.job?.kind === "break";
  const last = round.last?.break;
  const tokens = h("span", { class: "meta" });
  const where = h("p", { class: "field-help" }, "It runs in a temporary copy of your code.");

  const show = (info) => {
    tokens.textContent = formatTokens(info.tokens_estimate);
    where.replaceChildren("It runs from ", h("code", null, info.attack_dir), " in a temporary copy of your code.");
    if (!drafts.filename) {
      drafts.filename = info.suggested_filename;
      filename.value = info.suggested_filename;
    }
  };

  // Rebuilt from the current code on every copy, so the prompt is never stale.
  const copyPrompt = async () => {
    const info = await api.attackPrompt(round.id);
    show(info);
    return info.prompt;
  };

  const problem = () => {
    if (ctx.blocked) return ctx.blocked;
    if (!filename.value.trim()) return "Name the file first";
    if (/[\\/]/.test(filename.value)) return "Use a file name, not a path";
    return content.value.trim() ? null : "Paste the test file first";
  };

  const filename = h("input", {
    type: "text",
    class: "mono",
    autocomplete: "off",
    spellcheck: "false",
    value: drafts.filename ?? "",
    oninput: () => {
      drafts.filename = filename.value;
      setBlocked(run, problem());
    },
  });
  const content = h("textarea", {
    rows: 10,
    spellcheck: "false",
    value: drafts.attack ?? "",
    oninput: () => {
      drafts.attack = content.value;
      setBlocked(run, problem());
    },
  });
  const run = button("Run the attacks", {
    icon: "crack",
    kind: "primary",
    "data-fk": "run-break",
    onClick: () => ctx.runJob(() => api.breakIt(round.id, filename.value.trim(), content.value)),
  });
  setBlocked(run, problem());
  api.attackPrompt(round.id).then((info) => {
    show(info);
    setBlocked(run, problem());
  }).catch(() => {
    tokens.textContent = "";
  });

  return h("div", { class: "stack sections" },
    h("div", { class: "panel-head" },
      h("div", null,
        h("h2", null, "Break it"),
        h("p", null, "Get any LLM to try to break your code. Each attack runs on your code and on the reference solution, so a bad test can't count against you. Your workspace isn't changed."))),
    ctx.failure("break") && notice("fail", ["The attacks didn't run. ", ctx.failure("break")]),
    running && ctx.jobLog(),
    last ? results(last, running)
      : !running && emptyBlock("No attacks yet", "Follow the three steps below. It's optional, and it doesn't affect your score."),
    h("ol", { class: "steps" },
      h("li", null,
        h("p", { class: "step-title-text" }, "Copy the prompt"),
        h("p", { class: "muted" }, "It holds the briefs you've seen and your code. It doesn't hold the hidden tests."),
        h("div", { class: "route-actions" },
          copyButton("Copy the prompt", copyPrompt, { "data-fk": "copy-attack" }),
          tokens)),
      h("li", null,
        h("p", { class: "step-title-text" }, "Get an LLM to write the tests"),
        h("p", { class: "muted" }, "Paste the prompt into any chatbot or coding agent. It writes one test file that tries to break your code.")),
      h("li", null,
        h("p", { class: "step-title-text" }, "Paste the file here"),
        h("label", { class: "field" }, h("span", { class: "field-label" }, "File name"), filename, where),
        h("label", { class: "field" }, h("span", { class: "field-label" }, "Test file"), content),
        h("div", { class: "route-actions" }, run))),
    h("section", { class: "stack" },
      h("h3", null, "What the verdicts mean"),
      legend()),
    h("p", { class: "muted" }, icon("info"), " An attack only counts if the reference solution passes it, so a model that misreads the brief can't invent a bug."));
}

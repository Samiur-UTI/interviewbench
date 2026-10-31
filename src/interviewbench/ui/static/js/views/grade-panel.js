// Grade panel: the score, what's behind it, and the two ways to get the AI review.

import { api } from "../api.js";
import { formatDate, formatPercent, formatPoints, formatTokens, judgeProblem, parseTime, plural } from "../format.js";
import { icon } from "../icons.js";
import { setMarkdown } from "../markdown.js";
import { app } from "../state.js";
import { badge, button, copyButton, copyablePath, emptyBlock, h, loadingBlock, notice, setBlocked } from "../ui.js";
import { testDetails, testSummary } from "./tests-panel.js";

const SEVERITIES = [["high", "fail", "High"], ["medium", "warn", "Medium"], ["low", "", "Low"]];
const BACKEND_LABEL = { claude: "Claude", openai: "OpenAI-compatible" };

function explainer(open) {
  return h("details", { class: "explainer", open },
    h("summary", null, "How grading works"),
    h("div", { class: "explainer-body" },
      h("p", null, "Grading runs the hidden tests for every stage, even stages you haven't revealed yet. That fills in the auto-scored part of the rubric. It can take a few minutes, and it doesn't change your code."),
      h("p", null, "If a stage you haven't reached has failures, you only see how many. The details stay hidden, so nothing is spoiled."),
      h("p", null, "The rest of the rubric is about how you did the work, so it needs an AI reviewer. You can get that review two ways, further down this panel.")));
}

function bar(score) {
  const fill = h("span", { class: "bar-fill" });
  fill.style.setProperty("--fill", formatPercent(score));
  const tone = score >= 1 ? "ok" : score > 0 ? "warn" : "fail";
  return h("span", { class: `bar ${tone}`, "aria-hidden": "true" }, fill);
}

function scoreSection(grade) {
  const finished = parseTime(grade.finished_at);
  const pending = grade.pending_weight > 0;
  return h("section", { class: "stack", "aria-label": "Score" },
    h("div", { class: "score" },
      h("span", { class: "score-value" }, `${Math.round(grade.percent)}%`),
      h("div", null,
        h("p", { class: "score-line" }, pending
          ? `${formatPoints(grade.points)} of the ${formatPoints(grade.graded_weight)} points graded so far`
          : `${formatPoints(grade.points)} of ${formatPoints(grade.total_weight)} points`),
        pending && h("p", { class: "muted" }, `${formatPoints(grade.pending_weight)} more points wait for the AI review.`))),
    h("p", { class: "meta" }, [
      grade.time_used_minutes !== null && grade.time_used_minutes !== undefined && `${grade.time_used_minutes} min used`,
      grade.runner && `${grade.runner} runner`,
      finished && `graded ${formatDate(finished)}`,
    ].filter(Boolean).join(" · ")),
    grade.report_path && h("p", { class: "meta report" }, "Report ", copyablePath(grade.report_path)),
    grade.judge_error && notice("warn", [
      h("strong", null, "The AI review didn't finish. "), grade.judge_error,
      " The hidden-test scores here still count. Check Settings, or use a chatbot instead.",
    ]));
}

function stageRow(stage) {
  const clean = stage.total > 0 && stage.passed === stage.total && !stage.error;
  const failures = Array.isArray(stage.failures) ? stage.failures : [];
  return h("li", { class: "stage-result" },
    h("div", { class: "stage-result-head" },
      h("span", { class: stage.revealed ? (clean ? "tone-ok" : "tone-fail") : "muted" },
        icon(!stage.revealed ? "lock" : clean ? "check" : "cross")),
      h("span", { class: "stage-result-name" }, `Stage ${stage.stage}`, stage.title && `: ${stage.title}`,
        !stage.revealed && h("span", { class: "muted" }, " (not revealed)")),
      h("span", { class: "mono" }, `${stage.passed} of ${stage.total}`)),
    stage.withheld_failures > 0 && h("p", { class: "muted" },
      `${plural(stage.withheld_failures, "hidden test")} failed here. You'll see what they were once you reveal this stage.`),
    stage.error && h("pre", { class: "output" }, stage.error),
    failures.length > 0 && h("details", null,
      h("summary", null, `Show ${plural(failures.length, "failure")}`),
      testDetails({ failures })));
}

function criterionRow(criterion, revealed) {
  const scored = criterion.score !== null && criterion.score !== undefined;
  const ahead = criterion.stage > revealed;  // its description would give the stage away
  return h("li", { class: "criterion" },
    h("div", { class: "criterion-head" },
      h("code", { class: "criterion-id" }, criterion.id),
      badge("", criterion.type === "auto" ? "Hidden tests" : "AI review"),
      h("span", { class: "criterion-score mono" },
        scored ? `${formatPercent(criterion.score)} of ${formatPoints(criterion.weight)} pts`
          : `${formatPoints(criterion.weight)} pts waiting`)),
    scored ? bar(criterion.score) : h("span", { class: "bar waiting", "aria-hidden": "true" }),
    h("p", null, ahead ? `Hidden tests for stage ${criterion.stage}, which you haven't revealed yet.` : criterion.description),
    criterion.evidence && h("p", { class: "muted" }, criterion.evidence));
}

function issueRow(issue, kind, label) {
  return h("li", { class: "issue" },
    h("div", { class: "issue-head" },
      badge(kind, label, kind === "fail" || kind === "warn" ? "alert" : null),
      issue.category && h("span", { class: "muted" }, issue.category),
      issue.location && h("code", { class: "issue-location" }, issue.location)),
    h("p", null, issue.description));
}

function reviewSection(review) {
  const summary = h("div", { class: "md md-small" });
  setMarkdown(summary, review.summary, { headingOffset: 3 });
  const issues = review.issues ?? [];
  const missed = review.missed_edge_cases ?? [];
  return h("section", { class: "stack" },
    h("h3", null, "AI review"),
    h("p", { class: "meta" }, review.model),
    summary,
    review.candidate_tests && h("div", { class: "stack" },
      h("h4", null, "Your tests, as the reviewer saw them"),
      testSummary(review.candidate_tests),
      testDetails(review.candidate_tests)),
    h("h4", null, "Issues"),
    issues.length === 0 && h("p", { class: "muted" }, "The reviewer found no issues."),
    SEVERITIES.map(([severity, kind, label]) => {
      const group = issues.filter((issue) => issue.severity === severity);
      return group.length > 0 && h("ul", { class: "issues" }, group.map((issue) => issueRow(issue, kind, label)));
    }),
    missed.length > 0 && [
      h("h4", null, "Edge cases you missed"),
      h("ul", { class: "plain-list" }, missed.map((item) => h("li", null, item))),
    ]);
}

function connectedRoute(ctx, grade) {
  const judge = app.status?.settings?.judge;
  const problem = judge ? judgeProblem(judge) : "Open Settings to choose a model.";
  const model = judge?.model || judge?.default_model;
  return h("section", { class: "route" },
    h("h4", null, "Connected model"),
    h("p", null, "Uses the model in Settings. It sends the hidden tests, the reference solution and your diff to that provider, then fills in the judged criteria. Your provider charges for the call, and it can take a few minutes."),
    judge && h("p", { class: "meta" }, [BACKEND_LABEL[judge.backend] ?? judge.backend, model].filter(Boolean).join(" · ")),
    problem && notice("info", problem),
    h("div", { class: "route-actions" },
      button(grade?.review ? "Run the AI review again" : "Run the AI review", {
        icon: "play",
        kind: "primary",
        "data-fk": "judge-api",
        blocked: ctx.blocked ?? problem,
        onClick: () => ctx.runJob(() => api.grade(ctx.round.id, "api")),
      }),
      h("a", { href: "#/settings" }, "Open Settings")));
}

const prepareButton = (ctx, label) => button(label, {
  icon: "play",
  "data-fk": "judge-prepare",
  blocked: ctx.blocked,
  onClick: () => ctx.runJob(() => api.grade(ctx.round.id, "prepare")),
});

function promptSteps(ctx, grade) {
  const slot = h("div", { class: "stack" }, loadingBlock("Loading the prompt…"));
  const ready = (data) => {
    ctx.memo.judgePrompt = { key: grade.finished_at, ...data };
    slot.replaceChildren(h("div", { class: "route-actions" },
      copyButton("Copy the prompt", () => data.prompt, { kind: "primary", "data-fk": "copy-judge" }),
      h("span", { class: "meta" }, formatTokens(data.tokens_estimate))));
  };
  if (ctx.memo.judgePrompt?.key === grade.finished_at) {
    ready(ctx.memo.judgePrompt);
  } else {
    api.judgePrompt(ctx.round.id).then(ready).catch((err) => {
      slot.replaceChildren(
        err.status === 404
          ? notice("warn", "The prompt is gone: it's only kept in memory, and the server has restarted.")
          : notice("fail", `Couldn't load the prompt. ${err.message}`),
        prepareButton(ctx, "Prepare it again"));
    });
  }
  return slot;
}

function chatbotRoute(ctx, grade) {
  const input = h("textarea", {
    rows: 6,
    "aria-labelledby": "reply-label",
    spellcheck: "false",
    placeholder: "{ ... }",
    value: ctx.drafts.reply ?? "",
    oninput: () => {
      ctx.drafts.reply = input.value;
      setBlocked(score, ctx.blocked ?? (input.value.trim() ? null : "Paste the reply first"));
    },
  });
  const score = button("Score this reply", {
    icon: "gauge",
    kind: "primary",
    "data-fk": "judge-reply",
    blocked: ctx.blocked ?? (input.value.trim() ? null : "Paste the reply first"),
    onClick: () => ctx.runJob(() => api.judgeReply(ctx.round.id, input.value)),
  });
  const failed = ctx.failure("judge-reply");
  return h("section", { class: "route" },
    h("h4", null, "Any chatbot, no key needed"),
    h("p", null, "Paste one prompt into ChatGPT, Claude, Gemini or any other chatbot, then paste its JSON reply back here."),
    notice("warn", [
      h("strong", null, "The prompt contains the hidden tests and the reference solution. "),
      "Use it when you've finished, and don't share it.",
    ]),
    h("ol", { class: "steps" },
      h("li", null,
        h("p", { class: "step-title-text" }, "Get the prompt"),
        grade?.judge_prepared ? promptSteps(ctx, grade) : prepareButton(ctx, "Prepare the prompt")),
      h("li", null,
        h("p", { class: "step-title-text" }, "Paste it into a chatbot"),
        h("p", { class: "muted" }, "Ask in a new chat, and paste all of it.")),
      h("li", null,
        h("p", { class: "step-title-text", id: "reply-label" }, "Paste the JSON reply here"),
        input,
        failed && notice("fail", ["That reply didn't work. ", failed, " Your paste is still here, so you can fix it."]),
        h("div", { class: "route-actions" }, score))));
}

function routes(ctx, grade) {
  const body = [
    h("p", { class: "muted" }, "Pick either route. Use a model family other than the one that helped you solve the task, because LLM judges favour their own family's work."),
    connectedRoute(ctx, grade),
    chatbotRoute(ctx, grade),
  ];
  return grade?.review
    ? h("details", { class: "explainer" }, h("summary", null, "Get another AI review"), h("div", { class: "explainer-body" }, body))
    : h("section", { class: "stack" }, h("h3", null, "Get the AI review"), body);
}

export function render(ctx) {
  const grade = ctx.round.last?.grade;
  const running = ctx.job?.kind === "grade" || ctx.job?.kind === "judge-reply";
  return h("div", { class: "stack sections" },
    h("div", { class: "panel-head" },
      h("div", null,
        h("h2", null, "Grade your work"),
        h("p", null, "See how you did against the rubric. You can grade as often as you like.")),
      button(grade ? "Grade again" : "Grade my work", {
        icon: "gauge",
        kind: "primary",
        "data-fk": "grade",
        blocked: ctx.blocked,
        onClick: () => ctx.runJob(() => api.grade(ctx.round.id, "none")),
      })),
    explainer(!grade),
    ctx.failure("grade") && notice("fail", ["Grading failed. ", ctx.failure("grade"), " Fix that, then grade again."]),
    running && ctx.jobLog(),
    running && grade && h("p", { class: "meta" }, "Showing your last grade until this one finishes."),
    grade ? [
      scoreSection(grade),
      grade.review && reviewSection(grade.review),
      routes(ctx, grade),
      h("section", { class: "stack" },
        h("h3", null, "Hidden tests by stage"),
        h("ul", { class: "stage-results" }, grade.stages.map(stageRow))),
      h("section", { class: "stack" },
        h("h3", null, "Rubric"),
        h("ul", { class: "criteria" }, grade.criteria.map((criterion) => criterionRow(criterion, ctx.round.stage)))),
    ] : [
      !running && emptyBlock("Not graded yet", "Grade your work when you want a score. Stages you haven't reached will count as they are now."),
      routes(ctx, null),
    ]);
}

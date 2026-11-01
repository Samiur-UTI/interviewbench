// The Grade panel's numbers: the score, each stage's hidden tests, and the rubric.

import { CopyablePath } from "../../../components/button.js";
import { Badge, Notice } from "../../../components/feedback.js";
import { Icon } from "../../../components/icon.js";
import { formatDate, formatPercent, formatPoints, metaLine, parseTime, plural, testsPassed } from "../../../core/format.js";
import { html, useLayoutEffect, useRef } from "../../../preact.js";
import { TestDetails } from "./test-results.js";

// The CSP forbids style attributes, so the width goes through the CSSOM.
function Bar({ score }) {
  const fill = useRef(null);
  useLayoutEffect(() => {
    fill.current.style.setProperty("--fill", formatPercent(score));
  }, [score]);
  const tone = score >= 1 ? "ok" : score > 0 ? "warn" : "fail";
  return html`<span class=${`bar ${tone}`} aria-hidden="true"><span ref=${fill} class="bar-fill"></span></span>`;
}

export function ScoreSection({ grade }) {
  const finished = parseTime(grade.finished_at);
  const pending = grade.pending_weight > 0;
  const used = grade.time_used_minutes;
  const meta = metaLine(
    used !== null && used !== undefined && `${used} min used`,
    grade.runner && `${grade.runner} runner`,
    finished && `graded ${formatDate(finished)}`,
  );
  return html`
    <section class="stack" aria-label="Score">
      <div class="score">
        <span class="score-value">${Math.round(grade.percent)}%</span>
        <div>
          <p class="score-line">
            ${pending
              ? `${formatPoints(grade.points)} of the ${formatPoints(grade.graded_weight)} points graded so far`
              : `${formatPoints(grade.points)} of ${formatPoints(grade.total_weight)} points`}
          </p>
          ${pending && html`<p class="muted">${formatPoints(grade.pending_weight)} more points wait for the AI review.</p>`}
        </div>
      </div>
      <p class="meta">${meta}</p>
      ${grade.report_path && html`<p class="meta report">Report <${CopyablePath} path=${grade.report_path} /></p>`}
      ${grade.judge_error && html`
        <${Notice} kind="warn">
          <strong>The AI review didn't finish. </strong>${grade.judge_error} The hidden-test scores here still count. Check Settings, or use a chatbot instead.
        <//>`}
    </section>`;
}

export function StageRow({ stage }) {
  const clean = testsPassed(stage);
  const failures = Array.isArray(stage.failures) ? stage.failures : [];
  return html`
    <li class="stage-result">
      <div class="stage-result-head">
        <span class=${stage.revealed ? (clean ? "tone-ok" : "tone-fail") : "muted"}>
          <${Icon} name=${!stage.revealed ? "lock" : clean ? "check" : "cross"} />
        </span>
        <span class="stage-result-name">Stage ${stage.stage}${stage.title && `: ${stage.title}`}${!stage.revealed && html`<span class="muted"> (not revealed)</span>`}</span>
        <span class="mono">${stage.passed} of ${stage.total}</span>
      </div>
      ${stage.withheld_failures > 0 && html`
        <p class="muted">${plural(stage.withheld_failures, "hidden test")} failed here. You'll see what they were once you reveal this stage.</p>`}
      ${stage.error && html`<pre class="output">${stage.error}</pre>`}
      ${failures.length > 0 && html`
        <details>
          <summary>Show ${plural(failures.length, "failure")}</summary>
          <${TestDetails} result=${{ failures }} />
        </details>`}
    </li>`;
}

export function CriterionRow({ criterion, revealed }) {
  const scored = criterion.score !== null && criterion.score !== undefined;
  const ahead = criterion.stage > revealed;  // its description would give the stage away
  return html`
    <li class="criterion">
      <div class="criterion-head">
        <code class="criterion-id">${criterion.id}</code>
        <${Badge}>${criterion.type === "auto" ? "Hidden tests" : "AI review"}<//>
        <span class="criterion-score mono">
          ${scored
            ? `${formatPercent(criterion.score)} of ${formatPoints(criterion.weight)} pts`
            : `${formatPoints(criterion.weight)} pts waiting`}
        </span>
      </div>
      ${scored ? html`<${Bar} score=${criterion.score} />` : html`<span class="bar waiting" aria-hidden="true"></span>`}
      <p>${ahead ? `Hidden tests for stage ${criterion.stage}, which you haven't revealed yet.` : criterion.description}</p>
      ${criterion.evidence && html`<p class="muted">${criterion.evidence}</p>`}
    </li>`;
}

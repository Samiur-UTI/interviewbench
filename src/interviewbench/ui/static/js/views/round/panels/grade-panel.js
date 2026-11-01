// Grade panel: the score, what's behind it, and the two ways to get the AI review.

import { Button } from "../../../components/button.js";
import { Empty, Notice } from "../../../components/feedback.js";
import { api } from "../../../core/api.js";
import { html } from "../../../preact.js";
import { JobLog } from "../job-log.js";
import { useRoundContext } from "../round-context.js";
import { ReviewSection } from "./grade-review.js";
import { CriterionRow, ScoreSection, StageRow } from "./grade-score.js";
import { Routes } from "./judge-routes.js";

function Explainer({ open }) {
  return html`
    <details class="explainer" open=${open}>
      <summary>How grading works</summary>
      <div class="explainer-body">
        <p>Grading runs the hidden tests for every stage, even stages you haven't revealed yet. That fills in the auto-scored part of the rubric. It can take a few minutes, and it doesn't change your code.</p>
        <p>If a stage you haven't reached has failures, you only see how many. The details stay hidden, so nothing is spoiled.</p>
        <p>The rest of the rubric is about how you did the work, so it needs an AI reviewer. You can get that review two ways, further down this panel.</p>
      </div>
    </details>`;
}

function Graded({ grade, revealed }) {
  return html`
    <${ScoreSection} grade=${grade} />
    ${grade.review && html`<${ReviewSection} review=${grade.review} />`}
    <${Routes} grade=${grade} />
    <section class="stack">
      <h3>Hidden tests by stage</h3>
      <ul class="stage-results">
        ${grade.stages.map((stage) => html`<${StageRow} key=${stage.stage} stage=${stage} />`)}
      </ul>
    </section>
    <section class="stack">
      <h3>Rubric</h3>
      <ul class="criteria">
        ${grade.criteria.map((criterion) => html`<${CriterionRow} key=${criterion.id} criterion=${criterion} revealed=${revealed} />`)}
      </ul>
    </section>`;
}

export function GradePanel() {
  const { round, job, blocked, runJob, failure } = useRoundContext();
  const grade = round.last?.grade;
  const running = job?.kind === "grade" || job?.kind === "judge-reply";
  const failed = failure("grade");
  return html`
    <div class="stack sections">
      <div class="panel-head">
        <div>
          <h2>Grade your work</h2>
          <p>See how you did against the rubric. You can grade as often as you like.</p>
        </div>
        <${Button} icon="gauge" kind="primary" blocked=${blocked} onClick=${() => runJob(() => api.grade(round.id, "none"))}>
          ${grade ? "Grade again" : "Grade my work"}
        <//>
      </div>
      <${Explainer} open=${!grade} />
      ${failed && html`<${Notice} kind="fail">Grading failed. ${failed} Fix that, then grade again.<//>`}
      ${running && html`<${JobLog} />`}
      ${running && grade && html`<p class="meta">Showing your last grade until this one finishes.</p>`}
      ${grade
        ? html`<${Graded} grade=${grade} revealed=${round.stage} />`
        : html`
          ${!running && html`<${Empty} title="Not graded yet" text="Grade your work when you want a score. Stages you haven't reached will count as they are now." />`}
          <${Routes} grade=${null} />`}
    </div>`;
}

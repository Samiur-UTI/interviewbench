// Tests panel: the candidate's own tests. Hidden tests never run here.

import { Button } from "../../../components/button.js";
import { Empty, Notice } from "../../../components/feedback.js";
import { api } from "../../../core/api.js";
import { formatDate, parseTime } from "../../../core/format.js";
import { html } from "../../../preact.js";
import { JobLog } from "../job-log.js";
import { useRoundContext } from "../round-context.js";
import { TestDetails, TestSummary } from "./test-results.js";

function LastRun({ last, running }) {
  const finished = parseTime(last.finished_at);
  const meta = [last.runner && `${last.runner} runner`, finished && `finished ${formatDate(finished)}`];
  return html`
    <div class="stack">
      ${running && html`<p class="meta">Showing your last run until this one finishes.</p>`}
      <${TestSummary} result=${last} />
      <p class="meta">${meta.filter(Boolean).join(" · ")}</p>
      ${!last.error && last.total === 0 && html`
        <${Notice} kind="warn">No tests ran. Add tests to your project, then run them again.<//>`}
      <${TestDetails} result=${last} />
    </div>`;
}

export function TestsPanel() {
  const { round, job, blocked, runJob, failure } = useRoundContext();
  const last = round.last?.test;
  const running = job?.kind === "test";
  const failed = failure("test");
  return html`
    <div class="stack">
      <div class="panel-head">
        <div>
          <h2>Your tests</h2>
          <p>Runs the tests in your project, the way the grader runs them. The hidden tests stay hidden, so this can't spoil a stage.</p>
        </div>
        <${Button} icon="play" kind="primary" blocked=${blocked} onClick=${() => runJob(() => api.runTests(round.id))}>
          ${last ? "Run tests again" : "Run my tests"}
        <//>
      </div>
      ${failed && html`<${Notice} kind="fail">The test run failed. ${failed} Fix that, then run them again.<//>`}
      ${running && html`<${JobLog} />`}
      ${last
        ? html`<${LastRun} last=${last} running=${running} />`
        : !running && html`<${Empty} title="No test run yet" text="Run your tests whenever you like. Results show up here." />`}
    </div>`;
}

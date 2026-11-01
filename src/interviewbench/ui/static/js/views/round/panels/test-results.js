// How a run of the candidate's tests reads. Used by the Tests panel, and by Grade for what the AI review ran.

import { Notice } from "../../../components/feedback.js";
import { Icon } from "../../../components/icon.js";
import { testsPassed } from "../../../core/format.js";
import { html } from "../../../preact.js";

function FailureList({ failures }) {
  return html`
    <ul class="failures">
      ${failures.map((failure) => html`
        <li>
          <p class="failure-name"><${Icon} name="cross" /><code>${failure.name}</code></p>
          ${failure.message && html`<pre class="output">${failure.message}</pre>`}
        </li>`)}
    </ul>`;
}

export function TestSummary({ result }) {
  const clean = testsPassed(result);
  return html`
    <p class=${`result-line ${clean ? "ok" : "fail"}`}>
      <${Icon} name=${clean ? "check" : "cross"} />
      <span class="result-count">${result.passed} of ${result.total}</span> of your tests passed
    </p>`;
}

export function TestDetails({ result }) {
  return html`
    ${result.error && html`
      <div class="stack">
        <${Notice} kind="fail">Your tests could not run. This is what they printed:<//>
        <pre class="output">${result.error}</pre>
      </div>`}
    ${result.failures?.length > 0 && html`<${FailureList} failures=${result.failures} />`}`;
}

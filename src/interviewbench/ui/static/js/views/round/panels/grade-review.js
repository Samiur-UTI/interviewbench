// What the AI reviewer said.

import { Badge } from "../../../components/feedback.js";
import { MarkdownView } from "../../../components/markdown-view.js";
import { html } from "../../../preact.js";
import { TestDetails, TestSummary } from "./test-results.js";

const SEVERITIES = [["high", "fail", "High"], ["medium", "warn", "Medium"], ["low", "", "Low"]];

function IssueRow({ issue, kind, label }) {
  return html`
    <li class="issue">
      <div class="issue-head">
        <${Badge} kind=${kind} icon=${kind === "fail" || kind === "warn" ? "alert" : null}>${label}<//>
        ${issue.category && html`<span class="muted">${issue.category}</span>`}
        ${issue.location && html`<code class="issue-location">${issue.location}</code>`}
      </div>
      <p>${issue.description}</p>
    </li>`;
}

function IssueGroups({ issues }) {
  return SEVERITIES.map(([severity, kind, label]) => {
    const group = issues.filter((issue) => issue.severity === severity);
    return group.length > 0 && html`
      <ul class="issues">
        ${group.map((issue) => html`<${IssueRow} issue=${issue} kind=${kind} label=${label} />`)}
      </ul>`;
  });
}

export function ReviewSection({ review }) {
  const issues = review.issues ?? [];
  const missed = review.missed_edge_cases ?? [];
  return html`
    <section class="stack">
      <h3>AI review</h3>
      <p class="meta">${review.model}</p>
      <${MarkdownView} class="md md-small" source=${review.summary} headingOffset=${3} />
      ${review.candidate_tests && html`
        <div class="stack">
          <h4>Your tests, as the reviewer saw them</h4>
          <${TestSummary} result=${review.candidate_tests} />
          <${TestDetails} result=${review.candidate_tests} />
        </div>`}
      <h4>Issues</h4>
      ${issues.length === 0 && html`<p class="muted">The reviewer found no issues.</p>`}
      <${IssueGroups} issues=${issues} />
      ${missed.length > 0 && html`
        <h4>Edge cases you missed</h4>
        <ul class="plain-list">${missed.map((item) => html`<li>${item}</li>`)}</ul>`}
    </section>`;
}

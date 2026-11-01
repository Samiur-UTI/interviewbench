// The strip above the panels: what's running, or how the last job ended, wherever the candidate is.

import { Elapsed } from "../../components/elapsed.js";
import { Icon } from "../../components/icon.js";
import { formatTimeOfDay, parseTime } from "../../core/format.js";
import { roundHref } from "../../core/routes.js";
import { html } from "../../preact.js";
import { JOBS, jobName } from "./round-state.js";

function ViewLink({ id, kind, panel }) {
  const target = JOBS[kind]?.panel;
  if (!target || target === panel) return null;
  return html`<a href=${roundHref(id, target)}>View</a>`;
}

export function JobStrip({ id, panel, job, recent }) {
  if (job) {
    return html`
      <div class="job-strip" data-state="running">
        <span class="spinner" aria-hidden="true"></span>
        <span class="job-phase" title=${job.phase}>${job.phase}</span>
        <${Elapsed} since=${job.started_at} />
        <${ViewLink} id=${id} kind=${job.kind} panel=${panel} />
      </div>`;
  }
  if (recent) {
    const failed = recent.state !== "succeeded";
    return html`
      <div class="job-strip" data-state=${failed ? "failed" : "done"}>
        <${Icon} name=${failed ? "cross" : "check"} />
        <span class="job-phase">${jobName(recent.kind)} ${failed ? "failed" : "finished"}</span>
        <span class="job-time">${recent.finished_at ? formatTimeOfDay(parseTime(recent.finished_at)) : ""}</span>
        <${ViewLink} id=${id} kind=${recent.kind} panel=${panel} />
      </div>`;
  }
  return html`<div class="job-strip" data-state="idle"><span class="job-phase">Nothing running</span></div>`;
}

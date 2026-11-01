// `Validate` as a job. Its id is remembered, so a reload picks the running check back up.

import { Button } from "../../components/button.js";
import { Elapsed } from "../../components/elapsed.js";
import { Badge, Notice } from "../../components/feedback.js";
import { announce } from "../../core/announce.js";
import { api, followJob } from "../../core/api.js";
import { plural } from "../../core/format.js";
import { recall, remember } from "../../core/storage.js";
import { useAction } from "../../hooks/use-action.js";
import { useAbortSignal } from "../../hooks/use-dom.js";
import { html, useEffect, useState } from "../../preact.js";

function Row({ task }) {
  return html`
    <li class="validate-row">
      <p>
        <${Badge} kind=${task.ok ? "ok" : "fail"} icon=${task.ok ? "check" : "cross"}>${task.ok ? "Passed" : "Failed"}<//>
        ${" "}<code>${task.category}/${task.id}</code>
      </p>
      ${task.errors.length > 0 && html`
        <ul class="plain-list">${task.errors.map((error) => html`<li>${error}</li>`)}</ul>`}
    </li>`;
}

const countFailed = (tasks) => tasks.filter((task) => !task.ok).length;

// `finished` is the ended job, or null if the server no longer knows it.
function Results({ finished }) {
  if (!finished) {
    return html`<${Notice} kind="warn">That check was lost, perhaps because the server restarted. Run it again.<//>`;
  }
  if (finished.state === "failed") {
    return html`<${Notice} kind="fail">Validation failed. ${finished.error ?? ""}<//>`;
  }
  const checked = finished.result?.tasks ?? [];
  const failed = countFailed(checked);
  return html`
    <${Notice} kind=${failed ? "fail" : "ok"}>
      ${failed ? `${plural(failed, "task")} of ${checked.length} failed.` : `All ${plural(checked.length, "task")} passed.`}
    <//>
    <ul class="rows">${checked.map((task) => html`<${Row} key=${task.id} task=${task} />`)}</ul>`;
}

function announceResult(finished) {
  if (finished?.state !== "succeeded") return;
  const failed = countFailed(finished.result?.tasks ?? []);
  announce(failed ? `${plural(failed, "task")} failed.` : "All tasks passed.");
}

export function ValidateTasks({ tasks }) {
  const [chosen, setChosen] = useState(() => new Set());
  const [runTests, setRunTests] = useState(false);
  const [job, setJob] = useState(null);
  const [outcome, setOutcome] = useState(null);  // { finished }, once a check has ended
  const [starting, startError, act] = useAction();
  const signal = useAbortSignal();

  async function follow(id) {
    remember("validate-job", id);
    setJob({ id, phase: "Picking up the running check…", started_at: null });
    let finished = null;
    try {
      finished = await followJob(id, setJob, signal);
    } catch (err) {
      if (err.status === 401) return;  // the app has moved to its sign-in screen
      throw err;
    }
    if (signal.aborted) return;
    setJob(null);
    remember("validate-job", null);
    setOutcome({ finished });
    announceResult(finished);
  }

  useEffect(() => {
    const running = recall("validate-job", null);
    if (running) follow(running);
  }, []);

  const toggle = (id, on) => {
    const next = new Set(chosen);
    if (on) next.add(id);
    else next.delete(id);
    setChosen(next);
  };

  const check = () => act(async () => {
    setOutcome(null);
    const body = { run: runTests };
    if (chosen.size) body.task_ids = [...chosen];
    follow((await api.validate(body)).id);
  });

  return html`
    <div class="stack">
      <fieldset class="stack">
        <legend class="field-label">Check these tasks</legend>
        <p class="field-help">Leave them all unticked to check every task.</p>
        <div class="presets">
          ${tasks.map((task) => html`
            <label key=${task.id} class="check">
              <input
                type="checkbox"
                checked=${chosen.has(task.id)}
                onChange=${(event) => toggle(task.id, event.target.checked)}
              />
              <code>${task.id}</code>
            </label>`)}
        </div>
      </fieldset>
      <label class="check">
        <input type="checkbox" checked=${runTests} onChange=${(event) => setRunTests(event.target.checked)} />
        Also run the tests
      </label>
      <p class="field-help">The starter must fail stage 1, and each stage's solution must pass it. This can take a few minutes per task.</p>
      <div class="route-actions">
        <${Button} icon="check" kind="primary" blocked=${job || starting ? "Wait for this check to finish" : null} onClick=${check}>Validate<//>
      </div>
      <div role="status">
        ${job && html`
          <span class="job-line">
            <span class="spinner" aria-hidden="true"></span>
            <span>${job.phase}</span>
            <${Elapsed} since=${job.started_at} />
          </span>`}
      </div>
      <div class="stack">
        ${startError && html`<${Notice} kind="fail">Couldn't start the check. ${startError}<//>`}
        ${outcome && html`<${Results} finished=${outcome.finished} />`}
      </div>
    </div>`;
}

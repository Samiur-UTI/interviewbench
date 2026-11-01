// Rounds: every round in the workspaces folder, to resume or delete.

import { useApp } from "../../app/app-context.js";
import { Button, CopyablePath } from "../../components/button.js";
import { Async, Badge, Empty } from "../../components/feedback.js";
import { Icon } from "../../components/icon.js";
import { announce } from "../../core/announce.js";
import { activeJobId, api, followJob } from "../../core/api.js";
import { describeTimeLeft, formatDate, parseTime } from "../../core/format.js";
import { roundHref } from "../../core/routes.js";
import { useAsync } from "../../hooks/use-async.js";
import { useNow } from "../../hooks/use-now.js";
import { html, useEffect, useState } from "../../preact.js";
import { DeleteDialog } from "./delete-dialog.js";

const TICK_MS = 30000;

function timeLeft(round, time) {
  const ends = parseTime(round.ends_at);
  return ends === null ? "No limit" : describeTimeLeft(ends, time);
}

function RoundRow({ round, time, onDelete }) {
  const href = roundHref(round.id);
  const started = parseTime(round.started_at);
  const running = activeJobId(round) !== null;
  const graded = round.score_percent !== null && round.score_percent !== undefined;
  return html`
    <tr>
      <th scope="row">
        <a class="round-title" href=${href}>${round.title}</a>
        <span class="meta">${round.id}${started !== null && ` · started ${formatDate(started)}`}</span>
      </th>
      <td data-label="Stage">
        <span class="mono">${round.stage} of ${round.stage_count}</span>
        ${running && " "}${running && html`<${Badge} kind="accent">Job running<//>`}
      </td>
      <td data-label="Time" class="mono" data-time=${round.id}>${timeLeft(round, time)}</td>
      <td data-label="Score" class="mono">
        ${graded ? `${Math.round(round.score_percent)}%` : html`<span class="muted">Not graded</span>`}
      </td>
      <td class="round-actions">
        <a class="button" href=${href} aria-label=${`Resume ${round.id}`}><${Icon} name="arrow-right" />Resume</a>
        <${Button}
          kind="ghost"
          icon="trash"
          aria-label=${`Delete ${round.id}`}
          blocked=${running ? "Wait for the running job to finish" : null}
          onClick=${() => onDelete(round)}
        >Delete<//>
      </td>
    </tr>`;
}

function RoundTable({ rounds, reload }) {
  const { status } = useApp();
  const time = useNow(TICK_MS);
  const [deleting, setDeleting] = useState(null);

  // A running job blocks Delete: refresh when it ends so the row doesn't stay stale.
  const active = rounds.map(activeJobId).find((id) => id !== null);
  useEffect(() => {
    if (!active) return undefined;
    const controller = new AbortController();
    const { signal } = controller;
    followJob(active, () => {}, signal).then(() => signal.aborted || reload()).catch(() => {});
    return () => controller.abort();
  }, [active, reload]);

  const deleted = () => {
    announce(`Deleted ${deleting.id}.`);
    setDeleting(null);
    reload();
  };

  return html`
    ${rounds.length > 0
      ? html`
        <table class="round-table">
          <thead>
            <tr>
              <th scope="col">Round</th>
              <th scope="col">Stage</th>
              <th scope="col">Time</th>
              <th scope="col">Score</th>
              <th scope="col"><span class="visually-hidden">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            ${rounds.map((round) => html`<${RoundRow} key=${round.id} round=${round} time=${time} onDelete=${setDeleting} />`)}
          </tbody>
        </table>
        <p class="meta rounds-folder">Stored in <${CopyablePath} path=${status?.workspaces_dir ?? ""} /></p>`
      : html`
        <${Empty} title="No rounds yet" text="Your rounds appear here once you start a task.">
          <a class="button primary" href="#/tasks">Pick a task</a>
        <//>`}
    ${deleting && html`<${DeleteDialog} round=${deleting} onClose=${() => setDeleting(null)} onDeleted=${deleted} />`}`;
}

export function RoundsView() {
  const query = useAsync(async () => (await api.rounds()).rounds);
  return html`
    <div class="page">
      <header class="page-head">
        <h1>Rounds</h1>
        <p>Every round on this computer, including ones started from a terminal.</p>
      </header>
      <${Async}
        query=${query}
        loading="Loading rounds…"
        failed="Couldn't load your rounds"
        render=${(rounds) => html`<${RoundTable} rounds=${rounds} reload=${query.reload} />`}
      />
    </div>`;
}

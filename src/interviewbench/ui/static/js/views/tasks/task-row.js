// One task in the catalogue: what it is, what's scored, and starting or resuming a round.

import { Button } from "../../components/button.js";
import { Notice } from "../../components/feedback.js";
import { api } from "../../core/api.js";
import { formatPoints, metaLine, plural } from "../../core/format.js";
import { roundHref } from "../../core/routes.js";
import { useAction } from "../../hooks/use-action.js";
import { useApp } from "../../hooks/use-app.js";
import { html } from "../../preact.js";

// Auto criteria describe what each stage's hidden tests check, which would give away later stages,
// so they appear only as a total. Judged criteria are about how the work is done.
function RubricPeek({ task }) {
  const auto = task.rubric.filter((c) => c.type === "auto");
  const judged = task.rubric.filter((c) => c.type !== "auto");
  const points = (list) => formatPoints(list.reduce((sum, c) => sum + c.weight, 0));
  return html`
    <details class="peek">
      <summary>What's scored</summary>
      <div class="peek-body">
        <p>${points(auto)} points come from hidden tests, one set per stage. They stay out of sight here so later stages stay a surprise.</p>
        ${judged.length > 0 && html`
          <p>${points(judged)} points need an AI reviewer:</p>
          <ul class="peek-list">
            ${judged.map((c) => html`
              <li key=${c.id}>
                <span class="peek-weight mono">${formatPoints(c.weight)}</span>
                <span>${c.description}</span>
              </li>`)}
          </ul>`}
      </div>
    </details>`;
}

export function TaskRow({ task, openRound, options }) {
  const { status } = useApp();
  const [busy, error, act] = useAction();

  const start = () => act(async () => {
    const round = await api.startRound({
      task_id: task.id,
      git: options.git,
      open_editor: options.editor && Boolean(status?.editor),
    });
    location.hash = roundHref(round.id);
  });

  const meta = metaLine(
    task.category, task.level, task.difficulty, task.language, `${task.time_limit_minutes} min`,
    plural(task.stage_count, "stage"),
  );

  return html`
    <li class="task">
      <div class="task-main">
        <h2>${task.title}</h2>
        <p class="meta">${meta}</p>
        ${task.tags.length > 0 && html`
          <ul class="tags">${task.tags.map((tag) => html`<li key=${tag} class="badge">${tag}</li>`)}</ul>`}
        <${RubricPeek} task=${task} />
        <div class="task-error">
          ${error && html`<${Notice} kind="fail">Couldn't start this round. ${error}<//>`}
        </div>
      </div>
      <div class="task-actions">
        <${Button}
          icon="play"
          kind="primary"
          aria-label=${`Start round: ${task.title}`}
          busy=${busy && "Starting…"}
          onClick=${start}
        >Start round<//>
        ${openRound && html`<a href=${roundHref(openRound.id)}>Resume ${openRound.id}</a>`}
      </div>
    </li>`;
}

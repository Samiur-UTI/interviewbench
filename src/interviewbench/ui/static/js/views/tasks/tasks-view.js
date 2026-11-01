// Tasks: filter the catalogue, peek at the rubric, start a round.

import { HowToNote } from "../../app/howto.js";
import { Button } from "../../components/button.js";
import { Async, Empty } from "../../components/feedback.js";
import { api } from "../../core/api.js";
import { plural } from "../../core/format.js";
import { useAsync } from "../../hooks/use-async.js";
import { html, useState } from "../../preact.js";
import { StartOptions, useStartOptions } from "./start-options.js";
import { TaskRow } from "./task-row.js";

const NO_FILTERS = { category: "", level: "", tag: "" };

// Outlives the view, so the filters are still set after a look at another screen.
let savedFilters = NO_FILTERS;

function unique(values) {
  return [...new Set(values)].filter(Boolean).sort();
}

function matches(task, filters) {
  return (!filters.category || task.category === filters.category)
    && (!filters.level || task.level === filters.level)
    && (!filters.tag || task.tags.includes(filters.tag));
}

function FilterSelect({ label, value, options, onChange }) {
  return html`
    <label class="field">
      <span class="field-label">${label}</span>
      <select value=${value} onChange=${(event) => onChange(event.target.value)}>
        <option value="">All</option>
        ${options.map((option) => html`<option key=${option} value=${option}>${option}</option>`)}
      </select>
    </label>`;
}

function Catalogue({ tasks, rounds }) {
  const [filters, setFilters] = useState(savedFilters);
  const [options, updateOptions] = useStartOptions();
  const apply = (next) => {
    savedFilters = next;
    setFilters(next);
  };
  const shown = tasks.filter((task) => matches(task, filters));

  return html`
    <${HowToNote} />
    <div class="filters">
      <${FilterSelect}
        label="Category"
        value=${filters.category}
        options=${unique(tasks.map((t) => t.category))}
        onChange=${(category) => apply({ ...filters, category })}
      />
      <${FilterSelect}
        label="Level"
        value=${filters.level}
        options=${unique(tasks.map((t) => t.level))}
        onChange=${(level) => apply({ ...filters, level })}
      />
      <${FilterSelect}
        label="Tag"
        value=${filters.tag}
        options=${unique(tasks.flatMap((t) => t.tags))}
        onChange=${(tag) => apply({ ...filters, tag })}
      />
      <p class="meta filter-count" role="status">${plural(shown.length, "task")}</p>
    </div>
    <${StartOptions} options=${options} onChange=${updateOptions} />
    <div>
      ${shown.length > 0
        ? html`
          <ul class="rows">
            ${shown.map((task) => html`
              <${TaskRow}
                key=${task.id}
                task=${task}
                openRound=${rounds.find((r) => r.task_id === task.id)}
                options=${options}
              />`)}
          </ul>`
        : html`
          <${Empty} title="No tasks match these filters" text="Try a different combination, or show every task.">
            <${Button} onClick=${() => apply(NO_FILTERS)}>Show all tasks<//>
          <//>`}
    </div>`;
}

async function loadCatalogue() {
  const [{ tasks }, { rounds }] = await Promise.all([api.tasks(), api.rounds()]);
  return { tasks, rounds };
}

export function TasksView() {
  const query = useAsync(loadCatalogue);
  const body = ({ tasks, rounds }) => (tasks.length
    ? html`<${Catalogue} tasks=${tasks} rounds=${rounds} />`
    : html`<${Empty} title="No tasks found" text="This install has no tasks. Add one from the Author screen." />`);
  return html`
    <div class="page">
      <header class="page-head">
        <h1>Tasks</h1>
        <p>Pick a task to start a round. The clock starts as soon as you do.</p>
      </header>
      <${Async} query=${query} loading="Loading tasks…" failed="Couldn't load the tasks" render=${body} />
    </div>`;
}

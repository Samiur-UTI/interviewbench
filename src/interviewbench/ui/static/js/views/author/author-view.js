// Author: for people writing tasks. Create a task from a template and check tasks are valid.

import { Async } from "../../components/feedback.js";
import { Icon } from "../../components/icon.js";
import { api } from "../../core/api.js";
import { useAsync } from "../../hooks/use-async.js";
import { html } from "../../preact.js";
import { NewTaskForm } from "./new-task-form.js";
import { ValidateTasks } from "./validate-tasks.js";

function Sections({ tasks, categories, templates }) {
  return html`
    <section class="stack author-section">
      <h2><${Icon} name="plus" /> New task</h2>
      <p class="muted">Creates a task skeleton from a template. Fill in every TODO, then validate it below.</p>
      <${NewTaskForm} categories=${categories} templates=${templates} />
    </section>
    <section class="stack author-section">
      <h2><${Icon} name="check" /> Validate tasks</h2>
      <p class="muted">Checks each task follows the task format.</p>
      <${ValidateTasks} tasks=${tasks} />
    </section>`;
}

export function AuthorView() {
  const query = useAsync(() => api.tasks());
  return html`
    <div class="page narrow">
      <header class="page-head">
        <h1>Author</h1>
        <p>For people writing tasks. Task files live in a clone of the interviewbench repository.</p>
      </header>
      <${Async}
        query=${query}
        loading="Loading tasks…"
        failed="Couldn't load the tasks"
        render=${(data) => html`<${Sections} ...${data} />`}
      />
    </div>`;
}

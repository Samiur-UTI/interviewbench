// Creates a task skeleton from a template.

import { Button, CopyablePath } from "../../components/button.js";
import { Notice } from "../../components/feedback.js";
import { announce } from "../../core/announce.js";
import { api } from "../../core/api.js";
import { useAction } from "../../hooks/use-action.js";
import { html, useState } from "../../preact.js";

function Options({ names }) {
  return names.map((name) => html`<option key=${name} value=${name}>${name}</option>`);
}

export function NewTaskForm({ categories, templates }) {
  const [taskId, setTaskId] = useState("");
  const [category, setCategory] = useState(categories[0] ?? "");
  const [template, setTemplate] = useState("");
  const [created, setCreated] = useState(null);
  const [busy, error, act] = useAction();

  const submit = (event) => {
    event.preventDefault();
    act(async () => {
      setCreated(null);
      const body = { task_id: taskId.trim(), category };
      if (template) body.template = template;
      setCreated(await api.newTask(body));
      announce("Task created.");
    });
  };

  return html`
    <form class="stack" onSubmit=${submit}>
      <div class="form-row">
        <div class="field">
          <label class="field-label" for="new-task-id">Task id</label>
          <input
            id="new-task-id"
            type="text"
            class="mono"
            autocomplete="off"
            spellcheck=${false}
            required=${true}
            value=${taskId}
            onInput=${(event) => setTaskId(event.target.value)}
          />
          <span class="field-help">Also its folder name, such as order-api.</span>
        </div>
        <label class="field">
          <span class="field-label">Category</span>
          <select value=${category} onChange=${(event) => setCategory(event.target.value)}>
            <${Options} names=${categories} />
          </select>
        </label>
        <label class="field">
          <span class="field-label">Template</span>
          <select value=${template} onChange=${(event) => setTemplate(event.target.value)}>
            <option value="">Match the category</option>
            <${Options} names=${templates} />
          </select>
        </label>
      </div>
      <div class="route-actions">
        <${Button} kind="primary" icon="plus" type="submit" busy=${busy && "Creating…"}>Create task<//>
      </div>
      <div>
        ${created && html`
          <${Notice} kind="ok">
            <p>${created.message}</p>
            <${CopyablePath} path=${created.path} />
          <//>`}
        ${error && html`<${Notice} kind="fail">Couldn't create the task. ${error}<//>`}
      </div>
    </form>`;
}

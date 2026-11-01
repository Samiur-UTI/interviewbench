// Author: for people writing tasks. Create a task from a template and check tasks are valid.

import { api, followJob } from "../api.js";
import { formatElapsed, parseTime, plural } from "../format.js";
import { icon } from "../icons.js";
import { now, recall, remember } from "../state.js";
import {
  announce, badge, button, copyablePath, errorBlock, h, loadingBlock, notice, setBlocked, withBusy,
} from "../ui.js";

function newTaskForm(categories, templates) {
  const result = h("div");
  const taskId = h("input", { type: "text", class: "mono", autocomplete: "off", spellcheck: "false", required: true, id: "new-task-id" });
  const category = h("select", null, categories.map((name) => h("option", { value: name }, name)));
  const template = h("select", null,
    h("option", { value: "" }, "Match the category"),
    templates.map((name) => h("option", { value: name }, name)));
  const create = button("Create task", { kind: "primary", icon: "plus", type: "submit" });
  return h("form", {
    class: "stack",
    onsubmit: (event) => {
      event.preventDefault();
      if (create.getAttribute("aria-disabled") === "true") return;
      withBusy(create, "Creating…", async () => {
        result.replaceChildren();
        try {
          const body = { task_id: taskId.value.trim(), category: category.value };
          if (template.value) body.template = template.value;
          const created = await api.newTask(body);
          result.replaceChildren(notice("ok", [h("p", null, created.message), copyablePath(created.path)]));
          announce("Task created.");
        } catch (err) {
          result.replaceChildren(notice("fail", `Couldn't create the task. ${err.message}`));
        }
      });
    },
  },
  h("div", { class: "form-row" },
    h("div", { class: "field" }, h("label", { class: "field-label", for: "new-task-id" }, "Task id"), taskId,
      h("span", { class: "field-help" }, "Also its folder name, such as order-api.")),
    h("label", { class: "field" }, h("span", { class: "field-label" }, "Category"), category),
    h("label", { class: "field" }, h("span", { class: "field-label" }, "Template"), template)),
  h("div", { class: "route-actions" }, create),
  result);
}

function validation(tasks, signal) {
  const results = h("div", { class: "stack" });
  const progress = h("div", { role: "status" });
  const run = h("input", { type: "checkbox" });
  const chosen = new Set();
  let job = null;

  const showProgress = () => {
    progress.replaceChildren(job
      ? h("span", { class: "job-line" }, h("span", { class: "spinner", "aria-hidden": "true" }), h("span", null, job.phase),
          h("span", { class: "job-time", "data-elapsed": "" }, job.started_at ? formatElapsed(now() - parseTime(job.started_at)) : ""))
      : "");
    setBlocked(check, job ? "Wait for this check to finish" : null);
  };

  const showResults = (finished) => {
    if (finished?.state === "failed") {
      results.replaceChildren(notice("fail", `Validation failed. ${finished.error ?? ""}`));
      return;
    }
    const checked = finished?.result?.tasks ?? [];
    const failed = checked.filter((task) => !task.ok).length;
    results.replaceChildren(
      finished ? notice(failed ? "fail" : "ok", failed
        ? `${plural(failed, "task")} of ${checked.length} failed.`
        : `All ${plural(checked.length, "task")} passed.`) : notice("warn", "That check was lost, perhaps because the server restarted. Run it again."),
      h("ul", { class: "rows" }, checked.map((task) => h("li", { class: "validate-row" },
        h("p", null, badge(task.ok ? "ok" : "fail", task.ok ? "Passed" : "Failed", task.ok ? "check" : "cross"), " ",
          h("code", null, `${task.category}/${task.id}`)),
        task.errors.length > 0 && h("ul", { class: "plain-list" }, task.errors.map((error) => h("li", null, error)))))));
    announce(failed ? `${plural(failed, "task")} failed.` : "All tasks passed.");
  };

  async function follow(id) {
    remember("validate-job", id);
    job = { id, phase: "Picking up the running check…", started_at: null };
    showProgress();
    let finished = null;
    try {
      finished = await followJob(id, (update) => {
        job = update;
        showProgress();
      }, signal);
    } catch (err) {
      if (err.status === 401) return;  // the app has moved to its sign-in screen
      throw err;
    }
    if (signal.aborted) return;
    job = null;
    remember("validate-job", null);
    showProgress();
    showResults(finished);
  }

  const check = button("Validate", {
    icon: "check",
    kind: "primary",
    onClick: async () => {
      results.replaceChildren();
      try {
        const body = { run: run.checked };
        if (chosen.size) body.task_ids = [...chosen];
        follow((await api.validate(body)).id);
      } catch (err) {
        results.replaceChildren(notice("fail", `Couldn't start the check. ${err.message}`));
      }
    },
  });

  const element = h("div", { class: "stack" },
    h("fieldset", { class: "stack" },
      h("legend", { class: "field-label" }, "Check these tasks"),
      h("p", { class: "field-help" }, "Leave them all unticked to check every task."),
      h("div", { class: "presets" }, tasks.map((task) => h("label", { class: "check" },
        h("input", {
          type: "checkbox",
          onchange: (event) => {
            if (event.target.checked) chosen.add(task.id);
            else chosen.delete(task.id);
          },
        }),
        h("code", null, task.id))))),
    h("label", { class: "check" }, run, "Also run the tests"),
    h("p", { class: "field-help" }, "The starter must fail stage 1, and each stage's solution must pass it. This can take a few minutes per task."),
    h("div", { class: "route-actions" }, check),
    progress,
    results);

  const running = recall("validate-job", null);
  if (running) follow(running);
  return { element, tick: () => {
    const elapsed = progress.querySelector("[data-elapsed]");
    if (elapsed && job?.started_at) elapsed.textContent = formatElapsed(now() - parseTime(job.started_at));
  } };
}

export function show(main, _params, signal) {
  const root = h("div", { class: "page narrow" });
  const head = h("header", { class: "page-head" },
    h("h1", null, "Author"),
    h("p", null, "For people writing tasks. Task files live in a clone of the interviewbench repository."));
  main.append(root);
  let tick = () => {};
  const timer = setInterval(() => tick(), 1000);

  async function load() {
    root.replaceChildren(head, loadingBlock("Loading tasks…"));
    try {
      const { tasks, categories, templates } = await api.tasks();
      if (signal.aborted) return;
      const check = validation(tasks, signal);
      ({ tick } = check);
      root.replaceChildren(head,
        h("section", { class: "stack author-section" }, h("h2", null, icon("plus"), " New task"),
          h("p", { class: "muted" }, "Creates a task skeleton from a template. Fill in every TODO, then validate it below."),
          newTaskForm(categories, templates)),
        h("section", { class: "stack author-section" }, h("h2", null, icon("check"), " Validate tasks"),
          h("p", { class: "muted" }, "Checks each task follows the task format."),
          check.element));
    } catch (err) {
      if (!signal.aborted) root.replaceChildren(head, errorBlock(err, load, "Couldn't load the tasks"));
    }
  }

  load();
  return { leave: () => clearInterval(timer) };
}

// Tasks: filter the catalogue, peek at the rubric, start a round.

import { api } from "../api.js";
import { formatPoints, plural } from "../format.js";
import { app, recall, remember } from "../state.js";
import { button, emptyBlock, errorBlock, h, loadingBlock, notice, withBusy } from "../ui.js";
import { howToNote } from "./howto.js";

const filters = { category: "", level: "", tag: "" };

function unique(values) {
  return [...new Set(values)].filter(Boolean).sort();
}

function filterSelect(label, key, options, onChange) {
  return h("label", { class: "field" },
    h("span", { class: "field-label" }, label),
    h("select", {
      onchange: (event) => {
        filters[key] = event.target.value;
        onChange();
      },
    },
    h("option", { value: "" }, "All"),
    options.map((option) => h("option", { value: option, selected: option === filters[key] }, option))));
}

// Auto criteria describe what each stage's hidden tests check, which would give away later stages,
// so they appear only as a total. Judged criteria are about how the work is done.
function rubricPeek(task) {
  const auto = task.rubric.filter((c) => c.type === "auto");
  const judged = task.rubric.filter((c) => c.type !== "auto");
  const points = (list) => formatPoints(list.reduce((sum, c) => sum + c.weight, 0));
  return h("details", { class: "peek" },
    h("summary", null, "What's scored"),
    h("div", { class: "peek-body" },
      h("p", null, `${points(auto)} points come from hidden tests, one set per stage. They stay out of sight here so later stages stay a surprise.`),
      judged.length > 0 && h("p", null, `${points(judged)} points need an AI reviewer:`),
      judged.length > 0 && h("ul", { class: "peek-list" }, judged.map((c) => h("li", null,
        h("span", { class: "peek-weight mono" }, formatPoints(c.weight)),
        h("span", null, c.description))))));
}

function startOptions() {
  const editor = app.status?.editor;
  const options = recall("start-options", { editor: true, git: true });
  const save = () => remember("start-options", options);
  return {
    options,
    element: h("fieldset", { class: "start-options" },
      h("legend", null, "When a round starts"),
      h("label", { class: "check" },
        h("input", {
          type: "checkbox",
          checked: options.editor && Boolean(editor),
          disabled: !editor,
          onchange: (event) => {
            options.editor = event.target.checked;
            save();
          },
        }),
        editor ? `Open the folder in ${editor}` : "Open the folder in my editor (none found)"),
      h("label", { class: "check" },
        h("input", {
          type: "checkbox",
          checked: options.git,
          onchange: (event) => {
            options.git = event.target.checked;
            save();
          },
        }),
        "Save each stage in a git history")),
  };
}

function taskRow(task, openRound, options) {
  const error = h("div", { class: "task-error" });
  const start = button("Start round", {
    icon: "play",
    kind: "primary",
    "aria-label": `Start round: ${task.title}`,
    onClick: () => withBusy(start, "Starting…", async () => {
      error.replaceChildren();
      try {
        const round = await api.startRound({
          task_id: task.id,
          git: options.git,
          open_editor: options.editor && Boolean(app.status?.editor),
        });
        location.hash = `#/rounds/${encodeURIComponent(round.id)}/tests`;
      } catch (err) {
        error.replaceChildren(notice("fail", `Couldn't start this round. ${err.message}`));
      }
    }),
  });
  return h("li", { class: "task" },
    h("div", { class: "task-main" },
      h("h2", null, task.title),
      h("p", { class: "meta" }, [
        task.category, task.level, task.difficulty, task.language, `${task.time_limit_minutes} min`,
        plural(task.stage_count, "stage"),
      ].filter(Boolean).join(" · ")),
      task.tags.length > 0 && h("ul", { class: "tags" }, task.tags.map((tag) => h("li", { class: "badge" }, tag))),
      rubricPeek(task),
      error),
    h("div", { class: "task-actions" },
      start,
      openRound && h("a", { href: `#/rounds/${encodeURIComponent(openRound.id)}/tests` }, `Resume ${openRound.id}`)));
}

export function show(main, _params, signal) {
  const root = h("div", { class: "page" });
  const head = h("header", { class: "page-head" },
    h("h1", null, "Tasks"),
    h("p", null, "Pick a task to start a round. The clock starts as soon as you do."));
  main.append(root);

  function render(tasks, rounds) {
    const list = h("div");
    const count = h("p", { class: "meta filter-count", role: "status" });
    const { options, element: optionsField } = startOptions();

    const showList = () => {
      const shown = tasks.filter((t) => (!filters.category || t.category === filters.category)
        && (!filters.level || t.level === filters.level)
        && (!filters.tag || t.tags.includes(filters.tag)));
      count.textContent = plural(shown.length, "task");
      list.replaceChildren(shown.length
        ? h("ul", { class: "rows" }, shown.map((task) => taskRow(task, rounds.find((r) => r.task_id === task.id), options)))
        : emptyBlock("No tasks match these filters", "Try a different combination, or show every task.",
            button("Show all tasks", {
              onClick: () => {
                Object.assign(filters, { category: "", level: "", tag: "" });
                render(tasks, rounds);
              },
            })));
    };

    root.replaceChildren(head, howToNote() ?? "",
      h("div", { class: "filters" },
        filterSelect("Category", "category", unique(tasks.map((t) => t.category)), showList),
        filterSelect("Level", "level", unique(tasks.map((t) => t.level)), showList),
        filterSelect("Tag", "tag", unique(tasks.flatMap((t) => t.tags)), showList),
        count),
      optionsField,
      list);
    showList();
  }

  async function load() {
    root.replaceChildren(head, loadingBlock("Loading tasks…"));
    try {
      const [{ tasks }, { rounds }] = await Promise.all([api.tasks(), api.rounds()]);
      if (signal.aborted) return;
      if (tasks.length) render(tasks, rounds);
      else root.replaceChildren(head, emptyBlock("No tasks found", "This install has no tasks. Add one from the Author screen."));
    } catch (err) {
      if (!signal.aborted) root.replaceChildren(head, errorBlock(err, load, "Couldn't load the tasks"));
    }
  }

  load();
}

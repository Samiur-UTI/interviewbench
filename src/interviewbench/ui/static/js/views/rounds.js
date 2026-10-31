// Rounds: every round in the workspaces folder, to resume or delete.

import { api, followJob } from "../api.js";
import { describeTimeLeft, formatDate, parseTime } from "../format.js";
import { icon } from "../icons.js";
import { app, now } from "../state.js";
import {
  announce, badge, button, copyablePath, emptyBlock, errorBlock, h, loadingBlock, notice, openDialog, withBusy,
} from "../ui.js";

const TICK_MS = 30000;

// docs/GUI.md doesn't fix what active_job holds, so take a job or its id.
export function activeJobId(summary) {
  const active = summary.active_job;
  return active && typeof active === "object" ? active.id : active ?? null;
}

function confirmDelete(round, onDeleted) {
  const error = h("div");
  const input = h("input", {
    type: "text",
    class: "mono",
    autocomplete: "off",
    spellcheck: "false",
  });
  const confirm = button("Delete this round", {
    kind: "danger",
    icon: "trash",
    blocked: `Type ${round.id} first`,
    onClick: () => withBusy(confirm, "Deleting…", async () => {
      try {
        await api.deleteRound(round.id);
        dialog.close();
        onDeleted();
      } catch (err) {
        error.replaceChildren(notice("fail", `Couldn't delete this round. ${err.message}`));
      }
    }),
  });
  input.addEventListener("input", () => {
    const ready = input.value === round.id;
    confirm.title = ready ? "" : `Type ${round.id} first`;
    if (ready) confirm.removeAttribute("aria-disabled");
    else confirm.setAttribute("aria-disabled", "true");
  });
  const cancel = button("Keep it", { onClick: () => dialog.close() });
  const dialog = openDialog({
    title: `Delete ${round.id}?`,
    body: [
      h("p", null, "This removes the whole folder, including all your work in it. It can't be undone."),
      copyablePath(round.path),
      h("label", { class: "field" },
        h("span", { class: "field-label" }, "Type ", h("code", null, round.id), " to confirm"),
        input),
      error,
    ],
    actions: [cancel, confirm],
  });
  input.focus();
}

function timeCell(round) {
  const ends = parseTime(round.ends_at);
  return ends === null ? "No limit" : describeTimeLeft(ends, now());
}

function roundRow(round, onDeleted) {
  const href = `#/rounds/${encodeURIComponent(round.id)}/tests`;
  const started = parseTime(round.started_at);
  const running = activeJobId(round) !== null;
  return h("tr", null,
    h("th", { scope: "row" },
      h("a", { class: "round-title", href }, round.title),
      h("span", { class: "meta" }, round.id, started !== null && ` · started ${formatDate(started)}`)),
    h("td", { "data-label": "Stage" }, h("span", { class: "mono" }, `${round.stage} of ${round.stage_count}`),
      running && " ", running && badge("accent", "Job running")),
    h("td", { "data-label": "Time", class: "mono", "data-time": round.id }, timeCell(round)),
    h("td", { "data-label": "Score", class: "mono" }, round.score_percent === null || round.score_percent === undefined
      ? h("span", { class: "muted" }, "Not graded")
      : `${Math.round(round.score_percent)}%`),
    h("td", { class: "round-actions" },
      h("a", { class: "button", href, "aria-label": `Resume ${round.id}` }, icon("arrow-right"), "Resume"),
      button("Delete", {
        kind: "ghost",
        icon: "trash",
        "aria-label": `Delete ${round.id}`,
        blocked: running ? "Wait for the running job to finish" : null,
        onClick: () => confirmDelete(round, onDeleted),
      })));
}

export function show(main, _params, signal) {
  const root = h("div", { class: "page" });
  const head = h("header", { class: "page-head" },
    h("h1", null, "Rounds"),
    h("p", null, "Every round on this computer, including ones started from a terminal."));
  main.append(root);

  let rounds = [];
  const tick = setInterval(() => {
    for (const round of rounds) {
      const cell = root.querySelector(`[data-time="${CSS.escape(round.id)}"]`);
      if (cell) cell.textContent = timeCell(round);
    }
  }, TICK_MS);

  function render() {
    if (!rounds.length) {
      root.replaceChildren(head, emptyBlock("No rounds yet", "Your rounds appear here once you start a task.",
        h("a", { class: "button primary", href: "#/tasks" }, "Pick a task")));
      return;
    }
    const deleted = (id) => () => {
      announce(`Deleted ${id}.`);
      load();
    };
    root.replaceChildren(head,
      h("table", { class: "round-table" },
        h("thead", null, h("tr", null,
          h("th", { scope: "col" }, "Round"), h("th", { scope: "col" }, "Stage"), h("th", { scope: "col" }, "Time"),
          h("th", { scope: "col" }, "Score"), h("th", { scope: "col" }, h("span", { class: "visually-hidden" }, "Actions")))),
        h("tbody", null, rounds.map((round) => roundRow(round, deleted(round.id))))),
      h("p", { class: "meta rounds-folder" }, "Stored in ", copyablePath(app.status?.workspaces_dir ?? "")));
  }

  async function load() {
    if (!rounds.length) root.replaceChildren(head, loadingBlock("Loading rounds…"));
    try {
      ({ rounds } = await api.rounds());
      if (signal.aborted) return;
      render();
      // A running job blocks Delete: refresh when it ends so the row doesn't stay stale.
      const active = rounds.map(activeJobId).find((id) => id !== null);
      if (active) followJob(active, () => {}, signal).then(() => signal.aborted || load()).catch(() => {});
    } catch (err) {
      if (!signal.aborted) root.replaceChildren(head, errorBlock(err, load, "Couldn't load your rounds"));
    }
  }

  load();
  return { leave: () => clearInterval(tick) };
}

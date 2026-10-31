// Round: the header, the brief, and the panels on the right. Owns the running job, so the panels only
// read its state and ask for new jobs through ctx.

import { ApiError, api, followJob } from "../api.js";
import {
  countdown, formatElapsed, formatTimeOfDay, parseTime, timeMilestone, withoutTitle,
} from "../format.js";
import { icon } from "../icons.js";
import { setMarkdown } from "../markdown.js";
import { now } from "../state.js";
import {
  announce, button, copyablePath, emptyBlock, errorBlock, h, loadingBlock, notice, openDialog, withBusy,
} from "../ui.js";
import * as breakPanel from "./break-panel.js";
import * as changesPanel from "./changes-panel.js";
import * as gradePanel from "./grade-panel.js";
import { activeJobId } from "./rounds.js";
import * as testsPanel from "./tests-panel.js";

const PANELS = [
  { id: "tests", label: "Tests", icon: "flask", module: testsPanel },
  { id: "changes", label: "Changes", icon: "diff", module: changesPanel },
  { id: "grade", label: "Grade", icon: "gauge", module: gradePanel },
  { id: "break", label: "Break it", icon: "crack", module: breakPanel },
];
const JOBS = {
  test: { panel: "tests", result: "test", name: "Tests" },
  grade: { panel: "grade", result: "grade", name: "Grading" },
  "judge-reply": { panel: "grade", result: "grade", name: "Scoring the reply" },
  break: { panel: "break", result: "break", name: "Break it" },
};
const BUSY = "Wait for the running job to finish";

// Pasted text survives moving between panels and rounds. It's kept in memory only.
const drafts = new Map();

function draftsFor(id) {
  if (!drafts.has(id)) drafts.set(id, {});
  return drafts.get(id);
}

function stepper(round) {
  const titles = new Map(round.stages.map((stage) => [stage.number, stage.title]));
  const steps = Array.from({ length: round.stage_count }, (_, n) => n + 1);
  return h("ol", { class: "stepper", "aria-label": "Stages" }, steps.map((number) => {
    const state = number < round.stage ? "done" : number === round.stage ? "current" : "todo";
    return h("li", { class: state, "aria-current": state === "current" ? "step" : null },
      icon({ done: "check", current: "ring", todo: "lock" }[state]),
      h("span", { class: "step-number" }, number),
      h("span", { class: "step-title" }, titles.get(number) ?? "Not revealed yet"),
      state === "done" && h("span", { class: "visually-hidden" }, " (done)"));
  }));
}

function stageBody(stage) {
  const body = h("div", { class: "md" });
  setMarkdown(body, withoutTitle(stage.markdown, stage.title), { headingOffset: 2 });
  return body;
}

export function show(main, params, signal) {
  main.classList.add("fixed");
  const root = h("div", { class: "round" });
  main.append(root);

  const state = {
    id: params.id,
    panel: params.panel,
    round: null,
    job: null,  // the running job
    recent: null,  // the job that finished last, for the job strip
    failures: {},  // job kind -> error message of its last failed run
    revealed: null,  // { stage, message } just after moving on
    onFocusBack: null,
  };
  const memo = {};
  const clock = h("div", { class: "timer", role: "timer", "aria-label": "Time left" });
  const head = h("header", { class: "round-head" });
  const brief = h("section", { class: "brief-pane", tabindex: "0", "aria-label": "Brief" });
  const tabs = h("nav", { class: "tabs", "aria-label": "Round panels" });
  const strip = h("div", { class: "job-strip" });
  const panel = h("section", { class: "panel", tabindex: "0" });
  const headNotice = h("div", { class: "round-notice" });

  const blocked = () => (state.job ? BUSY : null);

  // --- the clock ----------------------------------------------------------------------------

  let lastTick = now();

  function tick() {
    const ends = parseTime(state.round?.ends_at);
    const current = now();
    if (ends !== null) {
      const { state: mood, text, label } = countdown(ends, current);
      clock.dataset.state = mood;
      clock.replaceChildren(h("span", { class: "timer-value" }, text), h("span", { class: "timer-label" }, label));
      const spoken = timeMilestone(ends, lastTick, current);
      if (spoken) announce(spoken);
    }
    lastTick = current;
    const elapsed = strip.querySelector("[data-elapsed]");
    if (elapsed && state.job) elapsed.textContent = formatElapsed(current - parseTime(state.job.started_at));
  }

  const timer = setInterval(tick, 1000);

  // --- the header -----------------------------------------------------------------------------

  async function openEditor() {
    headNotice.replaceChildren();
    try {
      const { editor } = await api.openEditor(state.id);
      announce(`Opened in ${editor}.`);
    } catch (err) {
      headNotice.replaceChildren(err.code === "no_editor"
        ? notice("warn", "No editor found on this computer. Copy the folder path and open it in your editor yourself.")
        : notice("fail", `Couldn't open your editor. ${err.message}`));
    }
  }

  function renderHead() {
    const { round } = state;
    head.replaceChildren(
      h("div", { class: "round-bar" },
        h("a", { class: "icon-button", href: "#/rounds", "aria-label": "All rounds", title: "All rounds" }, icon("arrow-left")),
        h("div", { class: "round-name" },
          h("h1", null, round.title),
          h("p", { class: "meta" }, round.id)),
        parseTime(round.ends_at) !== null && clock),
      h("div", { class: "round-tools" },
        stepper(round),
        h("div", { class: "round-buttons" },
          round.all_revealed
            ? h("a", { class: "button primary", href: `#/rounds/${encodeURIComponent(round.id)}/grade` }, icon("gauge"), "Go to Grade")
            : button("Next stage", { icon: "arrow-right", kind: "primary", blocked: blocked(), "data-fk": "next", onClick: confirmNext }),
          button("Open in editor", { icon: "editor", "data-fk": "editor", onClick: openEditor }),
          copyablePath(round.path, "Copy folder"))),
      headNotice);
    tick();
  }

  function confirmNext() {
    const { round } = state;
    const next = round.stage + 1;
    const error = h("div");
    const cancel = button("Not yet", { autofocus: true, onClick: () => dialog.close() });
    const proceed = button(round.git ? `Commit and show stage ${next}` : `Show stage ${next}`, {
      kind: "primary",
      icon: "arrow-right",
      onClick: () => withBusy(proceed, "Moving on…", async () => {
        try {
          const next = await api.nextStage(state.id);
          dialog.close();  // first: nothing behind an open dialog can take focus
          moveOn(next);
        } catch (err) {
          error.replaceChildren(notice("fail", `Couldn't move on. ${err.message}`));
        }
      }),
    });
    const dialog = openDialog({
      title: `Move on to stage ${next}?`,
      body: [
        h("ul", { class: "plain-list" },
          h("li", null, round.git
            ? ["Your work so far is committed and tagged ", h("code", null, `stage-${round.stage}`), "."]
            : "This round has no git history, so no checkpoint is saved."),
          h("li", null, `The brief for stage ${next} appears. It can't be hidden again, so this can't be undone.`),
          h("li", null, "Your code stays as it is, and the clock keeps running.")),
        error,
      ],
      actions: [cancel, proceed],
    });
  }

  function moveOn(round) {
    const { tagged, ...fresh } = round;
    let message = `Stage ${fresh.stage} revealed.`;
    if (tagged) message += ` Your stage ${fresh.stage - 1} work is committed and tagged ${tagged}.`;
    else if (fresh.git) message += " There was nothing new to commit, so no tag was added.";
    state.round = fresh;
    state.revealed = { stage: fresh.stage, message };
    renderHead();
    renderBrief();
    renderPanel();
    announce(message);
    brief.querySelector(".stage.current")?.scrollIntoView({ block: "start" });
    brief.querySelector(".stage.current h2")?.focus({ preventScroll: true });
  }

  // --- the brief ------------------------------------------------------------------------------

  function renderBrief() {
    const { round, revealed } = state;
    const stages = [...round.stages].sort((a, b) => a.number - b.number);
    brief.replaceChildren(h("div", { class: "brief" }, stages.map((stage) => {
      if (stage.number < round.stage) {
        return h("details", { class: "stage earlier" },
          h("summary", null, icon("check"), ` Stage ${stage.number}: ${stage.title}`),
          stageBody(stage));
      }
      const isNew = revealed?.stage === stage.number;
      return h("section", { class: `stage current${isNew ? " is-new" : ""}` },
        isNew && notice("ok", revealed.message),
        h("h2", { class: "focus-target", tabindex: "-1" },
          h("span", { class: "stage-kicker" }, `Stage ${stage.number} of ${round.stage_count}`),
          stage.title),
        stageBody(stage));
    })));
  }

  // --- the job strip --------------------------------------------------------------------------

  const panelLink = (kind) => {
    const target = JOBS[kind]?.panel;
    if (!target || target === state.panel) return null;
    return h("a", { href: `#/rounds/${encodeURIComponent(state.id)}/${target}` }, "View");
  };

  function renderStrip() {
    const { job, recent } = state;
    if (job) {
      strip.dataset.state = "running";
      strip.replaceChildren(
        h("span", { class: "spinner", "aria-hidden": "true" }),
        h("span", { class: "job-phase", title: job.phase }, job.phase),
        h("span", { class: "job-time", "data-elapsed": "" }, job.started_at ? formatElapsed(now() - parseTime(job.started_at)) : ""),
        panelLink(job.kind) ?? "");
    } else if (recent) {
      const failed = recent.state !== "succeeded";
      strip.dataset.state = failed ? "failed" : "done";
      strip.replaceChildren(
        icon(failed ? "cross" : "check"),
        h("span", { class: "job-phase" }, `${JOBS[recent.kind]?.name ?? "Job"} ${failed ? "failed" : "finished"}`),
        h("span", { class: "job-time" }, recent.finished_at ? formatTimeOfDay(parseTime(recent.finished_at)) : ""),
        panelLink(recent.kind) ?? "");
    } else {
      strip.dataset.state = "idle";
      strip.replaceChildren(h("span", { class: "job-phase" }, "Nothing running"));
    }
    const log = panel.querySelector("[data-job-log]");
    if (log) log.replaceChildren(...jobLogItems());
  }

  const jobLogItems = () => (state.job?.log ?? []).map((line) => h("li", null, line));

  // --- jobs -----------------------------------------------------------------------------------

  async function attach(job) {
    state.job = job;
    state.recent = null;
    for (const key of [job.kind, "lost", "start"]) delete state.failures[key];
    if (job.phase) announce(job.phase);
    renderAll();
    let phase = job.phase;
    try {
      const finished = await followJob(job.id, (update) => {
        state.job = update;
        if (update.phase !== phase) {
          phase = update.phase;
          announce(phase);
        }
        renderStrip();
      }, signal);
      if (!signal.aborted) await jobEnded(finished);
    } catch (err) {
      if (err.status !== 401) throw err;  // on a 401 the app has moved to its sign-in screen
    }
  }

  async function jobEnded(job) {
    state.job = null;
    if (!job) {
      state.failures.lost = "The server lost track of this job, perhaps because it restarted. Run it again.";
    } else if (job.state === "failed") {
      state.failures[job.kind] = job.error ?? "It stopped without saying why.";
      announce(`${JOBS[job.kind]?.name ?? "Job"} failed.`);
    } else {
      const key = JOBS[job.kind]?.result;
      if (key && state.round.last) state.round.last[key] = job.result;
      announce(`${JOBS[job.kind]?.name ?? "Job"} finished.`);
    }
    state.recent = job;
    await refreshRound();
    renderAll();
  }

  async function refreshRound() {
    try {
      const round = await api.round(state.id);
      if (!signal.aborted) state.round = round;
    } catch {
      // what's on screen stays; the connection banner covers an outage
    }
  }

  async function runJob(start) {
    if (state.job) return;
    try {
      await attach(await start());
    } catch (err) {
      if (err.code === "busy") {
        await refreshRound();
        reattach();
      } else if (err instanceof ApiError) {
        state.failures.start = err.message;
        keepingFocus(renderPanel);
      } else {
        throw err;
      }
    }
  }

  function reattach() {
    const id = activeJobId(state.round);
    if (id && !state.job) attach({ id, phase: "Picking up the running job…", log: [], started_at: null });
  }

  // --- the panels -----------------------------------------------------------------------------

  const ctx = {
    get round() { return state.round; },
    get job() { return state.job; },
    get blocked() { return blocked(); },
    memo,
    drafts: draftsFor(state.id),
    runJob,
    failure: (kind) => state.failures[kind] ?? null,
    jobLog: () => h("ol", { class: "job-log", "data-job-log": "" }, jobLogItems()),
    onFocusBack: (fn) => { state.onFocusBack = fn; },
  };

  // Rebuilding drops the focused element. data-fk marks controls that should keep focus across it.
  function keepingFocus(rebuild) {
    const key = document.activeElement?.dataset?.fk;
    rebuild();
    if (key) root.querySelector(`[data-fk="${key}"]`)?.focus();
  }

  function renderTabs() {
    tabs.replaceChildren(...PANELS.map((item) => h("a", {
      href: `#/rounds/${encodeURIComponent(state.id)}/${item.id}`,
      "aria-current": item.id === state.panel ? "page" : null,
    }, icon(item.icon), item.label)));
    panel.setAttribute("aria-label", PANELS.find((item) => item.id === state.panel).label);
  }

  function renderPanel() {
    const { scrollTop } = panel;
    state.onFocusBack = null;
    const current = PANELS.find((item) => item.id === state.panel);
    const problem = state.failures.lost ?? state.failures.start;
    panel.replaceChildren(problem ? notice("fail", problem) : "", current.module.render(ctx));
    panel.scrollTop = scrollTop;
  }

  function renderAll() {
    keepingFocus(() => {
      renderHead();
      renderStrip();
      renderPanel();
    });
  }

  function setPanel(id) {
    const known = PANELS.some((item) => item.id === id);
    if (!known) {
      location.replace(`#/rounds/${encodeURIComponent(state.id)}/tests`);
      return false;
    }
    state.panel = id;
    return true;
  }

  // --- loading --------------------------------------------------------------------------------

  async function load() {
    root.replaceChildren(h("div", { class: "page" }, loadingBlock("Loading your round…")));
    try {
      state.round = await api.round(state.id);
      if (signal.aborted) return;
    } catch (err) {
      if (signal.aborted) return;
      main.classList.remove("fixed");
      root.replaceChildren(h("div", { class: "page" }, err.status === 404
        ? emptyBlock("This round isn't here any more", "It may have been deleted, or its folder moved.",
            h("a", { class: "button primary", href: "#/rounds" }, "See your rounds"))
        : errorBlock(err, load, "Couldn't load this round")));
      return;
    }
    main.classList.add("fixed");
    root.replaceChildren(head,
      h("div", { class: "round-panes" }, brief, h("div", { class: "work-pane" }, tabs, strip, panel)));
    renderBrief();
    renderTabs();
    renderAll();
    reattach();
  }

  const onFocus = () => state.onFocusBack?.();
  window.addEventListener("focus", onFocus);

  if (setPanel(params.panel ?? "tests")) load();

  return {
    leave() {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    },
    update(next) {
      if (!setPanel(next.panel ?? "tests")) return;
      delete state.failures.start;
      if (!state.round) return;
      renderTabs();
      renderStrip();
      renderPanel();
      panel.scrollTop = 0;
    },
  };
}

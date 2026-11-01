// The Round screen's header: the name, the clock, the stage stepper and the tools.

import { Button, CopyablePath } from "../../components/button.js";
import { Notice } from "../../components/feedback.js";
import { Icon } from "../../components/icon.js";
import { announce } from "../../core/announce.js";
import { api } from "../../core/api.js";
import { now } from "../../core/clock.js";
import { countdown, parseTime, timeMilestone } from "../../core/format.js";
import { roundHref } from "../../core/routes.js";
import { useNow } from "../../hooks/use-now.js";
import { html, useEffect, useRef, useState } from "../../preact.js";
import { NextStageDialog } from "./next-stage-dialog.js";

const STEP_ICONS = { done: "check", current: "ring", todo: "lock" };

function Stepper({ round }) {
  const titles = new Map(round.stages.map((stage) => [stage.number, stage.title]));
  const steps = Array.from({ length: round.stage_count }, (_, n) => n + 1);
  return html`
    <ol class="stepper" aria-label="Stages">
      ${steps.map((number) => {
        const state = number < round.stage ? "done" : number === round.stage ? "current" : "todo";
        return html`
          <li class=${state} aria-current=${state === "current" ? "step" : null}>
            <${Icon} name=${STEP_ICONS[state]} />
            <span class="step-number">${number}</span>
            <span class="step-title">${titles.get(number) ?? "Not revealed yet"}</span>
            ${state === "done" && html`<span class="visually-hidden"> (done)</span>`}
          </li>`;
      })}
    </ol>`;
}

function Countdown({ ends }) {
  const time = useNow();
  const last = useRef(now());
  useEffect(() => {
    const spoken = timeMilestone(ends, last.current, time);
    if (spoken) announce(spoken);
    last.current = time;
  }, [ends, time]);
  const { state, text, label } = countdown(ends, time);
  return html`
    <div class="timer" role="timer" aria-label="Time left" data-state=${state}>
      <span class="timer-value">${text}</span>
      <span class="timer-label">${label}</span>
    </div>`;
}

export function RoundHeader({ round, blocked, onMoved }) {
  const [problem, setProblem] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const ends = parseTime(round.ends_at);

  const openEditor = async () => {
    setProblem(null);
    try {
      const { editor } = await api.openEditor(round.id);
      announce(`Opened in ${editor}.`);
    } catch (err) {
      setProblem(err.code === "no_editor"
        ? html`<${Notice} kind="warn">No editor found on this computer. Copy the folder path and open it in your editor yourself.<//>`
        : html`<${Notice} kind="fail">Couldn't open your editor. ${err.message}<//>`);
    }
  };

  return html`
    <header class="round-head">
      <div class="round-bar">
        <a class="icon-button" href="#/rounds" aria-label="All rounds" title="All rounds"><${Icon} name="arrow-left" /></a>
        <div class="round-name">
          <h1>${round.title}</h1>
          <p class="meta">${round.id}</p>
        </div>
        ${ends !== null && html`<${Countdown} ends=${ends} />`}
      </div>
      <div class="round-tools">
        <${Stepper} round=${round} />
        <div class="round-buttons">
          ${round.all_revealed
            ? html`<a class="button primary" href=${roundHref(round.id, "grade")}><${Icon} name="gauge" />Go to Grade</a>`
            : html`<${Button} icon="arrow-right" kind="primary" blocked=${blocked} onClick=${() => setConfirming(true)}>Next stage<//>`}
          <${Button} icon="editor" onClick=${openEditor}>Open in editor<//>
          <${CopyablePath} path=${round.path} label="Copy folder" />
        </div>
      </div>
      <div class="round-notice">${problem}</div>
      ${confirming && html`<${NextStageDialog} round=${round} onClose=${() => setConfirming(false)} onMoved=${onMoved} />`}
    </header>`;
}

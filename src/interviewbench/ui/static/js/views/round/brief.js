// The briefs revealed so far: the current stage open, earlier ones folded away.

import { Icon } from "../../components/icon.js";
import { Notice } from "../../components/feedback.js";
import { MarkdownView } from "../../components/markdown-view.js";
import { withoutTitle } from "../../core/format.js";
import { html, useEffect, useRef } from "../../preact.js";

const StageBody = ({ stage }) => html`<${MarkdownView} source=${withoutTitle(stage.markdown, stage.title)} headingOffset=${2} />`;

function EarlierStage({ stage }) {
  return html`
    <details class="stage earlier">
      <summary><${Icon} name="check" />${` Stage ${stage.number}: ${stage.title}`}</summary>
      <${StageBody} stage=${stage} />
    </details>`;
}

function CurrentStage({ stage, count, revealed }) {
  const isNew = revealed?.stage === stage.number;
  return html`
    <section class=${`stage current${isNew ? " is-new" : ""}`}>
      ${isNew && html`<${Notice} kind="ok">${revealed.message}<//>`}
      <h2 class="focus-target" tabindex="-1">
        <span class="stage-kicker">Stage ${stage.number} of ${count}</span>
        ${stage.title}
      </h2>
      <${StageBody} stage=${stage} />
    </section>`;
}

export function Brief({ round, revealed }) {
  const pane = useRef(null);
  useEffect(() => {
    if (!revealed) return;
    pane.current.querySelector(".stage.current")?.scrollIntoView({ block: "start" });
    pane.current.querySelector(".stage.current h2")?.focus({ preventScroll: true });
  }, [revealed]);

  const stages = [...round.stages].sort((a, b) => a.number - b.number);
  return html`
    <section ref=${pane} class="brief-pane" tabindex="0" aria-label="Brief">
      <div class="brief">
        ${stages.map((stage) => (stage.number < round.stage
          ? html`<${EarlierStage} key=${stage.number} stage=${stage} />`
          : html`<${CurrentStage} key=${stage.number} stage=${stage} count=${round.stage_count} revealed=${revealed} />`))}
      </div>
    </section>`;
}

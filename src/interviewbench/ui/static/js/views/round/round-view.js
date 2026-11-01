// Round: the header, the brief, and the panels on the right. To add a panel, add it to PANELS.

import { Empty, Failed, Loading, Notice } from "../../components/feedback.js";
import { Icon } from "../../components/icon.js";
import { roundHref } from "../../core/routes.js";
import { useFixedMain } from "../../hooks/use-dom.js";
import { html, useEffect, useLayoutEffect, useRef } from "../../preact.js";
import { Brief } from "./brief.js";
import { JobStrip } from "./job-strip.js";
import { BreakPanel } from "./panels/break-panel.js";
import { ChangesPanel } from "./panels/changes-panel.js";
import { GradePanel } from "./panels/grade-panel.js";
import { TestsPanel } from "./panels/tests-panel.js";
import { RoundContext } from "./round-context.js";
import { RoundHeader } from "./round-header.js";
import { useRound } from "./use-round.js";

const PANELS = [
  { id: "tests", label: "Tests", icon: "flask", Panel: TestsPanel },
  { id: "changes", label: "Changes", icon: "diff", Panel: ChangesPanel },
  { id: "grade", label: "Grade", icon: "gauge", Panel: GradePanel },
  { id: "break", label: "Break it", icon: "crack", Panel: BreakPanel },
];

function PanelTabs({ id, current }) {
  return html`
    <nav class="tabs" aria-label="Round panels">
      ${PANELS.map((item) => html`
        <a href=${roundHref(id, item.id)} aria-current=${item.id === current.id ? "page" : null}>
          <${Icon} name=${item.icon} />${item.label}
        </a>`)}
    </nav>`;
}

function Workspace({ id, current, state, dispatch, context }) {
  const pane = useRef(null);
  const { round, job, recent, failures, revealed } = state;
  const problem = failures.lost ?? failures.start;

  useLayoutEffect(() => {
    pane.current.scrollTop = 0;
  }, [current.id]);

  return html`
    <${RoundContext.Provider} value=${context}>
      <${RoundHeader}
        round=${round}
        blocked=${context.blocked}
        onMoved=${(moved) => dispatch({ type: "moved-on", round: moved })}
      />
      <div class="round-panes">
        <${Brief} round=${round} revealed=${revealed} />
        <div class="work-pane">
          <${PanelTabs} id=${id} current=${current} />
          <${JobStrip} id=${id} panel=${current.id} job=${job} recent=${recent} />
          <section ref=${pane} class="panel" tabindex="0" aria-label=${current.label}>
            ${problem && html`<${Notice} kind="fail">${problem}<//>`}
            <${current.Panel} key=${current.id} />
          </section>
        </div>
      </div>
    <//>`;
}

function LoadProblem({ query }) {
  return html`
    <div class="page">
      ${query.error.status === 404
        ? html`
          <${Empty} title="This round isn't here any more" text="It may have been deleted, or its folder moved.">
            <a class="button primary" href="#/rounds">See your rounds</a>
          <//>`
        : html`<${Failed} error=${query.error} retry=${query.reload} title="Couldn't load this round" />`}
    </div>`;
}

export function RoundView({ params }) {
  const { id } = params;
  const current = PANELS.find((item) => item.id === (params.panel ?? "tests"));
  const { state, dispatch, query, context } = useRound(id);
  useFixedMain(!(query.error && !state.round));

  useEffect(() => {
    if (!current) location.replace(roundHref(id));
    else dispatch({ type: "panel-changed" });
  }, [current, id, dispatch]);

  if (state.round && current) {
    return html`
      <div class="round">
        <${Workspace} id=${id} current=${current} state=${state} dispatch=${dispatch} context=${context} />
      </div>`;
  }
  if (query.error) return html`<div class="round"><${LoadProblem} query=${query} /></div>`;
  return html`<div class="round"><div class="page"><${Loading} text="Loading your round…" /></div></div>`;
}

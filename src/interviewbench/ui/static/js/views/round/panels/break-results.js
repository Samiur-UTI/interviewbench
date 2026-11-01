// What an attack run found, and what each verdict means.

import { Badge } from "../../../components/feedback.js";
import { formatDate, parseTime } from "../../../core/format.js";
import { html } from "../../../preact.js";

const VERDICTS = {
  "real break": { kind: "fail", icon: "crack", label: "Real break", meaning: "Fails on your code but passes on the reference. This is a bug worth fixing." },
  survived: { kind: "ok", icon: "check", label: "Survived", meaning: "Passes on both. Your code held up." },
  "bad test": { kind: "", icon: "ring", label: "Bad test", meaning: "Fails on the reference too, so the test is wrong. It's ignored." },
};
const ORDER = ["real break", "survived", "bad test"];

function VerdictBadge({ verdict }) {
  return html`<${Badge} kind=${verdict.kind} icon=${verdict.icon}>${verdict.label}<//>`;
}

export function Legend() {
  return html`
    <dl class="verdicts">
      ${ORDER.map((name) => html`
        <div>
          <dt><${VerdictBadge} verdict=${VERDICTS[name]} /></dt>
          <dd>${VERDICTS[name].meaning}</dd>
        </div>`)}
    </dl>`;
}

function Count({ number, label }) {
  return html`<li><span class="result-count">${number}</span> ${label}</li>`;
}

function Attack({ attack }) {
  return html`
    <li>
      <p class="attack-head">
        <${VerdictBadge} verdict=${VERDICTS[attack.verdict] ?? VERDICTS["bad test"]} />
        <code>${attack.name}</code>
      </p>
      ${attack.detail && html`<pre class="output">${attack.detail}</pre>`}
    </li>`;
}

export function Results({ last, running }) {
  const finished = parseTime(last.finished_at);
  const { real_break: real, survived, bad_test: bad } = last.counts;
  const attacks = [...last.attacks].sort((a, b) => ORDER.indexOf(a.verdict) - ORDER.indexOf(b.verdict));
  const meta = [last.runner && `${last.runner} runner`, finished && `finished ${formatDate(finished)}`];
  return html`
    <section class="stack">
      <h3>Results</h3>
      ${running && html`<p class="meta">Showing your last attack until this one finishes.</p>`}
      <ul class="break-counts">
        <${Count} number=${real} label=${real === 1 ? "real break" : "real breaks"} />
        <${Count} number=${survived} label="survived" />
        <${Count} number=${bad} label=${bad === 1 ? "bad test ignored" : "bad tests ignored"} />
      </ul>
      <p class="meta">${meta.filter(Boolean).join(" · ")}</p>
      <ul class="attacks">${attacks.map((attack) => html`<${Attack} attack=${attack} />`)}</ul>
    </section>`;
}

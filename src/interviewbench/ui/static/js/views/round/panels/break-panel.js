// Break it: an LLM writes attack tests, refereed by the reference solution.

import { Button, CopyButton } from "../../../components/button.js";
import { Empty, Notice } from "../../../components/feedback.js";
import { Icon } from "../../../components/icon.js";
import { api } from "../../../core/api.js";
import { formatTokens } from "../../../core/format.js";
import { useAsync } from "../../../hooks/use-async.js";
import { html, useEffect } from "../../../preact.js";
import { JobLog } from "../job-log.js";
import { useDraft, useRoundContext, useRunningHere } from "../round-context.js";
import { Legend, Results } from "./break-results.js";

function problemWith(filename, attack) {
  if (!filename.trim()) return "Name the file first";
  if (/[\\/]/.test(filename)) return "Use a file name, not a path";
  return attack.trim() ? null : "Paste the test file first";
}

export function BreakPanel() {
  const { round, blocked, drafts, runJob, settled, failure } = useRoundContext();
  const [filename, setFilename] = useDraft("filename");
  const [attack, setAttack] = useDraft("attack");
  const query = useAsync(() => api.attackPrompt(round.id), [round.id, round.stage, settled]);
  const info = query.data;
  const running = useRunningHere("break");
  const last = round.last?.break;
  const failed = failure("break");

  useEffect(() => {
    if (info && !drafts.filename) setFilename(info.suggested_filename);
  }, [info]);

  // Rebuilt from the current code on every copy, so the prompt is never stale.
  const copyPrompt = async () => {
    const fresh = await api.attackPrompt(round.id);
    query.set(fresh);
    return fresh.prompt;
  };

  return html`
    <div class="stack sections">
      <div class="panel-head">
        <div>
          <h2>Break it</h2>
          <p>Get any LLM to try to break your code. Each attack runs on your code and on the reference solution, so a bad test can't count against you. Your workspace isn't changed.</p>
        </div>
      </div>
      ${failed && html`<${Notice} kind="fail">The attacks didn't run. ${failed}<//>`}
      ${running && html`<${JobLog} />`}
      ${last
        ? html`<${Results} last=${last} running=${running} />`
        : !running && html`<${Empty} title="No attacks yet" text="Follow the three steps below. It's optional, and it doesn't affect your score." />`}
      <ol class="steps">
        <li>
          <p class="step-title-text">Copy the prompt</p>
          <p class="muted">It holds the briefs you've seen and your code. It doesn't hold the hidden tests.</p>
          <div class="route-actions">
            <${CopyButton} getText=${copyPrompt}>Copy the prompt<//>
            <span class="meta">${info ? formatTokens(info.tokens_estimate) : ""}</span>
          </div>
        </li>
        <li>
          <p class="step-title-text">Get an LLM to write the tests</p>
          <p class="muted">Paste the prompt into any chatbot or coding agent. It writes one test file that tries to break your code.</p>
        </li>
        <li>
          <p class="step-title-text">Paste the file here</p>
          <label class="field">
            <span class="field-label">File name</span>
            <input
              type="text"
              class="mono"
              autocomplete="off"
              spellcheck=${false}
              value=${filename}
              onInput=${(event) => setFilename(event.target.value)}
            />
            <p class="field-help">
              ${info
                ? html`It runs from <code>${info.attack_dir}</code> in a temporary copy of your code.`
                : "It runs in a temporary copy of your code."}
            </p>
          </label>
          <label class="field">
            <span class="field-label">Test file</span>
            <textarea
              rows="10"
              spellcheck=${false}
              value=${attack}
              onInput=${(event) => setAttack(event.target.value)}
            ></textarea>
          </label>
          <div class="route-actions">
            <${Button}
              icon="crack"
              kind="primary"
              blocked=${blocked ?? problemWith(filename, attack)}
              onClick=${() => runJob(() => api.breakIt(round.id, filename.trim(), attack))}
            >Run the attacks<//>
          </div>
        </li>
      </ol>
      <section class="stack">
        <h3>What the verdicts mean</h3>
        <${Legend} />
      </section>
      <p class="muted"><${Icon} name="info" /> An attack only counts if the reference solution passes it, so a model that misreads the brief can't invent a bug.</p>
    </div>`;
}

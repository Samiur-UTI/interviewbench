// The two ways to get the AI review: a model connected in Settings, or any chatbot by paste.

import { Button, CopyButton } from "../../../components/button.js";
import { Loading, Notice } from "../../../components/feedback.js";
import { api } from "../../../core/api.js";
import { formatTokens, metaLine } from "../../../core/format.js";
import { useApp } from "../../../hooks/use-app.js";
import { useAsync } from "../../../hooks/use-async.js";
import { html } from "../../../preact.js";
import { useDraft, useRoundContext } from "../round-context.js";
import { judgeProblem } from "./judge-problem.js";

const BACKEND_LABEL = { claude: "Claude", openai: "OpenAI-compatible" };

function ConnectedRoute({ grade }) {
  const { round, blocked, runJob } = useRoundContext();
  const judge = useApp().status?.settings?.judge;
  const problem = judge ? judgeProblem(judge) : "Open Settings to choose a model.";
  const model = judge?.model || judge?.default_model;
  return html`
    <section class="route">
      <h4>Connected model</h4>
      <p>Uses the model in Settings. It sends the hidden tests, the reference solution and your diff to that provider, then fills in the judged criteria. Your provider charges for the call, and it can take a few minutes.</p>
      ${judge && html`<p class="meta">${metaLine(BACKEND_LABEL[judge.backend] ?? judge.backend, model)}</p>`}
      ${problem && html`<${Notice} kind="info">${problem}<//>`}
      <div class="route-actions">
        <${Button} icon="play" kind="primary" blocked=${blocked ?? problem} onClick=${() => runJob(() => api.grade(round.id, "api"))}>
          ${grade?.review ? "Run the AI review again" : "Run the AI review"}
        <//>
        <a href="#/settings">Open Settings</a>
      </div>
    </section>`;
}

function PrepareButton({ children }) {
  const { round, blocked, runJob } = useRoundContext();
  return html`<${Button} icon="play" blocked=${blocked} onClick=${() => runJob(() => api.grade(round.id, "prepare"))}>${children}<//>`;
}

function PromptProblem({ error }) {
  return html`
    ${error.status === 404
      ? html`<${Notice} kind="warn">The prompt is gone: it's only kept in memory, and the server has restarted.<//>`
      : html`<${Notice} kind="fail">Couldn't load the prompt. ${error.message}<//>`}
    <${PrepareButton}>Prepare it again<//>`;
}

function PromptSteps({ grade }) {
  const { round, memo } = useRoundContext();
  const key = grade.finished_at;
  const query = useAsync(async () => {
    if (memo.judgePrompt?.key !== key) memo.judgePrompt = { key, ...await api.judgePrompt(round.id) };
    return memo.judgePrompt;
  }, [round.id, key], memo.judgePrompt?.key === key ? memo.judgePrompt : null);

  let body;
  if (query.error) {
    body = html`<${PromptProblem} error=${query.error} />`;
  } else if (query.data?.key === key) {
    body = html`
      <div class="route-actions">
        <${CopyButton} kind="primary" getText=${() => query.data.prompt}>Copy the prompt<//>
        <span class="meta">${formatTokens(query.data.tokens_estimate)}</span>
      </div>`;
  } else {
    body = html`<${Loading} text="Loading the prompt…" />`;
  }
  return html`<div class="stack">${body}</div>`;
}

function ChatbotRoute({ grade }) {
  const { round, blocked, runJob, failure } = useRoundContext();
  const [reply, setReply] = useDraft("reply");
  const failed = failure("judge-reply");
  return html`
    <section class="route">
      <h4>Any chatbot, no key needed</h4>
      <p>Paste one prompt into ChatGPT, Claude, Gemini or any other chatbot, then paste its JSON reply back here.</p>
      <${Notice} kind="warn">
        <strong>The prompt contains the hidden tests and the reference solution. </strong>Use it when you've finished, and don't share it.
      <//>
      <ol class="steps">
        <li>
          <p class="step-title-text">Get the prompt</p>
          ${grade?.judge_prepared
            ? html`<${PromptSteps} grade=${grade} />`
            : html`<${PrepareButton}>Prepare the prompt<//>`}
        </li>
        <li>
          <p class="step-title-text">Paste it into a chatbot</p>
          <p class="muted">Ask in a new chat, and paste all of it.</p>
        </li>
        <li>
          <p class="step-title-text" id="reply-label">Paste the JSON reply here</p>
          <textarea
            rows="6"
            aria-labelledby="reply-label"
            spellcheck=${false}
            placeholder="{ ... }"
            value=${reply}
            onInput=${(event) => setReply(event.target.value)}
          ></textarea>
          ${failed && html`<${Notice} kind="fail">That reply didn't work. ${failed} Your paste is still here, so you can fix it.<//>`}
          <div class="route-actions">
            <${Button}
              icon="gauge"
              kind="primary"
              blocked=${blocked ?? (reply.trim() ? null : "Paste the reply first")}
              onClick=${() => runJob(() => api.judgeReply(round.id, reply))}
            >Score this reply<//>
          </div>
        </li>
      </ol>
    </section>`;
}

// `grade` is null before the first grade. Once there's a review, asking for another moves out of the way.
export function Routes({ grade }) {
  const body = html`
    <p class="muted">Pick either route. Use a model family other than the one that helped you solve the task, because LLM judges favour their own family's work.</p>
    <${ConnectedRoute} grade=${grade} />
    <${ChatbotRoute} grade=${grade} />`;
  return grade?.review
    ? html`
      <details class="explainer">
        <summary>Get another AI review</summary>
        <div class="explainer-body">${body}</div>
      </details>`
    : html`
      <section class="stack">
        <h3>Get the AI review</h3>
        ${body}
      </section>`;
}

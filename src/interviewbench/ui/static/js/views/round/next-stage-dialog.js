// Confirms moving on, because a revealed stage can't be hidden again.

import { Button } from "../../components/button.js";
import { Dialog } from "../../components/dialog.js";
import { Notice } from "../../components/feedback.js";
import { api } from "../../core/api.js";
import { useAction } from "../../hooks/use-action.js";
import { html } from "../../preact.js";

export function NextStageDialog({ round, onClose, onMoved }) {
  const next = round.stage + 1;
  const [busy, error, act] = useAction();

  const proceed = () => act(async () => {
    const moved = await api.nextStage(round.id);
    onClose();  // first: nothing behind an open dialog can take focus
    onMoved(moved);
  });

  const actions = html`
    <${Button} autofocus onClick=${onClose}>Not yet<//>
    <${Button} kind="primary" icon="arrow-right" busy=${busy && "Moving on…"} onClick=${proceed}>
      ${round.git ? `Commit and show stage ${next}` : `Show stage ${next}`}
    <//>`;

  return html`
    <${Dialog} title=${`Move on to stage ${next}?`} onClose=${onClose} actions=${actions}>
      <ul class="plain-list">
        <li>
          ${round.git
            ? html`Your work so far is committed and tagged <code>stage-${round.stage}</code>.`
            : "This round has no git history, so no checkpoint is saved."}
        </li>
        <li>The brief for stage ${next} appears. It can't be hidden again, so this can't be undone.</li>
        <li>Your code stays as it is, and the clock keeps running.</li>
      </ul>
      ${error && html`<${Notice} kind="fail">Couldn't move on. ${error}<//>`}
    <//>`;
}

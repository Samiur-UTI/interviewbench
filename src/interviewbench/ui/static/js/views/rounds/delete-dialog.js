// Deleting a round removes its folder, so the candidate has to type the round's id first.

import { Button, CopyablePath } from "../../components/button.js";
import { Dialog } from "../../components/dialog.js";
import { Notice } from "../../components/feedback.js";
import { api } from "../../core/api.js";
import { useAction } from "../../hooks/use-action.js";
import { html, useState } from "../../preact.js";

export function DeleteDialog({ round, onClose, onDeleted }) {
  const [typed, setTyped] = useState("");
  const [busy, error, act] = useAction();

  const remove = () => act(async () => {
    await api.deleteRound(round.id);
    onDeleted();
  });

  const actions = html`
    <${Button} onClick=${onClose}>Keep it<//>
    <${Button}
      kind="danger"
      icon="trash"
      blocked=${typed === round.id ? null : `Type ${round.id} first`}
      busy=${busy && "Deleting…"}
      onClick=${remove}
    >Delete this round<//>`;

  return html`
    <${Dialog} title=${`Delete ${round.id}?`} onClose=${onClose} actions=${actions}>
      <p>This removes the whole folder, including all your work in it. It can't be undone.</p>
      <${CopyablePath} path=${round.path} />
      <label class="field">
        <span class="field-label">Type <code>${round.id}</code> to confirm</span>
        <input
          type="text"
          class="mono"
          autocomplete="off"
          spellcheck=${false}
          autofocus=${true}
          value=${typed}
          onInput=${(event) => setTyped(event.target.value)}
        />
      </label>
      <div>${error && html`<${Notice} kind="fail">Couldn't delete this round. ${error}<//>`}</div>
    <//>`;
}

// What happens when a round starts. Remembered per browser.

import { useApp } from "../../app/app-context.js";
import { recall, remember } from "../../core/storage.js";
import { html, useState } from "../../preact.js";

export function useStartOptions() {
  const [options, setOptions] = useState(() => recall("start-options", { editor: true, git: true }));
  const update = (change) => {
    const next = { ...options, ...change };
    setOptions(next);
    remember("start-options", next);
  };
  return [options, update];
}

export function StartOptions({ options, onChange }) {
  const editor = useApp().status?.editor;
  return html`
    <fieldset class="start-options">
      <legend>When a round starts</legend>
      <label class="check">
        <input
          type="checkbox"
          checked=${options.editor && Boolean(editor)}
          disabled=${!editor}
          onChange=${(event) => onChange({ editor: event.target.checked })}
        />
        ${editor ? `Open the folder in ${editor}` : "Open the folder in my editor (none found)"}
      </label>
      <label class="check">
        <input type="checkbox" checked=${options.git} onChange=${(event) => onChange({ git: event.target.checked })} />
        Save each stage in a git history
      </label>
    </fieldset>`;
}

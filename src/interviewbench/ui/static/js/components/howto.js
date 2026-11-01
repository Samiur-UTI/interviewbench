// "How a round works": shown once per browser on the Tasks screen, and on demand from the status bar.

import { recall, remember } from "../core/storage.js";
import { html, useState } from "../preact.js";
import { Button } from "./button.js";
import { Dialog } from "./dialog.js";
import { Icon } from "./icon.js";

function Steps() {
  return html`
    <ol class="howto-steps">
      <li><strong>Start a task.</strong> The clock starts and the starter code lands in a folder of its own. Open only that folder in your editor, and use any AI assistant you like there.</li>
      <li><strong>Work through the stages.</strong> There are usually three: fix a bug, add a feature, optimize. Run your own tests here whenever you want. The hidden tests stay hidden.</li>
      <li><strong>Move on when you're ready.</strong> Next stage saves your work and shows the next brief. You only see a stage once you get to it.</li>
      <li><strong>Grade your work.</strong> The hidden tests for every stage run, and an AI reviewer can score the rest. Then try Break it to see if an LLM can break your code.</li>
    </ol>`;
}

export function HowToDialog({ onClose }) {
  const close = html`<${Button} kind="primary" onClick=${onClose}>Got it<//>`;
  return html`<${Dialog} title="How a round works" onClose=${onClose} actions=${close}><${Steps} /><//>`;
}

export function HowToNote() {
  const [dismissed, setDismissed] = useState(() => recall("howto-dismissed", false));
  if (dismissed) return null;
  const dismiss = () => {
    remember("howto-dismissed", true);
    setDismissed(true);
  };
  return html`
    <section class="howto" aria-label="How a round works">
      <div class="howto-head">
        <h2>How a round works</h2>
        <button type="button" class="icon-button" aria-label="Dismiss this note" onClick=${dismiss}>
          <${Icon} name="cross" />
        </button>
      </div>
      <${Steps} />
    </section>`;
}

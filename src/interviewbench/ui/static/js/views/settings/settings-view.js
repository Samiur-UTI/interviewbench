// Settings: the model behind the connected AI review. Keys stay in the server's memory.

import { Async, Notice } from "../../components/feedback.js";
import { api } from "../../core/api.js";
import { useApp } from "../../hooks/use-app.js";
import { useAsync } from "../../hooks/use-async.js";
import { html, useState } from "../../preact.js";
import { SettingsForm } from "./settings-form.js";

export function SettingsView() {
  const { updateSettings } = useApp();
  const [saves, setSaves] = useState(0);
  const query = useAsync(async () => (await api.settings()).judge);

  const saved = (settings) => {
    updateSettings(settings);
    query.set(settings.judge);
    setSaves((count) => count + 1);
  };

  const form = (judge) => html`
    <${SettingsForm} key=${saves} judge=${judge} onSaved=${saved} focusSave=${saves > 0} />
    ${saves > 0 && html`<${Notice} kind="ok">Saved.<//>`}`;

  return html`
    <div class="page narrow">
      <header class="page-head">
        <h1>Settings</h1>
        <p>The model behind the connected AI review on the Grade panel. You don't need one: any chatbot can do the review with no key at all.</p>
      </header>
      <div>
        <${Async} query=${query} loading="Loading settings…" failed="Couldn't load your settings" render=${form} />
      </div>
      <div class="stack settings-notes">
        <h2>Where your data goes</h2>
        <ul class="plain-list">
          <li>A key you enter stays in this app's memory while it runs. It's never written to disk, and it goes when the app stops.</li>
          <li>An AI review sends the hidden tests, the reference solution and your diff to this provider, and it charges you for the call.</li>
          <li>Pick a model family other than the one that helped solve the task, because LLM judges favour their own family's work.</li>
        </ul>
      </div>
    </div>`;
}

// The judge's provider, model and key. A key typed here goes to the server's memory and never comes back.

import { Button } from "../../components/button.js";
import { Notice } from "../../components/feedback.js";
import { announce } from "../../core/announce.js";
import { api } from "../../core/api.js";
import { useAction } from "../../hooks/use-action.js";
import { html, useEffect, useRef, useState } from "../../preact.js";
import { PRESETS, presetFor } from "./presets.js";

function keyStatus(judge) {
  if (judge.key_source === "session") return "A key is set for this session.";
  if (judge.key_source === "env") return "Using the key from your environment.";
  return "No key set.";
}

function keyNote(judge, preset, original) {
  if (preset.id === "ollama") return "Not needed for a model on this computer.";
  if (judge.has_api_key && preset !== original) {
    return `${keyStatus(judge)} It will be sent to this provider, so enter this provider's key or clear it.`;
  }
  return keyStatus(judge);
}

// The view remounts this after each save, so `focusSave` puts focus back on the rebuilt button.
export function SettingsForm({ judge, onSaved, focusSave }) {
  const original = presetFor(judge);
  const [preset, setPreset] = useState(original);
  const [model, setModel] = useState(judge.model ?? "");
  const [baseUrl, setBaseUrl] = useState(judge.base_url ?? "");
  const [apiKey, setApiKey] = useState("");
  const [busy, error, act] = useAction();
  const form = useRef(null);
  const claude = preset.backend === "claude";

  useEffect(() => {
    if (focusSave) form.current.querySelector('[type="submit"]').focus();
  }, []);

  const save = (extra = {}) => act(async () => {
    const body = { backend: preset.backend, model: model.trim(), base_url: claude ? "" : baseUrl.trim(), ...extra };
    if (apiKey && extra.api_key === undefined) body.api_key = apiKey;
    onSaved(await api.saveSettings(body));
    announce("Settings saved.");
  });

  const choose = (item) => {
    setPreset(item);
    if (item.backend === "openai") setBaseUrl(item.base_url);
  };

  const submit = (event) => {
    event.preventDefault();
    save();
  };

  return html`
    <form ref=${form} class="stack settings-form" onSubmit=${submit}>
      <fieldset class="stack">
        <legend class="field-label">Provider</legend>
        <div class="presets">
          ${PRESETS.map((item) => html`
            <label key=${item.id} class="check">
              <input type="radio" name="preset" checked=${item === preset} onChange=${() => choose(item)} />
              ${item.label}
            </label>`)}
        </div>
      </fieldset>
      <label class="field">
        <span class="field-label">Model</span>
        <input
          type="text"
          class="mono"
          autocomplete="off"
          spellcheck=${false}
          placeholder=${claude ? judge.default_model ?? "" : "The model's exact name at this provider"}
          value=${model}
          onInput=${(event) => setModel(event.target.value)}
        />
      </label>
      <label class="field" hidden=${claude}>
        <span class="field-label">API address</span>
        <input
          type="url"
          class="mono"
          autocomplete="off"
          disabled=${claude}
          spellcheck=${false}
          value=${baseUrl}
          onInput=${(event) => setBaseUrl(event.target.value)}
        />
        <span class="field-help">The provider's OpenAI-compatible endpoint.</span>
      </label>
      <div class="field">
        <label class="field-label" for="api-key">API key</label>
        <div class="key-row">
          <input
            id="api-key"
            type="password"
            class="mono"
            autocomplete="off"
            spellcheck=${false}
            value=${apiKey}
            onInput=${(event) => setApiKey(event.target.value)}
          />
          <${Button} kind="ghost small" hidden=${judge.key_source !== "session"} onClick=${() => save({ api_key: "" })}>Clear key<//>
        </div>
        <p class="field-help">${keyNote(judge, preset, original)}</p>
      </div>
      <div>
        ${claude && !judge.claude_sdk_installed && html`
          <${Notice} kind="warn">The Claude connection needs an optional package that isn't installed, so pick another provider here, or use a chatbot on the Grade panel.<//>`}
      </div>
      <div>${error && html`<${Notice} kind="fail">Couldn't save. ${error}<//>`}</div>
      <div class="route-actions">
        <${Button} kind="primary" type="submit" busy=${busy && "Saving…"}>Save settings<//>
      </div>
    </form>`;
}

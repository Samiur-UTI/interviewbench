// Settings: the model behind the connected AI review. Keys stay in the server's memory.

import { api } from "../api.js";
import { app } from "../state.js";
import { announce, button, errorBlock, h, loadingBlock, notice, withBusy } from "../ui.js";

const PRESETS = [
  { id: "claude", label: "Claude", backend: "claude", base_url: "" },
  { id: "openrouter", label: "OpenRouter", backend: "openai", base_url: "https://openrouter.ai/api/v1" },
  { id: "gemini", label: "Gemini", backend: "openai", base_url: "https://generativelanguage.googleapis.com/v1beta/openai" },
  { id: "groq", label: "Groq", backend: "openai", base_url: "https://api.groq.com/openai/v1" },
  { id: "ollama", label: "Ollama (on this computer)", backend: "openai", base_url: "http://localhost:11434/v1" },
  { id: "custom", label: "Another OpenAI-compatible API", backend: "openai", base_url: "" },
];

function presetFor(judge) {
  if (judge.backend === "claude") return PRESETS[0];
  return PRESETS.find((p) => p.base_url && p.base_url === judge.base_url) ?? PRESETS[PRESETS.length - 1];
}

function keyStatus(judge) {
  if (judge.key_source === "session") return "A key is set for this session.";
  if (judge.key_source === "env") return "Using the key from your environment.";
  return "No key set.";
}

function form(root, judge, onSaved) {
  const original = presetFor(judge);
  let preset = original;
  const feedback = h("div");
  const keyNote = h("p", { class: "field-help" });
  const sdkNote = h("div");

  const model = h("input", { type: "text", class: "mono", autocomplete: "off", spellcheck: "false", value: judge.model ?? "" });
  const baseUrl = h("input", { type: "url", class: "mono", autocomplete: "off", spellcheck: "false", value: judge.base_url ?? "" });
  const apiKey = h("input", { type: "password", class: "mono", autocomplete: "off", spellcheck: "false" });
  const urlField = h("label", { class: "field" },
    h("span", { class: "field-label" }, "API address"),
    baseUrl,
    h("span", { class: "field-help" }, "The provider's OpenAI-compatible endpoint."));

  function showPreset() {
    urlField.hidden = preset.backend === "claude";
    model.placeholder = preset.backend === "claude" ? judge.default_model ?? "" : "The model's exact name at this provider";
    const local = preset.id === "ollama";
    const moved = judge.has_api_key && preset !== original;
    keyNote.textContent = local ? "Not needed for a model on this computer."
      : moved ? `${keyStatus(judge)} It will be sent to this provider, so enter this provider's key or clear it.`
        : keyStatus(judge);
    clear.hidden = judge.key_source !== "session";
    sdkNote.replaceChildren(preset.backend === "claude" && !judge.claude_sdk_installed
      ? notice("warn", "The Claude connection needs an optional package that isn't installed, so pick another provider here, or use a chatbot on the Grade panel.")
      : "");
  }

  const save = (extra = {}) => {
    if (saveButton.getAttribute("aria-disabled") === "true") return;
    withBusy(saveButton, "Saving…", async () => {
      feedback.replaceChildren();
      try {
        const body = { backend: preset.backend, model: model.value.trim(), base_url: preset.backend === "claude" ? "" : baseUrl.value.trim(), ...extra };
        if (apiKey.value && extra.api_key === undefined) body.api_key = apiKey.value;
        onSaved(await api.saveSettings(body));
        announce("Settings saved.");
      } catch (err) {
        feedback.replaceChildren(notice("fail", `Couldn't save. ${err.message}`));
      }
    });
  };

  const saveButton = button("Save settings", { kind: "primary", type: "submit" });
  const clear = button("Clear key", { kind: "ghost small", onClick: () => save({ api_key: "" }) });

  const formElement = h("form", {
    class: "stack settings-form",
    onsubmit: (event) => {
      event.preventDefault();
      save();
    },
  },
  h("fieldset", { class: "stack" },
    h("legend", { class: "field-label" }, "Provider"),
    h("div", { class: "presets" }, PRESETS.map((item) => h("label", { class: "check" },
      h("input", {
        type: "radio",
        name: "preset",
        checked: item === preset,
        onchange: () => {
          preset = item;
          if (item.backend === "openai") baseUrl.value = item.base_url;
          showPreset();
        },
      }),
      item.label)))),
  h("label", { class: "field" }, h("span", { class: "field-label" }, "Model"), model),
  urlField,
  h("div", { class: "field" },
    h("label", { class: "field-label", for: "api-key" }, "API key"),
    h("div", { class: "key-row" }, apiKey, clear),
    keyNote),
  sdkNote,
  feedback,
  h("div", { class: "route-actions" }, saveButton));
  apiKey.id = "api-key";
  showPreset();
  root.replaceChildren(formElement);
}

export function show(main, _params, signal) {
  const slot = h("div", null, loadingBlock("Loading settings…"));
  main.append(h("div", { class: "page narrow" },
    h("header", { class: "page-head" },
      h("h1", null, "Settings"),
      h("p", null, "The model behind the connected AI review on the Grade panel. You don't need one: any chatbot can do the review with no key at all.")),
    slot,
    h("div", { class: "stack settings-notes" },
      h("h2", null, "Where your data goes"),
      h("ul", { class: "plain-list" },
        h("li", null, "A key you enter stays in this app's memory while it runs. It's never written to disk, and it goes when the app stops."),
        h("li", null, "An AI review sends the hidden tests, the reference solution and your diff to this provider, and it charges you for the call."),
        h("li", null, "Pick a model family other than the one that helped solve the task, because LLM judges favour their own family's work.")))));

  const saved = (settings) => {
    if (app.status) app.status.settings = settings;
    form(slot, settings.judge, saved);
    slot.querySelector('[type="submit"]').focus();  // the button that had focus was just rebuilt
    slot.append(notice("ok", "Saved."));
  };

  async function load() {
    slot.replaceChildren(loadingBlock("Loading settings…"));
    try {
      const { judge } = await api.settings();
      if (!signal.aborted) form(slot, judge, saved);
    } catch (err) {
      if (!signal.aborted) slot.replaceChildren(errorBlock(err, load, "Couldn't load your settings"));
    }
  }

  load();
}

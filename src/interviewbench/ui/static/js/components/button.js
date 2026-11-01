// Buttons. `blocked` says why the action can't run now: the button stays focusable (aria-disabled,
// not disabled) so keyboard users keep their place and can read why.

import { announce } from "../core/announce.js";
import { html, useEffect, useRef, useState } from "../preact.js";
import { Icon } from "./icon.js";

// `busy` is the label to show while a short call runs. Pass it as a string, or a falsy value for idle.
export function Button({ icon, kind = "secondary", blocked, busy, onClick, type = "button", children, ...attrs }) {
  const disabled = Boolean(blocked || busy);
  const click = (event) => {
    if (disabled) event.preventDefault();
    else onClick?.(event);
  };
  return html`
    <button
      ...${attrs}
      type=${type}
      class=${`button ${kind}`}
      title=${blocked || null}
      aria-disabled=${disabled ? "true" : null}
      onClick=${click}
    >
      ${icon && html`<${Icon} name=${icon} />`}<span>${busy || children}</span>
    </button>`;
}

async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.className = "visually-hidden";
    area.value = text;
    document.body.append(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    return copied;
  }
}

// getText may be async, for prompts the server builds on demand.
export function CopyButton({ getText, children, ...attrs }) {
  const [shown, setShown] = useState(null);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    clearTimeout(timer.current);
    let message = "Couldn't copy. Select the text and copy it yourself.";
    try {
      if (await writeClipboard(await getText())) message = "Copied";
    } catch (err) {
      message = err.message;
    }
    setShown(message === "Copied" ? "Copied" : "Copy failed");
    announce(message);
    timer.current = setTimeout(() => setShown(null), 2000);
  };

  return html`<${Button} icon="copy" ...${attrs} onClick=${copy}>${shown ?? children}<//>`;
}

// A path with its copy button. The path is selectable text too.
export function CopyablePath({ path, label = "Copy path" }) {
  return html`
    <span class="path">
      <code class="path-text" title=${path}>${path}</code>
      <${CopyButton} kind="ghost small" getText=${() => path}>${label}<//>
    </span>`;
}

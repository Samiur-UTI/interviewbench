// DOM helpers shared by the views. Children become text nodes, so server text is never parsed as HTML.

import { icon } from "./icons.js";

const PROPERTIES = new Set(["value", "checked", "disabled", "open"]);

export function h(tag, props, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith("on")) element.addEventListener(key.slice(2), value);
    else if (PROPERTIES.has(key)) element[key] = value;
    else element.setAttribute(key, value === true ? "" : value);
  }
  element.append(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false));
  return element;
}

export function announce(text) {
  const live = document.getElementById("live");
  live.textContent = "";
  // A fresh text node in a later frame, or a repeated message isn't read out.
  requestAnimationFrame(() => {
    live.textContent = text;
  });
}

// `blocked` says why the action can't run now. The button stays focusable (aria-disabled, not
// disabled) so keyboard users keep their place and can read why.
export function button(label, { icon: name, kind = "secondary", onClick, blocked, ...attrs } = {}) {
  const element = h("button", { type: "button", class: `button ${kind}`, ...attrs }, name && icon(name), h("span", null, label));
  element.addEventListener("click", (event) => {
    if (element.getAttribute("aria-disabled") === "true") event.preventDefault();
    else onClick?.(event);
  });
  if (blocked) setBlocked(element, blocked);
  return element;
}

export function setBlocked(element, reason) {
  if (reason) {
    element.setAttribute("aria-disabled", "true");
    element.title = reason;
  } else {
    element.removeAttribute("aria-disabled");
    element.removeAttribute("title");
  }
}

// Runs fn while the button says what's happening. For short calls; long work runs as a job.
export async function withBusy(element, label, fn) {
  const text = element.querySelector("span");
  const idle = text.textContent;
  text.textContent = label;
  element.setAttribute("aria-disabled", "true");
  try {
    return await fn();
  } finally {
    text.textContent = idle;
    element.removeAttribute("aria-disabled");
  }
}

async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = h("textarea", { class: "visually-hidden", readonly: true }, text);
    document.body.append(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    return copied;
  }
}

// getText may be async, for prompts the server builds on demand.
export function copyButton(label, getText, attrs = {}) {
  let timer;
  const element = button(label, {
    icon: "copy",
    ...attrs,
    onClick: async () => {
      const text = element.querySelector("span");
      clearTimeout(timer);
      let message = "Couldn't copy. Select the text and copy it yourself.";
      try {
        if (await writeClipboard(await getText())) message = "Copied";
      } catch (err) {
        message = err.message;
      }
      text.textContent = message === "Copied" ? "Copied" : "Copy failed";
      announce(message);
      timer = setTimeout(() => {
        text.textContent = label;
      }, 2000);
    },
  });
  return element;
}

// A path with its copy button. The path is selectable text too.
export function copyablePath(path, label = "Copy path") {
  return h("span", { class: "path" },
    h("code", { class: "path-text", title: path }, path),
    copyButton(label, () => path, { kind: "ghost small" }));
}

export function openDialog({ title, body, actions, onClose }) {
  const heading = h("h2", { id: "dialog-title" }, title);
  const dialog = h("dialog", { class: "dialog", "aria-labelledby": "dialog-title" },
    heading, h("div", { class: "dialog-body" }, body), h("div", { class: "dialog-actions" }, actions));
  dialog.addEventListener("close", () => {
    dialog.remove();
    onClose?.();
  });
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}

// The states every panel must design for. Each keeps its slot filled, so nothing is ever blank.
export function loadingBlock(text) {
  return h("div", { class: "state", role: "status" }, h("span", { class: "spinner", "aria-hidden": "true" }), h("p", null, text));
}

export function emptyBlock(title, text, action) {
  return h("div", { class: "state" }, h("h2", null, title), text && h("p", null, text), action);
}

export function errorBlock(err, retry, title = "That didn't work") {
  const hint = err.status === 0 ? "Check that ib ui is still running, then try again." : null;
  return h("div", { class: "state error", role: "alert", "data-failed": "" },
    h("h2", null, icon("alert"), " ", title),
    h("p", null, err.message),
    hint && h("p", null, hint),
    retry && button("Try again", { icon: "refresh", onClick: retry }));
}

export function notice(kind, content, action) {
  const name = { ok: "check", warn: "alert", fail: "cross", info: "info" }[kind];
  return h("div", { class: `notice ${kind}` }, icon(name), h("div", { class: "notice-text" }, content), action);
}

// Status is never colour alone: every badge carries its label and an icon.
export function badge(kind, label, name) {
  return h("span", { class: `badge ${kind}` }, name && icon(name), label);
}

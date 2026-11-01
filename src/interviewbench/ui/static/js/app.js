// Router, the app frame (theme, status bar, connection banner) and the 401 screen.

import { api, connection } from "./api.js";
import { icon } from "./icons.js";
import { app, recall, remember, setStatus } from "./state.js";
import { announce, button, h } from "./ui.js";
import * as author from "./views/author.js";
import { showHowTo } from "./views/howto.js";
import * as round from "./views/round.js";
import * as rounds from "./views/rounds.js";
import * as settings from "./views/settings.js";
import * as tasks from "./views/tasks.js";

const STATUS_POLL_MS = 15000;
const STATUS_POLL_OFFLINE_MS = 3000;

const main = document.getElementById("main");
const banner = document.getElementById("banner");
const statusbar = document.getElementById("statusbar");
const themeToggle = document.getElementById("theme-toggle");

function parseRoute(hash) {
  const [name, id, panel] = hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  if (name === "tasks" && !id) return { nav: "tasks", title: "Tasks", view: tasks };
  if (name === "rounds" && !id) return { nav: "rounds", title: "Rounds", view: rounds };
  if (name === "rounds") return { nav: "rounds", title: id, view: round, key: id, params: { id, panel } };
  if (name === "author" && !id) return { nav: "author", title: "Author", view: author };
  if (name === "settings" && !id) return { nav: "settings", title: "Settings", view: settings };
  return null;
}

let current = null;  // { route, leave, update, controller }
let needsAuth = false;

function render({ focus = true } = {}) {
  let route = null;
  try {
    route = parseRoute(location.hash);
  } catch {
    // a malformed % escape in a hand-typed address
  }
  if (!route) {
    location.replace("#/tasks");
    return;
  }
  if (needsAuth) return;
  if (current?.route.key && current.route.key === route.key) {
    current.route = route;
    current.update?.(route.params);
    return;
  }
  current?.controller.abort();
  current?.leave?.();
  const controller = new AbortController();
  main.replaceChildren();
  main.scrollTop = 0;
  main.classList.remove("fixed");
  document.title = `${route.title} · interviewbench`;
  for (const link of document.querySelectorAll("[data-nav]")) {
    if (link.dataset.nav === route.nav) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  const { leave, update } = route.view.show(main, route.params, controller.signal) ?? {};
  current = { route, leave, update, controller };
  if (focus) main.focus({ preventScroll: true });
}

function showAuthRequired() {
  needsAuth = true;
  current?.controller.abort();
  current?.leave?.();
  current = null;
  main.replaceChildren(h("div", { class: "page" }, h("div", { class: "state" },
    h("h2", null, "Open the link ib ui printed"),
    h("p", null, "This page can only talk to the server through the private link shown in the terminal where you ran ib ui. Open that link, or start ib ui again to get a new one."),
    button("Reload", { icon: "refresh", onClick: () => location.reload() }))));
  banner.hidden = true;
}

function setBanner(online) {
  banner.hidden = online || needsAuth;
  if (online) {
    banner.replaceChildren();
    if (main.querySelector("[data-failed]")) render({ focus: false });
    return;
  }
  banner.replaceChildren(icon("alert"),
    h("span", null, "Can't reach the server. It may have stopped, or the computer went to sleep. Your work is safe in its folder. Trying again…"),
    button("Try now", { kind: "ghost small", onClick: refreshStatus }));
}

function statusItem(state, name, text) {
  return h("span", { class: `status-item ${state}` }, icon(name), text);
}

function renderStatus() {
  const status = app.status;
  if (!status) {
    statusbar.replaceChildren(h("span", { class: "status-item" }, "Checking this computer…"));
    return;
  }
  const { docker, bash, default: runner } = status.runner;
  const usable = runner === "docker" ? docker : runner ? bash : false;
  const editor = status.editor;
  statusbar.replaceChildren(
    usable
      ? statusItem("ok", "check", `Tests run: ${runner === "docker" ? "in Docker" : "on this computer"}`)
      : statusItem("warn", "alert", "No way to run tests: start Docker or install Git Bash"),
    docker ? statusItem("ok", "check", "Docker running") : statusItem("off", "ring", "Docker not running"),
    editor ? statusItem("ok", "check", `Editor: ${editor}`) : statusItem("off", "ring", "No editor found"),
    h("span", { class: "status-spacer" }),
    h("button", { type: "button", class: "link-button", onclick: showHowTo }, "How a round works"),
    h("span", { class: "status-item" }, `v${status.version}`),
  );
}

let pollTimer;

async function refreshStatus() {
  clearTimeout(pollTimer);
  let wait = STATUS_POLL_MS;
  try {
    setStatus(await api.status());
    renderStatus();
  } catch (err) {
    if (err.status === 401) return;
    wait = STATUS_POLL_OFFLINE_MS;
  }
  pollTimer = setTimeout(refreshStatus, wait);
}

function setTheme(theme) {
  const root = document.documentElement;
  if (theme) root.dataset.theme = theme;
  const shown = theme ?? root.dataset.theme ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = shown === "dark" ? "light" : "dark";
  themeToggle.replaceChildren(icon(shown === "dark" ? "sun" : "moon"));
  themeToggle.setAttribute("aria-label", `Switch to ${next} theme`);
  themeToggle.title = `Switch to ${next} theme`;
  themeToggle.dataset.next = next;
}

themeToggle.addEventListener("click", () => {
  const theme = themeToggle.dataset.next;
  setTheme(theme);
  remember("theme", theme);
  announce(`${theme} theme`);
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => setTheme(null));
setTheme(recall("theme", null));

document.getElementById("skip-link").addEventListener("click", () => main.focus());
connection.addEventListener("auth", showAuthRequired);
connection.addEventListener("online", () => {
  setBanner(true);
  refreshStatus();
});
connection.addEventListener("offline", () => setBanner(false));
window.addEventListener("hashchange", () => render());

renderStatus();
await refreshStatus();
render({ focus: false });

// The entry point. index.html loads this and nothing else.

import { App } from "./app/app.js";
import { html, render } from "./preact.js";

render(html`<${App} />`, document.getElementById("app"));

document.getElementById("skip-link").addEventListener("click", () => document.getElementById("main").focus());

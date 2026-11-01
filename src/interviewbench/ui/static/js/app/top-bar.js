// The top of every page: the brand, the main navigation and the theme switch.

import { Icon } from "../components/icon.js";
import { announce } from "../core/announce.js";
import { HOME, NAV } from "../core/routes.js";
import { html } from "../preact.js";
import { useTheme } from "./use-theme.js";

function ThemeSwitch() {
  const { theme, toggle } = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  const label = `Switch to ${next} theme`;
  const press = () => announce(`${toggle()} theme`);
  return html`
    <button class="icon-button" type="button" aria-label=${label} title=${label} onClick=${press}>
      <${Icon} name=${theme === "dark" ? "sun" : "moon"} />
    </button>`;
}

export function TopBar({ current }) {
  return html`
    <header class="topbar">
      <a class="brand" href=${HOME}>
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M1.5 6h13v2h-13zM3.5 8H5v5.5H3.5zM11 8h1.5v5.5H11z" /></svg>
        <span>interviewbench</span>
      </a>
      <nav class="mainnav" aria-label="Main">
        ${NAV.map(({ name, label, href }) => html`
          <a href=${href} aria-current=${name === current ? "page" : null}>${label}</a>`)}
      </nav>
      <${ThemeSwitch} />
    </header>`;
}

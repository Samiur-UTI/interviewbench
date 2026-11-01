// Markdown on the page. setMarkdown escapes first, and it's the only way HTML reaches the page.

import { setMarkdown } from "../core/markdown.js";
import { html, useLayoutEffect, useRef } from "../preact.js";

export function MarkdownView({ source, headingOffset, class: className = "md" }) {
  const body = useRef(null);
  useLayoutEffect(() => {
    setMarkdown(body.current, source, { headingOffset });
  }, [source, headingOffset]);
  return html`<div ref=${body} class=${className}></div>`;
}

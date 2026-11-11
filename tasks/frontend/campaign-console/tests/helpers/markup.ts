// Reading server-rendered markup (render-to-string output) the way assistive technology and a
// browser would: elements with their attributes, the text of an element, labels of inputs.
//
//   const html = renderToString(client.html`<${client.ReconnectForm} connection=${c} />`);
//   const inputs = elements(html, "input");               // [{ tag, attrs: { name, type, ... } }]
//   labelFor(html, inputs[0].attrs.id);                    // "Access token"
//   textById(html, "reconnect-conn_twilio-title");         // "Reconnect Twilio"
//
// Attribute names are lower-cased (readOnly and readonly are the same attribute); a bare attribute
// (`readonly`, `disabled`, `value` with an empty value) has the value "".
import { decodeEntities } from "./browser.ts";

export interface Element {
  tag: string;
  attrs: Record<string, string>;
  /** Offset of the start tag in the markup. */
  index: number;
  /** Offset just past the start tag. */
  end: number;
}

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const START_TAG = /<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*\/?>/g;
const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of source.matchAll(ATTR)) attrs[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  return attrs;
}

/** Every element's start tag, in document order (optionally only `tag`). */
export function elements(html: string, tag?: string): Element[] {
  const found: Element[] = [];
  for (const m of html.matchAll(START_TAG)) {
    const name = m[1].toLowerCase();
    if (tag && name !== tag.toLowerCase()) continue;
    found.push({ tag: name, attrs: parseAttrs(m[2] ?? ""), index: m.index!, end: m.index! + m[0].length });
  }
  return found;
}

/** The markup inside `element` (up to its matching end tag). "" for void elements. */
export function innerHtml(html: string, element: Element): string {
  if (VOID.has(element.tag)) return "";
  const pattern = new RegExp(`<(/?)${element.tag}\\b[^>]*?(/?)>`, "gi");
  pattern.lastIndex = element.end;
  let depth = 1;
  for (let m = pattern.exec(html); m; m = pattern.exec(html)) {
    if (m[1]) depth -= 1;
    else if (!m[2]) depth += 1;
    if (depth === 0) return html.slice(element.end, m.index);
  }
  return html.slice(element.end);
}

/** The text of `element`, tags removed, entities decoded, whitespace collapsed. */
export function textOf(html: string, element: Element): string {
  return decodeEntities(innerHtml(html, element).replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

export function byId(html: string, id: string): Element | undefined {
  return elements(html).find((e) => e.attrs.id === id);
}

/** Text of the element with that id, or undefined when there is none. */
export function textById(html: string, id: string): string | undefined {
  const element = byId(html, id);
  return element ? textOf(html, element) : undefined;
}

/** Text of the elements an aria-labelledby / aria-describedby value points at (space-separated ids). */
export function textOfIds(html: string, ids: string | undefined): string {
  return (ids ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => textById(html, id) ?? "")
    .join(" ")
    .trim();
}

/**
 * The accessible label of the input with that id: the text of `<label for=id>` (or of a label
 * wrapping it), or what aria-labelledby / aria-label say. "" when it has none.
 */
export function labelFor(html: string, inputId: string | undefined): string {
  if (!inputId) return "";
  const input = byId(html, inputId);
  if (input?.attrs["aria-labelledby"]) return textOfIds(html, input.attrs["aria-labelledby"]);
  if (input?.attrs["aria-label"]) return input.attrs["aria-label"].trim();
  const labels = elements(html, "label");
  const explicit = labels.find((l) => l.attrs.for === inputId);
  if (explicit) return textOf(html, explicit);
  const wrapping = labels.find((l) => input && l.end <= input.index && innerHtml(html, l).includes(`id="${inputId}"`));
  return wrapping ? textOf(html, wrapping) : "";
}

/** Attribute present (bare or with any value other than "false"). */
export function hasFlag(element: Element | undefined, name: string): boolean {
  if (!element) return false;
  const value = element.attrs[name.toLowerCase()];
  return value !== undefined && value !== "false";
}

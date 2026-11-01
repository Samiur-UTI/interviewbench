// Escape-first Markdown for task briefs and model text. The whole source is HTML-escaped before any
// parsing, so every tag in the output is written by this file: nothing in the source can open one.

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

const FENCE = /^( {0,3})(`{3,}|~{3,})\s*([^`]*)$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^ {0,3}([-*_])\s*(?:\1\s*){2,}$/;
const QUOTE = /^ {0,3}&gt; ?/;
const LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])( +|$)(.*)$/;
const INDENTED = /^ {4}/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const SAFE_LINK = /^(?:https?:|mailto:)/i;
// Stand-ins for finished inline HTML. The source can't contain them: they are stripped up front.
const HOLD_OPEN = "";
const HOLD_CLOSE = "";

function indentOf(line) {
  return line.length - line.trimStart().length;
}

function isListItem(line) {
  return LIST_ITEM.test(line) && !HR.test(line);
}

function isTableStart(lines, i) {
  return lines[i].includes("|") && i + 1 < lines.length && lines[i + 1].includes("-")
    && lines[i + 1].includes("|") && TABLE_RULE.test(lines[i + 1]);
}

function startsBlock(lines, i) {
  const line = lines[i];
  return HEADING.test(line) || FENCE.test(line) || HR.test(line) || QUOTE.test(line)
    || isListItem(line) || isTableStart(lines, i);
}

function inline(text) {
  const held = [];
  const hold = (html) => `${HOLD_OPEN}${held.push(html) - 1}${HOLD_CLOSE}`;
  const out = text
    // One pass, left to right, so a backslash can guard a backtick and code can hold a backslash.
    .replace(/\\([\\`*_{}[\]()#+\-.!|~])|(`+)([\s\S]*?[^`])\2(?!`)/g, (_, escaped, ticks, code) => {
      if (escaped) return hold(escaped);
      const padded = code.length > 2 && code.startsWith(" ") && code.endsWith(" ");
      return hold(`<code>${padded ? code.slice(1, -1) : code}</code>`);
    })
    .replace(/(!?)\[([^\]]*)\]\(\s*([^\s)]+)(?:\s+&quot;.*?&quot;)?\s*\)/g, (match, bang, label, url) => {
      if (bang) return label;  // images aren't part of a brief, and the CSP wouldn't load them
      if (!SAFE_LINK.test(url) || url.includes(HOLD_OPEN)) return label;
      return `${hold(`<a href="${url}" target="_blank" rel="noreferrer">`)}${label}${hold("</a>")}`;
    })
    .replace(/\*\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*\*/g, "<strong><em>$1</em></strong>")
    .replace(/\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*/g, "<strong>$1</strong>")
    .replace(/(?<!\w)__(?=\S)([\s\S]+?)(?<=\S)__(?!\w)/g, "<strong>$1</strong>")
    .replace(/\*(?=\S)([\s\S]+?)(?<=\S)\*/g, "<em>$1</em>")
    .replace(/(?<!\w)_(?=\S)([\s\S]+?)(?<=\S)_(?!\w)/g, "<em>$1</em>")
    .replace(/(?: {2,}|\\)\n/g, "<br>\n");
  return out.replace(/(\d+)/g, (_, n) => held[n]);
}

function splitRow(line) {
  const row = line.trim().replace(/^\|/, "");
  const cells = [];
  let cell = "";
  let inCode = false;
  for (let i = 0; i < row.length; i++) {
    if (row[i] === "\\" && row[i + 1] === "|") {
      cell += "\\|";
      i++;
    } else if (row[i] === "|" && !inCode) {
      cells.push(cell);
      cell = "";
    } else {
      if (row[i] === "`") inCode = !inCode;
      cell += row[i];
    }
  }
  if (cell.trim()) cells.push(cell);
  return cells.map((c) => c.trim());
}

function table(lines, start) {
  const head = splitRow(lines[start]);
  const align = splitRow(lines[start + 1]).map((cell) => {
    if (cell.startsWith(":") && cell.endsWith(":")) return ' class="ta-center"';
    return cell.endsWith(":") ? ' class="ta-right"' : "";
  });
  const row = (cells, tag) => head
    .map((_, n) => `<${tag}${align[n] ?? ""}>${inline(cells[n] ?? "")}</${tag}>`)
    .join("");
  let i = start + 2;
  const body = [];
  while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) {
    body.push(`<tr>${row(splitRow(lines[i]), "td")}</tr>`);
    i++;
  }
  const html = `<div class="md-table"><table><thead><tr>${row(head, "th")}</tr></thead>`
    + `<tbody>${body.join("")}</tbody></table></div>`;
  return { html, next: i };
}

function fenced(lines, start, match) {
  const [, pad, marker, info] = match;
  const closing = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`);
  const language = info.trim().split(/\s+/)[0].replace(/[^\w-].*$/, "");
  const code = [];
  let i = start + 1;
  while (i < lines.length && !closing.test(lines[i])) {
    code.push(lines[i].slice(Math.min(pad.length, indentOf(lines[i]))));
    i++;
  }
  const label = language ? ` class="language-${language}"` : "";
  return { html: `<pre><code${label}>${code.join("\n")}</code></pre>`, next: i + 1 };
}

function list(lines, start, options) {
  const first = lines[start].match(LIST_ITEM);
  const ordered = /\d/.test(first[2]);
  const base = first[1].length;
  const isSibling = (line) => isListItem(line) && indentOf(line) <= base
    && /\d/.test(line.match(LIST_ITEM)[2]) === ordered;
  const items = [];
  let loose = false;
  let i = start;
  while (i < lines.length && isSibling(lines[i])) {
    const [, pad, marker, gap, rest] = lines[i].match(LIST_ITEM);
    const inner = pad.length + marker.length + (gap.length > 4 || !gap.length ? 1 : gap.length);
    // Marker lines nest under any deeper indent: briefs put bullets two spaces under "1. ".
    const belongs = (line) => indentOf(line) >= inner || (indentOf(line) > base && isListItem(line));
    const body = [rest];
    i++;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        let next = i;
        while (next < lines.length && !lines[next].trim()) next++;
        if (next === lines.length || !belongs(lines[next])) break;
        body.push("");
        i++;
      } else if (belongs(line)) {
        body.push(line.slice(Math.min(indentOf(line), inner)));
        i++;
      } else if (body[body.length - 1].trim() && !startsBlock(lines, i)) {
        body.push(line.trim());  // a paragraph wrapped without its indent
        i++;
      } else {
        break;
      }
    }
    if (body.includes("")) loose = true;
    items.push(body);
    let next = i;
    while (next < lines.length && !lines[next].trim()) next++;
    if (next === i) continue;
    if (next === lines.length || !isSibling(lines[next])) break;
    loose = true;
    i = next;
  }
  const number = ordered ? parseInt(first[2], 10) : 1;
  const open = ordered ? (number === 1 ? "<ol>" : `<ol start="${number}">`) : "<ul>";
  const html = items
    .map((body) => `<li>${blocks(body, { ...options, tight: !loose }).join("\n")}</li>`)
    .join("\n");
  return { html: `${open}\n${html}\n${ordered ? "</ol>" : "</ul>"}`, next: i };
}

function quote(lines, start, options) {
  const inner = [];
  let i = start;
  while (i < lines.length && lines[i].trim()) {
    if (QUOTE.test(lines[i])) inner.push(lines[i].replace(QUOTE, ""));
    else if (startsBlock(lines, i)) break;
    else inner.push(lines[i]);
    i++;
  }
  const html = blocks(inner, { ...options, tight: false }).join("\n");
  return { html: `<blockquote>\n${html}\n</blockquote>`, next: i };
}

function heading(level, text, options) {
  const tag = `h${Math.min(level + (options.headingOffset ?? 0), 6)}`;
  return `<${tag}>${inline(text)}</${tag}>`;
}

function paragraph(lines, start, options) {
  const text = [lines[start].trimStart()];
  let i = start + 1;
  while (i < lines.length && lines[i].trim()) {
    const underline = lines[i].match(/^ {0,3}(=+|-+)\s*$/);
    if (underline) {
      return { html: heading(underline[1][0] === "=" ? 1 : 2, text.join("\n"), options), next: i + 1 };
    }
    if (startsBlock(lines, i)) break;
    text.push(lines[i].trimStart());
    i++;
  }
  const html = inline(text.join("\n"));
  return { html: options.tight ? html : `<p>${html}</p>`, next: i };
}

function blocks(lines, options) {
  const out = [];
  let i = 0;
  const add = ({ html, next }) => {
    out.push(html);
    i = next;
  };
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(FENCE);
    const title = line.match(HEADING);
    if (!line.trim()) {
      i++;
    } else if (fence) {
      add(fenced(lines, i, fence));
    } else if (INDENTED.test(line)) {
      const code = [];
      while (i < lines.length && (INDENTED.test(lines[i]) || !lines[i].trim())) code.push(lines[i++].slice(4));
      while (!code[code.length - 1].trim()) code.pop();
      out.push(`<pre><code>${code.join("\n")}</code></pre>`);
    } else if (title) {
      add({ html: heading(title[1].length, title[2], options), next: i + 1 });
    } else if (HR.test(line)) {
      add({ html: "<hr>", next: i + 1 });
    } else if (QUOTE.test(line)) {
      add(quote(lines, i, options));
    } else if (isListItem(line)) {
      add(list(lines, i, options));
    } else if (isTableStart(lines, i)) {
      add(table(lines, i));
    } else {
      add(paragraph(lines, i, options));
    }
  }
  return out;
}

// headingOffset moves a brief's headings below the page's own: 2 turns "# Title" into <h3>.
export function renderMarkdown(source, options = {}) {
  const text = escapeHtml(String(source ?? "").replace(/[\0]/g, ""));
  const lines = text.split(/\r\n|\r|\n/).map((line) => line.replace(/^\t+/, (t) => "    ".repeat(t.length)));
  return blocks(lines, options).join("\n");
}

// The one place Markdown reaches the page: everything above escapes before it builds a tag.
export function setMarkdown(element, source, options) {
  element.innerHTML = renderMarkdown(source, options);
}

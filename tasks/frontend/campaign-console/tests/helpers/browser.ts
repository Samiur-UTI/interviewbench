// Reading the dashboard page the way a browser does, and searching what the browser received.
//
//   const page = await (await fetch(`${url}/dashboard`)).text();
//   const state = parseState(page);                  // JSON.parse of the __STATE__ element's text
//   assert.deepEqual(leaks(page, secrets), []);       // no secret anywhere in the page

/** The opening tag of the state element, whatever the attribute order. */
const STATE_OPEN = /<script\b[^>]*\bid\s*=\s*["']?__STATE__["']?[^>]*>/i;

/**
 * The text of `<script id="__STATE__">` as a browser's parser sees it: everything up to the first
 * `</script`, in any letter case, with no entity decoding. Throws if the element is missing.
 */
export function stateScriptText(page: string): string {
  const open = STATE_OPEN.exec(page);
  if (!open) throw new Error('no <script id="__STATE__"> element in the page');
  const start = open.index + open[0].length;
  const end = page.slice(start).search(/<\/script/i);
  return end < 0 ? page.slice(start) : page.slice(start, start + end);
}

/** The state the page embeds, parsed the way src/client/main.ts does. */
export function parseState(page: string): any {
  return JSON.parse(stateScriptText(page));
}

/** The page with the state element (as the browser delimits it) removed: the rendered markup. */
export function withoutState(page: string): string {
  const open = STATE_OPEN.exec(page);
  if (!open) return page;
  const start = open.index + open[0].length;
  const rest = page.slice(start);
  const end = rest.search(/<\/script\s*>/i);
  const close = end < 0 ? rest.length : end + /<\/script\s*>/i.exec(rest.slice(end))![0].length;
  return page.slice(0, open.index) + page.slice(start + close);
}

/** Every start tag in `html`, e.g. `<span class="headline">`. */
export function startTags(html: string): string[] {
  return html.match(/<[a-zA-Z][^>]*>/g) ?? [];
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Decodes the character references a server-side renderer may use. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED[ref.toLowerCase()] ?? whole;
  });
}

/**
 * The text a user sees in rendered markup: tags removed, entities decoded. Only meaningful for
 * markup where text is escaped (a raw `<` in text would be read as a tag, which is the point).
 */
export function visibleText(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ""));
}

/** The secrets that occur in `haystack` (strings are searched as they are, objects as JSON). */
export function leaks(haystack: unknown, secrets: Iterable<string>): string[] {
  const text = typeof haystack === "string" ? haystack : JSON.stringify(haystack);
  return [...new Set(secrets)].filter((secret) => secret.length > 0 && text.includes(secret));
}

import assert from "node:assert/strict";
import { test } from "node:test";

import { escapeHtml, renderMarkdown as md } from "../../src/interviewbench/ui/static/js/core/markdown.js";

const ALLOWED_TAG = new RegExp(
  "^</?(?:h[1-6]|p|ul|ol|li|pre|code|em|strong|blockquote|hr|br|table|thead|tbody|tr|th|td)>$"
  + "|^<code class=\"language-[\\w-]+\">$"
  + "|^<(?:th|td) class=\"ta-(?:center|right)\">$"
  + "|^<ol start=\"\\d+\">$"
  + "|^<div class=\"md-table\">$|^</div>$"
  + "|^<a href=\"(?:https?:|mailto:)[^\"\\s]*\" target=\"_blank\" rel=\"noreferrer\">$|^</a>$",
);

function assertOnlySafeTags(html) {
  for (const [tag] of html.matchAll(/<[^>]*>?/g)) {
    assert.match(tag, ALLOWED_TAG, `unexpected tag in: ${html}`);
  }
}

test("escapeHtml covers every character that can leave text or an attribute", () => {
  assert.equal(escapeHtml(`<a href="x" id='y'>&`), "&lt;a href=&quot;x&quot; id=&#39;y&#39;&gt;&amp;");
});

test("headings, including setext, with an offset under the page's own", () => {
  assert.equal(md("# One"), "<h1>One</h1>");
  assert.equal(md("### Three ###"), "<h3>Three</h3>");
  assert.equal(md("Title\n===\n\nSub\n---"), "<h1>Title</h1>\n<h2>Sub</h2>");
  assert.equal(md("# One", { headingOffset: 2 }), "<h3>One</h3>");
  assert.equal(md("##### Five", { headingOffset: 3 }), "<h6>Five</h6>");
  assert.equal(md("#NotAHeading"), "<p>#NotAHeading</p>");
});

test("paragraphs join wrapped lines and honour hard breaks", () => {
  assert.equal(md("one\ntwo\n\nthree"), "<p>one\ntwo</p>\n<p>three</p>");
  assert.equal(md("one  \ntwo"), "<p>one<br>\ntwo</p>");
});

test("inline formatting", () => {
  assert.equal(md("*a* _b_ **c** __d__ ***e***"),
    "<p><em>a</em> <em>b</em> <strong>c</strong> <strong>d</strong> <strong><em>e</em></strong></p>");
  assert.equal(md("snake_case_name stays and 2 * 3 * 4 too"), "<p>snake_case_name stays and 2 * 3 * 4 too</p>");
  assert.equal(md("\\*not em\\* and \\`not code\\`"), "<p>*not em* and `not code`</p>");
});

test("inline code keeps its text literal", () => {
  assert.equal(md("`a*b*c` and `` x`y ``"), "<p><code>a*b*c</code> and <code>x`y</code></p>");
  assert.equal(md("`<b>&`"), "<p><code>&lt;b&gt;&amp;</code></p>");
  assert.equal(md("`\\*`"), "<p><code>\\*</code></p>");
  assert.equal(md("an `unclosed tick"), "<p>an `unclosed tick</p>");
});

test("fenced code keeps markup, blank lines and indentation, closed or not", () => {
  assert.equal(md("```python\nif x < 1:\n\n    **y**\n```"),
    '<pre><code class="language-python">if x &lt; 1:\n\n    **y**</code></pre>');
  assert.equal(md("~~~\na\n~~~\nafter"), "<pre><code>a</code></pre>\n<p>after</p>");
  assert.equal(md("````\n```\n````"), "<pre><code>```</code></pre>");
  assert.equal(md("```\nnever closed"), "<pre><code>never closed</code></pre>");
});

test("indented code", () => {
  assert.equal(md("para\n\n    code()\n\n    more\n\nafter"),
    "<p>para</p>\n<pre><code>code()\n\nmore</code></pre>\n<p>after</p>");
});

test("tight and loose lists", () => {
  assert.equal(md("- a\n- b"), "<ul>\n<li>a</li>\n<li>b</li>\n</ul>");
  assert.equal(md("* a\n\n* b"), "<ul>\n<li><p>a</p></li>\n<li><p>b</p></li>\n</ul>");
  assert.equal(md("3. c\n4. d"), '<ol start="3">\n<li>c</li>\n<li>d</li>\n</ol>');
});

test("a wrapped list item stays one item, indented or lazy", () => {
  assert.equal(md("- first\n  still first\n- second\nstill second"),
    "<ul>\n<li>first\nstill first</li>\n<li>second\nstill second</li>\n</ul>");
});

test("nested lists, including bullets two spaces under a numbered item", () => {
  assert.equal(md("- a\n  - b\n    - c\n- d"),
    "<ul>\n<li>a\n<ul>\n<li>b\n<ul>\n<li>c</li>\n</ul></li>\n</ul></li>\n<li>d</li>\n</ul>");
  assert.equal(md("1. a\n  - b\n2. c"), "<ol>\n<li>a\n<ul>\n<li>b</li>\n</ul></li>\n<li>c</li>\n</ol>");
});

test("a list item can hold code and paragraphs", () => {
  assert.equal(md("1. run\n\n   ```sh\n   ls\n   ```\n\n2. done"),
    '<ol>\n<li><p>run</p>\n<pre><code class="language-sh">ls</code></pre></li>\n<li><p>done</p></li>\n</ol>');
});

test("a list ends at the next paragraph or a different list kind", () => {
  assert.equal(md("- a\n\nafter"), "<ul>\n<li>a</li>\n</ul>\n<p>after</p>");
  assert.equal(md("- a\n1. b"), "<ul>\n<li>a</li>\n</ul>\n<ol>\n<li>b</li>\n</ol>");
});

test("blockquotes nest blocks and take lazy lines", () => {
  assert.equal(md("> # q\n> text\nlazy\n\nafter"),
    "<blockquote>\n<h1>q</h1>\n<p>text\nlazy</p>\n</blockquote>\n<p>after</p>");
  assert.equal(md("> > deep"), "<blockquote>\n<blockquote>\n<p>deep</p>\n</blockquote>\n</blockquote>");
});

test("horizontal rules", () => {
  assert.equal(md("a\n\n---\n\nb"), "<p>a</p>\n<hr>\n<p>b</p>");
  assert.equal(md("* * *"), "<hr>");
  assert.equal(md("___"), "<hr>");
});

test("tables with alignment, inline markup and pipes in code", () => {
  const html = md("| Name | Left | Mid | Right |\n|---|:--|:-:|--:|\n| `a|b` | **x** | \\| | 3 |\n| short |\n\nafter");
  assert.match(html, /^<div class="md-table"><table><thead><tr><th>Name<\/th><th>Left<\/th>/);
  assert.match(html, /<th class="ta-center">Mid<\/th><th class="ta-right">Right<\/th>/);
  assert.match(html, /<td><code>a\|b<\/code><\/td><td><strong>x<\/strong><\/td><td class="ta-center">\|<\/td>/);
  assert.match(html, /<tr><td>short<\/td><td><\/td><td class="ta-center"><\/td><td class="ta-right"><\/td><\/tr>/);
  assert.match(html, /<p>after<\/p>$/);
});

test("a pipe in a paragraph is not a table", () => {
  assert.equal(md("a | b\nc | d"), "<p>a | b\nc | d</p>");
});

test("links get noreferrer, open a new tab and keep their inline markup", () => {
  assert.equal(md("[**docs**](https://example.com/a?b=1&c=2 \"title\")"),
    '<p><a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noreferrer"><strong>docs</strong></a></p>');
  assert.equal(md("[mail](mailto:me@example.com)"),
    '<p><a href="mailto:me@example.com" target="_blank" rel="noreferrer">mail</a></p>');
});

test("links with any other scheme keep their text but lose the link", () => {
  for (const url of [
    "javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,x", "vbscript:x", "file:///etc/passwd",
    "/relative", "//evil.example", "java&#115;cript:alert(1)", "javascript&colon;alert(1)",
    "%6A%61vascript:alert(1)", "\u0001javascript:alert(1)",
  ]) {
    const html = md(`[click](${url})`);
    assert.ok(!html.includes("<a "), `${url} became a link: ${html}`);
    assert.ok(html.includes("click"));
  }
});

test("images render as their alt text", () => {
  assert.equal(md("![a chart](https://example.com/x.png)"), "<p>a chart</p>");
});

test("XSS payloads come out as text wherever they are placed", () => {
  const payloads = [
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    "<svg/onload=alert(1)>",
    "<a href=\"javascript:alert(1)\">x</a>",
    "<iframe srcdoc='<script>alert(1)</script>'></iframe>",
    "<style>body{display:none}</style>",
    "&lt;script&gt;alert(1)&lt;/script&gt;",
    "<details open ontoggle=alert(1)>",
    "<!-- <script> -->",
    "<",
    "x\" onmouseover=\"alert(1)",
  ];
  const places = [
    (p) => p,
    (p) => `# ${p}`,
    (p) => `- ${p}`,
    (p) => `1. a\n   - ${p}`,
    (p) => `> ${p}`,
    (p) => `*${p}*`,
    (p) => `**${p}**`,
    (p) => `\`${p}\``,
    (p) => `\`\`\`\n${p}\n\`\`\``,
    (p) => `\`\`\`${p}\ncode\n\`\`\``,
    (p) => `    ${p}`,
    (p) => `| ${p} |\n|---|\n| ${p} |`,
    (p) => `[${p}](https://example.com)`,
    (p) => `[x](https://example.com/${p})`,
    (p) => `[x](https://example.com "${p}")`,
    (p) => `![${p}](https://example.com)`,
  ];
  for (const payload of payloads) {
    for (const place of places) assertOnlySafeTags(md(place(payload)));
  }
});

test("an attribute breakout stays inside the quoted href", () => {
  const html = md('[x](https://e.com/"onclick="alert(1))');
  assertOnlySafeTags(html);
  assert.ok(html.includes("&quot;onclick=&quot;"));
});

test("the source can't forge the placeholders that hold inline HTML", () => {
  assert.equal(md("\uE0000\uE001 `a`"), "<p>0 <code>a</code></p>");
});

test("the language label is reduced to safe characters", () => {
  assertOnlySafeTags(md('```"><script>\ncode\n```'));
  assert.equal(md("```c++\nx\n```"), '<pre><code class="language-c">x</code></pre>');
});

test("empty and missing input", () => {
  assert.equal(md(""), "");
  assert.equal(md(null), "");
  assert.equal(md(undefined), "");
  assert.equal(md("\n\n  \n"), "");
});

test("CRLF sources behave like LF", () => {
  assert.equal(md("# a\r\n\r\n- b\r\n- c\r\n"), "<h1>a</h1>\n<ul>\n<li>b</li>\n<li>c</li>\n</ul>");
});

test("a long run of markers stays fast", () => {
  const start = performance.now();
  md(`${"*a ".repeat(3000)}\n${"[".repeat(3000)}`);
  assert.ok(performance.now() - start < 2000);
});

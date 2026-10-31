// Changes panel: everything the candidate changed against the starter, as a readable diff.

import { api } from "../api.js";
import { parseDiff } from "../diff.js";
import { plural } from "../format.js";
import { button, emptyBlock, errorBlock, h, loadingBlock, notice } from "../ui.js";

const OPEN_LINES = 300;  // larger files start collapsed
const STATUS = { added: ["ok", "Added"], deleted: ["fail", "Deleted"], modified: ["accent", "Modified"] };
const SIGN = { add: "+", del: "-", context: " ", note: "" };

function diffLine(line) {
  return h("div", { class: `diff-line ${line.type}` },
    h("span", { class: "diff-num" }, line.oldLine ?? ""),
    h("span", { class: "diff-num" }, line.newLine ?? ""),
    h("span", { class: "diff-sign" }, SIGN[line.type]),
    h("span", { class: "diff-text" }, line.text));
}

function fileDiff(summary, parsed) {
  const [kind, label] = STATUS[summary.status] ?? STATUS.modified;
  const lines = parsed?.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0) ?? 0;
  return h("details", { class: "diff-file", open: lines <= OPEN_LINES },
    h("summary", null,
      h("span", { class: `badge ${kind}` }, label),
      h("code", { class: "diff-path" }, summary.path),
      h("span", { class: "diff-counts" },
        h("span", { class: "added" }, `+${summary.additions}`), " ",
        h("span", { class: "removed" }, `-${summary.deletions}`))),
    lines
      ? h("div", { class: "diff-scroll", tabindex: "0", role: "group", "aria-label": `Diff of ${summary.path}` },
        h("div", { class: "diff-body" }, parsed.hunks.map((hunk) => [
          h("div", { class: "diff-hunk" }, hunk.header),
          hunk.lines.map(diffLine),
        ])))
      : h("p", { class: "meta diff-none" }, parsed?.binary ? "Binary file: no preview." : "No preview for this file."));
}

function changes(data) {
  const parsed = parseDiff(data.diff);
  const byPath = new Map(parsed.map((file) => [file.path, file]));
  const added = data.files.reduce((sum, file) => sum + file.additions, 0);
  const removed = data.files.reduce((sum, file) => sum + file.deletions, 0);
  return h("div", { class: "stack" },
    h("p", { class: "meta" }, `${plural(data.files.length, "file")} changed · +${added} -${removed}`),
    data.truncated && notice("warn", "This diff is too long to show in full. Open your editor to see the rest."),
    data.files.map((file) => fileDiff(file, byPath.get(file.path))));
}

export function render(ctx) {
  const body = h("div", null);

  async function load() {
    if (!ctx.memo.changes) body.replaceChildren(loadingBlock("Comparing your code with the starter…"));
    try {
      const data = await api.changes(ctx.round.id);
      ctx.memo.changes = data;
      if (body.isConnected) body.replaceChildren(show(data));
    } catch (err) {
      if (body.isConnected) body.replaceChildren(errorBlock(err, load, "Couldn't load your changes"));
    }
  }

  const show = (data) => (data.files.length ? changes(data)
    : emptyBlock("No changes yet", "Edits you save in your editor show up here."));

  if (ctx.memo.changes) body.replaceChildren(show(ctx.memo.changes));
  ctx.onFocusBack(load);
  load();

  return h("div", { class: "stack" },
    h("div", { class: "panel-head" },
      h("div", null,
        h("h2", null, "Your changes"),
        h("p", null, "Everything you've changed since the starter code, without files the grader ignores.")),
      button("Refresh", { icon: "refresh", "data-fk": "refresh-changes", onClick: load })),
    body);
}

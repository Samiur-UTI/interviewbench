// Changes panel: everything the candidate changed against the starter, as a readable diff.

import { Button } from "../../../components/button.js";
import { Async, Empty, Notice } from "../../../components/feedback.js";
import { api } from "../../../core/api.js";
import { parseDiff } from "../../../core/diff.js";
import { plural } from "../../../core/format.js";
import { useAsync } from "../../../hooks/use-async.js";
import { useWindowFocus } from "../../../hooks/use-dom.js";
import { html, useMemo } from "../../../preact.js";
import { useRoundContext } from "../round-context.js";
import { FileDiff } from "./diff-view.js";

function ChangedFiles({ data }) {
  if (!data.files.length) return html`<${Empty} title="No changes yet" text="Edits you save in your editor show up here." />`;
  const byPath = new Map(parseDiff(data.diff).map((file) => [file.path, file]));
  const added = data.files.reduce((sum, file) => sum + file.additions, 0);
  const removed = data.files.reduce((sum, file) => sum + file.deletions, 0);
  return html`
    <div class="stack">
      <p class="meta">${plural(data.files.length, "file")} changed · +${added} -${removed}</p>
      ${data.truncated && html`
        <${Notice} kind="warn">This diff is too long to show in full. Open your editor to see the rest.<//>`}
      ${data.files.map((file) => html`<${FileDiff} key=${file.path} summary=${file} parsed=${byPath.get(file.path)} />`)}
    </div>`;
}

export function ChangesPanel() {
  const { round, memo, settled } = useRoundContext();
  const query = useAsync(async () => {
    memo.changes = await api.changes(round.id);
    return memo.changes;
  }, [round.id, round.stage, settled], memo.changes ?? null);
  useWindowFocus(query.reload);
  // The same vnode tells Preact to skip the subtree, which a long diff makes worth doing: this panel
  // re-renders on every job poll and status check.
  const files = useMemo(() => html`<${ChangedFiles} data=${query.data} />`, [query.data]);

  return html`
    <div class="stack">
      <div class="panel-head">
        <div>
          <h2>Your changes</h2>
          <p>Everything you've changed since the starter code, without files the grader ignores.</p>
        </div>
        <${Button} icon="refresh" onClick=${query.reload}>Refresh<//>
      </div>
      <div>
        <${Async}
          query=${query}
          loading="Comparing your code with the starter…"
          failed="Couldn't load your changes"
          render=${() => files}
        />
      </div>
    </div>`;
}

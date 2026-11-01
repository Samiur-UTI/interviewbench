// Changes panel: everything the candidate changed against the starter, as a readable diff.

import { Button } from "../../../components/button.js";
import { Async, Empty, Notice } from "../../../components/feedback.js";
import { api } from "../../../core/api.js";
import { parseDiff } from "../../../core/diff.js";
import { plural } from "../../../core/format.js";
import { useAsync } from "../../../hooks/use-async.js";
import { useWindowFocus } from "../../../hooks/use-dom.js";
import { html } from "../../../preact.js";
import { useRoundContext } from "../round-context.js";
import { FileDiff } from "./diff-view.js";

function ChangedFiles({ data }) {
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
  const { round, memo } = useRoundContext();
  const query = useAsync(async () => {
    memo.changes = await api.changes(round.id);
    return memo.changes;
  }, [round.id, round.stage], memo.changes ?? null);
  useWindowFocus(query.reload);

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
          render=${(data) => (data.files.length
            ? html`<${ChangedFiles} data=${data} />`
            : html`<${Empty} title="No changes yet" text="Edits you save in your editor show up here." />`)}
        />
      </div>
    </div>`;
}

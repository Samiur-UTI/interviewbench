import { html } from "./html.ts";
import { PLATFORM_NAMES, formatTime, isoTime } from "./format.ts";
import type { Campaign, PublicEvent, PublicRun, RunStatus } from "../../shared/types.ts";

export interface RunListProps {
  runs: PublicRun[];
  campaigns: Record<string, Campaign>;
  events: Record<string, PublicEvent[]>;
  /** "Load earlier events" on a run (createDashboardClient().loadEarlierEvents). */
  onLoadEarlier?: (runId: string) => void;
}

const RUN_STATUS_TEXT: Record<RunStatus, string> = {
  queued: "Queued",
  running: "Running",
  paused: "Paused",
  completed: "Completed",
  failed: "Failed",
};

function EventItem({ event }: { event: PublicEvent }) {
  // Platform text is shown as text (README, rule 3): what a lead typed is never markup.
  const headline = event.target?.headline;
  return html`
    <li class=${`event event-${event.type}`}>
      <time datetime=${isoTime(event.at)}>${formatTime(event.at)}</time>
      <span class="message">${event.message}</span>
      ${headline && html`<span class="headline">${headline}</span>`}
    </li>
  `;
}

function RunItem({
  run,
  campaign,
  events,
  onLoadEarlier,
}: {
  run: PublicRun;
  campaign?: Campaign;
  events: PublicEvent[];
  onLoadEarlier?: (runId: string) => void;
}) {
  const titleId = `run-${run.id}-title`;
  const listId = `run-${run.id}-events`;
  const countId = `run-${run.id}-event-count`;
  const { sent, total } = run.progress;
  // The page and snapshots carry only the newest events: say so, and offer the rest.
  const totalEvents = typeof run.eventCount === "number" ? run.eventCount : events.length;
  const more = events.length < totalEvents;
  return html`
    <section class="run" data-status=${run.status} aria-labelledby=${titleId}>
      <header class="run-header">
        <h3 id=${titleId}>${campaign?.name ?? run.campaignId}</h3>
        <span class="badge">${RUN_STATUS_TEXT[run.status]}</span>
        ${campaign && html`<span class="platform">${PLATFORM_NAMES[campaign.platform]}</span>`}
      </header>
      <label class="progress">
        <span>${sent} of ${total} ${campaign ? campaign.itemLabel.toLowerCase() : "items"} sent</span>
        <progress max=${total} value=${sent}></progress>
      </label>
      ${more &&
      html`<div class="earlier">
        <p class="event-count" id=${countId}>Showing the latest ${events.length} of ${totalEvents} events</p>
        <button type="button" aria-controls=${listId} aria-describedby=${countId} onClick=${() => onLoadEarlier?.(run.id)}>
          Load earlier events
        </button>
      </div>`}
      ${events.length === 0
        ? html`<p class="empty">No activity yet.</p>`
        : html`<ol class="events" id=${listId}>
            ${events.map((event) => html`<${EventItem} key=${event.id} event=${event} />`)}
          </ol>`}
    </section>
  `;
}

export function RunList({ runs, campaigns, events, onLoadEarlier }: RunListProps) {
  if (runs.length === 0) return html`<p class="empty">No campaign has run yet.</p>`;
  return html`
    <div class="runs">
      ${runs.map(
        (run) =>
          html`<${RunItem}
            key=${run.id}
            run=${run}
            campaign=${campaigns[run.campaignId]}
            events=${events[run.id] ?? []}
            onLoadEarlier=${onLoadEarlier}
          />`,
      )}
    </div>
  `;
}

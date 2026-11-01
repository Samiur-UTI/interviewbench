// Pure formatting: times, durations and counts. No DOM here, so node can test it.

const LOW_TIME_MS = 5 * 60 * 1000;
// Spoken once each as the clock crosses them. The rest of the countdown stays silent.
const MILESTONES_MIN = [10, 5, 1];

// Python's isoformat() gives microseconds, which Date.parse doesn't promise to read.
export function parseTime(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return value < 1e12 ? value * 1000 : value;
  const parsed = Date.parse(String(value).replace(/(\.\d{3})\d+/, "$1"));
  return Number.isNaN(parsed) ? null : parsed;
}

function pad(n) {
  return String(n).padStart(2, "0");
}

// 04:09, or 1:04:09 from an hour up.
export function formatClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const seconds = pad(total % 60);
  return hours ? `${hours}:${pad(minutes)}:${seconds}` : `${pad(minutes)}:${seconds}`;
}

// 8s, 2m 05s, 1h 03m: how long a job has been going.
export function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  if (total < 3600) return `${Math.floor(total / 60)}m ${pad(total % 60)}s`;
  return `${Math.floor(total / 3600)}h ${pad(Math.floor(total / 60) % 60)}m`;
}

function roughMinutes(ms) {
  const minutes = Math.max(1, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return rest ? `${Math.floor(minutes / 60)} h ${rest} min` : `${Math.floor(minutes / 60)} h`;
}

// The live countdown. Overtime is a state, not an alarm: the round keeps going.
export function countdown(endsAt, now) {
  const left = endsAt - now;
  if (left <= 0) return { state: "overtime", text: `+${formatClock(now - endsAt)}`, label: "over time" };
  return {
    state: left <= LOW_TIME_MS ? "low" : "running",
    text: formatClock(left + 999),  // show 00:01 for the last second, not 00:00
    label: "left",
  };
}

// What to say when the clock moved from `before` to `after`, or null.
export function timeMilestone(endsAt, before, after) {
  if (before < endsAt && after >= endsAt) return "Time is up. You can keep working; the report shows the time used.";
  for (const minutes of MILESTONES_MIN) {
    const mark = endsAt - minutes * 60000;
    if (before < mark && after >= mark) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} left.`;
  }
  return null;
}

// "12 min left" or "Over by 3 min", for lists where a ticking clock would only distract.
export function describeTimeLeft(endsAt, now) {
  const left = endsAt - now;
  return left > 0 ? `${roughMinutes(left)} left` : `Over by ${roughMinutes(-left)}`;
}

export function formatTimeOfDay(ms) {
  const date = new Date(ms);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatDate(ms) {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${formatTimeOfDay(ms)}`;
}

export function plural(count, word, many = `${word}s`) {
  return `${count} ${count === 1 ? word : many}`;
}

// Rubric weights and points: 12.5 stays, 15.0 becomes 15.
export function formatPoints(value) {
  return String(Math.round((value ?? 0) * 10) / 10);
}

export function formatPercent(fraction) {
  return `${Math.round((fraction ?? 0) * 100)}%`;
}

export function formatTokens(count) {
  return `about ${Number(count ?? 0).toLocaleString("en-US")} tokens`;
}

// Why a connected AI review can't run yet, or null. `judge` is Settings.judge from the API.
export function judgeProblem(judge) {
  if (judge.backend === "claude") {
    if (!judge.claude_sdk_installed) {
      return "The Claude connection needs an optional package that isn't installed. Pick another provider, or use a chatbot.";
    }
    return judge.has_api_key ? null : "Add an API key in Settings first.";
  }
  if (!judge.base_url) return "Add the provider's API address in Settings first.";
  if (!judge.model) return "Choose a model in Settings first.";
  const local = /^https?:\/\/(localhost|127\.0\.0\.1)\b/.test(judge.base_url);
  return judge.has_api_key || local ? null : "Add an API key in Settings first.";
}

// A brief opens with its stage title, which the page already shows as a heading.
export function withoutTitle(markdown, title) {
  const [first, ...rest] = String(markdown ?? "").trimStart().split("\n");
  return first.replace(/^#+\s*/, "").trim() === title ? rest.join("\n").trimStart() : String(markdown ?? "");
}

// fetch wrapper for /api and job polling. See docs/GUI.md for the shapes.

const POLL_MS = 800;

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Fires "auth" on a 401, and "offline" / "online" when the server stops or starts answering.
export const connection = new EventTarget();
let online = true;

function setOnline(value) {
  if (value === online) return;
  online = value;
  connection.dispatchEvent(new Event(value ? "online" : "offline"));
}

async function call(method, path, body) {
  const options = { method, credentials: "same-origin" };
  if (method !== "GET") {
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify(body ?? {});
  }
  let response;
  try {
    response = await fetch(path, options);
  } catch {
    setOnline(false);
    throw new ApiError(0, "unreachable", "Can't reach the server. It may have stopped.");
  }
  setOnline(true);
  const data = await response.json().catch(() => null);
  if (response.ok) return data;
  if (response.status === 401) connection.dispatchEvent(new Event("auth"));
  throw new ApiError(
    response.status,
    data?.error?.code ?? "error",
    data?.error?.message ?? `The server answered with an error (${response.status}). Try again.`,
  );
}

const round = (id) => `/api/rounds/${encodeURIComponent(id)}`;

export const api = {
  status: () => call("GET", "/api/status"),
  settings: () => call("GET", "/api/settings"),
  saveSettings: (judge) => call("PUT", "/api/settings", { judge }),
  tasks: () => call("GET", "/api/tasks"),
  newTask: (body) => call("POST", "/api/tasks", body),
  validate: (body) => call("POST", "/api/validate", body),
  rounds: () => call("GET", "/api/rounds"),
  startRound: (body) => call("POST", "/api/rounds", body),
  round: (id) => call("GET", round(id)),
  deleteRound: (id) => call("DELETE", round(id), { confirm: id }),
  nextStage: (id) => call("POST", `${round(id)}/next`),
  openEditor: (id) => call("POST", `${round(id)}/open-editor`),
  changes: (id) => call("GET", `${round(id)}/changes`),
  runTests: (id) => call("POST", `${round(id)}/test`),
  grade: (id, judge) => call("POST", `${round(id)}/grade`, { judge }),
  judgePrompt: (id) => call("GET", `${round(id)}/judge-prompt`),
  judgeReply: (id, reply) => call("POST", `${round(id)}/judge-reply`, { reply }),
  attackPrompt: (id) => call("GET", `${round(id)}/attack-prompt`),
  breakIt: (id, filename, content) => call("POST", `${round(id)}/break`, { filename, content }),
  job: (id) => call("GET", `/api/jobs/${encodeURIComponent(id)}`),
};

function wait(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

// Follows a job to its end, calling onUpdate with each poll. Returns the finished job, or null if the
// server no longer knows it (restarted, or kept past the hour) or `signal` aborted. Lost connections
// are retried: the job keeps running on the server, and the banner tells the candidate.
export async function followJob(id, onUpdate, signal) {
  while (!signal?.aborted) {
    try {
      const job = await api.job(id);
      if (signal?.aborted) return null;
      onUpdate(job);
      if (job.state !== "running") return job;
    } catch (err) {
      if (err.status === 404) return null;
      if (err.status === 401) throw err;
    }
    await wait(POLL_MS, signal);
  }
  return null;
}

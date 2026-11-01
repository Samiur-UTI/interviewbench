// The Round screen's state as a reducer. Pure, so node can test it.

export const JOBS = {
  test: { panel: "tests", result: "test", name: "Tests" },
  grade: { panel: "grade", result: "grade", name: "Grading" },
  "judge-reply": { panel: "grade", result: "grade", name: "Scoring the reply" },
  break: { panel: "break", result: "break", name: "Break it" },
};

const LOST = "The server lost track of this job, perhaps because it restarted. Run it again.";

export const jobName = (kind) => JOBS[kind]?.name ?? "Job";

export const initialRoundState = {
  round: null,
  job: null,  // the running job
  recent: null,  // the job that finished last, for the job strip
  failures: {},  // job kind, "lost" or "start" -> the error of its last failed run
  revealed: null,  // { stage, message } just after moving on
};

function without(failures, ...keys) {
  return Object.fromEntries(Object.entries(failures).filter(([key]) => !keys.includes(key)));
}

function ended(state, job) {
  const base = { ...state, job: null, recent: job };
  if (!job) return { ...base, failures: { ...state.failures, lost: LOST } };
  if (job.state === "failed") {
    return { ...base, failures: { ...state.failures, [job.kind]: job.error ?? "It stopped without saying why." } };
  }
  const key = JOBS[job.kind]?.result;
  if (!key || !state.round?.last) return base;
  return { ...base, round: { ...state.round, last: { ...state.round.last, [key]: job.result } } };
}

// What to say and show after moving on, from the `next` API's answer.
function movedOn(state, { tagged, ...round }) {
  let message = `Stage ${round.stage} revealed.`;
  if (tagged) message += ` Your stage ${round.stage - 1} work is committed and tagged ${tagged}.`;
  else if (round.git) message += " There was nothing new to commit, so no tag was added.";
  return { ...state, round, revealed: { stage: round.stage, message } };
}

export function roundReducer(state, action) {
  switch (action.type) {
    case "loaded":
      return { ...state, round: action.round };
    case "job-started":
      return {
        ...state,
        job: action.job,
        recent: null,
        failures: without(state.failures, action.job.kind, "lost", "start"),
      };
    case "job-updated":
      return { ...state, job: action.job };
    case "job-ended":
      return ended(state, action.job);
    case "start-failed":
      return { ...state, failures: { ...state.failures, start: action.message } };
    case "panel-changed":
      return { ...state, failures: without(state.failures, "start") };
    case "moved-on":
      return movedOn(state, action.round);
    default:
      throw new Error(`Unknown action: ${action.type}`);
  }
}

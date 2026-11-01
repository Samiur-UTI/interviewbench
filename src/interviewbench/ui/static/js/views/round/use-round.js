// Loads a round and owns its running job: starting it, following it, and picking it up after a reload.

import { announce } from "../../core/announce.js";
import { ApiError, activeJobId, api, followJob } from "../../core/api.js";
import { useAbortSignal } from "../../hooks/use-dom.js";
import { useAsync } from "../../hooks/use-async.js";
import { useCallback, useEffect, useMemo, useReducer, useRef } from "../../preact.js";
import { initialRoundState, jobName, roundReducer } from "./round-state.js";

const BUSY = "Wait for the running job to finish";

// Pasted text survives moving between panels and rounds. It's kept in memory only.
const drafts = new Map();

function draftsFor(id) {
  if (!drafts.has(id)) drafts.set(id, {});
  return drafts.get(id);
}

export function useRound(id) {
  const [state, dispatch] = useReducer(roundReducer, initialRoundState);
  const signal = useAbortSignal();
  const following = useRef(false);  // set at once: state only changes on the next render
  const memo = useRef({});
  const query = useAsync(() => api.round(id), [id]);

  const refresh = useCallback(async () => {
    try {
      const round = await api.round(id);
      if (!signal.aborted) dispatch({ type: "loaded", round });
      return round;
    } catch {
      return null;  // what's on screen stays; the connection banner covers an outage
    }
  }, [id, signal]);

  const finish = useCallback(async (job) => {
    following.current = false;
    dispatch({ type: "job-ended", job });
    if (job) announce(`${jobName(job.kind)} ${job.state === "failed" ? "failed" : "finished"}.`);
    await refresh();
  }, [refresh]);

  const attach = useCallback(async (job) => {
    following.current = true;
    dispatch({ type: "job-started", job });
    if (job.phase) announce(job.phase);
    let { phase } = job;
    try {
      const finished = await followJob(job.id, (update) => {
        dispatch({ type: "job-updated", job: update });
        if (update.phase !== phase) {
          ({ phase } = update);
          announce(phase);
        }
      }, signal);
      if (!signal.aborted) await finish(finished);
    } catch (err) {
      if (err.status !== 401) throw err;  // on a 401 the app has moved to its sign-in screen
    }
  }, [signal, finish]);

  const reattach = useCallback((round) => {
    const running = activeJobId(round);
    if (running && !following.current) attach({ id: running, phase: "Picking up the running job…", log: [], started_at: null });
  }, [attach]);

  const runJob = useCallback(async (start) => {
    if (following.current) return;
    try {
      await attach(await start());
    } catch (err) {
      if (err.code === "busy") {
        const round = await refresh();
        if (round) reattach(round);
      } else if (err instanceof ApiError) {
        dispatch({ type: "start-failed", message: err.message });
      } else {
        throw err;
      }
    }
  }, [attach, refresh, reattach]);

  useEffect(() => {
    if (!query.data) return;
    dispatch({ type: "loaded", round: query.data });
    reattach(query.data);
  }, [query.data, reattach]);

  const context = useMemo(() => ({
    round: state.round,
    job: state.job,
    blocked: state.job ? BUSY : null,
    runJob,
    failure: (kind) => state.failures[kind] ?? null,
    memo: memo.current,
    drafts: draftsFor(id),
  }), [state.round, state.job, state.failures, runJob, id]);

  return { state, dispatch, query, context };
}

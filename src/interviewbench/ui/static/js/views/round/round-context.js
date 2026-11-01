// What a Round panel can read and do. The Round screen owns the running job, so panels only read its
// state and ask for new jobs here.
//   round:     the Round from the API
//   job:       the running job, or null
//   blocked:   why nothing can start now, or null. Pass it to a Button's `blocked`.
//   runJob:    runJob(() => api.something(round.id)) starts a job and follows it to its end
//   failure:   failure("grade") is the error of that kind's last failed run, or null
//   memo:      an object that outlives panel switches, for data worth showing at once when coming back
//   drafts:    pasted text, kept in memory across panels. Read it through useDraft.

import { createContext, useContext, useState } from "../../preact.js";

export const RoundContext = createContext(null);

export const useRoundContext = () => useContext(RoundContext);

// Like useState for a string, but the text survives moving between panels and rounds.
export function useDraft(name) {
  const { drafts } = useRoundContext();
  const [value, setValue] = useState(drafts[name] ?? "");
  const update = (next) => {
    drafts[name] = next;
    setValue(next);
  };
  return [value, update];
}

// "How a round works": shown once per browser on the Tasks screen, and on demand from the status bar.

import { icon } from "../icons.js";
import { recall, remember } from "../state.js";
import { button, h, openDialog } from "../ui.js";

function steps() {
  return h("ol", { class: "howto-steps" },
    h("li", null, h("strong", null, "Start a task."), " The clock starts and the starter code lands in a folder of its own. Open only that folder in your editor, and use any AI assistant you like there."),
    h("li", null, h("strong", null, "Work through the stages."), " There are usually three: fix a bug, add a feature, optimize. Run your own tests here whenever you want. The hidden tests stay hidden."),
    h("li", null, h("strong", null, "Move on when you're ready."), " Next stage saves your work and shows the next brief. You only see a stage once you get to it."),
    h("li", null, h("strong", null, "Grade your work."), " The hidden tests for every stage run, and an AI reviewer can score the rest. Then try Break it to see if an LLM can break your code."));
}

export function showHowTo() {
  const close = button("Got it", { kind: "primary", onClick: () => dialog.close() });
  const dialog = openDialog({ title: "How a round works", body: steps(), actions: close });
}

export function howToNote() {
  if (recall("howto-dismissed", false)) return null;
  const note = h("section", { class: "howto", "aria-label": "How a round works" },
    h("div", { class: "howto-head" },
      h("h2", null, "How a round works"),
      h("button", {
        type: "button",
        class: "icon-button",
        "aria-label": "Dismiss this note",
        onclick: () => {
          remember("howto-dismissed", true);
          note.remove();
        },
      }, icon("cross"))),
    steps());
  return note;
}

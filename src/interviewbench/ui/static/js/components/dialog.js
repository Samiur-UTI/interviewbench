// A modal. The parent decides whether it exists: render it to open, stop rendering it to close.
// onClose also fires when the browser closes it, as Escape does.

import { html, useLayoutEffect, useRef } from "../preact.js";

export function Dialog({ title, onClose, actions, children }) {
  const dialog = useRef(null);
  useLayoutEffect(() => {
    const element = dialog.current;
    element.showModal();
    return () => {
      if (element.open) element.close();
    };
  }, []);
  return html`
    <dialog ref=${dialog} class="dialog" aria-labelledby="dialog-title" onClose=${onClose}>
      <h2 id="dialog-title">${title}</h2>
      <div class="dialog-body">${children}</div>
      <div class="dialog-actions">${actions}</div>
    </dialog>`;
}

// Speaks a message to screen readers through the page's live region.

export function announce(text) {
  const live = document.getElementById("live");
  live.textContent = "";
  // A fresh text node in a later frame, or a repeated message isn't read out.
  requestAnimationFrame(() => {
    live.textContent = text;
  });
}

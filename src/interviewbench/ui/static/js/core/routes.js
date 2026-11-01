// The app's addresses. Pure, so node can test it. To add a screen, add it here and in app/views.js.

const PLAIN = { tasks: "Tasks", rounds: "Rounds", author: "Author", settings: "Settings" };

export const HOME = "#/tasks";
export const NAV = Object.entries(PLAIN).map(([name, label]) => ({ name, label, href: `#/${name}` }));

// The route for a location hash, or null if it isn't one. A malformed % escape counts as "isn't".
export function parseRoute(hash) {
  let parts;
  try {
    parts = hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  } catch {
    return null;
  }
  const [name, id, panel] = parts;
  if (name === "rounds" && id) return { name: "round", nav: "rounds", title: id, key: `round:${id}`, params: { id, panel } };
  if (Object.hasOwn(PLAIN, name) && !id) return { name, nav: name, title: PLAIN[name], key: name, params: {} };
  return null;
}

export function roundHref(id, panel = "tests") {
  return `#/rounds/${encodeURIComponent(id)}/${panel}`;
}

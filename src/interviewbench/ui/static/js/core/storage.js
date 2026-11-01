// Per-browser choices. Storage can throw in private windows. These are conveniences, so failing is fine.

export function remember(key, value) {
  try {
    localStorage.setItem(`ib.${key}`, JSON.stringify(value));
  } catch {
    // not remembered
  }
}

export function recall(key, fallback) {
  try {
    const stored = localStorage.getItem(`ib.${key}`);
    return stored === null ? fallback : JSON.parse(stored);
  } catch {
    return fallback;
  }
}

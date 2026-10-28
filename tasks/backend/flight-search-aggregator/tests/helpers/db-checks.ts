// The structural checks of stage 3, as pure functions over what helpers/db-spy.mjs recorded.
// Each returns a list of problems (empty = pass), so the tests can print all of them at once.

export interface ReadRecord {
  sql: string;
  params: unknown[];
  rows: number;
  bytes: number;
  thread?: number;
}

export interface ConnectionInfo {
  path: string;
  open: boolean;
  synchronous?: number;
  journalMode?: string;
  thread?: number;
}

/** What the spy counted over one window (a search, or one getPage call). */
export interface SpyStats {
  prepares: number;
  writes: number;
  autocommitWrites: number;
  commits: number; // explicit transactions committed
  rowsRead: number;
  bytesRead: number;
  changes: number;
  reads: ReadRecord[];
  violations: string[];
  connections: ConnectionInfo[];
}

/** `EXPLAIN QUERY PLAN` details for a statement and its params, on a test-owned connection. */
export type Explain = (sql: string, params: unknown[]) => string[];

const READS_OFFERS = /\boffers\b/i;
// The SEARCH on offers of a page after the first must seek past the cursor: a range on the sort
// key right after the search id, e.g. "(search_id=? AND (total_cents,duration_min,offer_id)>(?,?,?))".
const SEEKS_CURSOR = /\(search_id=\? AND (?:\([\w,]+\)|\w+)>\(?\?/;

export const readsOffers = (r: ReadRecord): boolean => READS_OFFERS.test(r.sql);

/** Test 3: every offers-reading SELECT of one getPage call is an index seek in the page's order. */
export function pagePlanProblems(reads: ReadRecord[], explain: Explain, withCursor: boolean): string[] {
  const offerReads = reads.filter(readsOffers);
  if (offerReads.length === 0) return ["getPage read nothing from offers (a page must come from the database)"];
  const problems: string[] = [];
  for (const r of offerReads) {
    const details = explain(r.sql, r.params);
    const plan = details.join(" | ");
    const where = `${oneLine(r.sql)}\n    plan: ${plan}`;
    if (/USE TEMP B-TREE/.test(plan)) problems.push(`sorts instead of reading an index in order: ${where}`);
    if (/\bSCAN offers\b/.test(plan)) problems.push(`scans offers: ${where}`);
    const search = details.find((d) => /\bSEARCH offers USING (COVERING )?INDEX\b/.test(d));
    if (!search) problems.push(`doesn't search offers through an index: ${where}`);
    else if (withCursor && !SEEKS_CURSOR.test(search)) {
      problems.push(`doesn't seek to the cursor position (reads the search from its start): ${where}`);
    }
    if (withCursor && /\bOFFSET\b/i.test(r.sql)) problems.push(`uses OFFSET: ${oneLine(r.sql)}`);
  }
  return problems;
}

/** Test 4: one getPage call reads about what it returns. `k` = max rows per offer (1 + children). */
export function pageReadProblems(stats: SpyStats, limit: number, k: number, pageJsonLength: number): string[] {
  const problems: string[] = [];
  const maxRows = (limit + 1) * k + 2;
  if (stats.rowsRead > maxRows) problems.push(`read ${stats.rowsRead} rows for a page of ${limit} (bound ${maxRows})`);
  const maxBytes = 3 * pageJsonLength + 16 * 1024;
  if (stats.bytesRead > maxBytes) problems.push(`read ${stats.bytesRead} bytes for a ${pageJsonLength}-byte page (bound ${maxBytes})`);
  return problems;
}

/** Test 5: the data team's settings are intact on every connection, and nothing else is opened. */
export function durabilityProblems(stats: SpyStats, dbPath: string): string[] {
  const problems: string[] = [];
  const same = (p: string) => p.replaceAll("\\", "/").toLowerCase() === dbPath.replaceAll("\\", "/").toLowerCase();
  for (const c of stats.connections) {
    if (!same(c.path)) problems.push(`a connection to ${JSON.stringify(c.path)}, not the service's dbPath`);
    if (!c.open) continue;
    if (c.synchronous !== 2) problems.push(`synchronous=${c.synchronous} on a connection (must stay FULL = 2)`);
    if (c.journalMode !== "wal") problems.push(`journal_mode=${c.journalMode} on a connection (must stay wal)`);
  }
  return problems;
}

/**
 * Test 1: a search's rows are committed in a few transactions, not row by row. Commits are
 * counted twice: in the WAL file (`walCommits`, null when a checkpoint restarted the WAL during
 * the search) and by the spy (autocommit writes plus transactions committed), however they
 * were sent.
 */
export function batchingProblems(stats: SpyStats, walCommits: number | null, rowsInDb: number): string[] {
  const problems: string[] = [];
  if (stats.autocommitWrites > 2) {
    problems.push(`${stats.autocommitWrites} write statements ran outside a transaction (each is its own commit)`);
  }
  const commits = Math.max(walCommits ?? 0, stats.autocommitWrites + stats.commits);
  if (commits > 3) problems.push(`the search made ${commits} commits`);
  if (rowsInDb > stats.changes) {
    problems.push(`DB writes not observed: ${rowsInDb} rows stored, but only ${stats.changes} changes seen on the service's connections`);
  }
  return problems;
}

/** Test 2: statements are prepared once, not per row. */
export function prepareProblems(small: SpyStats, big: SpyStats, second: SpyStats): string[] {
  const problems: string[] = [];
  if (big.prepares > 40) problems.push(`${big.prepares} statements compiled in one search (bound 40)`);
  if (big.prepares - small.prepares > 5) {
    problems.push(`compiles grow with the data: ${small.prepares} at the small size, ${big.prepares} at 10x`);
  }
  if (second.prepares > big.prepares) {
    problems.push(`a second search compiled more (${second.prepares}) than the first (${big.prepares})`);
  }
  return problems;
}

const oneLine = (sql: string) => sql.replace(/\s+/g, " ").trim().slice(0, 300);

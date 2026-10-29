// Test-owned `node:sqlite` spy, loaded with `node --import <this file>` into the stage-3 scenario
// child (helpers/scenario.ts) and, through the patched Worker, into every worker thread it starts.
//
// It records what the code under test does with SQLite, however it reaches it:
// - `DatabaseSync` and `Worker` are replaced by proxies and `syncBuiltinESMExports()` is
//   called, so named ESM imports, `process.getBuiltinModule` and `createRequire` all get them.
//   Proxies (not subclasses) so `Object.getPrototypeOf()` can't hand out the original classes.
//   Workers always get this preload, whatever `execArgv` they pass; `eval` workers are refused.
// - `prepare`/`exec`, the statement methods, the `SQLTagStore` methods and user-defined SQL
//   functions are wrapped.
// - Every tracked connection gets `wal_autocheckpoint=0` (not a durability setting), so the
//   scenario can count commit frames in the WAL file.
//
// Per thread it counts compiles, write statements (and those run outside a transaction, which
// are commits of their own), transactions committed, rows and bytes returned (including the
// arguments passed to user-defined functions), and keeps every SELECT with its params.
// Workers send their counts to the main thread over an unref'd BroadcastChannel, eagerly after
// any database activity and when the main thread asks (collect()).
import { createRequire, syncBuiltinESMExports } from "node:module";
import { isMainThread, threadId } from "node:worker_threads";

const require = createRequire(import.meta.url);
const wt = require("node:worker_threads");
const sqlite = require("node:sqlite");

const SELF = import.meta.url;
const CHANNEL = "interviewbench-db-spy";

const OrigDatabaseSync = sqlite.DatabaseSync;
const OrigWorker = wt.Worker;
const DB = OrigDatabaseSync.prototype;
const ST = sqlite.StatementSync.prototype;
const orig = {
  prepare: DB.prepare,
  exec: DB.exec,
  close: DB.close,
  open: DB.open,
  createTagStore: DB.createTagStore,
  function: DB.function,
  aggregate: DB.aggregate,
  applyChangeset: DB.applyChangeset,
  run: ST.run,
  get: ST.get,
  all: ST.all,
  iterate: ST.iterate,
};

// ---- SQL classification ------------------------------------------------------------------

const stripComments = (sql) => sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").trim();
const WRITE = /^(INSERT|UPDATE|DELETE|REPLACE)\b/i;
const WITH_WRITE = /^WITH\b[\s\S]*\b(INSERT|UPDATE|DELETE|REPLACE)\b/i;
const READ = /^(SELECT|WITH|VALUES)\b/i;
const TX_START = /^(BEGIN|SAVEPOINT)\b/i;
const TX_COMMIT = /^(COMMIT|END)\b/i;
const TX_ROLLBACK = /^ROLLBACK\b(?!\s+(TRANSACTION\s+)?TO\b)/i;

const isWrite = (sql) => {
  const s = stripComments(sql);
  return WRITE.test(s) || WITH_WRITE.test(s);
};
const isRead = (sql) => !isWrite(sql) && READ.test(stripComments(sql));
/** The statements in an `exec` script. Good enough for SQL without `;` inside literals. */
const splitStatements = (sql) => stripComments(sql).split(";").map((s) => s.trim()).filter(Boolean);

function valueBytes(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === "string") return v.length;
  if (v instanceof Uint8Array) return v.byteLength;
  return 8;
}
function rowBytes(row) {
  if (row === undefined || row === null) return 0;
  let n = 0;
  for (const v of Array.isArray(row) ? row : Object.values(row)) n += valueBytes(v);
  return n;
}
/** Params as structured-clone-safe values (they cross the BroadcastChannel and stdout). */
const cloneParams = (args) =>
  args.map((a) => (a instanceof Uint8Array ? `<blob ${a.byteLength}>` : typeof a === "bigint" ? Number(a) : a));

// ---- per-thread state ----------------------------------------------------------------------

/** @type {{ db: any, path: string, closed: boolean, lastTotal: number, finalTotal?: number }[]} */
const connections = [];
const byDb = new WeakMap(); // DatabaseSync -> connection record
const stmtDb = new WeakMap(); // StatementSync -> DatabaseSync

const fresh = () => ({
  prepares: 0,
  writes: 0,
  autocommitWrites: 0,
  commits: 0, // explicit transactions committed (autocommit writes are counted above)
  rowsRead: 0,
  bytesRead: 0,
  reads: [], // { sql, params, rows, bytes }
  violations: [], // anything the spy refused, e.g. an eval worker
});
let delta = fresh();

function totalChanges(db) {
  return Number(orig.get.call(orig.prepare.call(db, "SELECT total_changes() AS n")).n);
}

function track(db, path) {
  const rec = { db, path: String(path), closed: false, lastTotal: 0 };
  connections.push(rec);
  byDb.set(db, rec);
  if (db.isOpen) prepareConnection(rec);
}
function prepareConnection(rec) {
  orig.exec.call(rec.db, "PRAGMA wal_autocheckpoint = 0");
  rec.lastTotal = totalChanges(rec.db);
}

/** Counts a write about to run on `db`. Outside a transaction it is a commit of its own. */
function countWrite(db) {
  delta.writes++;
  if (!db.isTransaction) delta.autocommitWrites++;
  scheduleReport();
}

/**
 * Runs a statement that isn't a write and counts it as a commit if it ended the transaction
 * `db` was in (COMMIT, END or the outermost RELEASE), however it was sent. With this count the
 * scenario doesn't depend on the WAL file alone, which a checkpoint can restart.
 */
function runTracked(db, sql, call) {
  const wasTransaction = db?.isTransaction === true;
  const result = call();
  if (wasTransaction && !db.isTransaction && !TX_ROLLBACK.test(stripComments(sql))) {
    delta.commits++;
    scheduleReport();
  }
  return result;
}

/** Wraps a user-defined SQL function so each call counts as a row read, with its arguments. */
function countingCallback(fn) {
  if (typeof fn !== "function") return fn;
  const counting = function (...args) {
    delta.rowsRead++;
    delta.bytesRead += rowBytes(args);
    scheduleReport();
    return fn.apply(this, args);
  };
  // node:sqlite derives the SQL argument count from `length` unless `varargs` is set.
  return Object.defineProperty(counting, "length", { value: fn.length });
}

/** Counts the rows and bytes a read returns (lazily, for iterate()) and keeps its SQL. */
function recordRead(sql, params, result, isIterate) {
  if (!isRead(sql)) return result;
  const entry = { sql, params: cloneParams(params), rows: 0, bytes: 0 };
  delta.reads.push(entry);
  const count = (row) => {
    entry.rows++;
    const b = rowBytes(row);
    entry.bytes += b;
    delta.rowsRead++;
    delta.bytesRead += b;
  };
  if (isIterate) {
    return (function* () {
      for (const row of result) {
        count(row);
        yield row;
      }
    })();
  }
  if (Array.isArray(result)) result.forEach(count);
  else if (result !== undefined) count(result);
  scheduleReport();
  return result;
}

// ---- patches -------------------------------------------------------------------------------

// A proxy, not a subclass: Object.getPrototypeOf(DatabaseSync) would return the original class,
// and with it an untracked connection. `db.constructor` is pointed at the proxy for the same reason.
const SpyDatabaseSync = new Proxy(OrigDatabaseSync, {
  construct(target, args, newTarget) {
    const db = Reflect.construct(target, args, newTarget);
    track(db, args[0]);
    return db;
  },
});
DB.constructor = SpyDatabaseSync;

DB.open = function (...args) {
  const r = orig.open.apply(this, args);
  const rec = byDb.get(this);
  if (rec) prepareConnection(rec);
  return r;
};

DB.close = function (...args) {
  const rec = byDb.get(this);
  if (rec && !rec.closed && this.isOpen) {
    rec.finalTotal = totalChanges(this);
    rec.closed = true;
  }
  return orig.close.apply(this, args);
};

DB.prepare = function (sql, ...args) {
  delta.prepares++;
  scheduleReport();
  const stmt = orig.prepare.call(this, sql, ...args);
  stmtDb.set(stmt, this);
  return stmt;
};

DB.exec = function (sql) {
  const statements = splitStatements(String(sql));
  delta.prepares += statements.length;
  const writes = statements.filter(isWrite).length;
  delta.writes += writes;
  if (!this.isTransaction && statements.length > 0 && !TX_START.test(statements[0])) delta.autocommitWrites += writes;
  scheduleReport();
  const wasTransaction = this.isTransaction;
  const result = orig.exec.call(this, sql);
  // Every COMMIT/END in the script ends a transaction; so does a RELEASE of the outermost savepoint.
  let commits = statements.filter((s) => TX_COMMIT.test(s)).length;
  if (commits === 0 && wasTransaction && !this.isTransaction && !statements.some((s) => TX_ROLLBACK.test(s))) commits = 1;
  delta.commits += commits;
  return result;
};

// A changeset is applied in one transaction of its own unless one is open.
DB.applyChangeset = function (...args) {
  if (!this.isTransaction) delta.commits++;
  scheduleReport();
  return orig.applyChangeset.apply(this, args);
};

// User-defined functions see every row a query visits, so a query can return one row while its
// function collects the whole search. Their calls count as rows read.
DB.function = function (name, ...rest) {
  return orig.function.call(this, name, ...rest.map(countingCallback));
};
DB.aggregate = function (name, options) {
  const counted = options && { ...options, step: countingCallback(options.step), inverse: countingCallback(options.inverse) };
  return orig.aggregate.call(this, name, counted);
};

for (const method of ["run", "get", "all", "iterate"]) {
  ST[method] = function (...args) {
    const sql = this.sourceSQL;
    if (isWrite(sql)) {
      countWrite(stmtDb.get(this) ?? { isTransaction: false });
      return orig[method].apply(this, args);
    }
    const run = () => orig[method].apply(this, args);
    return recordRead(sql, args, runTracked(stmtDb.get(this), sql, run), method === "iterate");
  };
}

// SQLTagStore runs its cached statements without going through StatementSync.prototype, and in
// Node 24.13 every store gets its own prototype object. The methods are patched on that
// prototype, not on the store, so Object.getPrototypeOf(store).run is the wrapper too.
const compiledBy = new WeakMap(); // store -> SQL it has already compiled
DB.createTagStore = function (...args) {
  const store = orig.createTagStore.apply(this, args);
  compiledBy.set(store, new Set());
  const proto = Object.getPrototypeOf(store);
  for (const method of ["run", "get", "all", "iterate"]) {
    const original = proto[method];
    if (typeof original !== "function" || original.ibSpied) continue;
    const wrapped = function (strings, ...values) {
      const sql = Array.from(strings).join("?");
      const compiled = compiledBy.get(this);
      if (compiled && !compiled.has(sql)) {
        compiled.add(sql);
        delta.prepares++;
      }
      if (isWrite(sql)) {
        countWrite(this.db);
        return original.call(this, strings, ...values);
      }
      const run = () => original.call(this, strings, ...values);
      return recordRead(sql, values, runTracked(this.db, sql, run), method === "iterate");
    };
    wrapped.ibSpied = true;
    Object.defineProperty(proto, method, { configurable: true, writable: true, value: wrapped });
  }
  return store;
};

// A proxy for the same reason as SpyDatabaseSync.
const SpyWorker = new Proxy(OrigWorker, {
  construct(target, [filename, options = {}], newTarget) {
    if (options?.eval) {
      const error = new Error("this task's test harness doesn't support eval workers: pass a file or URL");
      delta.violations.push(error.message);
      throw error;
    }
    const execArgv = options?.execArgv ?? process.execArgv;
    const preload = `--import=${SELF}`;
    const worker = Reflect.construct(
      target,
      [filename, { ...options, execArgv: execArgv.includes(preload) ? execArgv : [preload, "--no-warnings=ExperimentalWarning", ...execArgv] }],
      newTarget,
    );
    if (isMainThread) {
      liveWorkers.add(worker.threadId);
      worker.once("exit", () => liveWorkers.delete(worker.threadId));
    }
    return worker;
  },
});
OrigWorker.prototype.constructor = SpyWorker;

sqlite.DatabaseSync = SpyDatabaseSync;
wt.Worker = SpyWorker;
syncBuiltinESMExports();

// ---- reporting -----------------------------------------------------------------------------

/** Takes this thread's counts since the last snapshot, plus the state of its connections. */
function snapshot() {
  const out = delta;
  delta = fresh();
  out.thread = threadId;
  out.changes = 0;
  out.connections = connections.map((rec) => {
    const info = { path: rec.path, open: !rec.closed && rec.db.isOpen };
    let total = rec.finalTotal;
    if (info.open) {
      total = totalChanges(rec.db);
      // Read through the original prepare: whatever the code under test did to the pragma
      // text, this is what the connection really uses.
      info.synchronous = Number(orig.get.call(orig.prepare.call(rec.db, "PRAGMA synchronous")).synchronous);
      info.journalMode = String(orig.get.call(orig.prepare.call(rec.db, "PRAGMA journal_mode")).journal_mode);
    }
    if (total !== undefined) {
      out.changes += total - rec.lastTotal;
      rec.lastTotal = total;
    }
    return info;
  });
  return out;
}

const channel = new BroadcastChannel(CHANNEL);
channel.unref();

let reportScheduled = false;
function scheduleReport() {
  if (isMainThread || reportScheduled) return;
  reportScheduled = true;
  setImmediate(() => {
    reportScheduled = false;
    channel.postMessage({ type: "report", thread: threadId, stats: snapshot() });
  }).unref();
}

const liveWorkers = new Set();
const pending = []; // reports from workers since the last collect()
let flushId = 0;
const flushWaiters = new Map(); // flush id -> { threads: Set, done() }

if (isMainThread) {
  channel.onmessage = ({ data }) => {
    if (data.type === "report") pending.push(data.stats);
    if (data.type === "flushed") {
      pending.push(data.stats);
      const waiter = flushWaiters.get(data.id);
      waiter?.threads.delete(data.thread);
      if (waiter && waiter.threads.size === 0) waiter.done();
    }
  };
} else {
  channel.onmessage = ({ data }) => {
    if (data.type === "flush") channel.postMessage({ type: "flushed", id: data.id, thread: threadId, stats: snapshot() });
  };
  process.on("exit", () => channel.postMessage({ type: "report", thread: threadId, stats: snapshot() }));
}

/** Sums thread snapshots into one. */
function merge(snaps) {
  const total = { ...fresh(), changes: 0, threads: [], connections: [] };
  for (const s of snaps) {
    total.prepares += s.prepares;
    total.writes += s.writes;
    total.autocommitWrites += s.autocommitWrites;
    total.commits += s.commits;
    total.rowsRead += s.rowsRead;
    total.bytesRead += s.bytesRead;
    total.changes += s.changes;
    total.reads.push(...s.reads.map((r) => ({ ...r, thread: s.thread })));
    total.violations.push(...s.violations);
    total.connections.push(...s.connections.map((c) => ({ ...c, thread: s.thread })));
    if (!total.threads.includes(s.thread)) total.threads.push(s.thread);
  }
  return total;
}

if (isMainThread) {
  globalThis.__ibDbSpy = {
    /** Starts a measurement window: forgets everything counted so far, in every thread. */
    async mark() {
      await this.collect();
    },
    /** Everything counted since the last mark()/collect(), in all threads. */
    async collect() {
      const id = ++flushId;
      const threads = new Set(liveWorkers);
      if (threads.size > 0) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 2000);
          flushWaiters.set(id, {
            threads,
            done: () => {
              clearTimeout(timer);
              resolve();
            },
          });
          channel.postMessage({ type: "flush", id });
        });
        flushWaiters.delete(id);
      }
      // Reports a worker sent just before it exited may still be in flight.
      await new Promise((resolve) => setImmediate(resolve));
      return merge([snapshot(), ...pending.splice(0)]);
    },
    /** A connection the spy doesn't track, for the scenario's own reads (use query()). */
    open(path, options) {
      return new OrigDatabaseSync(path, options);
    },
    /** Runs a read without counting it. */
    query(db, sql, ...params) {
      return orig.all.call(orig.prepare.call(db, sql), ...params);
    },
  };
}

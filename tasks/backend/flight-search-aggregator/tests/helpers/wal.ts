// Counts commits in a SQLite WAL file (https://www.sqlite.org/fileformat.html#the_write_ahead_log).
// Each commit ends with a frame whose header bytes 4-7 (the database size after the commit) are
// non-zero. Only frames carrying the header's salt belong to the current WAL generation.
import { existsSync, readFileSync } from "node:fs";

export interface WalState {
  salt: string; // changes when the WAL restarts from the beginning (after a checkpoint)
  frames: number;
  commits: number;
}

const HEADER = 32;
const FRAME_HEADER = 24;

export function readWal(dbPath: string): WalState {
  const path = `${dbPath}-wal`;
  if (!existsSync(path)) return { salt: "", frames: 0, commits: 0 };
  const buf = readFileSync(path);
  if (buf.length < HEADER) return { salt: "", frames: 0, commits: 0 };
  const pageSize = buf.readUInt32BE(8);
  const salt1 = buf.readUInt32BE(16);
  const salt2 = buf.readUInt32BE(20);
  let frames = 0;
  let commits = 0;
  for (let off = HEADER; off + FRAME_HEADER + pageSize <= buf.length; off += FRAME_HEADER + pageSize) {
    if (buf.readUInt32BE(off + 8) !== salt1 || buf.readUInt32BE(off + 12) !== salt2) break;
    frames++;
    if (buf.readUInt32BE(off + 4) !== 0) commits++;
  }
  return { salt: `${salt1}:${salt2}`, frames, commits };
}

/**
 * Commits added between two readings, or null if the WAL restarted in between (a checkpoint
 * reset it), in which case the caller falls back to counting statements.
 */
export function commitsBetween(before: WalState, after: WalState): number | null {
  if (before.salt !== "" && before.salt !== after.salt) return null;
  return after.commits - before.commits;
}

// Self-test of the stage-3 spy and checks, run by task authors (not by the verifier):
//
//   APP_DIR=<a stage-3 app> node --no-warnings=ExperimentalWarning tests/helpers/spy-selftest.ts
//
// Every bypass case must be caught (at least one problem) and every "good-*" control must pass.
// Needs only src/db/schema.ts from APP_DIR.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CASES = [
  "good-transaction",
  "worker-execargv",
  "worker-no-warnings",
  "worker-tag-store",
  "eval-worker",
  "tag-store",
  "multi-statement-exec",
  "child-process",
  "child-process-wal-reset",
  "transaction-per-row",
  "tag-store-prototype",
  "memory-database",
  "pragma-synchronous-off",
  "good-page",
  "json-group-array-page",
  "expanded-or-page",
  "limit-without-order-page",
  "offset-page",
  "page-from-memory",
  "user-function-page",
];

const spyUrl = new URL("./db-spy.mjs", import.meta.url).href;
const child = fileURLToPath(new URL("./spy-selftest-child.ts", import.meta.url));
let failures = 0;
for (const name of CASES) {
  const dir = mkdtempSync(join(tmpdir(), "ib-spy-"));
  const r = spawnSync(
    process.execPath,
    ["--no-warnings=ExperimentalWarning", `--import=${spyUrl}`, child, name, join(dir, "search.db")],
    { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } },
  );
  rmSync(dir, { recursive: true, force: true });
  const line = r.stdout.trim().split("\n").pop() ?? "";
  let problems: string[] | undefined;
  try {
    problems = JSON.parse(line).problems;
  } catch {
    console.log(`ERROR ${name}: exit ${r.status}\n${r.stderr}`);
    failures++;
    continue;
  }
  const expectClean = name.startsWith("good-");
  const ok = expectClean ? problems!.length === 0 : problems!.length > 0;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${expectClean ? "clean" : "caught"}`);
  for (const p of problems!) console.log(`       - ${p.split("\n")[0]}`);
}
console.log(failures === 0 ? "all cases behave as expected" : `${failures} case(s) wrong`);
process.exitCode = failures === 0 ? 0 : 1;

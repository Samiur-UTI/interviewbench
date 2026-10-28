// Runs a helper script in a fresh Node process and reports how it ended.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { APP_DIR } from "./app.ts";

export interface ChildResult {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
  killed: boolean;
}

export interface ChildOptions {
  args?: string[];
  execArgv?: string[]; // extra node flags, e.g. a preload
  limitMs: number; // the child is killed (killed: true) if it hasn't exited by then
}

/** The flags every child gets: node:sqlite's one-line ExperimentalWarning is noise in stderr. */
const BASE_FLAGS = ["--no-warnings=ExperimentalWarning"];

export function runChild(script: URL, options: ChildOptions): Promise<ChildResult> {
  const start = performance.now();
  const env: NodeJS.ProcessEnv = { ...process.env, APP_DIR };
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT; // run as a plain script, not as a test file
  const child = spawn(
    process.execPath,
    [...BASE_FLAGS, ...(options.execArgv ?? []), fileURLToPath(script), ...(options.args ?? [])],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  let killed = false;
  const timer = setTimeout(() => {
    killed = true;
    child.kill("SIGKILL");
  }, options.limitMs);
  return new Promise((resolve) => {
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, ms: performance.now() - start, killed });
    });
  });
}

/** The spy preload for stage-3 structural scenarios (helpers/db-spy.mjs). */
export const SPY_FLAGS = [`--import=${new URL("./db-spy.mjs", import.meta.url).href}`];

const RESULT_PREFIX = "SCENARIO-RESULT ";

/** Prints a scenario's result as one line the parent can find among anything else it printed. */
export function printResult(result: unknown): void {
  console.log(RESULT_PREFIX + JSON.stringify(result));
}

/** Runs a scenario child and returns its printed result, or throws with what went wrong. */
export async function runScenario<T>(script: URL, options: ChildOptions): Promise<T> {
  const r = await runChild(script, options);
  const line = r.stdout.split("\n").find((l) => l.startsWith(RESULT_PREFIX));
  if (r.killed) throw new Error(`scenario ${options.args?.[0] ?? ""} didn't finish within ${options.limitMs} ms`);
  if (r.code !== 0 || !line) {
    throw new Error(`scenario ${options.args?.[0] ?? ""} failed (exit ${r.code}):\n${r.stderr.slice(-3000)}`);
  }
  return JSON.parse(line.slice(RESULT_PREFIX.length)) as T;
}

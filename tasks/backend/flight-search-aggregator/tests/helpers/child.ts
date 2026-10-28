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

/** Kills the child (and reports killed: true) if it hasn't exited after `limitMs`. */
export function runChild(script: URL, limitMs: number): Promise<ChildResult> {
  const start = performance.now();
  const env = { ...process.env, APP_DIR };
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT; // run as a plain script, not as a test file
  const child = spawn(process.execPath, [fileURLToPath(script)], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  let killed = false;
  const timer = setTimeout(() => {
    killed = true;
    child.kill("SIGKILL");
  }, limitMs);
  return new Promise((resolve) => {
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, ms: performance.now() - start, killed });
    });
  });
}

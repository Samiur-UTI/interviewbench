// Runs the real server (src/server/main.ts) in its own Node process, for the tests that need a
// crash to be observable: an exception there ends that process, not the test runner.
//
//   const server = await startServer({ seed: buildSeed() });     // PORT=0, waits for "listening on"
//   after(() => server.kill());
//   ... await fetch(`${server.url}/api/dashboard`); assert.ok(server.alive());
//
// Windows notes: SIGTERM handlers never run there, so tests assert only that the process is gone
// after kill(); kill() uses `taskkill /T /F` on win32 so no server is left behind.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_DIR } from "./app.ts";
import type { ChildProcess } from "node:child_process";

export interface StartOptions {
  /** A seed object, written to a temp file passed as SEED_PATH (removed by kill()). */
  seed?: unknown;
  /** An existing seed file (default: the app's data/seed.json). Ignored when `seed` is given. */
  seedPath?: string;
  /** Extra environment. The sandbox platforms default to 5-20 ms latency and no random failures. */
  env?: Record<string, string>;
  /** How long to wait for the "listening on" line (default 15 s). */
  deadlineMs?: number;
}

export interface ServerProcess {
  /** http://127.0.0.1:<port> */
  url: string;
  port: number;
  child: ChildProcess;
  /** Output so far (grows while the process runs). */
  readonly stdout: string;
  readonly stderr: string;
  /** Resolves when the process exits, for whatever reason. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** True while the process is running. */
  alive(): boolean;
  /** Resolves true if the process exits within `ms`, false if it is still running then. */
  exitsWithin(ms: number): Promise<boolean>;
  /** Kills the process (and its children) and waits for it to exit. Safe to call twice. */
  kill(): Promise<void>;
}

const LISTENING = /listening on (http:\/\/127\.0\.0\.1:(\d+))/;

function forceKill(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    child.kill("SIGKILL");
  }
}

export function startServer(options: StartOptions = {}): Promise<ServerProcess> {
  let tempDir: string | undefined;
  let seedPath = options.seedPath;
  if (options.seed !== undefined) {
    tempDir = mkdtempSync(join(tmpdir(), "relay-seed-"));
    seedPath = join(tempDir, "seed.json");
    writeFileSync(seedPath, JSON.stringify(options.seed));
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: "0",
    RELAY_SANDBOX_LATENCY_MS: "5,20",
    RELAY_SANDBOX_FAILURE_RATE: "0",
    ...(seedPath ? { SEED_PATH: seedPath } : {}),
    ...options.env,
  };
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT; // run as a plain script, not as a test file

  const child = spawn(process.execPath, ["--no-warnings=ExperimentalWarning", join(APP_DIR, "src", "server", "main.ts")], {
    cwd: APP_DIR,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (d) => (stdout += d));
  child.stderr!.on("data", (d) => (stderr += d));
  child.on("error", () => {}); // a spawn failure shows up as "exit" below

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("exit", (code, signal) => {
      if (tempDir) rmSync(tempDir, { recursive: true, force: true });
      resolve({ code, signal });
    });
  });
  const alive = () => child.exitCode === null && child.signalCode === null;

  let killing: Promise<void> | undefined;
  const kill = () => {
    killing ??= (async () => {
      forceKill(child);
      const gone = await Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 5_000).unref())]);
      if (!gone) {
        child.kill("SIGKILL");
        await exited;
      }
    })();
    return killing;
  };

  const deadlineMs = options.deadlineMs ?? 15_000;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      void kill();
      reject(new Error(`server didn't print "listening on" within ${deadlineMs} ms\nstdout:\n${stdout}\nstderr:\n${stderr.slice(-3000)}`));
    }, deadlineMs);
    const onData = () => {
      const match = LISTENING.exec(stdout);
      if (!match) return;
      clearTimeout(timer);
      child.stdout!.off("data", onData);
      resolve({
        url: match[1],
        port: Number(match[2]),
        child,
        get stdout() {
          return stdout;
        },
        get stderr() {
          return stderr;
        },
        exited,
        alive,
        exitsWithin: (ms) =>
          Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms).unref())]),
        kill,
      });
    };
    child.stdout!.on("data", onData);
    void exited.then(({ code, signal }) => {
      clearTimeout(timer);
      reject(new Error(`server exited (code ${code}, signal ${signal}) before listening\nstderr:\n${stderr.slice(-3000)}`));
    });
  });
}

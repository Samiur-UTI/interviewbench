// Loads the code under test from $APP_DIR by absolute path, so nothing in the candidate's folder
// (package.json, loaders, test config) decides how the hidden tests run.
//
// The import is attempted once. If it fails (syntax error, missing file, an `enum`), the error is
// cached and rethrown inside every test that calls loadApp(), so each test is reported as failed
// rather than the whole file collapsing into a single testcase.
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// The app's exports, loosely typed: the hidden tests define the contract they check.
export type App = Record<string, any>;

export const APP_DIR = process.env.APP_DIR ?? "/app";

let loaded: { app?: App; error?: unknown } | undefined;

export async function loadApp(): Promise<App> {
  if (!loaded) {
    try {
      loaded = { app: (await import(pathToFileURL(join(APP_DIR, "src", "index.ts")).href)) as App };
    } catch (error) {
      loaded = { error };
    }
  }
  if (loaded.error !== undefined) throw loaded.error;
  return loaded.app as App;
}

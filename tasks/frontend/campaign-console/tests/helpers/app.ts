// Loads the code under test from $APP_DIR by absolute path, so nothing in the candidate's folder
// (package.json, loaders, test config) decides how the hidden tests run.
//
// Each import is attempted once. If it fails (syntax error, missing file, an `enum`), the error is
// cached and rethrown inside every test that asks for the module, so each test is reported as
// failed rather than the whole file collapsing into a single testcase.
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// The app's exports, loosely typed: the hidden tests define the contract they check.
export type Module = Record<string, any>;

export const APP_DIR = process.env.APP_DIR ?? "/app";

const cache = new Map<string, { module?: Module; error?: unknown }>();

/** Imports `<APP_DIR>/<relative>` once. */
export async function loadAppModule(relative: string): Promise<Module> {
  let entry = cache.get(relative);
  if (!entry) {
    try {
      entry = { module: (await import(pathToFileURL(join(APP_DIR, relative)).href)) as Module };
    } catch (error) {
      entry = { error };
    }
    cache.set(relative, entry);
  }
  if (entry.error !== undefined) throw entry.error;
  return entry.module as Module;
}

/** The server barrel, src/index.ts. */
export const loadApp = (): Promise<Module> => loadAppModule("src/index.ts");

/** The browser barrel, src/client/index.ts (imports cleanly in Node). */
export const loadClient = (): Promise<Module> => loadAppModule("src/client/index.ts");

/** The vendored renderer, for SSR of single components: `(await loadRender()).renderToString(vnode)`. */
export const loadRender = (): Promise<Module> => loadAppModule("vendor/preact/render-to-string.mjs");

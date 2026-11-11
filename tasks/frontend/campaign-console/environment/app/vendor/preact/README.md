# vendor/preact

Third-party code we serve to the browser and import on the server for SSR. It is checked in
because the console runs with no npm install: the server, the tests and the browser all load these
files straight from this folder.

| File | Package | Version | Licence |
|---|---|---|---|
| `preact.mjs` | [preact](https://github.com/preactjs/preact) (`dist/preact.mjs`) | 10.28.2 | MIT, `LICENSE-preact.txt` |
| `hooks.mjs` | preact (`hooks/dist/hooks.mjs`) | 10.28.2 | MIT, `LICENSE-preact.txt` |
| `render-to-string.mjs` | [preact-render-to-string](https://github.com/preactjs/preact-render-to-string) (`dist/index.mjs`) | 6.8.2 | MIT, `LICENSE-preact.txt` |
| `htm.mjs` | [htm](https://github.com/developit/htm) (`dist/htm.mjs`) | 3.1.1 | Apache-2.0, `LICENSE-htm.txt` |

The only change to the published files: bare `"preact"` imports were rewritten to `"./preact.mjs"`,
so browsers and Node resolve them without an import map or a bundler.

The `*.d.mts` files are ours: minimal type declarations for the parts of these APIs the console
uses, so `npm run typecheck` works without `node_modules`. Extend them when you use more of the API.

Upgrading: download the same files from the new release, redo the import rewrite, update the table.

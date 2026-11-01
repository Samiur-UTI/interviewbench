# Vendored libraries

These files are third-party code served to the browser. There is no npm and no build step: this
folder is the whole dependency.

| File | From | License |
|---|---|---|
| `preact.module.js` | `preact@10.29.8`, `dist/preact.module.js` | MIT (`LICENSE-preact.txt`) |
| `hooks.module.js` | `preact@10.29.8`, `hooks/dist/hooks.module.js` | MIT (`LICENSE-preact.txt`) |
| `htm.module.js` | `htm@3.1.1`, `dist/htm.module.js` | Apache-2.0 (`LICENSE-htm.txt`) |

One edit: `hooks.module.js` imports `from"preact"` in the package. It says `from"./preact.module.js"`
here, because a browser needs an import map for a bare name, and the CSP forbids an inline one.

`manifest.json` pins each file's SHA-256, and `tests/test_gui_static.py` checks them. To update:

1. Pick a version that has been out for a few weeks, and read its changelog.
2. Download the tarball from the npm registry and check it against the registry's `integrity`.
3. Copy the files in, repeat the edit above, and update this table and `manifest.json`.

Only `js/preact.js` may import from this folder.

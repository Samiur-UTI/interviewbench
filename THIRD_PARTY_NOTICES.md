# Third-party notices

interviewbench vendors the code below. Versions are those recorded in the repo's own vendor
READMEs and manifests. Each copy keeps its license file next to it.

## The local GUI

Path: `src/interviewbench/ui/static/vendor/` (see its `README.md` and `manifest.json`).

| Name | Version | License | Vendored copy | License file |
|---|---|---|---|---|
| preact | 10.29.8 | MIT | `src/interviewbench/ui/static/vendor/preact.module.js` | `src/interviewbench/ui/static/vendor/LICENSE-preact.txt` |
| preact hooks (part of preact) | 10.29.8 | MIT | `src/interviewbench/ui/static/vendor/hooks.module.js` | `src/interviewbench/ui/static/vendor/LICENSE-preact.txt` |
| htm | 3.1.1 | Apache-2.0 | `src/interviewbench/ui/static/vendor/htm.module.js` | `src/interviewbench/ui/static/vendor/LICENSE-htm.txt` |

## The campaign-console task

Path: `tasks/frontend/campaign-console/environment/app/vendor/preact/` (see its `README.md`).

| Name | Version | License | Vendored copy | License file |
|---|---|---|---|---|
| preact | 10.28.2 | MIT | `tasks/frontend/campaign-console/environment/app/vendor/preact/preact.mjs` | `tasks/frontend/campaign-console/environment/app/vendor/preact/LICENSE-preact.txt` |
| preact hooks (part of preact) | 10.28.2 | MIT | `tasks/frontend/campaign-console/environment/app/vendor/preact/hooks.mjs` | `tasks/frontend/campaign-console/environment/app/vendor/preact/LICENSE-preact.txt` |
| preact-render-to-string | 6.8.2 | MIT | `tasks/frontend/campaign-console/environment/app/vendor/preact/render-to-string.mjs` | `tasks/frontend/campaign-console/environment/app/vendor/preact/LICENSE-preact.txt` |
| htm | 3.1.1 | Apache-2.0 | `tasks/frontend/campaign-console/environment/app/vendor/preact/htm.mjs` | `tasks/frontend/campaign-console/environment/app/vendor/preact/LICENSE-htm.txt` |

The README in that folder gives `LICENSE-preact.txt` as the license file for preact-render-to-string
too. That file's copyright line names Jason Miller, the preact author. This repo does not hold a
separate license file for preact-render-to-string.

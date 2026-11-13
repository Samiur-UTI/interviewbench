# Maintaining interviewbench

For maintainers: how `main` is protected, what each check enforces, how to review a pull request
and how to release. Contributors start with [CONTRIBUTING.md](../CONTRIBUTING.md).

## How main is protected

Nobody pushes to `main` directly. Every change is a pull request, and it merges only when the
checks pass. Two rulesets hold the rules. They are kept in the repository so they can be reviewed
and restored:

| Ruleset | File | Applies to | What it requires |
|---|---|---|---|
| Protect main | `.github/rulesets/main-protection.json` | Everyone, admins included | A pull request, every check below green, all review threads resolved. No force-push, no deleting the branch. |
| Review on main | `.github/rulesets/main-review.json` | Everyone except admins merging a pull request | One approval from a code owner (`.github/CODEOWNERS`), given after the last push. |

The second ruleset has an admin bypass because a maintainer cannot approve their own pull request.
The bypass is for pull requests only: an admin still cannot push to `main`, and still needs the
checks to pass, because the first ruleset has no bypass.

### The required checks

| Check | Workflow | What it enforces |
|---|---|---|
| Tests (ubuntu-latest and windows-latest, Python 3.10 and 3.12) | `ci.yml` | The whole test suite, on both systems and on the oldest supported Python. It includes every task's starter and reference solutions. |
| Tasks in containers | `ci.yml` | Every task's starter fails stage 1 and every reference solution passes, in the task's own Docker image. |
| Lint | `ci.yml` | `ruff check src tests` with the rules in `pyproject.toml`. |
| Commit messages | `pr-checks.yml` | Every commit subject follows `type(scope): subject`. |
| Tests with code changes | `pr-checks.yml` | A pull request that changes `src/` also changes `tests/`. |

If you rename a job, change its name in `main-protection.json` and in the ruleset on GitHub in the
same pull request. A required check that never reports blocks every merge.

### The `no-tests-needed` label

"Tests with code changes" fails when a pull request changes `src/` and not `tests/`. For a change
that cannot have a test (a comment, help text, a pure rename), add the `no-tests-needed` label and
the check re-runs and passes. Only maintainers can add labels, so this is a maintainer's decision.
Create the label once under Issues > Labels.

## Going public: one-time setup

GitHub applies rulesets to a private repository only on a paid plan, so they start working when the
repository is public. Do these in order:

1. Delete the branches that hold the old history (`main-old` and the merged feature branches).
2. Change the visibility to public.
3. Settings > Rules > Rulesets > New ruleset > Import a ruleset. Import `main-protection.json`, then
   `main-review.json`. Check that each shows "Active" and targets the default branch.
4. Settings > Code security: turn on private vulnerability reporting (`SECURITY.md` sends reporters
   there), Dependabot alerts, secret scanning and push protection.
5. Settings > Actions > General: require approval for workflows from first-time contributors, and
   set the default workflow permissions to read-only.
6. Settings > General > Pull Requests: allow merge commits (the project keeps each pull request's
   commits), and turn on "Automatically delete head branches".
7. Settings > General > Features: turn on Discussions, which the issue chooser links to, or remove
   that link from `.github/ISSUE_TEMPLATE/config.yml`.
8. Issues > Labels: create `no-tests-needed`, `bug` and `task`.

To check the protection works, open a pull request from a branch with a failing test: the merge
button must stay blocked. Then try `git push origin main` with a local commit: it must be refused.

## Reviewing a pull request

The checks cover what a machine can check. Read for the rest:

- **A test that fails without the change.** Check out the branch, revert the change under `src/`
  and run the new test. A test that passes either way proves nothing.
- **Logic in the right place.** Workflows shared by the CLI and the GUI belong in `rounds.py`. The
  grader has no language-specific logic.
- **No new dependency without a reason.** The GUI server uses only the standard library.
- **Errors written for the user.** A problem the user can cause is a clear message, not a traceback.
- **Nothing that spoils a round.** Output a candidate can see mid-round must not name a later
  stage's hidden tests, brief or reference behaviour.

For a new or changed task, also:

- **Fair hidden tests.** Read every hidden test against the brief for its stage. Each rule a test
  enforces must be stated there or in the starter's docs.
- **A blind attempt.** Ask for one, or run one: a person or an AI agent starts from `ib start`, sees
  only the briefs, and every failure is traced to the candidate or to an unstated rule.
- **Originality.** The author confirms it in the pull request. Look for real company names, real
  service hosts and credentials that look real.
- **No later-stage hints.** Nothing visible at stage 1 says what stages 2 and 3 ask for.

## Releasing

1. Move the entries under "Unreleased" in `CHANGELOG.md` to a new version heading with the date.
2. Set `__version__` in `src/interviewbench/__init__.py`. The package version is read from it.
3. Open a pull request with both changes. After it merges, tag the merge commit `v<version>` and
   push the tag.
4. Build from a clean checkout of the tag (`python -m build`): the wheel bundles whatever is in
   `tasks/`, `rubrics/` and `templates/` at build time.

"""The repository settings kept in .github/ agree with each other (see docs/MAINTAINING.md)."""

import itertools
import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

REPO = Path(__file__).resolve().parents[1]
RULESETS = REPO / ".github" / "rulesets"
WORKFLOWS = REPO / ".github" / "workflows"


def ruleset(name):
    return json.loads((RULESETS / name).read_text(encoding="utf-8"))


def rule(rs, rule_type):
    return next(r for r in rs["rules"] if r["type"] == rule_type)


def check_names():
    """Every check name the workflows report: each job's `name`, expanded over its matrix."""
    names = set()
    for path in WORKFLOWS.glob("*.yml"):
        for job_id, job in yaml.safe_load(path.read_text(encoding="utf-8"))["jobs"].items():
            template = job.get("name", job_id)
            matrix = {k: v for k, v in job.get("strategy", {}).get("matrix", {}).items() if isinstance(v, list)}
            for combo in itertools.product(*matrix.values()):
                values = dict(zip(matrix, combo, strict=True))
                names.add(re.sub(r"\$\{\{\s*matrix\.(\w+)\s*\}\}", lambda m, v=values: str(v[m.group(1)]), template))
    return names


def test_every_required_check_is_reported_by_a_workflow():
    # A required check that no job reports never turns green, and blocks every merge.
    required = {c["context"] for c in rule(ruleset("main-protection.json"), "required_status_checks")["parameters"]
                ["required_status_checks"]}
    missing = required - check_names()
    assert not missing, f"required in main-protection.json but no workflow job has this name: {sorted(missing)}"


def test_main_has_no_bypass_and_merges_tested_commits():
    rs = ruleset("main-protection.json")
    assert rs["enforcement"] == "active"
    assert rs["conditions"]["ref_name"]["include"] == ["~DEFAULT_BRANCH"]
    assert rs["bypass_actors"] == []
    assert {"deletion", "non_fast_forward", "pull_request", "required_status_checks"} <= {r["type"] for r in rs["rules"]}
    # The branch is tested against the current main before it merges.
    assert rule(rs, "required_status_checks")["parameters"]["strict_required_status_checks_policy"] is True
    # Merge commits keep each commit the "Commit messages" check passed.
    assert rule(rs, "pull_request")["parameters"]["allowed_merge_methods"] == ["merge"]


def test_review_ruleset_requires_a_fresh_code_owner_approval():
    params = rule(ruleset("main-review.json"), "pull_request")["parameters"]
    assert params["required_approving_review_count"] >= 1
    assert params["require_code_owner_review"] and params["dismiss_stale_reviews_on_push"]
    assert params["require_last_push_approval"]


def test_release_tags_cannot_move_or_disappear():
    rs = ruleset("release-tags.json")
    assert rs["target"] == "tag" and rs["enforcement"] == "active"
    assert rs["conditions"]["ref_name"]["include"] == ["refs/tags/v*"]
    assert {"deletion", "update", "non_fast_forward"} <= {r["type"] for r in rs["rules"]}


def run_pre_push(stdin):
    bash = shutil.which("bash")
    if bash is None:
        pytest.skip("needs bash to run the git hook")
    hook = (REPO / ".githooks" / "pre-push").as_posix()
    return subprocess.run([bash, hook, "origin", "url"], input=stdin, capture_output=True, text=True)


ZERO = "0" * 40
SHA = "a" * 40


@pytest.mark.parametrize("remote_refs", [["refs/heads/main"], ["refs/heads/feature", "refs/heads/main"]])
def test_pre_push_hook_refuses_main(remote_refs):
    result = run_pre_push("".join(f"refs/heads/x {SHA} {ref} {ZERO}\n" for ref in remote_refs))
    assert result.returncode != 0
    assert "refusing to push to main" in result.stderr


@pytest.mark.parametrize("remote_ref", ["refs/heads/fix/thing", "refs/heads/maintenance", "refs/tags/v1.0.0"])
def test_pre_push_hook_allows_other_refs(remote_ref):
    assert run_pre_push(f"refs/heads/x {SHA} {remote_ref} {ZERO}\n").returncode == 0

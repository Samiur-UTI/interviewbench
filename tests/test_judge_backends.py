"""Judging with any model: a pasted chatbot reply, or any OpenAI-compatible API."""

import http.server
import json
import os
import shutil
import sys
import threading
import types

import pytest
from typer.testing import CliRunner

from conftest import RUNNER_KIND
from interviewbench import judge
from interviewbench import workspace as ws
from interviewbench.cli import app
from interviewbench.grader import grade
from interviewbench.judge import JudgeError, parse_reply, run_judge
from interviewbench.rounds import JudgeSettings, grade_round
from interviewbench.tasks import JUDGE_PROMPT, JUDGE_REPLY, MARKER, REPORT

cli = CliRunner()


def answer(task, **overrides):
    """A complete judge answer giving every judge criterion its top level."""
    output = {
        "criteria": [
            {"id": c.id, "rationale": f"why {c.id}", "evidence": ["bucket.py:1"], "level": max(c.levels)}
            for c in task.criteria if c.type == "judge"
        ],
        "missed_edge_cases": ["an edge case"],
        "issues": [{"severity": "medium", "category": "tests", "location": "t.py", "description": "d"}],
        "summary": "Solid.",
    }
    output.update(overrides)
    return output


@pytest.fixture
def workspace(tmp_path, solution_dir):
    dest = tmp_path / "ws"
    shutil.copytree(solution_dir, dest)
    (dest / MARKER).write_text(json.dumps({"task": "rate-limiter", "started_at": "2026-01-01T00:00:00+00:00"}))
    return dest


def test_parse_reply_handles_chatbot_formatting(task):
    body = json.dumps(answer(task))
    assert parse_reply(body)["summary"] == "Solid."
    assert parse_reply(f"Sure! Here it is:\n```json\n{body}\n```\nAnything else?")["summary"] == "Solid."
    assert parse_reply(f"<think>maybe {{not json}}</think>\n{body}")["summary"] == "Solid."
    with pytest.raises(JudgeError, match="no JSON object"):
        parse_reply("Sorry, I can't help with that.")


def test_export_then_pasted_reply_scores_the_rubric(task, workspace, tmp_path, monkeypatch):
    monkeypatch.setenv("IB_DATA_DIR", str(tmp_path / "data"))
    (workspace / JUDGE_PROMPT).write_text("an old export, from when it went into the workspace", encoding="utf-8")
    result = cli.invoke(app, ["grade", "--dir", str(workspace), "--runner", RUNNER_KIND, "--judge-export"])
    assert result.exit_code == 0, result.output
    # The prompt holds the hidden tests and the reference solution: never in the workspace.
    assert not (workspace / JUDGE_PROMPT).exists()
    exported = ws.private_dir(workspace) / JUDGE_PROMPT
    assert not exported.resolve().is_relative_to(workspace.resolve())
    assert exported.resolve().is_relative_to((tmp_path / "data").resolve())
    assert str(exported) in "".join(result.output.split("\n"))
    prompt = exported.read_text(encoding="utf-8")
    assert "<hidden_tests>" in prompt and "<candidate_submission>" in prompt
    assert "Reply with ONLY a JSON object" in prompt and '"missed_edge_cases"' in prompt

    reply = exported.parent / JUDGE_REPLY
    reply.write_text(f"Here you go:\n```json\n{json.dumps(answer(task))}\n```", encoding="utf-8")
    result = cli.invoke(app, ["grade", "--dir", str(workspace), "--runner", RUNNER_KIND, "--judge-reply", str(reply)])
    assert result.exit_code == 0, result.output
    report = (workspace / REPORT).read_text(encoding="utf-8")
    assert "**Score: 100.0/100 (100%)**" in report
    assert "AI review (pasted reply (ib-judge-reply.txt))" in report


def test_judge_options_are_exclusive(workspace):
    result = cli.invoke(app, ["grade", "--dir", str(workspace), "--judge", "--judge-export"])
    assert result.exit_code == 1 and "only one" in result.output


class FakeProvider(http.server.BaseHTTPRequestHandler):
    """An OpenAI-compatible chat completions endpoint that records requests."""

    response: tuple[int, dict] = (500, {})
    seen: list = []

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        FakeProvider.seen.append((self.path, self.headers.get("Authorization"), body))
        status, payload = FakeProvider.response
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


@pytest.fixture
def provider(monkeypatch):
    server = http.server.HTTPServer(("127.0.0.1", 0), FakeProvider)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    for name in ("NO_PROXY", "no_proxy"):
        monkeypatch.setenv(name, "127.0.0.1,localhost")
    monkeypatch.setenv("IB_JUDGE_BASE_URL", f"http://127.0.0.1:{server.server_port}/v1/")
    monkeypatch.setenv("IB_JUDGE_API_KEY", "test-key")
    FakeProvider.seen = []
    yield FakeProvider
    server.shutdown()


def chat(content):
    return 200, {"choices": [{"message": {"role": "assistant", "content": content}, "finish_reason": "stop"}]}


def test_openai_compatible_backend(task, workspace, provider, runner):
    loose = answer(task)
    loose["criteria"][0]["level"] = str(loose["criteria"][0]["level"])  # models without schema enforcement
    loose["issues"][0]["severity"] = "critical"
    provider.response = chat(f"```json\n{json.dumps(loose)}\n```")
    result = grade(task, workspace, runner)
    run_judge(result, workspace, runner=runner, backend="openai", model="some/free-model")

    path, auth, body = provider.seen[0]
    assert path == "/v1/chat/completions" and auth == "Bearer test-key"
    assert body["model"] == "some/free-model" and body["messages"][0]["role"] == "system"
    assert "JSON Schema" in body["messages"][1]["content"]
    assert result.graded_weight == result.total_weight
    assert result.points == pytest.approx(100)
    assert result.review.issues[0].severity == "low"  # unknown severities are normalized
    assert "some/free-model via http://127.0.0.1" in result.review.model


def test_explicit_credentials_override_the_environment(task, workspace, provider, runner, monkeypatch):
    provider.response = chat(json.dumps(answer(task)))
    url = f"{os.environ['IB_JUDGE_BASE_URL']}"
    monkeypatch.setenv("IB_JUDGE_BASE_URL", "http://127.0.0.1:1/never-called")
    run_judge(
        grade(task, workspace, runner), workspace, runner=runner, backend="openai", model="m",
        api_key="typed-in-the-gui", base_url=url,
    )
    path, auth, _ = provider.seen[0]
    assert path == "/v1/chat/completions" and auth == "Bearer typed-in-the-gui"
    assert "typed-in-the-gui" not in os.environ.values()


def test_a_wrong_explicit_key_is_not_blamed_on_the_environment(task, workspace, provider, runner):
    provider.response = (401, {"error": "invalid key"})
    with pytest.raises(JudgeError, match="HTTP 401 .check the API key."):
        run_judge(grade(task, workspace, runner), workspace, runner=runner, backend="openai", model="m", api_key="k")


def test_grade_round_never_repeats_the_key_in_an_error(task, workspace, provider, runner):
    provider.response = (401, {"error": "bad key: secret-123"})
    settings = JudgeSettings(backend="openai", model="m", api_key="secret-123")
    outcome = grade_round(task, workspace, runner, judge="api", settings=settings)
    assert "HTTP 401" in outcome.judge_error and "secret-123" not in outcome.judge_error
    assert "secret-123" not in repr(settings)


def test_claude_backend_gets_an_explicit_key(task, workspace, runner, monkeypatch):
    seen = {}

    def fake_claude(model, *, system, user, schema, api_key=None):
        seen["api_key"] = api_key
        return answer(task)

    monkeypatch.setattr(judge, "_call_claude", fake_claude)
    run_judge(grade(task, workspace, runner), workspace, runner=runner, model="m", api_key="sk-typed")
    assert seen["api_key"] == "sk-typed"


def test_anthropic_client_is_built_with_the_explicit_key(monkeypatch):
    built = []

    class Stop(Exception):
        pass

    class Client:
        def __init__(self, **kwargs):
            built.append(kwargs)
            raise Stop

    sdk = types.ModuleType("anthropic")
    sdk.Anthropic = Client
    monkeypatch.setitem(sys.modules, "anthropic", sdk)
    with pytest.raises(Stop):
        judge._call_claude("m", system="s", user="u", schema={}, api_key="sk-typed")
    with pytest.raises(Stop):
        judge._call_claude("m", system="s", user="u", schema={})
    assert built == [{"api_key": "sk-typed"}, {}]


def test_openai_backend_reports_http_errors(task, workspace, provider, runner):
    provider.response = (401, {"error": "invalid key"})
    with pytest.raises(JudgeError, match="HTTP 401 .check IB_JUDGE_API_KEY."):
        run_judge(grade(task, workspace, runner), workspace, runner=runner, backend="openai", model="m")


def test_openai_backend_needs_a_url_and_a_model(task, workspace, runner, monkeypatch):
    monkeypatch.delenv("IB_JUDGE_BASE_URL", raising=False)
    monkeypatch.delenv("IB_JUDGE_MODEL", raising=False)
    result = grade(task, workspace, runner)
    with pytest.raises(JudgeError, match="needs a model"):
        run_judge(result, workspace, runner=runner, backend="openai")
    with pytest.raises(JudgeError, match="IB_JUDGE_BASE_URL"):
        run_judge(result, workspace, runner=runner, backend="openai", model="m")
    with pytest.raises(JudgeError, match="Unknown judge backend"):
        run_judge(result, workspace, runner=runner, backend="gpt")

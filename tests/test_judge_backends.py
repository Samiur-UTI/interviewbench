"""Judging with any model: a pasted chatbot reply, or any OpenAI-compatible API."""

import http.server
import json
import shutil
import threading

import pytest
from typer.testing import CliRunner

from conftest import RUNNER_KIND
from interviewbench.cli import app
from interviewbench.grader import grade
from interviewbench.judge import JudgeError, parse_reply, run_judge
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


def test_export_then_pasted_reply_scores_the_rubric(task, workspace):
    result = cli.invoke(app, ["grade", "--dir", str(workspace), "--runner", RUNNER_KIND, "--judge-export"])
    assert result.exit_code == 0, result.output
    prompt = (workspace / JUDGE_PROMPT).read_text(encoding="utf-8")
    assert "<hidden_tests>" in prompt and "<candidate_submission>" in prompt
    assert "Reply with ONLY a JSON object" in prompt and '"missed_edge_cases"' in prompt

    reply = workspace / JUDGE_REPLY
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

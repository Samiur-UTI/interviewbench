"""The GUI's API over real HTTP, against a real server on a free port."""

import http.client
import json
import os
import shutil
import threading
import time
from pathlib import Path

import pytest

from conftest import RUNNER_KIND
from interviewbench import rounds
from interviewbench import workspace as ws
from interviewbench.grader import StageResult, grade
from interviewbench.runner import RunnerError
from interviewbench.tasks import JUDGE_PROMPT, MARKER, REPORT, UI_STATE, get_task
from interviewbench.ui import server as ui_server
from interviewbench.ui.server import MAX_BODY, serve
from test_judge_backends import FakeProvider, answer, chat, provider  # noqa: F401

REPO = Path(__file__).resolve().parents[1]
ATTACK = """\
from ratelimiter import FakeClock, RateLimiter, TokenBucket


def test_burst_after_idle_is_capped():
    clock = FakeClock()
    bucket = TokenBucket(capacity=3, refill_rate=1, clock=clock)
    clock.advance(10_000)
    assert sum(bucket.allow() for _ in range(10)) == 3


def test_retry_after_is_zero_for_a_full_bucket():
    assert RateLimiter(5, 1, FakeClock()).retry_after("k") == 0.0


def test_a_wrong_reading_of_the_brief():
    bucket = TokenBucket(capacity=3, refill_rate=1, clock=FakeClock())
    assert sum(bucket.allow() for _ in range(10)) == 4
"""


class Reply:
    def __init__(self, response):
        self.status = response.status
        self.headers = response.headers
        self.text = response.read().decode("utf-8")

    @property
    def json(self):
        return json.loads(self.text)

    @property
    def code(self):
        return self.json["error"]["code"]


class Client:
    def __init__(self, server, *, logged_in=True):
        self.server = server
        self.cookie = f"{server.cookie_name}={server.token}" if logged_in else None

    def raw(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.port, timeout=30)
        try:
            conn.request(method, path, body, {} if headers is None else headers)
            return Reply(conn.getresponse())
        finally:
            conn.close()

    def call(self, method, path, body=None, **headers):
        sent = {"Content-Type": "application/json"} if method != "GET" else {}
        if self.cookie:
            sent["Cookie"] = self.cookie
        sent.update({name.replace("_", "-"): value for name, value in headers.items()})
        return self.raw(method, path, None if body is None else json.dumps(body), sent)

    def get(self, path):
        return self.call("GET", path)

    def post(self, path, body=None):
        return self.call("POST", path, {} if body is None else body)

    def finish(self, reply):
        """Follow a job from its 202 to the end."""
        assert reply.status == 202, reply.text
        job = reply.json
        deadline = time.monotonic() + 120
        while job["state"] == "running":
            assert time.monotonic() < deadline, job
            time.sleep(0.02)
            job = self.get(f"/api/jobs/{job['id']}").json
        return job

    def succeeded(self, reply):
        job = self.finish(reply)
        assert job["state"] == "succeeded", job
        return job["result"]

    def start(self, **body):
        reply = self.post("/api/rounds", {"task_id": "rate-limiter", **body})
        assert reply.status == 201, reply.text
        return reply.json


@pytest.fixture
def rounds_dir(tmp_path, monkeypatch):
    root = tmp_path / "rounds"
    monkeypatch.setenv("IB_WORKSPACES", str(root))
    monkeypatch.setenv("IB_EDITOR", "")
    for name in ("IB_JUDGE_BACKEND", "IB_JUDGE_MODEL", "IB_JUDGE_BASE_URL", "IB_JUDGE_API_KEY",
                 "OPENAI_API_KEY", "ANTHROPIC_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(ui_server, "docker_available", lambda: False)
    return root


@pytest.fixture
def server(rounds_dir, tmp_path):
    running = serve(0, static_dir=tmp_path / "no-static-here")
    yield running
    running.stop()


@pytest.fixture
def api(server):
    return Client(server)


# --- Security -------------------------------------------------------------------------------


def test_the_printed_link_sets_the_session_cookie_and_cleans_the_address_bar(server):
    reply = Client(server, logged_in=False).raw("GET", f"/?token={server.token}")
    assert reply.status == 302 and reply.headers["Location"] == "/"
    cookie = reply.headers["Set-Cookie"]
    assert cookie.startswith(f"ib_session_{server.port}={server.token};")
    assert "HttpOnly" in cookie and "SameSite=Strict" in cookie


def test_a_wrong_token_sets_no_cookie(server):
    reply = Client(server, logged_in=False).raw("GET", "/?token=guess")
    assert reply.status == 404 and "Set-Cookie" not in reply.headers


def test_the_api_needs_the_session_cookie(server):
    anonymous = Client(server, logged_in=False)
    reply = anonymous.get("/api/status")
    assert reply.status == 401 and reply.code == "unauthorized"
    assert anonymous.call("POST", "/api/rounds", {"task_id": "rate-limiter"}).status == 401
    assert anonymous.call("GET", "/api/status", Cookie=f"{server.cookie_name}=wrong").status == 401
    assert anonymous.call("GET", "/api/status", Cookie=f"ib_session_1={server.token}").status == 401


def test_another_apps_odd_cookie_doesnt_lock_you_out(api):
    assert api.call("GET", "/api/status", Cookie=f'other={{"a":1}}; {api.cookie}').status == 200


@pytest.mark.parametrize("host", ["evil.example", "evil.example:80", "127.0.0.1", "127.0.0.1:1", ""])
def test_a_rebound_host_is_refused_everywhere(api, host):
    assert api.call("GET", "/api/status", Host=host).status == 403
    assert api.raw("GET", "/", headers={"Host": host}).status == 403


def test_both_local_host_names_work(api):
    assert api.call("GET", "/api/status", Host=f"localhost:{api.server.port}").status == 200
    assert api.call("GET", "/api/status", Host=f"LOCALHOST:{api.server.port}").status == 200


@pytest.mark.parametrize("origin", ["http://evil.example", "null", "https://127.0.0.1", "http://127.0.0.1:1"])
def test_a_foreign_origin_cant_change_anything(api, origin, rounds_dir):
    reply = api.call("POST", "/api/rounds", {"task_id": "rate-limiter"}, Origin=origin)
    assert reply.status == 403 and reply.code == "forbidden"
    assert not rounds_dir.exists()


def test_this_servers_own_origins_are_accepted(api):
    for host in ("127.0.0.1", "localhost"):
        reply = api.call("PUT", "/api/settings", {"judge": {}}, Origin=f"http://{host}:{api.server.port}")
        assert reply.status == 200


@pytest.mark.parametrize("content_type", ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"])
def test_form_posts_are_refused(api, content_type, rounds_dir):
    # What a cross-site <form> or simple fetch can send without a preflight.
    reply = api.call("POST", "/api/rounds", {"task_id": "rate-limiter"}, Content_Type=content_type)
    assert reply.status == 403
    assert not rounds_dir.exists()


def test_json_with_a_charset_is_fine(api):
    assert api.call("PUT", "/api/settings", {"judge": {}}, Content_Type="application/json; charset=utf-8").status == 200


def test_a_mutation_needs_a_content_type(api):
    assert api.raw("POST", "/api/rounds", "{}", {"Cookie": api.cookie}).status == 403


def test_oversize_bodies_are_refused(api):
    body = b'{"reply": "' + b"x" * MAX_BODY + b'"}'
    reply = api.raw("POST", "/api/rounds/whatever/judge-reply", body,
                    {"Cookie": api.cookie, "Content-Type": "application/json"})
    assert reply.status == 413 and reply.code == "too_large"


@pytest.mark.parametrize("body", ["{not json", "[1, 2]", '"text"', "\xff"])
def test_bad_json_is_a_400(api, body):
    reply = api.raw("POST", "/api/rounds", body.encode("latin-1"),
                    {"Cookie": api.cookie, "Content-Type": "application/json"})
    assert reply.status == 400 and reply.code == "bad_request"


def test_every_response_carries_the_security_headers(api):
    for reply in (api.get("/api/status"), api.get("/api/nope"), api.raw("GET", "/"),
                  Client(api.server, logged_in=False).get("/api/status")):
        assert reply.headers["Cache-Control"] == "no-store"
        assert reply.headers["X-Content-Type-Options"] == "nosniff"
        assert reply.headers["Content-Security-Policy"] == (
            "default-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'"
        )


def test_http_servers_own_errors_are_json_with_the_headers_too(api):
    reply = api.raw("PATCH", "/api/status")
    assert reply.status == 501 and reply.code == "not_implemented"
    assert reply.headers["X-Content-Type-Options"] == "nosniff"


def test_the_server_only_binds_to_loopback(server):
    assert server.server_address[0] == "127.0.0.1"


def test_static_files_need_no_cookie_and_stay_inside_the_folder(rounds_dir, tmp_path):
    static = tmp_path / "site" / "static"
    (static / "js").mkdir(parents=True)
    (static / "index.html").write_text("<!doctype html>", encoding="utf-8")
    (static / "js" / "app.js").write_text("export {};", encoding="utf-8")
    (static / "notes.txt").write_text("not a web file", encoding="utf-8")
    (tmp_path / "site" / "secret.js").write_text("secret", encoding="utf-8")
    running = serve(0, static_dir=static)
    try:
        client = Client(running, logged_in=False)
        assert client.raw("GET", "/").text == "<!doctype html>"
        script = client.raw("GET", "/js/app.js")
        assert script.status == 200 and script.headers["Content-Type"].startswith("text/javascript")
        assert client.raw("GET", "/notes.txt").status == 404
        assert client.raw("GET", "/js").status == 404
        for path in ("/../secret.js", "/js/../../secret.js", "/%2e%2e/secret.js", "/..%2fsecret.js",
                     "/..%5csecret.js", "/%2e%2e%5csecret.js", "/index.html%00.js",
                     f"/{(tmp_path / 'site' / 'secret.js').as_posix()}"):
            reply = client.raw("GET", path)
            assert reply.status == 404 and "secret" not in reply.text, path
    finally:
        running.stop()


def test_a_build_without_static_files_says_so(server):
    reply = Client(server, logged_in=False).raw("GET", "/")
    assert reply.status == 404 and "ui/static" in reply.text


@pytest.mark.parametrize("bad", ["..", "%2e%2e", "..%2f..%2fetc", "..%5c..%5cetc", "a%00b", "x%0a", "a%20b"])
def test_round_ids_cant_escape_the_workspaces_folder(api, bad):
    for method, suffix in (("GET", ""), ("GET", "/changes"), ("POST", "/next"), ("POST", "/test")):
        reply = api.call(method, f"/api/rounds/{bad}{suffix}", {} if method == "POST" else None)
        assert reply.status == 404, (bad, suffix)


def test_a_folder_that_isnt_a_round_cant_be_read_or_deleted(api, rounds_dir):
    (rounds_dir / "photos").mkdir(parents=True)
    assert api.get("/api/rounds/photos").status == 404
    assert api.call("DELETE", "/api/rounds/photos", {"confirm": "photos"}).status == 404
    assert (rounds_dir / "photos").is_dir()


# --- App ------------------------------------------------------------------------------------


def test_status(api, rounds_dir):
    status = api.get("/api/status").json
    assert status["workspaces_dir"] == str(rounds_dir) and status["editor"] is None
    assert status["runner"] == {"docker": False, "bash": True, "default": "local"}
    assert status["version"] and status["now"]
    assert status["settings"]["judge"]["backend"] == "claude"


def test_status_stays_fast_while_docker_is_slow(rounds_dir, tmp_path, monkeypatch):
    calls = []
    release = threading.Event()

    def slow_docker():
        calls.append(1)
        release.wait(10)
        return True

    monkeypatch.setattr(ui_server, "docker_available", slow_docker)
    running = serve(0, static_dir=tmp_path)
    try:
        client = Client(running)
        started = time.monotonic()
        for _ in range(5):
            assert client.get("/api/status").json["runner"]["docker"] is False
        assert time.monotonic() - started < 2
        assert len(calls) == 1  # one refresh at a time
        release.set()
        deadline = time.monotonic() + 5
        while not client.get("/api/status").json["runner"]["docker"]:
            assert time.monotonic() < deadline
        assert len(calls) == 1  # cached for 30 s
    finally:
        release.set()
        running.stop()


def test_settings_default_to_the_environment(rounds_dir, tmp_path, monkeypatch):
    monkeypatch.setenv("IB_JUDGE_BACKEND", "openai")
    monkeypatch.setenv("IB_JUDGE_MODEL", "some/model")
    monkeypatch.setenv("IB_JUDGE_BASE_URL", "http://localhost:11434/v1")
    monkeypatch.setenv("IB_JUDGE_API_KEY", "env-key")
    running = serve(0, static_dir=tmp_path)
    try:
        judge = Client(running).get("/api/settings").json["judge"]
    finally:
        running.stop()
    assert judge["backend"] == "openai" and judge["model"] == "some/model"
    assert judge["base_url"] == "http://localhost:11434/v1"
    assert judge["has_api_key"] is True and judge["key_source"] == "env"
    assert judge["default_model"] is None and "env-key" not in json.dumps(judge)


def test_settings_keep_clear_and_never_echo_the_key(api):
    judge = {"backend": "openai", "model": "m", "base_url": "http://localhost:1/v1", "api_key": "sk-secret"}
    reply = api.call("PUT", "/api/settings", {"judge": judge})
    saved = reply.json["judge"]
    assert saved["has_api_key"] is True and saved["key_source"] == "session"
    assert "sk-secret" not in reply.text and '"api_key"' not in reply.text
    assert "sk-secret" not in api.get("/api/status").text + api.get("/api/settings").text
    assert "sk-secret" not in os.environ.values()
    assert api.call("PUT", "/api/settings", {"judge": {"model": "other"}}).json["judge"]["key_source"] == "session"
    cleared = api.call("PUT", "/api/settings", {"judge": {"api_key": ""}}).json["judge"]
    assert cleared["has_api_key"] is False and cleared["key_source"] is None and cleared["model"] == "other"


@pytest.mark.parametrize("judge", [{"backend": "gpt"}, {"base_url": "file:///etc/passwd"}, {"model": 3}])
def test_bad_settings_are_refused_and_change_nothing(api, judge):
    before = api.get("/api/settings").json
    assert api.call("PUT", "/api/settings", {"judge": judge}).status == 400
    assert api.get("/api/settings").json == before


# --- Tasks ----------------------------------------------------------------------------------


def test_tasks_list_never_spoils_a_stage(api, task):
    reply = api.get("/api/tasks")
    body = reply.json
    assert {"rate-limiter", "flight-search-aggregator"} <= {t["id"] for t in body["tasks"]}
    assert "backend" in body["categories"] and "backend-python" in body["templates"]
    listed = next(t for t in body["tasks"] if t["id"] == "rate-limiter")
    assert listed["stage_count"] == 3 and listed["language"] == "python"
    assert set(listed["rubric"][0]) == {"id", "type", "weight", "description"}
    for stage in task.stages:
        assert stage.title not in reply.text
    assert "retry_after" not in reply.text and "evicted" not in reply.text


def test_new_task_and_validate(api, tmp_path, monkeypatch):
    root = tmp_path / "bench"
    for folder in ("rubrics", "templates"):
        shutil.copytree(REPO / folder, root / folder)
    (root / "tasks").mkdir()
    monkeypatch.setenv("IB_ROOT", str(root))
    made = api.post("/api/tasks", {"task_id": "order-api", "category": "backend"})
    assert made.status == 200, made.text
    assert (Path(made.json["path"]) / "task.toml").is_file() and "TODO" in made.json["message"]
    assert [t["id"] for t in api.get("/api/tasks").json["tasks"]] == ["order-api"]
    assert api.post("/api/tasks", {"task_id": "order-api", "category": "backend"}).status == 400
    result = api.succeeded(api.post("/api/validate", {"run": False}))
    assert result == {"tasks": [{"id": "order-api", "category": "backend", "ok": True, "errors": []}]}


@pytest.mark.parametrize("task_id", ["../../evil", "..", "a/b", "Upper", "x\n"])
def test_new_task_refuses_a_path_as_an_id(api, task_id):
    assert api.post("/api/tasks", {"task_id": task_id, "category": "backend"}).status == 400


def test_validate_reports_a_task_as_a_job(api):
    job = api.finish(api.post("/api/validate", {"task_ids": ["rate-limiter"], "run": False}))
    assert job["kind"] == "validate" and job["round_id"] is None and job["state"] == "succeeded"
    assert job["result"]["tasks"][0]["ok"] is True
    missing = api.finish(api.post("/api/validate", {"task_ids": ["nope"]}))
    assert missing["state"] == "failed" and "Unknown task 'nope'" in missing["error"]


# --- Rounds ---------------------------------------------------------------------------------


def test_starting_never_overwrites_a_round(api, rounds_dir):
    first = api.start()
    assert first["id"] == "rate-limiter" and first["stage"] == 1 and first["git"] is True
    assert first["path"] == str(rounds_dir / "rate-limiter")
    assert first["ends_at"] > first["started_at"]
    assert api.start(git=False)["id"] == "rate-limiter-2"
    assert not (rounds_dir / "rate-limiter-2" / ".git").exists()
    listed = api.get("/api/rounds").json["rounds"]
    assert {r["id"] for r in listed} == {"rate-limiter", "rate-limiter-2"}
    assert listed[0]["score_percent"] is None and listed[0]["active_job"] is None


def test_rounds_started_with_ib_start_show_up(api, rounds_dir, task):
    rounds.start_round(task, rounds_dir / "from-the-terminal", open_editor=False)
    assert api.get("/api/rounds/from-the-terminal").json["task_id"] == "rate-limiter"


def test_starting_an_unknown_task_is_a_friendly_error(api):
    reply = api.post("/api/rounds", {"task_id": "nope"})
    assert reply.status == 400 and "Unknown task" in reply.json["error"]["message"]


def test_round_shows_only_revealed_stages(api, task):
    started = api.start()
    assert [s["number"] for s in started["stages"]] == [1] and started["all_revealed"] is False
    assert started["stages"][0]["title"] == task.stages[0].title
    assert not started["stages"][0]["markdown"].startswith("# ")
    assert started["last"] == {"test": None, "grade": None, "break": None}
    assert task.stages[1].title not in json.dumps(started)
    assert "retry_after" not in json.dumps(started)


def test_next_reveals_tags_and_stops(api, task):
    api.start()
    reply = api.post("/api/rounds/rate-limiter/next")
    assert reply.status == 200 and reply.json["tagged"] == "stage-1" and reply.json["stage"] == 2
    assert [s["number"] for s in reply.json["stages"]] == [1, 2]
    assert api.post("/api/rounds/rate-limiter/next").json["all_revealed"] is True
    done = api.post("/api/rounds/rate-limiter/next")
    assert done.status == 409 and done.code == "all_revealed"


def test_next_without_git_tags_nothing(api):
    api.start(git=False)
    assert api.post("/api/rounds/rate-limiter/next").json["tagged"] is None


def test_delete_needs_the_id_and_removes_the_git_folder(api, rounds_dir):
    api.start()
    assert api.call("DELETE", "/api/rounds/rate-limiter", {"confirm": "wrong"}).status == 400
    assert api.call("DELETE", "/api/rounds/rate-limiter", {}).status == 400
    assert (rounds_dir / "rate-limiter").is_dir()
    reply = api.call("DELETE", "/api/rounds/rate-limiter", {"confirm": "rate-limiter"})
    assert reply.status == 200 and reply.json == {"deleted": True}
    assert not (rounds_dir / "rate-limiter").exists()
    assert api.get("/api/rounds/rate-limiter").status == 404


def test_open_editor(api, monkeypatch):
    api.start()
    missing = api.post("/api/rounds/rate-limiter/open-editor")
    assert missing.status == 409 and missing.code == "no_editor"
    launched = []
    monkeypatch.setenv("IB_EDITOR", "my-editor")
    monkeypatch.setattr(ws, "_launch", launched.append)
    assert api.post("/api/rounds/rate-limiter/open-editor").json == {"editor": "my-editor"}
    assert launched[0][0] == "my-editor"


def test_changes_work_without_git(api, rounds_dir):
    api.start(git=False)
    (rounds_dir / "rate-limiter" / "extra.md").write_text("one\ntwo\n", encoding="utf-8")
    changes = api.get("/api/rounds/rate-limiter/changes").json
    assert changes["files"] == [{"path": "extra.md", "status": "added", "additions": 2, "deletions": 0}]
    assert "+++ b/extra.md" in changes["diff"] and changes["truncated"] is False


def test_attack_prompt_has_a_suggested_name_and_no_hidden_tests(api, rounds_dir):
    api.start()
    prompt = api.get("/api/rounds/rate-limiter/attack-prompt").json
    assert prompt["suggested_filename"] == "test_attack.py" and prompt["attack_dir"] == "tests"
    assert prompt["tokens_estimate"] > 0 and "## Stage 1/3" in prompt["prompt"]
    assert "## Stage 2/3" not in prompt["prompt"]
    assert "test_burst_after_idle_is_capped_at_capacity" not in prompt["prompt"]
    assert not (rounds_dir / "rate-limiter" / "ib-attack-prompt.md").exists()


# --- Jobs -----------------------------------------------------------------------------------


@pytest.fixture
def stuck(monkeypatch):
    """Candidate tests that run until released, to hold a job open."""
    release = threading.Event()
    running = threading.Event()

    def wait_for_release(task, workspace, runner, timeout=None):
        running.set()
        release.wait(30)
        return StageResult(0, 1, 1)

    monkeypatch.setattr(ui_server, "run_candidate_tests", wait_for_release)
    yield running
    release.set()


def test_one_job_at_a_time_and_a_reload_can_reattach(api, stuck, rounds_dir):
    api.start()
    job = api.post("/api/rounds/rate-limiter/test", {"runner": RUNNER_KIND}).json
    assert job["kind"] == "test" and job["round_id"] == "rate-limiter" and job["state"] == "running"
    assert stuck.wait(10)

    assert api.get("/api/rounds/rate-limiter").json["active_job"] == job["id"]
    assert api.get("/api/rounds").json["rounds"][0]["active_job"] == job["id"]
    for reply in (
        api.post("/api/rounds/rate-limiter/test"),
        api.post("/api/rounds/rate-limiter/grade"),
        api.post("/api/rounds/rate-limiter/break", {"filename": "test_x.py", "content": "x"}),
        api.post("/api/rounds/rate-limiter/judge-reply", {"reply": "{}"}),
        api.post("/api/rounds/rate-limiter/next"),
        api.call("DELETE", "/api/rounds/rate-limiter", {"confirm": "rate-limiter"}),
    ):
        assert reply.status == 409 and reply.code == "busy"
    assert json.loads((rounds_dir / "rate-limiter" / MARKER).read_text())["stage"] == 1
    assert api.get("/api/rounds/rate-limiter/changes").status == 200  # reading stays open


def test_a_failed_job_says_why_in_plain_words(api, monkeypatch):
    api.start()

    def no_runner(kind):
        raise RunnerError("Docker is not available. Start Docker, or use --runner local.")

    monkeypatch.setattr(ui_server, "get_runner", no_runner)
    job = api.finish(api.post("/api/rounds/rate-limiter/test"))
    assert job["state"] == "failed" and job["error"].startswith("Docker is not available")
    assert job["finished_at"] and job["result"] is None
    assert api.get("/api/rounds/rate-limiter").json["active_job"] is None


def test_a_crash_in_a_job_is_a_message_not_a_traceback(api, monkeypatch):
    api.start()

    def crash(*args, **kwargs):
        raise ValueError("boom")

    monkeypatch.setattr(ui_server, "run_candidate_tests", crash)
    job = api.finish(api.post("/api/rounds/rate-limiter/test", {"runner": RUNNER_KIND}))
    assert job["state"] == "failed" and job["error"] == "Something went wrong: boom"


def test_a_crash_in_a_request_is_a_500_without_a_traceback(api, monkeypatch):
    def crash(*args, **kwargs):
        raise ValueError("boom")

    monkeypatch.setattr(rounds, "list_rounds", crash)
    reply = api.get("/api/rounds")
    assert reply.status == 500 and reply.code == "internal" and "Traceback" not in reply.text


def test_an_unknown_runner_is_refused_up_front(api):
    api.start()
    assert api.post("/api/rounds/rate-limiter/test", {"runner": "cloud"}).status == 400


def test_unknown_jobs_and_routes_are_404s(api):
    assert api.get("/api/jobs/nope").status == 404
    assert api.get("/api/nope").status == 404
    assert api.call("DELETE", "/api/status", {}).status == 404


# --- Grading --------------------------------------------------------------------------------


def hidden_failures(task, workspace, runner, stage):
    return [f.name for f in grade(task, workspace, runner).stages[stage - 1].failures]


def test_grading_withholds_unrevealed_stages_until_they_are_revealed(api, rounds_dir, task, runner):
    api.start()
    workspace = rounds_dir / "rate-limiter"
    stage2 = hidden_failures(task, workspace, runner, 2)
    assert stage2

    reply = api.post("/api/rounds/rate-limiter/grade", {"runner": RUNNER_KIND})
    view = api.succeeded(reply)
    first, second, third = view["stages"]
    assert first["revealed"] is True and first["title"] == task.stages[0].title and first["failures"]
    assert second["revealed"] is False and second["title"] is None and second["failures"] == []
    assert second["withheld_failures"] == len(stage2)
    assert third["revealed"] is False and third["title"] is None
    for text in (json.dumps(view), api.get("/api/rounds/rate-limiter").text):
        assert not [name for name in stage2 if name in text]
        assert task.stages[1].title not in text and "retry_after" not in text

    round_after = api.post("/api/rounds/rate-limiter/next").json
    shown = round_after["last"]["grade"]["stages"][1]
    assert shown["revealed"] is True and shown["title"] == task.stages[1].title
    assert sorted(f["name"] for f in shown["failures"]) == sorted(stage2) and shown["withheld_failures"] == 0


def test_a_job_log_shows_each_phase(api):
    api.start()
    job = api.finish(api.post("/api/rounds/rate-limiter/grade", {"runner": RUNNER_KIND}))
    assert job["log"] == [f"Running hidden tests for stage {n} of 3" for n in (1, 2, 3)]
    assert job["phase"] == "Running hidden tests for stage 3 of 3"


def test_judge_failure_keeps_the_hidden_test_scores(api, rounds_dir):
    api.start()
    api.call("PUT", "/api/settings", {"judge": {"backend": "openai", "model": "m", "base_url": ""}})
    view = api.succeeded(api.post("/api/rounds/rate-limiter/grade", {"runner": RUNNER_KIND, "judge": "api"}))
    assert "IB_JUDGE_BASE_URL" in view["judge_error"] and view["review"] is None
    assert view["pending_weight"] == 55
    assert (rounds_dir / "rate-limiter" / REPORT).is_file()


def test_the_key_reaches_the_provider_and_nothing_else(api, provider, rounds_dir, task, monkeypatch):  # noqa: F811
    api.start()
    monkeypatch.delenv("IB_JUDGE_API_KEY")
    url = os.environ["IB_JUDGE_BASE_URL"]
    api.call("PUT", "/api/settings", {"judge": {"backend": "openai", "model": "m", "base_url": url, "api_key": "sk-secret"}})
    provider.response = chat(json.dumps(answer(task)))
    reply = api.post("/api/rounds/rate-limiter/grade", {"runner": RUNNER_KIND, "judge": "api"})
    job = api.finish(reply)
    assert job["state"] == "succeeded", job
    view = job["result"]
    assert provider.seen[0][1] == "Bearer sk-secret"
    assert view["pending_weight"] == 0 and view["review"]["summary"] == "Solid."
    assert view["review"]["candidate_tests"]["total"] == 4

    assert "sk-secret" not in json.dumps(job) + api.get("/api/rounds/rate-limiter").text
    assert "sk-secret" not in os.environ.values()
    for path in (rounds_dir / "rate-limiter").rglob("*"):
        if path.is_file() and ".git" not in path.parts:
            assert b"sk-secret" not in path.read_bytes(), path


def test_a_key_quoted_by_a_provider_error_is_scrubbed(api, provider, rounds_dir, monkeypatch):  # noqa: F811
    api.start()
    url = os.environ["IB_JUDGE_BASE_URL"]
    api.call("PUT", "/api/settings", {"judge": {"backend": "openai", "model": "m", "base_url": url, "api_key": "sk-secret"}})
    provider.response = (401, {"error": "bad key sk-secret"})
    view = api.succeeded(api.post("/api/rounds/rate-limiter/grade", {"runner": RUNNER_KIND, "judge": "api"}))
    assert "HTTP 401" in view["judge_error"] and "sk-secret" not in view["judge_error"]
    assert b"sk-secret" not in (rounds_dir / "rate-limiter" / UI_STATE).read_bytes()


def test_the_judge_prompt_stays_in_memory(api, rounds_dir):
    api.start()
    workspace = rounds_dir / "rate-limiter"
    assert api.get("/api/rounds/rate-limiter/judge-prompt").status == 404
    view = api.succeeded(api.post("/api/rounds/rate-limiter/grade", {"runner": RUNNER_KIND, "judge": "prepare"}))
    assert view["judge_prepared"] is True
    assert api.get("/api/rounds/rate-limiter").json["last"]["grade"]["judge_prepared"] is True
    prompt = api.get("/api/rounds/rate-limiter/judge-prompt").json
    assert "<hidden_tests>" in prompt["prompt"] and prompt["tokens_estimate"] > 0
    assert not (workspace / JUDGE_PROMPT).exists()
    stored = (workspace / UI_STATE).read_text(encoding="utf-8")
    assert "<hidden_tests>" not in stored and "reference_solution" not in stored


def forbid_hidden_tests(monkeypatch):
    def boom(*args, **kwargs):
        raise AssertionError("the hidden tests ran again")

    monkeypatch.setattr(rounds, "grade", boom)


def test_judge_reply_reuses_the_grade_for_unchanged_code(api, task, rounds_dir, monkeypatch):
    api.start()
    api.succeeded(api.post("/api/rounds/rate-limiter/grade", {"runner": RUNNER_KIND, "judge": "prepare"}))
    forbid_hidden_tests(monkeypatch)
    reply = json.dumps(answer(task))
    view = api.succeeded(api.post("/api/rounds/rate-limiter/judge-reply", {"reply": f"```json\n{reply}\n```"}))
    assert view["pending_weight"] == 0 and view["review"]["model"] == "pasted reply"
    assert view["judge_error"] is None


def test_judge_reply_regrades_changed_code(api, task, rounds_dir, monkeypatch):
    api.start()
    api.succeeded(api.post("/api/rounds/rate-limiter/grade", {"runner": RUNNER_KIND, "judge": "prepare"}))
    (rounds_dir / "rate-limiter" / "extra.md").write_text("changed", encoding="utf-8")
    forbid_hidden_tests(monkeypatch)
    job = api.finish(api.post("/api/rounds/rate-limiter/judge-reply", {"reply": json.dumps(answer(task))}))
    assert job["state"] == "failed" and "ran again" in job["error"]


def test_a_changed_workspace_makes_the_prompt_stale(api, rounds_dir):
    api.start()
    api.succeeded(api.post("/api/rounds/rate-limiter/grade", {"runner": RUNNER_KIND, "judge": "prepare"}))
    (rounds_dir / "rate-limiter" / "extra.md").write_text("changed", encoding="utf-8")
    view = api.succeeded(api.post("/api/rounds/rate-limiter/grade", {"runner": RUNNER_KIND}))
    assert view["judge_prepared"] is False


def test_a_bad_pasted_reply_keeps_the_scores_and_says_why(api):
    api.start()
    api.succeeded(api.post("/api/rounds/rate-limiter/grade", {"runner": RUNNER_KIND, "judge": "prepare"}))
    view = api.succeeded(api.post("/api/rounds/rate-limiter/judge-reply", {"reply": "sorry, I can't"}))
    assert "no JSON object" in view["judge_error"] and view["pending_weight"] == 55


def test_a_plain_grade_always_runs_the_hidden_tests(api, monkeypatch):
    api.start()
    api.succeeded(api.post("/api/rounds/rate-limiter/grade", {"runner": RUNNER_KIND}))
    forbid_hidden_tests(monkeypatch)
    job = api.finish(api.post("/api/rounds/rate-limiter/grade", {"runner": RUNNER_KIND}))
    assert job["state"] == "failed" and "ran again" in job["error"]


def test_a_bad_judge_mode_is_refused(api):
    api.start()
    assert api.post("/api/rounds/rate-limiter/grade", {"judge": "reply"}).status == 400


# --- Break ----------------------------------------------------------------------------------


def test_break_needs_a_bare_file_name(api):
    api.start()
    for name in ("../evil.py", "a/b.py", "..\\evil.py", ".."):
        reply = api.post("/api/rounds/rate-limiter/break", {"filename": name, "content": "x"})
        assert reply.status == 400 and "plain file name" in reply.json["error"]["message"]


# --- The whole thing ------------------------------------------------------------------------


def test_a_full_round_and_its_results_survive_a_restart(api, rounds_dir, tmp_path, task, runner, monkeypatch):
    started = api.start()
    workspace = Path(started["path"])

    tests = api.succeeded(api.post("/api/rounds/rate-limiter/test", {"runner": RUNNER_KIND}))
    assert tests["passed"] == tests["total"] == 4 and tests["error"] is None and tests["runner"] == RUNNER_KIND

    (workspace / "tests" / "test_extra.py").write_text("def test_broken():\n    assert 1 == 2\n", encoding="utf-8")
    tests = api.succeeded(api.post("/api/rounds/rate-limiter/test", {"runner": RUNNER_KIND}))
    assert tests["total"] == 5 and tests["failures"][0]["name"] == "test_broken"
    (workspace / "tests" / "test_extra.py").unlink()

    for number in (1, 2, 3):
        solved = rounds.build_reference(task, tmp_path / f"solved-{number}", runner, upto=number)
        shutil.copytree(solved, workspace, dirs_exist_ok=True)
        if number < 3:
            assert api.post("/api/rounds/rate-limiter/next").status == 200

    view = api.succeeded(api.post("/api/rounds/rate-limiter/grade", {"runner": RUNNER_KIND, "judge": "prepare"}))
    assert view["points"] == 45 and view["graded_weight"] == 45 and view["pending_weight"] == 55
    assert view["judge_prepared"] is True and view["summary"].startswith("Score: 45.0/45")
    assert view["report_path"] == str(workspace / REPORT) and view["time_used_minutes"] == 0
    assert all(s["revealed"] and s["passed"] == s["total"] for s in view["stages"])

    prompt = api.get("/api/rounds/rate-limiter/judge-prompt").json["prompt"]
    assert "<candidate_submission>" in prompt
    judged = api.succeeded(api.post("/api/rounds/rate-limiter/judge-reply", {"reply": json.dumps(answer(task))}))
    assert judged["points"] == 100 and judged["percent"] == 100 and judged["pending_weight"] == 0
    assert judged["review"]["issues"][0]["severity"] == "medium"
    assert all(c["score"] == 1 for c in judged["criteria"])

    attacked = api.succeeded(api.post(
        "/api/rounds/rate-limiter/break",
        {"filename": "test_attack.py", "content": ATTACK, "runner": RUNNER_KIND},
    ))
    assert attacked["counts"] == {"real_break": 0, "survived": 2, "bad_test": 1}
    assert {a["verdict"] for a in attacked["attacks"]} == {"survived", "bad test"}
    assert not (workspace / "tests" / "test_attack.py").exists()

    assert api.get("/api/rounds").json["rounds"][0]["score_percent"] == 100

    # A new server: nothing in memory, everything in ib-ui.json.
    fresh = serve(0, static_dir=tmp_path / "no-static-here")
    try:
        again = Client(fresh)
        last = again.get("/api/rounds/rate-limiter").json["last"]
        assert last["test"]["total"] == 5
        assert last["grade"]["points"] == 100 and last["grade"]["judge_prepared"] is False
        assert last["break"]["counts"]["bad_test"] == 1
        assert again.get("/api/rounds/rate-limiter/judge-prompt").status == 404

        forbid_hidden_tests(monkeypatch)
        rejudged = again.succeeded(again.post(
            "/api/rounds/rate-limiter/judge-reply", {"reply": json.dumps(answer(task))},
        ))
        assert rejudged["points"] == 100 and rejudged["judge_prepared"] is True
    finally:
        fresh.stop()


def test_a_break_on_the_starter_finds_real_breaks(api):
    api.start()
    result = api.succeeded(api.post(
        "/api/rounds/rate-limiter/break",
        {"filename": "test_attack.py", "content": ATTACK, "runner": RUNNER_KIND},
    ))
    assert result["counts"]["real_break"] >= 1 and result["runner"] == RUNNER_KIND
    assert api.get("/api/rounds/rate-limiter").json["last"]["break"] == result


def test_an_attack_file_with_no_tests_is_a_friendly_failure(api):
    api.start()
    job = api.finish(api.post(
        "/api/rounds/rate-limiter/break",
        {"filename": "nothing_test.py", "content": "VALUE = 1\n", "runner": RUNNER_KIND},
    ))
    assert job["state"] == "failed" and "No attack tests ran" in job["error"]


def test_a_damaged_results_file_is_just_no_results(api, rounds_dir):
    api.start()
    (rounds_dir / "rate-limiter" / UI_STATE).write_text("{not json", encoding="utf-8")
    assert api.get("/api/rounds/rate-limiter").json["last"]["grade"] is None
    (rounds_dir / "rate-limiter" / UI_STATE).write_text('{"grade": {"percent": 5}}', encoding="utf-8")
    assert api.get("/api/rounds/rate-limiter").json["last"]["grade"] is None


def test_works_for_a_typescript_task(api):
    reply = api.post("/api/rounds", {"task_id": "flight-search-aggregator"})
    assert reply.status == 201, reply.text
    prompt = api.get("/api/rounds/flight-search-aggregator/attack-prompt").json
    assert prompt["suggested_filename"] == "attack.test.ts"
    task = get_task("flight-search-aggregator")
    assert task.stages[1].title not in reply.text

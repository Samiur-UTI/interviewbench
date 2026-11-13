"""The GUI's HTTP server: routing, auth, static files and `serve()`. See docs/GUI.md.

The server can run code, so everything here assumes a hostile web page in another tab: it binds to
127.0.0.1 only, and every request has to prove it comes from the page `ib ui` opened. All workflows
live in rounds.py; handlers only translate requests and start jobs.
"""

from __future__ import annotations

import hmac
import json
import os
import re
import secrets
import socketserver
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.util import find_spec
from pathlib import Path
from typing import Callable
from urllib.parse import parse_qs, unquote, urlsplit

from .. import __version__, rounds
from .. import workspace as ws
from ..breaker import attack_prompt
from ..grader import run_candidate_tests
from ..judge import BACKENDS, DEFAULT_MODEL, JudgeError, JudgeRequest, env_api_key
from ..rounds import AllRevealed, JudgeSettings, RoundError, UnknownRound
from ..runner import RUNNERS, RunnerError, docker_available, find_bash, get_runner
from ..tasks import REPORT, TaskError, _ID_PATTERN, categories, get_task
from . import serialize
from .jobs import Busy, Jobs, friendly_message

HOST = "127.0.0.1"
PORT_ATTEMPTS = 50
MAX_BODY = 2 * 1024 * 1024
MAX_DRAIN = 16 * MAX_BODY  # reading this much lets the client see the 413 instead of a reset connection
DOCKER_TTL = 30
STATIC_DIR = Path(__file__).parent / "static"
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
}
SECURITY_HEADERS = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": (
        "default-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'"
    ),
}


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code


def _bad_request(message: str) -> ApiError:
    return ApiError(400, "bad_request", message)


def _field(body: dict, name: str, kind: type, default: object = None) -> object:
    """body[name], or `default` if it's missing or null. A value of the wrong type is a 400."""
    value = body.get(name)
    if value is None:
        return default
    if not isinstance(value, kind):
        raise _bad_request(f"'{name}' must be a {kind.__name__}.")
    return value


def _required(body: dict, name: str) -> str:
    value = _field(body, name, str)
    if not value:
        raise _bad_request(f"'{name}' is required.")
    return value


def _runner_kind(body: dict, default: str = "auto") -> str:
    kind = _field(body, "runner", str, default)
    if kind not in RUNNERS:
        raise _bad_request(f"Unknown runner '{kind}'. Use one of: {', '.join(RUNNERS)}.")
    return kind


class DockerState:
    """Whether Docker is up, refreshed off the request thread: `docker info` can take 15 s."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._available = False
        self._checked: float | None = None
        self._refreshing = False

    def current(self) -> bool:
        with self._lock:
            stale = self._checked is None or time.monotonic() - self._checked >= DOCKER_TTL
            if stale and not self._refreshing:
                self._refreshing = True
                threading.Thread(target=self._refresh, daemon=True).start()
            return self._available

    def _refresh(self) -> None:
        available = docker_available()
        with self._lock:
            self._available = available
            self._checked = time.monotonic()
            self._refreshing = False


def _default_backend() -> str:
    backend = os.environ.get("IB_JUDGE_BACKEND", "")
    return backend if backend in BACKENDS else BACKENDS[0]


@dataclass
class Settings:
    """The judge settings of this run. The key lives here and nowhere else."""

    backend: str = field(default_factory=_default_backend)
    model: str = field(default_factory=lambda: os.environ.get("IB_JUDGE_MODEL", ""))
    base_url: str = field(default_factory=lambda: os.environ.get("IB_JUDGE_BASE_URL", ""))
    api_key: str = field(default="", repr=False)

    def view(self) -> dict:
        source = "session" if self.api_key else "env" if env_api_key(self.backend) else None
        return {"judge": {
            "backend": self.backend,
            "model": self.model,
            "base_url": self.base_url,
            "has_api_key": source is not None,
            "key_source": source,
            "default_model": DEFAULT_MODEL if self.backend == "claude" else None,
            "claude_sdk_installed": find_spec("anthropic") is not None,
        }}

    def update(self, judge: dict) -> None:
        """A field left out keeps its value; an empty one clears it."""

        def new(name: str) -> str:
            return _field(judge, name, str, "").strip() if name in judge else getattr(self, name)

        backend, model, base_url, api_key = new("backend"), new("model"), new("base_url"), new("api_key")
        if backend not in BACKENDS:
            raise _bad_request(f"Unknown judge backend '{backend}'. Use one of: {', '.join(BACKENDS)}.")
        if base_url and not base_url.startswith(("http://", "https://")):
            raise _bad_request("The base URL must start with http:// or https://.")
        self.backend, self.model, self.base_url, self.api_key = backend, model, base_url, api_key

    def for_judge(self) -> JudgeSettings:
        return JudgeSettings(self.backend, self.model or None, self.base_url or None, self.api_key or None)


@dataclass
class PreparedJudge:
    """A judge prompt, in memory only: it holds the hidden tests and the reference solution."""

    request: JudgeRequest
    fingerprint: str


class Api:
    """One method per endpoint. Each returns (status, JSON body)."""

    def __init__(self) -> None:
        self.jobs = Jobs()
        self.settings = Settings()
        self.docker = DockerState()
        self._lock = threading.Lock()  # guards settings, prepared, starting a round and ib-ui.json
        self._prepared: dict[str, PreparedJudge] = {}

    # --- Stored state ---------------------------------------------------------------------------

    def _state(self, path: Path) -> dict:
        with self._lock:
            return serialize.read_state(path)

    def _remember(self, path: Path, key: str, value: dict) -> None:
        with self._lock:
            state = serialize.read_state(path)
            state[key] = value
            serialize.write_state(path, state)

    def _judge_prepared(self, round_id: str, state: dict) -> bool:
        with self._lock:
            held = self._prepared.get(round_id)
        grade = state.get("grade")
        return bool(held and isinstance(grade, dict) and grade.get("fingerprint") == held.fingerprint)

    def _round_view(self, info: rounds.RoundInfo) -> dict:
        state = self._state(info.path)
        return serialize.round_view(info, state, self.jobs.active(info.id), self._judge_prepared(info.id, state))

    # --- App ------------------------------------------------------------------------------------

    def status(self, body: dict) -> tuple[int, dict]:
        docker, bash = self.docker.current(), find_bash() is not None
        with self._lock:
            settings = self.settings.view()
        return 200, {
            "version": __version__,
            "now": datetime.now(timezone.utc).isoformat(),
            "workspaces_dir": str(ws.workspaces_root()),
            "editor": ws.editor_name(),
            "runner": {
                "docker": docker,
                "bash": bash,
                "default": "docker" if docker else "local" if bash else None,
            },
            "settings": settings,
        }

    def get_settings(self, body: dict) -> tuple[int, dict]:
        with self._lock:
            return 200, self.settings.view()

    def put_settings(self, body: dict) -> tuple[int, dict]:
        judge = _field(body, "judge", dict)
        if judge is None:
            raise _bad_request("'judge' is required.")
        with self._lock:
            self.settings.update(judge)
            return 200, self.settings.view()

    # --- Tasks ----------------------------------------------------------------------------------

    def tasks(self, body: dict) -> tuple[int, dict]:
        return 200, {
            "tasks": [serialize.task_view(t) for t in rounds.available_tasks()],
            "categories": categories(),
            "templates": rounds.templates(),
        }

    def new_task(self, body: dict) -> tuple[int, dict]:
        task_id = _required(body, "task_id")
        if not _ID_PATTERN.fullmatch(task_id):
            raise _bad_request("A task id is lowercase letters, digits and hyphens, like order-api.")
        created = rounds.new_task(task_id, _required(body, "category"), _field(body, "template", str))
        message = f"Created from templates/{created.template}. Fill in every TODO, then validate it."
        return 200, {"path": str(created.path), "message": message}

    def validate(self, body: dict) -> tuple[int, dict]:
        task_ids = _field(body, "task_ids", list)
        if task_ids and not all(isinstance(t, str) for t in task_ids):
            raise _bad_request("'task_ids' must be a list of task ids.")
        run = _field(body, "run", bool, False)
        kind = _runner_kind(body)

        def work(progress: Callable[[str], None]) -> dict:
            runner = get_runner(kind) if run else None
            checks = rounds.validate_tasks(task_ids, runner, progress)
            return {"tasks": [serialize.check_view(c) for c in checks]}

        return 202, self.jobs.start("validate", None, work)

    # --- Rounds ---------------------------------------------------------------------------------

    def list_rounds(self, body: dict) -> tuple[int, dict]:
        return 200, {"rounds": [
            serialize.round_summary(info, self._state(info.path), self.jobs.active(info.id))
            for info in rounds.list_rounds()
        ]}

    def start_round(self, body: dict) -> tuple[int, dict]:
        task = get_task(_required(body, "task_id"))
        git = _field(body, "git", bool, True)
        open_editor = _field(body, "open_editor", bool, True)
        with self._lock:  # two starts mustn't pick the same free folder
            started = rounds.start_in_free_folder(task, git=git, open_editor=open_editor)
        return 201, self._round_view(rounds.load_round(started.path.name))

    def get_round(self, body: dict, round_id: str) -> tuple[int, dict]:
        return 200, self._round_view(rounds.load_round(round_id))

    def delete_round(self, body: dict, round_id: str) -> tuple[int, dict]:
        if _field(body, "confirm", str) != round_id:
            raise _bad_request("To delete a round, send its id as 'confirm'.")
        with self.jobs.claim(round_id):
            rounds.delete_round(round_id)
        with self._lock:
            self._prepared.pop(round_id, None)
        return 200, {"deleted": True}

    def next_stage(self, body: dict, round_id: str) -> tuple[int, dict]:
        with self.jobs.claim(round_id):
            info = rounds.load_round(round_id)
            revealed = rounds.next_stage(info.task, info.path, info.marker)
        return 200, {**self._round_view(rounds.load_round(round_id)), "tagged": revealed.tagged}

    def open_editor(self, body: dict, round_id: str) -> tuple[int, dict]:
        editor = ws.open_in_editor(rounds.load_round(round_id).path)
        if not editor:
            raise ApiError(409, "no_editor", "No editor found. Install VS Code, Cursor or Windsurf, or set IB_EDITOR.")
        return 200, {"editor": editor}

    def changes(self, body: dict, round_id: str) -> tuple[int, dict]:
        info = rounds.load_round(round_id)
        return 200, serialize.changes_view(rounds.changes(info.task, info.path))

    def run_tests(self, body: dict, round_id: str) -> tuple[int, dict]:
        info = rounds.load_round(round_id)
        kind = _runner_kind(body)

        def work(progress: Callable[[str], None]) -> dict:
            runner = get_runner(kind)
            progress(f"Running your tests ({runner.name} runner)")
            result = run_candidate_tests(info.task, info.path, runner)
            view = serialize.candidate_tests_view(result, runner.name)
            self._remember(info.path, "test", view)
            return view

        return 202, self.jobs.start("test", round_id, work)

    def grade(self, body: dict, round_id: str) -> tuple[int, dict]:
        info = rounds.load_round(round_id)
        kind = _runner_kind(body)
        judge = _field(body, "judge", str, "none")
        if judge not in ("none", "api", "prepare"):
            raise _bad_request("'judge' must be none, api or prepare.")
        if judge != "none":
            rounds.check_judge_ready(info.task, info.marker)
        return 202, self.jobs.start("grade", round_id, self._grade_work(info, kind, judge))

    def judge_reply(self, body: dict, round_id: str) -> tuple[int, dict]:
        info = rounds.load_round(round_id)
        rounds.check_judge_ready(info.task, info.marker)
        reply = _required(body, "reply")
        grade = self._state(info.path).get("grade")
        kind = grade.get("runner") if isinstance(grade, dict) else None
        work = self._grade_work(info, kind if kind in RUNNERS else "auto", "reply", reply)
        return 202, self.jobs.start("judge-reply", round_id, work)

    def _grade_work(
        self, info: rounds.RoundInfo, kind: str, judge: str, reply: str | None = None
    ) -> Callable[[Callable[[str], None]], dict]:
        with self._lock:
            settings = self.settings.for_judge()

        def work(progress: Callable[[str], None]) -> dict:
            runner = get_runner(kind)
            fingerprint = rounds.fingerprint(info.path)
            prior, request = None, None
            if judge != "none":
                prior = serialize.prior_result(self._state(info.path).get("grade"), info.task, fingerprint, runner.name)
            if judge in ("prepare", "reply"):
                with self._lock:
                    held = self._prepared.get(info.id)
                if held and held.fingerprint == fingerprint:
                    request = held.request
            outcome = rounds.grade_round(
                info.task, info.path, runner, judge=judge, settings=settings, reply=reply,
                prior=prior, request=request, progress=progress,
            )
            if outcome.request:
                with self._lock:
                    self._prepared[info.id] = PreparedJudge(outcome.request, fingerprint)
            stored = serialize.grade_record(
                outcome.result, fingerprint=fingerprint, judge_error=outcome.judge_error,
                time_used=rounds.time_used_minutes(info.marker), report_path=info.path / REPORT,
            )
            self._remember(info.path, "grade", stored)
            return serialize.grade_view(stored, info.task, info.stage, self._judge_prepared(info.id, {"grade": stored}))

        return work

    def judge_prompt(self, body: dict, round_id: str) -> tuple[int, dict]:
        info = rounds.load_round(round_id)
        rounds.check_judge_ready(info.task, info.marker)
        with self._lock:
            held = self._prepared.get(round_id)
        if held is None:
            raise ApiError(404, "not_found", "There's no judge prompt yet. Grade with the prepare option first.")
        prompt = held.request.as_paste()
        return 200, {"prompt": prompt, "tokens_estimate": rounds.tokens_estimate(prompt)}

    def attack_prompt(self, body: dict, round_id: str) -> tuple[int, dict]:
        info = rounds.load_round(round_id)
        prompt = attack_prompt(info.task, info.path, info.stage)
        return 200, {
            "prompt": prompt,
            "suggested_filename": rounds.suggested_attack_file(info.task),
            "attack_dir": info.task.attack_dir,
            "tokens_estimate": rounds.tokens_estimate(prompt),
        }

    def break_round(self, body: dict, round_id: str) -> tuple[int, dict]:
        info = rounds.load_round(round_id)
        filename, content = _required(body, "filename"), _required(body, "content")
        kind = _runner_kind(body)
        rounds.check_attack_name(info.task, filename)

        def work(progress: Callable[[str], None]) -> dict:
            runner = get_runner(kind)
            outcome = rounds.break_content(info.task, info.path, filename, content, runner, progress=progress)
            view = serialize.break_view(outcome, runner.name)
            self._remember(info.path, "break", view)
            return view

        return 202, self.jobs.start("break", round_id, work)

    # --- Jobs -----------------------------------------------------------------------------------

    def get_job(self, body: dict, job_id: str) -> tuple[int, dict]:
        job = self.jobs.get(job_id)
        if job is None:
            raise ApiError(404, "not_found", "That job is finished and forgotten, or the server restarted.")
        return 200, job


def _route(method: str, pattern: str, handler: Callable) -> tuple[str, re.Pattern, Callable]:
    return method, re.compile(pattern.replace("{id}", "([^/]+)")), handler


ROUTES = [
    _route("GET", "/api/status", Api.status),
    _route("GET", "/api/settings", Api.get_settings),
    _route("PUT", "/api/settings", Api.put_settings),
    _route("GET", "/api/tasks", Api.tasks),
    _route("POST", "/api/tasks", Api.new_task),
    _route("POST", "/api/validate", Api.validate),
    _route("GET", "/api/rounds", Api.list_rounds),
    _route("POST", "/api/rounds", Api.start_round),
    _route("GET", "/api/rounds/{id}", Api.get_round),
    _route("DELETE", "/api/rounds/{id}", Api.delete_round),
    _route("POST", "/api/rounds/{id}/next", Api.next_stage),
    _route("POST", "/api/rounds/{id}/open-editor", Api.open_editor),
    _route("GET", "/api/rounds/{id}/changes", Api.changes),
    _route("POST", "/api/rounds/{id}/test", Api.run_tests),
    _route("POST", "/api/rounds/{id}/grade", Api.grade),
    _route("GET", "/api/rounds/{id}/judge-prompt", Api.judge_prompt),
    _route("POST", "/api/rounds/{id}/judge-reply", Api.judge_reply),
    _route("GET", "/api/rounds/{id}/attack-prompt", Api.attack_prompt),
    _route("POST", "/api/rounds/{id}/break", Api.break_round),
    _route("GET", "/api/jobs/{id}", Api.get_job),
]


class Handler(BaseHTTPRequestHandler):
    server: UIServer
    server_version = "interviewbench"
    sys_version = ""
    timeout = 30

    def do_GET(self) -> None:
        self._handle()

    def do_POST(self) -> None:
        self._handle()

    def do_PUT(self) -> None:
        self._handle()

    def do_DELETE(self) -> None:
        self._handle()

    def log_message(self, format: str, *args: object) -> None:
        pass  # the first request line holds the token

    def end_headers(self) -> None:
        for name, value in SECURITY_HEADERS.items():
            self.send_header(name, value)
        super().end_headers()

    def send_error(self, code: int, message: str | None = None, explain: str | None = None) -> None:
        """http.server's own errors (bad request line, unknown method) as JSON with our headers."""
        self._error(code, HTTPStatus(code).name.lower(), message or HTTPStatus(code).phrase)

    def _handle(self) -> None:
        try:
            self._check_host()
            url = urlsplit(self.path)
            if url.path == "/api" or url.path.startswith("/api/"):
                self._api(url.path)
            elif self.command == "GET":
                self._static(url.path, url.query)
            else:
                raise ApiError(404, "not_found", "Nothing here.")
        except ApiError as exc:
            self._error(exc.status, exc.code, str(exc))
        except OSError:  # the browser went away mid-request
            self.close_connection = True

    def _error(self, status: int, code: str, message: str) -> None:
        self._send_json(status, {"error": {"code": code, "message": message}})

    def _send(self, status: int, content_type: str, data: bytes, extra: dict | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        for name, value in (extra or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(data)

    def _send_json(self, status: int, payload: dict) -> None:
        self._send(status, "application/json; charset=utf-8", json.dumps(payload).encode("utf-8"))

    # --- Checks every request must pass ---------------------------------------------------------

    def _check_host(self) -> None:
        """A rebound DNS name reaches this port with the attacker's host name in Host."""
        host = (self.headers.get("Host") or "").lower()
        if host not in (f"127.0.0.1:{self.server.port}", f"localhost:{self.server.port}"):
            raise ApiError(403, "forbidden", "This server only answers on 127.0.0.1 and localhost.")

    def _check_session(self) -> None:
        # Parsed by hand: cookies ignore ports, so a local app's odd cookie can arrive here, and it
        # would make http.cookies give up on the whole header.
        pairs = (part.strip().partition("=") for part in (self.headers.get("Cookie") or "").split(";"))
        session = next((value for name, _, value in pairs if name == self.server.cookie_name), "")
        if not hmac.compare_digest(session.encode(), self.server.token.encode()):
            raise ApiError(401, "unauthorized", "Open the link `ib ui` printed in your terminal.")

    def _check_mutation(self) -> None:
        content_type = (self.headers.get("Content-Type") or "").partition(";")[0].strip().lower()
        if content_type != "application/json":
            raise ApiError(403, "forbidden", "Requests that change something must be sent as application/json.")
        origin = self.headers.get("Origin")
        if origin is not None and origin not in (
            f"http://127.0.0.1:{self.server.port}", f"http://localhost:{self.server.port}",
        ):
            raise ApiError(403, "forbidden", "This request came from another site.")

    def _read_body(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = -1
        if length < 0:
            raise _bad_request("The request has a bad Content-Length.")
        if length > MAX_BODY:
            self.rfile.read(min(length, MAX_DRAIN))
            self.close_connection = True
            raise ApiError(413, "too_large", f"That's too large: the limit is {MAX_BODY // (1024 * 1024)} MB.")
        raw = self.rfile.read(length)
        if not raw.strip():
            return {}
        try:
            body = json.loads(raw)
        except ValueError as exc:
            raise _bad_request("The request body isn't valid JSON.") from exc
        if not isinstance(body, dict):
            raise _bad_request("The request body must be a JSON object.")
        return body

    # --- API ------------------------------------------------------------------------------------

    def _api(self, path: str) -> None:
        self._check_session()
        body = {}
        if self.command != "GET":
            self._check_mutation()
            body = self._read_body()
        for method, pattern, handler in ROUTES:
            match = pattern.fullmatch(path)
            if method == self.command and match:
                status, payload = self._call(handler, body, [unquote(g) for g in match.groups()])
                self._send_json(status, payload)
                return
        raise ApiError(404, "not_found", "Nothing here.")

    def _call(self, handler: Callable, body: dict, args: list[str]) -> tuple[int, dict]:
        try:
            return handler(self.server.api, body, *args)
        except Busy as exc:
            raise ApiError(409, "busy", "This round is busy with a running job. Wait for it to finish.") from exc
        except AllRevealed as exc:
            raise ApiError(409, "all_revealed", str(exc)) from exc
        except UnknownRound as exc:
            raise ApiError(404, "not_found", str(exc)) from exc
        except (JudgeError, RoundError, RunnerError, TaskError) as exc:
            raise _bad_request(str(exc)) from exc
        except ApiError:
            raise
        except Exception as exc:  # never a traceback: this answer goes to the candidate
            raise ApiError(500, "internal", friendly_message(exc)) from exc

    # --- Static files ---------------------------------------------------------------------------

    def _static(self, path: str, query: str) -> None:
        if path == "/" and self._accept_token(query):
            return
        relative = "index.html" if path == "/" else unquote(path).lstrip("/")
        root = self.server.static_dir.resolve()
        try:
            target = (root / relative).resolve()
            found = target.is_relative_to(root) and target.is_file()
        except (OSError, ValueError):  # e.g. a NUL in the path
            found = False
        content_type = CONTENT_TYPES.get(target.suffix.lower()) if found else None
        if content_type is None:
            message = "Not found."
            if path == "/":
                message = "The GUI's page isn't in this build: src/interviewbench/ui/static/ is missing."
            raise ApiError(404, "not_found", message)
        self._send(200, content_type, target.read_bytes())

    def _accept_token(self, query: str) -> bool:
        """The link `ib ui` printed: swap the token for a cookie, and take it out of the address bar."""
        token = (parse_qs(query).get("token") or [""])[0]
        if not hmac.compare_digest(token.encode(), self.server.token.encode()):
            return False
        cookie = f"{self.server.cookie_name}={self.server.token}; Path=/; HttpOnly; SameSite=Strict"
        self._send(302, "text/plain; charset=utf-8", b"", {"Location": "/", "Set-Cookie": cookie})
        return True


class UIServer(ThreadingHTTPServer):
    # On Windows, SO_REUSEADDR lets two servers share a port, which would hide a port already in use.
    allow_reuse_address = os.name != "nt"
    daemon_threads = True
    request_queue_size = 64  # a page load fetches many modules at once

    def __init__(self, port: int, static_dir: Path) -> None:
        super().__init__((HOST, port), Handler)
        self.port = self.server_address[1]
        self.token = secrets.token_urlsafe(32)
        self.cookie_name = f"ib_session_{self.port}"
        self.static_dir = static_dir
        self.api = Api()

    def server_bind(self) -> None:
        socketserver.TCPServer.server_bind(self)  # HTTPServer's also does a reverse DNS lookup

    def handle_error(self, request: object, client_address: object) -> None:
        pass  # a broken connection; nothing a candidate can act on

    @property
    def url(self) -> str:
        return f"http://{HOST}:{self.port}/?token={self.token}"

    def stop(self) -> None:
        self.shutdown()
        self.server_close()


def serve(port: int = 0, *, static_dir: Path = STATIC_DIR) -> UIServer:
    """Bind `port` or the next free one, and serve on a background thread until `.stop()`."""
    for candidate in range(port, port + PORT_ATTEMPTS) if port else [0]:
        try:
            server = UIServer(candidate, static_dir)
            break
        except OSError:
            continue
    else:
        raise OSError(f"No free port between {port} and {port + PORT_ATTEMPTS - 1}.")
    server.api.docker.current()  # starts the first check, so /api/status is right soon after start
    threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.1}, daemon=True).start()
    return server

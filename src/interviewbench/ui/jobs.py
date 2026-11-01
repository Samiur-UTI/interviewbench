"""Background jobs: long work runs off the request thread and the browser polls for it.

A round has at most one running job, and a quick change such as `next` claims the round too, so
nothing changes a round while a job is reading it.
"""

from __future__ import annotations

import threading
import time
import uuid
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Callable, Iterator

from ..judge import JudgeError
from ..rounds import RoundError
from ..runner import RunnerError
from ..tasks import TaskError

KEEP_SECONDS = 3600


class Busy(Exception):
    pass


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def friendly_message(exc: Exception) -> str:
    if isinstance(exc, (JudgeError, RoundError, RunnerError, TaskError)):
        return str(exc)
    return f"Something went wrong: {str(exc) or type(exc).__name__}"


@dataclass
class Job:
    id: str
    kind: str
    round_id: str | None
    state: str = "running"
    phase: str = "Getting ready"
    log: list[str] = field(default_factory=list)
    started_at: str = field(default_factory=now_iso)
    finished_at: str | None = None
    result: dict | None = None
    error: str | None = None


class Jobs:
    def __init__(self, keep_seconds: float = KEEP_SECONDS) -> None:
        self._keep_seconds = keep_seconds
        self._lock = threading.Lock()
        self._jobs: dict[str, Job] = {}
        self._finished: dict[str, float] = {}  # job id -> time.monotonic() when it finished
        self._claims: dict[str, str | None] = {}  # round id -> its running job, None for a quick change

    def start(self, kind: str, round_id: str | None, work: Callable[[Callable[[str], None]], dict]) -> dict:
        """Run `work(progress)` on its own thread. Returns the job, or raises Busy."""
        job = Job(uuid.uuid4().hex, kind, round_id)
        with self._lock:
            self._forget_old_jobs()
            if round_id is not None:
                if round_id in self._claims:
                    raise Busy
                self._claims[round_id] = job.id
            self._jobs[job.id] = job
            snapshot = asdict(job)
        threading.Thread(target=self._run, args=(job, work), daemon=True).start()
        return snapshot

    def _run(self, job: Job, work: Callable[[Callable[[str], None]], dict]) -> None:
        def progress(phase: str) -> None:
            with self._lock:
                job.phase = phase
                job.log.append(phase)

        result, error = None, None
        try:
            result = work(progress)
        except Exception as exc:  # the thread's last stop: the browser must hear how the job ended
            error = friendly_message(exc)
        with self._lock:
            job.result, job.error = result, error
            job.state = "failed" if error else "succeeded"
            job.finished_at = now_iso()
            self._finished[job.id] = time.monotonic()
            self._claims.pop(job.round_id, None)

    def get(self, job_id: str) -> dict | None:
        with self._lock:
            self._forget_old_jobs()
            job = self._jobs.get(job_id)
            return asdict(job) if job else None

    def active(self, round_id: str) -> str | None:
        with self._lock:
            return self._claims.get(round_id)

    @contextmanager
    def claim(self, round_id: str) -> Iterator[None]:
        """Hold a round for a quick change made on the request thread. Raises Busy."""
        with self._lock:
            if round_id in self._claims:
                raise Busy
            self._claims[round_id] = None
        try:
            yield
        finally:
            with self._lock:
                del self._claims[round_id]

    def _forget_old_jobs(self) -> None:
        cutoff = time.monotonic() - self._keep_seconds
        for job_id, finished in list(self._finished.items()):
            if finished < cutoff:
                del self._finished[job_id], self._jobs[job_id]

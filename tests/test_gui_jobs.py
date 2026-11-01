"""The GUI's background jobs."""

import threading

import pytest

from interviewbench.ui.jobs import Busy, Jobs


def wait_for(jobs, job_id):
    for _ in range(1000):
        job = jobs.get(job_id)
        if job["state"] != "running":
            return job
        threading.Event().wait(0.01)
    raise AssertionError("the job never finished")


def test_a_job_reports_phases_and_its_result():
    jobs = Jobs()

    def work(progress):
        progress("one")
        progress("two")
        return {"done": True}

    job = jobs.start("test", "r", work)
    assert job["state"] == "running" and job["phase"] == "Getting ready" and job["finished_at"] is None
    done = wait_for(jobs, job["id"])
    assert done["state"] == "succeeded" and done["log"] == ["one", "two"] and done["phase"] == "two"
    assert done["result"] == {"done": True} and done["finished_at"] and jobs.active("r") is None


def test_a_round_runs_one_job_but_other_rounds_are_free():
    jobs = Jobs()
    release = threading.Event()

    def blocked(progress):
        release.wait(10)
        return {}

    job = jobs.start("test", "a", blocked)
    with pytest.raises(Busy):
        jobs.start("grade", "a", blocked)
    with pytest.raises(Busy):
        with jobs.claim("a"):
            pass
    other = jobs.start("test", "b", lambda progress: {})
    assert jobs.active("a") == job["id"]
    release.set()
    wait_for(jobs, job["id"])
    wait_for(jobs, other["id"])
    jobs.start("test", "a", lambda progress: {})


def test_a_claim_blocks_jobs_and_is_released_even_on_error():
    jobs = Jobs()
    with pytest.raises(ValueError):
        with jobs.claim("a"):
            with pytest.raises(Busy):
                jobs.start("test", "a", lambda progress: {})
            raise ValueError
    with jobs.claim("a"):
        pass


def test_jobs_without_a_round_never_collide():
    jobs = Jobs()
    release = threading.Event()
    first = jobs.start("validate", None, lambda progress: release.wait(10) and {})
    second = jobs.start("validate", None, lambda progress: release.wait(10) and {})
    assert first["id"] != second["id"]
    release.set()


def test_finished_jobs_are_forgotten_after_a_while():
    jobs = Jobs(keep_seconds=0)
    job = jobs.start("test", None, lambda progress: {})
    for _ in range(1000):
        if jobs.get(job["id"]) is None:
            return
        threading.Event().wait(0.01)
    raise AssertionError("the job was kept")

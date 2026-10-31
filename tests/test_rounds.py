"""The workflows behind the CLI and the GUI, called directly."""

import pytest

from interviewbench import rounds
from interviewbench import workspace as ws
from interviewbench.tasks import BRIEF


def test_start_round_reports_what_it_set_up(tmp_path, task):
    started = rounds.start_round(task, tmp_path / "ws", open_editor=False)
    assert started.path == tmp_path / "ws" and started.git is True and started.editor is None
    assert ws.read_marker(started.path)["stage"] == 1
    with pytest.raises(rounds.RoundError, match="already exists"):
        rounds.start_round(task, tmp_path / "ws", open_editor=False)


def test_next_stage_reports_the_tag_and_stops_at_the_last_stage(tmp_path, task):
    dest = rounds.start_round(task, tmp_path / "ws", open_editor=False).path
    marker = ws.read_marker(dest)
    assert rounds.next_stage(task, dest, marker) == rounds.RevealedStage(2, "stage-1")
    assert rounds.next_stage(task, dest, marker) == rounds.RevealedStage(3, "stage-2")
    assert "## Stage 3/3" in (dest / BRIEF).read_text(encoding="utf-8")
    with pytest.raises(rounds.AllRevealed, match="already revealed"):
        rounds.next_stage(task, dest, marker)


def test_next_stage_without_git_tags_nothing(tmp_path, task):
    dest = rounds.start_round(task, tmp_path / "ws", git=False, open_editor=False).path
    assert rounds.next_stage(task, dest, ws.read_marker(dest)).tagged is None

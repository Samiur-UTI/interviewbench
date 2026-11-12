"""`ib ui`: the link, the browser, Ctrl+C and the port."""

import pytest
from typer.testing import CliRunner

from interviewbench import cli
from interviewbench.ui import server as ui_server
from interviewbench.ui.server import serve


@pytest.fixture(autouse=True)
def quiet_docker(monkeypatch):
    monkeypatch.setattr(ui_server, "docker_available", lambda: False)



def stop_at_once(monkeypatch):
    def interrupt(seconds):
        raise KeyboardInterrupt

    monkeypatch.setattr(cli.time, "sleep", interrupt)


def test_ib_ui_prints_the_link_and_stops_on_ctrl_c(monkeypatch):
    stop_at_once(monkeypatch)
    opened = []
    monkeypatch.setattr(cli.webbrowser, "open", opened.append)
    result = CliRunner().invoke(cli.app, ["ui", "--port", "0", "--no-open"])
    assert result.exit_code == 0, result.output
    assert "http://127.0.0.1:" in result.output and "/?token=" in result.output and "Stopped." in result.output
    assert opened == []


def test_ib_ui_opens_the_browser_on_the_printed_link(monkeypatch):
    stop_at_once(monkeypatch)
    opened = []
    monkeypatch.setattr(cli.webbrowser, "open", opened.append)
    result = CliRunner().invoke(cli.app, ["ui", "--port", "0"])
    assert result.exit_code == 0, result.output
    assert opened and opened[0] in result.output


def test_bare_ib_opens_the_gui(monkeypatch):
    stop_at_once(monkeypatch)
    opened = []
    monkeypatch.setattr(cli.webbrowser, "open", opened.append)
    result = CliRunner().invoke(cli.app, [])
    assert result.exit_code == 0, result.output
    assert opened and opened[0] in result.output and "ib --help" in result.output


def test_ib_help_still_lists_the_commands(monkeypatch):
    monkeypatch.setattr(cli, "ui", lambda **_: pytest.fail("--help must not start the GUI"))
    result = CliRunner().invoke(cli.app, ["--help"])
    assert result.exit_code == 0, result.output
    assert "start" in result.output and "grade" in result.output and "ui" in result.output


def test_a_taken_port_falls_to_the_next_free_one(tmp_path):
    first = serve(0, static_dir=tmp_path)
    second = serve(first.port, static_dir=tmp_path)
    try:
        assert second.port > first.port
    finally:
        second.stop()
        first.stop()

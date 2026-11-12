"""The local runner: temp files stay inside the run, and a timeout ends the whole script."""

import os
import shutil
import stat
import tempfile
import time
from pathlib import Path

import pytest

from interviewbench.grader import run_stage_tests
from interviewbench.runner import LocalRunner, RunnerError, Sandbox, is_secret_name, remove_tree


@pytest.fixture(scope="module")
def local():
    try:
        return LocalRunner()
    except RunnerError as exc:
        pytest.skip(str(exc))


def sandbox(root: Path, **extra) -> Sandbox:
    (root / "app").mkdir(parents=True)
    return Sandbox(app=root / "app", logs=root / "logs", **extra)


# Each tool writes a temp file where its own convention says, and records where that was.
PROBE = r"""
touch "$TMPDIR/from-bash"
"$PYTHON" - <<'EOF'
import os, tempfile
with open(os.path.join(os.environ["LOGS_DIR"], "python.txt"), "w") as f:
    f.write(tempfile.gettempdir())
for name in ("TEMP", "TMP"):
    assert os.path.exists(os.path.join(os.environ[name], "from-bash")), name
tempfile.mkdtemp(prefix="left-behind-")
EOF
if command -v node >/dev/null; then
  node -e 'const fs = require("fs"), os = require("os"), path = require("path");
    fs.mkdtempSync(path.join(os.tmpdir(), "left-behind-"));
    fs.writeFileSync(path.join(process.env.LOGS_DIR, "node.txt"), os.tmpdir());'
fi
"""


def test_temp_files_go_to_the_sandbox_temp_folder_and_are_removed(local, tmp_path):
    box = sandbox(tmp_path, temp=tmp_path / "temp")
    done = local.run(None, PROBE, box, timeout=60)
    assert done.returncode == 0, done.output
    for log in ("python.txt", "node.txt"):
        if (box.logs / log).exists():
            assert Path((box.logs / log).read_text()).resolve() == box.temp.resolve(), log
    assert not box.temp.exists()


def test_without_a_sandbox_temp_folder_the_run_makes_and_removes_its_own(local, tmp_path):
    done = local.run(None, PROBE, sandbox(tmp_path), timeout=60)
    assert done.returncode == 0, done.output
    used = Path((tmp_path / "logs" / "python.txt").read_text())
    assert used.name.startswith("ib-tmp-")
    assert Path(tempfile.gettempdir()).resolve() == used.resolve().parent
    assert not used.exists()


def test_a_timeout_ends_the_scripts_children_too(local, tmp_path):
    # The grandchild would write `survived` two seconds in, long after the one-second timeout.
    script = 'echo started; bash -c "\\"$PYTHON\\" -c \\"import time; time.sleep(2); open(\'survived\', \'w\')\\""'
    box = sandbox(tmp_path)
    began = time.monotonic()
    done = local.run(None, script, box, timeout=1)
    assert done.timed_out
    assert time.monotonic() - began < 2  # didn't wait for the grandchild to close the output pipe
    assert "started" in done.output
    time.sleep(2.5)
    assert not (box.app / "survived").exists()


SECRETS = {
    "ANTHROPIC_API_KEY": "sk-ant-fake", "OPENAI_API_KEY": "sk-fake", "IB_JUDGE_API_KEY": "fake",
    "GITHUB_TOKEN": "ghp_fake", "GH_TOKEN": "fake", "AWS_SECRET_ACCESS_KEY": "fake", "AWS_ACCESS_KEY_ID": "fake",
    "AZURE_CLIENT_SECRET": "fake", "GOOGLE_APPLICATION_CREDENTIALS": "fake.json", "NPM_TOKEN": "fake",
    "DATABASE_URL": "postgres://user:fake@db/x", "SSH_AUTH_SOCK": "/tmp/fake.sock", "My_Db_Password": "fake",
}


def test_scripts_do_not_see_secret_looking_variables(local, tmp_path, monkeypatch):
    for name, value in SECRETS.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setenv("IB_TEST_HARMLESS", "1")
    script = """"$PYTHON" - <<'EOF'
import os
with open(os.path.join(os.environ["LOGS_DIR"], "env.txt"), "w") as f:
    f.write("\\n".join(os.environ))
EOF
"""
    box = sandbox(tmp_path)
    done = local.run(None, script, box, timeout=60)
    assert done.returncode == 0, done.output
    seen = {name.upper() for name in (box.logs / "env.txt").read_text().splitlines()}
    assert not seen & {name.upper() for name in SECRETS}
    assert {"IB_TEST_HARMLESS", "PATH", "APP_DIR", "LOGS_DIR", "PYTHON"} <= seen


@pytest.mark.parametrize("name", [
    *SECRETS, "anthropic_base_url", "OpenAI_Base_URL", "IB_JUDGE_MODEL", "github_actions", "Azure_OpenAI_Endpoint",
    "STRIPE_SECRET_KEY", "SLACK_BOT_TOKEN", "node_auth_token", "npm_config__auth", "MY_PRIVATE_KEY", "PGPASSWORD",
    "MYSQL_PWD", "REDIS_URL", "MongoDB_URI", "SENTRY_DSN", "CLAUDE_CODE_OAUTH_TOKEN", "GIT_ASKPASS",
    "VSCODE_GIT_IPC_HANDLE", "SomeServiceApiKey", "DB_PASSWD", "AWS_PROFILE",
])
def test_secret_names(name):
    assert is_secret_name(name)


@pytest.mark.parametrize("name", [
    "PATH", "Path", "HOME", "USERPROFILE", "TEMP", "TMP", "TMPDIR", "SystemRoot", "APPDATA", "LOCALAPPDATA", "LANG",
    "NODE_OPTIONS", "NODE_PATH", "PYTHONIOENCODING", "PYTHONHASHSEED", "PYTHON", "APP_DIR", "TESTS_DIR",
    "SOLUTION_DIR", "LOGS_DIR", "IB_TEST_HARMLESS", "IB_DATA_DIR", "IB_BASH", "PWD", "OLDPWD", "GIT_AUTHOR_NAME",
    "JAVA_HOME", "COMSPEC", "PATHEXT", "KEYBOARD_LAYOUT", "CI", "TERM", "PUBLIC_URL",
])
def test_harmless_names(name):
    assert not is_secret_name(name)


def test_remove_tree_deletes_read_only_files(tmp_path):
    target = tmp_path / "t" / "nested"
    target.mkdir(parents=True)
    locked = target / "pack.idx"
    locked.write_text("x")
    os.chmod(locked, stat.S_IREAD)
    assert remove_tree(tmp_path / "t")
    assert not (tmp_path / "t").exists()
    assert remove_tree(tmp_path / "never-existed")


def test_grading_leaves_nothing_in_the_temp_folder(task, runner, tmp_path, monkeypatch):
    temp = tmp_path / "system-temp"
    temp.mkdir()
    monkeypatch.setattr(tempfile, "tempdir", str(temp))
    workspace = shutil.copytree(task.starter_dir, tmp_path / "ws")
    result = run_stage_tests(task, workspace, 1, runner)
    assert result.total > 0, result.error
    assert list(temp.iterdir()) == []

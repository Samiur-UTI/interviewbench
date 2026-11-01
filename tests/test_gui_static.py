"""The browser side of `ib ui`: its node tests, plus the rules of docs/GUI.md that a reader can miss."""

import re
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).parents[1]
STATIC = ROOT / "src" / "interviewbench" / "ui" / "static"
NODE_TESTS = ROOT / "tests" / "gui_js"
JS = sorted(STATIC.rglob("*.js"))

# The only way Markdown reaches the page: renderMarkdown escapes the source before it builds a tag.
MARKDOWN_SINK = "element.innerHTML = renderMarkdown(source, options);"
HTML_SINKS = re.compile(r"\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|srcdoc")
# Addresses the code may contain. None is ever loaded: one's a namespace, the rest are judge settings.
ALLOWED_URLS = {
    "http://www.w3.org/2000/svg",
    "http://localhost:11434/v1",
    "https://api.groq.com/openai/v1",
    "https://generativelanguage.googleapis.com/v1beta/openai",
    "https://openrouter.ai/api/v1",
}


def read(path):
    return path.read_text(encoding="utf-8")


def test_node_tests_pass():
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is not on PATH")
    version = subprocess.run([node, "--version"], capture_output=True, text=True).stdout
    if int(version.lstrip("v").split(".")[0]) < 22:
        pytest.skip("the node tests need node 22+, which imports ES modules from .js files")
    tests = [str(p) for p in sorted(NODE_TESTS.glob("*.test.mjs"))]
    assert tests
    done = subprocess.run([node, "--test", *tests], capture_output=True, text=True, encoding="utf-8")
    assert done.returncode == 0, done.stdout + done.stderr


def test_html_has_no_inline_script_or_style():
    html = read(STATIC / "index.html")
    assert "<style" not in html
    assert not re.search(r"\sstyle\s*=", html)
    assert not re.search(r"\son\w+\s*=", html)
    for tag in re.findall(r"<script\b[^>]*>", html):
        assert 'type="module"' in tag and 'src="/' in tag, tag
    assert re.findall(r"<script\b[^>]*>(.*?)</script>", html, re.S) == [""]


def test_css_loads_nothing():
    css = read(STATIC / "styles.css")
    assert "@import" not in css and "@font-face" not in css and "url(" not in css


def test_nothing_external():
    for path in [*STATIC.rglob("*.html"), *STATIC.rglob("*.css"), *JS]:
        for url in re.findall(r"https?://[^\s\"'`)]+", read(path)):
            assert url in ALLOWED_URLS, f"{path.name}: {url}"
    for path in [STATIC / "index.html", STATIC / "styles.css"]:
        assert "http" not in read(path), path.name


def test_favicon_has_no_links_or_scripts():
    svg = read(STATIC / "favicon.svg")
    assert "<script" not in svg and "href" not in svg


def test_html_is_only_built_by_the_markdown_renderer():
    for path in JS:
        for line in read(path).splitlines():
            if HTML_SINKS.search(line):
                assert path.name == "markdown.js" and line.strip() == MARKDOWN_SINK, f"{path.name}: {line}"


def test_styles_are_only_set_through_cssom():
    for path in JS:
        text = read(path)
        assert not re.search(r"""setAttribute\(\s*["']style""", text), path.name
        assert "cssText" not in text, path.name
        assert not re.search(r"""\bstyle:\s""", text), path.name
        for use in re.findall(r"\.style\.\w+", text):
            assert use == ".style.setProperty", f"{path.name}: {use}"


def test_modules_import_only_local_files_that_exist():
    for path in JS:
        for target in re.findall(r"""(?:from|import)\s+["']([^"']+)["']""", read(path)):
            assert target.startswith("."), f"{path.name}: {target}"
            assert (path.parent / target).is_file(), f"{path.name}: {target}"


def test_no_emoji_or_terminal_commands_in_the_normal_flow():
    for path in JS:
        text = read(path)
        assert not re.search(r"[\U0001F300-\U0001FAFF☀-➿]", text), path.name
        assert not re.search(r"""\b(ib (start|test|next|grade|break|validate|new)|pip install)\b""", text), path.name

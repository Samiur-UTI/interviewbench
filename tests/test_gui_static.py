"""The browser side of `ib ui`: its node tests, plus the rules of docs/GUI.md that a reader can miss."""

import hashlib
import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).parents[1]
STATIC = ROOT / "src" / "interviewbench" / "ui" / "static"
NODE_TESTS = ROOT / "tests" / "gui_js"
VENDOR = STATIC / "vendor"
SCRIPTS = sorted(p for pattern in ("*.js", "*.mjs") for p in STATIC.rglob(pattern))
JS = [p for p in SCRIPTS if VENDOR not in p.parents]  # our code; vendor/ is pinned below
VENDORED = [p for p in SCRIPTS if VENDOR in p.parents]
LAYERS = {"core": 0, "hooks": 1, "components": 2, "views": 3, "app": 4}

# The only way Markdown reaches the page: renderMarkdown escapes the source before it builds a tag.
MARKDOWN_SINK = "element.innerHTML = renderMarkdown(source, options);"
HTML_SINKS = re.compile(
    r"\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML|document\.write|\beval\(|\bFunction\(|srcdoc"
    r"|dangerouslySetInnerHTML|\bsrc=\$\{"
)
# Addresses the code may contain. None is ever loaded: they're judge settings.
ALLOWED_URLS = {
    "http://localhost:11434/v1",
    "https://api.groq.com/openai/v1",
    "https://generativelanguage.googleapis.com/v1beta/openai",
    "https://openrouter.ai/api/v1",
}


def read(path):
    return path.read_text(encoding="utf-8")


def test_node_tests_pass():
    node = shutil.which("node")
    version = subprocess.run([node, "--version"], capture_output=True, text=True).stdout if node else "v0"
    if int(version.lstrip("v").split(".")[0]) < 22:
        reason = "the node tests need node 22+, which imports ES modules from .js files"
        if os.environ.get("CI"):  # they hold the Markdown escaping guarantee, so CI mustn't lose them
            pytest.fail(reason)
        pytest.skip(reason)
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
        assert not re.search(r"""\bstyle:\s|\bstyle=""", text), path.name
        for use in re.findall(r"\.style\.\w+", text):
            assert use == ".style.setProperty", f"{path.name}: {use}"


def test_modules_import_only_local_files_that_exist():
    for path in JS:
        for target in re.findall(r"""^(?:import\b|export\s*[{*])[^"']*["']([^"']+)["']""", read(path), re.M):
            assert target.startswith("."), f"{path.name}: {target}"
            assert (path.parent / target).is_file(), f"{path.name}: {target}"


def test_links_are_built_from_routes_only():
    for path in JS:
        for link in re.findall(r"""\bhref=\$\{([^}]*)\}""", read(path)):
            assert re.match(r"(roundHref\(|HOME$|href$)", link), f"{path.name}: {link}"


def imports(path):
    for target in re.findall(r"""^(?:import\b|export\s*[{*])[^"']*["']([^"']+)["']""", read(path), re.M):
        yield (path.parent / target).resolve().relative_to(STATIC.resolve() / "js").parts


def test_imports_point_one_way():
    for path in JS:
        parts = path.relative_to(STATIC / "js").parts
        if parts[0] not in LAYERS:
            continue
        for target in imports(path):
            if target[0] in LAYERS:
                assert LAYERS[target[0]] <= LAYERS[parts[0]], f"{'/'.join(parts)} imports {'/'.join(target)}"
            if parts[0] == target[0] == "views":
                assert parts[1] == target[1], f"{'/'.join(parts)} reaches into another screen"


def test_only_preact_js_reaches_the_vendor_folder():
    for path in JS:
        if "vendor/" in read(path):
            assert path == STATIC / "js" / "preact.js", path.name


def test_core_stays_free_of_the_framework_so_node_can_test_it():
    for path in sorted((STATIC / "js" / "core").glob("*.js")):
        assert "preact" not in read(path), path.name


def test_vendored_files_match_their_pinned_hashes():
    manifest = json.loads(read(VENDOR / "manifest.json"))
    assert sorted(manifest) == sorted(p.relative_to(VENDOR).as_posix() for p in VENDORED)
    for name, entry in manifest.items():
        assert hashlib.sha256((VENDOR / name).read_bytes()).hexdigest() == entry["sha256"], name


def test_vendored_code_needs_nothing_the_csp_forbids():
    for path in VENDORED:
        text = read(path)
        assert not re.search(r"\bFunction\(|\beval\(", text), path.name
        assert not re.search(r"""(?:from|import)\s*["'][^."']""", text), f"{path.name} has a bare import"


def test_no_emoji_or_terminal_commands_in_the_normal_flow():
    for path in JS:
        text = read(path)
        assert not re.search(r"[\U0001F300-\U0001FAFF☀-➿]", text), path.name
        assert not re.search(r"""\b(ib (start|test|next|grade|break|validate|new)|pip install)\b""", text), path.name

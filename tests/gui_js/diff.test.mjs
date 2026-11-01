import assert from "node:assert/strict";
import { test } from "node:test";

import { parseDiff } from "../../src/interviewbench/ui/static/js/diff.js";

const GIT = `diff --git a/src/a.py b/src/a.py
index 83db48f..bf2a1c3 100644
--- a/src/a.py
+++ b/src/a.py
@@ -2,3 +2,4 @@ def f():
 keep
-old
+new
+extra
 tail
diff --git a/notes.md b/notes.md
new file mode 100644
index 0000000..e69de29
--- /dev/null
+++ b/notes.md
@@ -0,0 +1 @@
+hello
\\ No newline at end of file
diff --git a/gone.py b/gone.py
deleted file mode 100644
--- a/gone.py
+++ /dev/null
@@ -1,2 +0,0 @@
-x
-y
diff --git a/logo.png b/logo.png
new file mode 100644
Binary files /dev/null and b/logo.png differ
`;

test("a git diff splits into files with statuses and counts", () => {
  const files = parseDiff(GIT);
  assert.deepEqual(files.map((f) => [f.path, f.status, f.additions, f.deletions, f.binary]), [
    ["src/a.py", "modified", 2, 1, false],
    ["notes.md", "added", 1, 0, false],
    ["gone.py", "deleted", 0, 2, false],
    ["logo.png", "added", 0, 0, true],
  ]);
});

test("lines carry their old and new numbers", () => {
  const [{ hunks: [hunk] }] = parseDiff(GIT);
  assert.equal(hunk.header, "@@ -2,3 +2,4 @@ def f():");
  assert.deepEqual(hunk.lines, [
    { type: "context", text: "keep", oldLine: 2, newLine: 2 },
    { type: "del", text: "old", oldLine: 3 },
    { type: "add", text: "new", newLine: 3 },
    { type: "add", text: "extra", newLine: 4 },
    { type: "context", text: "tail", oldLine: 4, newLine: 5 },
  ]);
});

test("the no-newline marker is a note, not a change", () => {
  const notes = parseDiff(GIT)[1].hunks[0].lines;
  assert.deepEqual(notes[1], { type: "note", text: "No newline at end of file" });
});

test("difflib output has no diff --git lines and may carry timestamps", () => {
  const files = parseDiff(
    "--- a/x.py\t2026-01-01\n+++ b/x.py\t2026-01-02\n@@ -1 +1 @@\n-a\n+b\n--- /dev/null\n+++ b/y.py\n@@ -0,0 +1,1 @@\n+c\n",
  );
  assert.deepEqual(files.map((f) => [f.path, f.status]), [["x.py", "modified"], ["y.py", "added"]]);
});

test("removed lines that look like headers stay inside their hunk", () => {
  const [file, ...rest] = parseDiff("--- a/s.sql\n+++ b/s.sql\n@@ -1,3 +1,2 @@\n-- comment\n--- rule\n+++ plus\n x\n");
  assert.equal(rest.length, 0);
  assert.deepEqual(file.hunks[0].lines.map((l) => [l.type, l.text]), [
    ["del", "- comment"], ["del", "-- rule"], ["add", "++ plus"], ["context", "x"],
  ]);
});

test("a blank context line and CRLF endings survive", () => {
  const [{ hunks: [hunk] }] = parseDiff("--- a/x\r\n+++ b/x\r\n@@ -1,2 +1,2 @@\r\n\r\n-a\r\n+b\r\n");
  assert.deepEqual(hunk.lines.map((l) => [l.type, l.text]), [["context", ""], ["del", "a"], ["add", "b"]]);
});

test("renames and paths with spaces", () => {
  const [moved, spaced] = parseDiff(
    "diff --git a/old.py b/new.py\nsimilarity index 100%\nrename from old.py\nrename to new.py\n"
    + 'diff --git a/my file.md b/my file.md\n--- "a/my file.md"\n+++ "b/my file.md"\n@@ -1 +1 @@\n-a\n+b\n',
  );
  assert.equal(moved.path, "new.py");
  assert.equal(spaced.path, "my file.md");
});

test("no diff means no files", () => {
  assert.deepEqual(parseDiff(""), []);
  assert.deepEqual(parseDiff(null), []);
  assert.deepEqual(parseDiff("not a diff\nat all\n"), []);
});

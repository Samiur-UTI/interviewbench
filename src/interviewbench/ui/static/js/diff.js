// Parses unified diffs, from git or Python's difflib, into files, hunks and numbered lines.

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;
const NULL_PATH = "/dev/null";

function cleanPath(raw) {
  const path = raw.split("\t")[0].trim().replace(/^"|"$/g, "");
  return path === NULL_PATH ? path : path.replace(/^[ab]\//, "");
}

function newFile() {
  return { path: "", status: "modified", binary: false, additions: 0, deletions: 0, hunks: [] };
}

function finish(file) {
  if (!file.path) file.path = file.newPath && file.newPath !== NULL_PATH ? file.newPath : file.oldPath ?? "";
  if (file.oldPath === NULL_PATH) file.status = "added";
  if (file.newPath === NULL_PATH) file.status = "deleted";
  delete file.oldPath;
  delete file.newPath;
  return file;
}

export function parseDiff(text) {
  const files = [];
  const lines = String(text ?? "").split("\n").map((line) => line.replace(/\r$/, ""));
  let file = null;
  let hunk = null;
  let oldLeft = 0;
  let newLeft = 0;
  let oldLine = 0;
  let newLine = 0;

  const begin = () => {
    if (file) files.push(finish(file));
    file = newFile();
    hunk = null;
  };

  lines.forEach((line, i) => {
    // Inside a hunk the counts decide, so a removed "-- x" can't pass for a "--- x" header.
    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      if (line.startsWith("\\")) {
        hunk.lines.push({ type: "note", text: line.slice(2) });
      } else if (line.startsWith("+")) {
        hunk.lines.push({ type: "add", text: line.slice(1), newLine: newLine++ });
        file.additions++;
        newLeft--;
      } else if (line.startsWith("-")) {
        hunk.lines.push({ type: "del", text: line.slice(1), oldLine: oldLine++ });
        file.deletions++;
        oldLeft--;
      } else {
        hunk.lines.push({ type: "context", text: line.slice(1), oldLine: oldLine++, newLine: newLine++ });
        oldLeft--;
        newLeft--;
      }
      return;
    }
    const range = line.match(HUNK);
    if (line.startsWith("diff --git ")) {
      begin();
      const paths = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      if (paths) file.path = paths[2];
    } else if (line.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")) {
      if (!file || file.hunks.length) begin();
      file.oldPath = cleanPath(line.slice(4));
    } else if (line.startsWith("+++ ") && file) {
      file.newPath = cleanPath(line.slice(4));
      file.path = "";
    } else if (range && file) {
      [oldLine, newLine] = [Number(range[1]), Number(range[3])];
      oldLeft = range[2] === undefined ? 1 : Number(range[2]);
      newLeft = range[4] === undefined ? 1 : Number(range[4]);
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
    } else if (line.startsWith("\\") && hunk) {
      hunk.lines.push({ type: "note", text: line.slice(2) });
    } else if (file && line.startsWith("Binary files ")) {
      file.binary = true;
    } else if (file && line.startsWith("new file mode")) {
      file.status = "added";
    } else if (file && line.startsWith("deleted file mode")) {
      file.status = "deleted";
    } else if (file && line.startsWith("rename to ")) {
      file.path = line.slice("rename to ".length);
    }
  });
  if (file) files.push(finish(file));
  return files;
}

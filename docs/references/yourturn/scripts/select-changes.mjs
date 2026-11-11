// Keeps only some changes of a file diff.
//
// Rewrites the OLD side so that every change NOT matching `contains` is
// already applied there. Diffing the result against the real new file then
// shows just the matching changes, while both files stay complete (so context
// can still be expanded in the browser).
//
// A change is a run of removed/added lines. It matches when any of its lines
// includes one of the needles.

// Parses a unified diff of one file into changes: runs of removed/added lines.
// `at` is the index in the old file's lines where the change starts, `newStart`
// the 1-based line in the new file (for a pure deletion, the line after it).
export function parseChanges(patch) {
  const changes = [];
  let current = null;
  let oldIndex = 0;
  let newLine = 0;
  let inHunk = false;

  for (const line of patch.split("\n")) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      inHunk = true;
      current = null;
      // Old start is 1-based. A zero-length old range is an insertion after that line.
      oldIndex = Number(header[1]) - 1 + (header[2] === "0" ? 1 : 0);
      newLine = Number(header[3]) + (header[4] === "0" ? 1 : 0);
      continue;
    }
    if (!inHunk) continue; // skip the file header
    const sign = line[0];
    if (sign === " ") {
      current = null;
      oldIndex++;
      newLine++;
    } else if (sign === "-" || sign === "+") {
      if (!current) changes.push((current = { at: oldIndex, newStart: newLine, removed: [], added: [] }));
      if (sign === "-") {
        current.removed.push(line.slice(1));
        oldIndex++;
      } else {
        current.added.push(line.slice(1));
        newLine++;
      }
    }
  }
  return changes;
}

// One compact line per change, so an agent can pick a `contains` snippet
// without reading whole diffs.
export function formatChanges({ files }) {
  const out = [];
  for (const file of files) {
    if (file.kind !== "text" || !file.patch) {
      out.push(`${file.path} (${file.kind === "text" ? file.status : file.kind})`);
      continue;
    }
    const changes = parseChanges(file.patch);
    const added = changes.reduce((n, c) => n + c.added.length, 0);
    const removed = changes.reduce((n, c) => n + c.removed.length, 0);
    out.push(`${file.path} (${file.status}, +${added} -${removed})`);
    for (const c of changes) {
      const where = c.added.length
        ? `L${c.newStart}${c.added.length > 1 ? `-${c.newStart + c.added.length - 1}` : ""}`
        : `after L${c.newStart - 1}`;
      const text = [...c.added, ...c.removed].map((l) => l.trim()).find(Boolean) ?? "(blank lines)";
      out.push(`  ${where}  +${c.added.length} -${c.removed.length}  ${text.length > 80 ? text.slice(0, 80) + "..." : text}`);
    }
  }
  return out.join("\n");
}

export function selectChanges({ patch, oldContents, contains }) {
  const oldLines = oldContents.split("\n");
  const changes = parseChanges(patch);

  const matches = (change) =>
    [...change.removed, ...change.added].some((l) => contains.some((needle) => l.includes(needle)));
  if (!changes.some(matches)) {
    throw new Error(`No change contains ${contains.map((c) => JSON.stringify(c)).join(" or ")}`);
  }

  const out = [];
  let pos = 0;
  for (const change of changes) {
    out.push(...oldLines.slice(pos, change.at));
    out.push(...(matches(change) ? change.removed : change.added));
    pos = change.at + change.removed.length;
  }
  out.push(...oldLines.slice(pos));
  return out.join("\n");
}

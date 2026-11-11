// Git collection.
//
// Takes a validated diff source and returns raw per-file data.
// No external dependencies — only node built-ins.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { selectChanges } from "./select-changes.mjs";

const execAsync = promisify(execFile);

// Stable options used for every git diff call. Recorded in one place so all
// call sites produce identical output.
export const GIT_DIFF_OPTIONS = Object.freeze([
  "--unified=3",
  "--find-renames",
  "--no-ext-diff",
  "--no-textconv",
]);

export const DEFAULT_LIMITS = {
  maxFileBytes: 1_000_000,
  maxTotalBytes: 10_000_000,
  maxFiles: 100,
};

// ---------------------------------------------------------------------------
// Internal git runner
// ---------------------------------------------------------------------------

async function git(args, cwd) {
  try {
    const { stdout } = await execAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    // git diff --no-index exits 1 when differences are found; that is success.
    if (err.code === 1 && args.includes("--no-index")) {
      return err.stdout ?? "";
    }
    const detail = (err.stderr ?? "").trim() || err.message;
    throw new Error(`git ${args[0]}: ${detail}`);
  }
}

// ---------------------------------------------------------------------------
// Repo root and ref validation
// ---------------------------------------------------------------------------

export async function getRepoRoot(cwd = process.cwd()) {
  try {
    return (await git(["rev-parse", "--show-toplevel"], cwd)).trim();
  } catch {
    throw new Error("Not inside a Git worktree");
  }
}

async function validateRef(ref, repoRoot) {
  try {
    await git(["rev-parse", "--verify", `${ref}^{commit}`], repoRoot);
  } catch {
    throw new Error(`Invalid Git ref: ${ref}`);
  }
}

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

async function validatePaths(paths, repoRoot) {
  const prefix = repoRoot + "/";
  for (const p of paths) {
    const abs = resolve(repoRoot, p);
    let real = abs;
    try {
      real = await realpath(abs);
    } catch {
      // Path may not exist yet (new file). Check the resolved form only.
    }
    if (real !== repoRoot && !real.startsWith(prefix)) {
      throw new Error(`Path resolves outside repository root: ${p}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Patch splitting and header parsing
// ---------------------------------------------------------------------------

function readGitPathToken({ input, start = 0 }) {
  if (input[start] !== '"') {
    const end = input.indexOf(" ", start);
    const value = end === -1 ? input.slice(start) : input.slice(start, end);
    return { value, end: end === -1 ? input.length : end };
  }

  let value = "";
  let i = start + 1;
  while (i < input.length) {
    const ch = input[i];
    if (ch === '"') return { value, end: i + 1 };
    if (ch !== "\\") {
      value += ch;
      i++;
      continue;
    }

    const next = input[i + 1];
    if (next === "t") value += "\t";
    else if (next === "n") value += "\n";
    else if (next === "r") value += "\r";
    else if (next === "b") value += "\b";
    else if (next === "\\" || next === '"') value += next;
    else if (/[0-7]/.test(next ?? "")) {
      const octal = input.slice(i + 1).match(/^[0-7]{1,3}/)?.[0] ?? "";
      value += String.fromCharCode(Number.parseInt(octal, 8));
      i += octal.length - 1;
    } else {
      value += next ?? "";
    }
    i += 2;
  }
  return { value, end: input.length };
}

function stripGitPrefix({ path }) {
  return path.startsWith("a/") || path.startsWith("b/") ? path.slice(2) : path;
}

function parsePrefixedPath({ line, marker }) {
  if (!line.startsWith(marker)) return null;
  const rest = line.slice(marker.length);
  if (rest.startsWith('"')) {
    return stripGitPrefix({ path: readGitPathToken({ input: line, start: marker.length }).value });
  }
  return stripGitPrefix({ path: rest.split("\t")[0] });
}

// Parse "diff --git a/<p> b/<p>", including Git's C-quoted path form.
function parseGitDiffHeader(line) {
  const PRE = "diff --git ";
  if (!line.startsWith(PRE)) return null;
  const rest = line.slice(PRE.length);
  if (rest.startsWith("a/")) {
    let pos = rest.lastIndexOf(" b/");
    while (pos >= 0) {
      const a = rest.slice(2, pos);
      const b = rest.slice(pos + 3);
      if (a === b) return { oldPath: a, newPath: b };
      pos = rest.lastIndexOf(" b/", pos - 1);
    }
    const first = rest.indexOf(" b/");
    if (first >= 0) return { oldPath: rest.slice(2, first), newPath: rest.slice(first + 3) };
  }
  const oldToken = readGitPathToken({ input: line, start: PRE.length });
  const nextStart = oldToken.end + (line[oldToken.end] === " " ? 1 : 0);
  const newToken = readGitPathToken({ input: line, start: nextStart });
  return {
    oldPath: stripGitPrefix({ path: oldToken.value }),
    newPath: stripGitPrefix({ path: newToken.value }),
  };
}

function splitIntoPatchChunks(output) {
  if (!output.trim()) return [];
  return output.split(/^(?=diff --git )/m).filter(Boolean);
}

// Parse a single file's diff chunk into a RawFile.
function parseChunk(chunk) {
  const lines = chunk.split("\n");
  const headerPaths = parseGitDiffHeader(lines[0] ?? "");

  let status = "modified";
  let newPath = null;
  let oldPath = null;
  let kind = "text";

  for (const line of lines.slice(1)) {
    if (line.startsWith("new file mode ")) {
      status = "added";
      if (line.slice("new file mode ".length).trim() === "120000") kind = "symlink";
    } else if (line.startsWith("deleted file mode ")) {
      status = "deleted";
      if (line.slice("deleted file mode ".length).trim() === "120000") kind = "symlink";
    } else if (line.startsWith("old mode ") && line.slice("old mode ".length).trim() === "120000") {
      kind = "symlink";
    } else if (line.startsWith("new mode ") && line.slice("new mode ".length).trim() === "120000") {
      kind = "symlink";
    } else if (line.startsWith("rename from ")) {
      oldPath = readGitPathToken({ input: line, start: "rename from ".length }).value;
      status = "renamed";
    } else if (line.startsWith("rename to ")) {
      newPath = readGitPathToken({ input: line, start: "rename to ".length }).value;
    } else if (line.startsWith("Binary files ")) {
      kind = "binary";
    } else if (line.startsWith("+++ ")) {
      if (newPath === null) newPath = parsePrefixedPath({ line, marker: "+++ " });
    } else if (line.startsWith("--- ") && status === "deleted" && newPath === null) {
      newPath = parsePrefixedPath({ line, marker: "--- " });
    }
  }

  if (newPath === null) {
    newPath = status === "deleted" ? headerPaths?.oldPath : headerPaths?.newPath;
  }

  const result = { path: newPath ?? "", status, kind };
  if (oldPath !== null) result.oldPath = oldPath;
  // Only text files carry patch content; binary, symlink and unsupported are
  // metadata-only so the browser never receives raw file contents.
  if (kind === "text") result.patch = chunk;
  return result;
}

// ---------------------------------------------------------------------------
// Tracked file diff
// ---------------------------------------------------------------------------

async function runTrackedDiff(source, repoRoot) {
  const paths = source.paths ?? [];
  const pathArgs = paths.length > 0 ? ["--", ...paths] : [];

  let args;
  switch (source.mode) {
    case "unstaged":
      args = ["diff", ...GIT_DIFF_OPTIONS, ...pathArgs];
      break;
    case "staged":
      args = ["diff", "--cached", ...GIT_DIFF_OPTIONS, ...pathArgs];
      break;
    case "dirty-tree":
      args = ["diff", "HEAD", ...GIT_DIFF_OPTIONS, ...pathArgs];
      break;
    case "merge-base-range":
      // Three-dot syntax: diff from merge base of base and head to head.
      args = ["diff", `${source.base}...${source.head}`, ...GIT_DIFF_OPTIONS, ...pathArgs];
      break;
    default:
      throw new Error(`Unknown source mode: ${source.mode}`);
  }

  const output = await git(args, repoRoot);
  return splitIntoPatchChunks(output).map(parseChunk);
}

// ---------------------------------------------------------------------------
// Untracked file collection
// ---------------------------------------------------------------------------

async function listUntrackedPaths(paths, repoRoot) {
  const args = ["ls-files", "--others", "--exclude-standard"];
  if (paths && paths.length > 0) args.push("--", ...paths);
  try {
    const out = await git(args, repoRoot);
    return out.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function collectUntrackedFile(relPath, repoRoot) {
  const absPath = resolve(repoRoot, relPath);
  const prefix = repoRoot + "/";

  let lstats;
  try {
    lstats = await lstat(absPath);
  } catch {
    return null; // vanished between ls-files and now
  }

  // Verify the resolved path is inside the repo root.
  let real = absPath;
  try {
    real = await realpath(absPath);
  } catch {
    // Non-existent path — lstat succeeded so this shouldn't happen.
  }
  if (real !== repoRoot && !real.startsWith(prefix)) return null;

  if (lstats.isSymbolicLink()) {
    return { path: relPath, status: "added", kind: "symlink" };
  }
  if (!lstats.isFile()) {
    return { path: relPath, status: "added", kind: "unsupported" };
  }
  if (lstats.size === 0) {
    return { path: relPath, status: "added", kind: "text", size: 0 };
  }

  // The relative path keeps the machine's folders out of the patch header,
  // which the review page shows. After "--" a leading dash is safe.
  const out = await git(
    ["diff", "--no-index", ...GIT_DIFF_OPTIONS, "--", "/dev/null", relPath],
    repoRoot
  );

  const chunks = splitIntoPatchChunks(out);
  if (!chunks.length) {
    return { path: relPath, status: "added", kind: "text", size: lstats.size };
  }

  const parsed = parseChunk(chunks[0]);
  const result = { path: relPath, status: "added", kind: parsed.kind, size: lstats.size };
  if (parsed.kind === "text") result.patch = parsed.patch;
  return result;
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

function checkLimits(files, limits) {
  if (files.length > limits.maxFiles) {
    throw new Error(
      `File count ${files.length} exceeds limit of ${limits.maxFiles}. Narrow the paths field.`
    );
  }
  let totalBytes = 0;
  for (const file of files) {
    if (file.kind !== "text" || !file.patch) continue;
    const bytes = Buffer.byteLength(file.patch, "utf8");
    if (bytes > limits.maxFileBytes) {
      throw new Error(
        `'${file.path}' patch (${bytes} bytes) exceeds per-file limit of ${limits.maxFileBytes}. Narrow the paths field.`
      );
    }
    totalBytes += bytes;
    if (totalBytes > limits.maxTotalBytes) {
      throw new Error(
        `Total patch size exceeds limit of ${limits.maxTotalBytes}. Narrow the paths field.`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Collect a diff from the local Git repository.
 *
 * @param {{ source: object, limits?: object, cwd?: string }} options
 *   source   — validated DiffSource from diffSourceSchema
 *   limits   — optional overrides for DEFAULT_LIMITS
 *   cwd      — working directory; defaults to process.cwd()
 *
 * @returns {Promise<{ files: object[], repoRoot: string }>}
 *   files    — RawFile array (text files include patch string, others are
 *              metadata only)
 *   repoRoot — absolute path to the repository root
 */
export async function collectDiff({ source, limits = DEFAULT_LIMITS, cwd = process.cwd() }) {
  const repoRoot = await getRepoRoot(cwd);

  if (source.paths?.length) {
    await validatePaths(source.paths, repoRoot);
  }

  if (source.mode === "merge-base-range") {
    await validateRef(source.base, repoRoot);
    await validateRef(source.head, repoRoot);
  }

  const files = await runTrackedDiff(source, repoRoot);

  if (source.mode === "unstaged" || source.mode === "dirty-tree") {
    const untrackedPaths = await listUntrackedPaths(source.paths, repoRoot);
    for (const relPath of untrackedPaths) {
      const file = await collectUntrackedFile(relPath, repoRoot);
      if (file) files.push(file);
    }
  }

  checkLimits(files, limits);

  return { files, repoRoot };
}

/**
 * A whole change with the full old and new contents of its text files, so the
 * browser can expand the context around each change. Mirrors the sides
 * `git diff` compares for each source mode.
 *
 * @param {{ source: object, limits?: object, cwd?: string }} options
 * @returns {Promise<object[]>} the files of collectDiff. A text file also has
 *   oldContents and newContents, unless it is over the limits: then it only
 *   has its patch.
 */
export async function collectChange({ source, limits = DEFAULT_LIMITS, cwd = process.cwd() }) {
  const { files, repoRoot } = await collectDiff({ source, limits, cwd });

  // Which revision holds each side. "" is the index, "worktree" is the disk.
  const sides = {
    unstaged: { old: "", new: "worktree" },
    staged: { old: "HEAD", new: "" },
    "dirty-tree": { old: "HEAD", new: "worktree" },
    "merge-base-range": {
      old: source.mode === "merge-base-range" ? (await git(["merge-base", source.base, source.head], repoRoot)).trim() : "",
      new: source.mode === "merge-base-range" ? source.head : ""
    }
  }[source.mode];

  // One side of a file, or null when it is over the per-file limit.
  const read = async (rev, p) => {
    if (rev === "worktree") {
      const abs = resolve(repoRoot, p);
      return (await lstat(abs)).size > limits.maxFileBytes ? null : readFile(abs, "utf8");
    }
    const out = await git(["show", `${rev}:${p}`], repoRoot);
    return out.length > limits.maxFileBytes ? null : out;
  };

  let total = 0;
  for (const file of files) {
    if (file.kind !== "text") continue;
    const oldContents = file.status === "added" ? "" : await read(sides.old, file.oldPath ?? file.path);
    const newContents = file.status === "deleted" ? "" : await read(sides.new, file.path);
    if (oldContents === null || newContents === null) continue;
    if (total + oldContents.length + newContents.length > limits.maxTotalBytes) continue;
    total += oldContents.length + newContents.length;
    file.oldContents = oldContents;
    file.newContents = newContents;
  }
  return files;
}

/**
 * Old and new full contents of one changed text file.
 *
 * @param {{ source: object, path: string, oldPath?: string, contains?: string[], limits?: object, cwd?: string }} options
 *   contains — keep only the changes whose lines include one of these strings;
 *   the other changes come back already applied on the old side.
 *   oldPath — pass the previous name of a renamed file. git only pairs a rename
 *   when both names are in the pathspec.
 * @returns {Promise<{ oldContents: string, newContents: string }>}
 */
export async function collectFileContents({ source, path, oldPath, contains, limits = DEFAULT_LIMITS, cwd = process.cwd() }) {
  const paths = oldPath ? [path, oldPath] : [path];
  const file = (await collectChange({ source: { ...source, paths }, limits, cwd })).find((f) => f.path === path);
  if (!file) throw new Error(`No changes to ${path} for source mode ${source.mode}`);
  if (file.kind !== "text") throw new Error(`${path} is not a text file`);
  if (file.oldContents === undefined) throw new Error(`${path} exceeds ${limits.maxFileBytes} bytes`);
  return {
    oldContents: contains?.length ? selectChanges({ patch: file.patch, oldContents: file.oldContents, contains }) : file.oldContents,
    newContents: file.newContents
  };
}

#!/usr/bin/env node
// Lists the changes in a git diff, one compact line each, so you can pick a
// `contains` snippet for a Diff card without reading whole diffs.
//
//   node changes.mjs [dirty-tree|staged|unstaged] [-- paths...]
//   node changes.mjs range <base> <head> [-- paths...]
//
// Read-only. Prints text to stdout.

import { collectDiff } from "./git-collect.mjs";
import { diffSourceSchema } from "../dist/catalog.mjs";
import { formatChanges } from "./select-changes.mjs";

const args = process.argv.slice(2);
const dashes = args.indexOf("--");
const positional = dashes === -1 ? args : args.slice(0, dashes);
const paths = dashes === -1 ? [] : args.slice(dashes + 1);
const [mode = "dirty-tree", base, head] = positional;

const source = diffSourceSchema.safeParse(
  mode === "range"
    ? { mode: "merge-base-range", base, head, ...(paths.length ? { paths } : {}) }
    : { mode, ...(paths.length ? { paths } : {}) }
);
if (!source.success) {
  process.stderr.write(`yourturn: bad arguments. Usage: changes.mjs [dirty-tree|staged|unstaged] | range <base> <head> [-- paths...]\n`);
  process.exit(1);
}

try {
  const { files } = await collectDiff({ source: source.data });
  process.stdout.write((files.length ? formatChanges({ files }) : "No changes.") + "\n");
} catch (err) {
  process.stderr.write(`yourturn: ${err.message}\n`);
  process.exit(1);
}

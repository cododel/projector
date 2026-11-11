#!/usr/bin/env node
// Writes a spec to disk as an artifact that open.mjs can show.
//
//   cat spec.json | node create.mjs [--target local|remote] [--code-ok]
//   # prints {"id":"...","path":"...","target":"...","confirm"?:true}
//
// Stdin is { id?, title, spec }. The spec is a Page with Section children, see
// references/authoring.md. Without an id one is made from the date and the
// title, with a number added when that is taken.
//
// The artifact lands in .agents/artifacts/local/<id>/ or in
// .agents/artifacts/remote/<id>/ under the project root, which is the git top
// level, or the current directory outside a repo. The target comes from
// config.json unless the option says otherwise. A project with no config.json
// is not set up and gets no page, see references/setup.md. remote/ is the
// only folder a deploy uploads, so a page in local/ never leaves the machine.
// A page that holds source code from git is only written to remote/ with
// --code-ok, which says the user was asked. In local/ it prints "confirm":
// ask the user before it is ever moved to remote/.
//
// The folder is a static site of its own: the spec in entry.json, a copy of
// the viewer and of the project's components in _core/, and index.html with
// the import map the libraries load through and a content security policy
// that lets the page talk to the hosts of that map and to nobody else. Files
// the page shows go into the assets/ folder next to entry.json.
//
// Exit codes: 0 written, 1 bad input (see stderr).

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { catalog, resolveElementProps, validateSpec, z } from "../dist/catalog.mjs";
import { collectChange, collectFileContents } from "./git-collect.mjs";

function fail(msg) {
  process.stderr.write(`yourturn: ${msg}\n`);
  process.exit(1);
}

const inputSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "use lowercase letters, digits and dashes").optional(),
  title: z.string().trim().min(1),
  spec: z.looseObject({
    root: z.string(),
    elements: z.record(z.string(), z.looseObject({ type: z.string(), props: z.looseObject({}) }))
  })
});

const usage = "usage: node create.mjs [--target local|remote] [--code-ok] < spec.json";
let args;
try {
  args = parseArgs({ options: { target: { type: "string" }, "code-ok": { type: "boolean" } } });
} catch (err) {
  fail(`${err.message}\n${usage}`);
}
if (process.stdin.isTTY) fail(`no spec given: pipe { id?, title, spec } to stdin\n${usage}`);
let raw;
try {
  raw = JSON.parse(readFileSync(0, "utf8"));
} catch (err) {
  fail(`could not parse stdin as JSON: ${err.message}`);
}
if (raw?.type === "diff") {
  fail("a diff review is a page now: put a Diff with a source and no path in a Section, see references/review.md");
}
const input = inputSchema.safeParse(raw);
if (!input.success) fail(`invalid input, expected { id?, title, spec }:\n${z.prettifyError(input.error)}`);
const { title, spec } = input.data;

const { valid, issues } = validateSpec(spec);
if (!valid) fail(`invalid spec:\n${issues.map((i) => `- ${i.message}`).join("\n")}`);

const root = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).stdout?.trim() || process.cwd();
const artifacts = join(root, ".agents", "artifacts");

// The config is written once, from the user's answers. Without it nobody
// asked them where pages go, so nothing is written.
const configPath = join(artifacts, "config.json");
if (!existsSync(configPath)) {
  fail(
    `no ${configPath}, so this project is not set up yet. Read references/setup.md, ask the user and write the ` +
      "config. Then run this again."
  );
}
const config = z
  .looseObject({ target: z.enum(["local", "remote"]).optional(), imports: z.record(z.string(), z.string()).optional() })
  .safeParse(JSON.parse(readFileSync(configPath, "utf8")));
if (!config.success) fail(`invalid ${configPath}:\n${z.prettifyError(config.error)}`);
const target = args.values.target ?? config.data.target ?? "local";
if (target !== "local" && target !== "remote") fail(`unknown target '${target}'\n${usage}`);
const localPath = join(artifacts, "config.local.json");
const local = z
  .object({ confirmCode: z.boolean().optional() })
  .parse(existsSync(localPath) ? JSON.parse(readFileSync(localPath, "utf8")) : {});

// The project's own components, see references/components.md. Every .js file
// at the top of the folder is one and its file name is the type.
const componentsPath = join(artifacts, "components");
const projectComponents = existsSync(componentsPath)
  ? readdirSync(componentsPath, { withFileTypes: true })
      .filter((file) => file.isFile() && file.name.endsWith(".js"))
      .map((file) => file.name.slice(0, -".js".length))
  : [];
const replaced = projectComponents.filter((name) => catalog.data.components[name]);
if (replaced.length) process.stderr.write(`yourturn: project components replace the built-in ${replaced.join(", ")}\n`);

// The page can only load what its import map names. A package a component
// imports with no entry there would show up as an error card in the browser,
// so it fails here. Helpers in subfolders are checked too.
const dist = fileURLToPath(new URL("../dist", import.meta.url));
const template = readFileSync(join(dist, "index.html"), "utf8");
const imports = { ...JSON.parse(template.match(/<script type="importmap">([^]*?)<\/script>/)[1]).imports, ...config.data.imports };
if (target === "local" && Object.values(imports).some((address) => !/^\.\.?\/(?![\\/])/.test(address) || address.includes("\\"))) {
  fail("local artifacts require relative import-map paths");
}
const unmapped = projectComponents.length
  ? readdirSync(componentsPath, { recursive: true })
      .filter((file) => file.endsWith(".js"))
      .flatMap((file) =>
        Array.from(
          readFileSync(join(componentsPath, file), "utf8").matchAll(
            /^\s*(?:import\s*|import\s[^;'"]*?\bfrom\s*|export\s*[*{][^;'"]*?\bfrom\s*)["']([^"']+)["']/gm
          ),
          ([, name]) => ({ file, name })
        )
      )
      // A name of the map, a name under a map entry that ends with a slash, or a relative file.
      .filter(({ name }) => !/^\.{0,2}\//.test(name) && !Object.keys(imports).some((key) => key === name || (key.endsWith("/") && name.startsWith(key))))
  : [];
if (unmapped.length) {
  fail(
    `the project's components import what the page cannot load:\n${unmapped.map(({ file, name }) => `- ${file}: '${name}'`).join("\n")}\n` +
      `Add each one to "imports" in ${configPath}, see "Rules for the file" in references/components.md`
  );
}

// The spec rules: a Page at the root, Sections under it, blocks under those.
const page = spec.elements[spec.root];
if (page.type !== "Page") {
  fail(
    `the root element must be a Page whose children are Section elements, got '${page.type}'. ` +
      "The page adds the submit button itself. See references/authoring.md"
  );
}
const problems = [];
for (const [id, el] of Object.entries(spec.elements)) {
  const component = catalog.data.components[el.type];
  if (!component && !projectComponents.includes(el.type)) {
    const known = projectComponents.length ? `, the project has ${projectComponents.join(", ")}` : "";
    problems.push(`${id}: unknown component '${el.type}'${known}`);
    continue;
  }
  const inPage = page.children?.includes(id) ?? false;
  if (el.type === "Page" && id !== spec.root) problems.push(`${id}: a Page is only allowed as the root`);
  if (inPage && el.type !== "Section") problems.push(`${id}: a child of the Page must be a Section, not ${el.type}`);
  if (!inPage && el.type === "Section") problems.push(`${id}: a Section must be a child of the Page`);
  // The props of a project component are checked by the page, its file only runs in a browser.
  if (projectComponents.includes(el.type)) continue;
  // Props are checked the way the page sees them, with values bound to state filled in.
  const props = component.props.strict().safeParse(resolveElementProps(el.props, { stateModel: spec.state ?? {} }));
  for (const issue of props.error?.issues ?? []) {
    problems.push(`${id} (${el.type}): ${[...issue.path, issue.message].join(": ")}`);
  }
  if (el.type !== "Diff") continue;
  const { path, source, content, contains, oldPath, comments = [] } = el.props;
  if (!source === !content) problems.push(`${id} (Diff): give either content or source`);
  // With no path a Diff is the whole change of its source.
  if (!path && (content || contains || oldPath)) problems.push(`${id} (Diff): content, contains and oldPath need a path`);
  if (!path && comments.some((c) => !c.path)) {
    problems.push(`${id} (Diff): with no path every comment needs the path of its file`);
  }
}
if (problems.length) fail(`invalid spec:\n${problems.map((p) => `- ${p}`).join("\n")}`);

// A page with a diff read from git holds whole source files, and remote/ is
// what a deploy uploads. So this stops here until the user was asked, unless
// they said not to be asked again.
const code = Object.values(spec.elements).some((el) => el.type === "Diff" && el.props.source);
const confirm = code && local.confirmCode !== false;
if (confirm && target === "remote" && !args.values["code-ok"]) {
  fail(
    "this page holds source code from this repo and a page in remote/ is deployed. Nothing was written. " +
      'Ask the user first: "This page holds source code from this repo. Deploying uploads it to <address>. ' +
      'Deploy it, or keep it local?" Then run this again with --code-ok when they said to deploy it, or with ' +
      "--target local when they keep it local. Never add --code-ok on your own."
  );
}

// Diff cards with a `source` get the full old and new file contents, so the
// browser can expand context and a replay never reads git.
for (const [id, el] of Object.entries(spec.elements)) {
  if (el.type !== "Diff" || !el.props.source) continue;
  const { source, path, oldPath, contains, comments = [] } = el.props;
  if (path) {
    const { oldContents, newContents } = await collectFileContents({
      source,
      path,
      oldPath,
      contains: [contains ?? []].flat()
    }).catch((err) => fail(err.message));
    el.props.oldFile = { name: path, contents: oldContents };
    el.props.newFile = { name: path, contents: newContents };
  } else {
    // The whole change: one card per file.
    const files = await collectChange({ source }).catch((err) => fail(err.message));
    if (!files.length) fail(`${id}: no changes for source mode ${source.mode}`);
    const stray = comments.find((c) => !files.some((f) => f.path === c.path));
    if (stray) fail(`${id}: a comment is on '${stray.path}', which is not a changed file`);
    el.props.files = [];
    el.props.skipped = [];
    for (const f of files) {
      if (f.kind !== "text") el.props.skipped.push(`${f.path} (${f.kind})`);
      // Too large to carry whole, so the card shows its patch and no more context.
      else if (f.oldContents === undefined) el.props.files.push({ path: f.path, content: f.patch });
      else if (f.oldContents === f.newContents) {
        el.props.skipped.push(`${f.path} (${f.oldPath ? `renamed from ${f.oldPath}` : "no line changes"})`);
      } else {
        el.props.files.push({
          path: f.path,
          oldFile: { name: f.oldPath ?? f.path, contents: f.oldContents },
          newFile: { name: f.path, contents: f.newContents }
        });
      }
    }
  }
  delete el.props.source;
  delete el.props.contains;
}

const createdAt = new Date().toISOString();
// An apostrophe goes without a trace, so "last week's" reads last-weeks.
const slug = title.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
const base = input.data.id ?? [createdAt.slice(0, 10), slug].filter(Boolean).join("-");

// remote/ is the only folder a deploy uploads. A page in local/ stays on the machine.
const home = join(artifacts, target);
const other = join(artifacts, target === "local" ? "remote" : "local");
mkdirSync(home, { recursive: true });

// Making the folder is what claims the id, so two runs at once never share one.
// An id names one page, whichever of the two folders it is in. A made-up id
// that is taken gets -2, -3 and so on. A given id is never changed.
let id = base;
for (let n = 2; ; n++) {
  try {
    if (!existsSync(join(other, id))) {
      mkdirSync(join(home, id));
      break;
    }
  } catch (err) {
    if (err.code !== "EEXIST") fail(err.message);
  }
  if (input.data.id) fail(`artifact '${id}' already exists, pass another "id"`);
  id = `${base}-${n}`;
}
const path = join(home, id);
writeFileSync(join(path, "entry.json"), JSON.stringify({ version: 1, id, title, createdAt, spec }));

// The artifact keeps its own copy of the viewer and the components, so it
// opens from any static host and looks the same after either changes.
cpSync(join(dist, "_core"), join(path, "_core"), { recursive: true });
if (projectComponents.length) cpSync(componentsPath, join(path, "_core", "components"), { recursive: true });
// JSON inside a script tag must not hold a closing tag.
function inline(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}
// The page may load code from the hosts of the import map and from its own
// folder, and send a form to the agent on loopback. Nothing else: a library
// that turns bad cannot hand the page to another host. The import map is an
// inline script, so the policy names it by its hash. The diff view compiles
// wasm and the libraries put styles into the page.
const importMap = inline({ imports });
const hosts = target === "remote"
  ? [...new Set(Object.values(imports).filter((address) => /^https?:/.test(address)).map((address) => new URL(address).origin))].join(" ")
  : "";
const policy = [
  "default-src 'none'",
  `script-src 'self' 'wasm-unsafe-eval' 'sha256-${createHash("sha256").update(importMap).digest("base64")}' ${hosts}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self' ${hosts}`,
  "worker-src 'self' blob:",
  "form-action http://127.0.0.1:*",
  "base-uri 'none'"
].join("; ");
writeFileSync(
  join(path, "index.html"),
  template
    .replace(/(<meta http-equiv="Content-Security-Policy" content=")[^"]*/, (_, open) => open + policy)
    .replace(/(<script type="importmap">)[^]*?(<\/script>)/, (_, open, close) => open + importMap + close)
    .replace(/(<script type="application\/json" id="components">)[^]*?(<\/script>)/, (_, open, close) => open + inline(projectComponents) + close)
);
// In local/ the page still says that it holds code, for the day it is moved.
process.stdout.write(JSON.stringify({ id, path, target, ...(confirm && target === "local" ? { confirm } : {}) }) + "\n");

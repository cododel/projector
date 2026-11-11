#!/usr/bin/env node
// Opens an artifact in the browser, waits for the answer, saves and prints it.
//
//   node open.mjs <id> [--target local|remote] [--url <base>] [--no-open]
//
// The folder an artifact is in says how it opens. One in
// .agents/artifacts/local/ is served from here. One in .agents/artifacts/remote/
// is opened from the deployed site at <base>/<id>/ and this script only waits
// for the answer. <base> is "url" in .agents/artifacts/config.json or --url.
// With --target local a remote artifact is served from here too. A local one
// never opens remote: remote/ is the only folder a deploy uploads.
//
// This is a one-shot loopback server. The page is opened at
// <base>/<id>/#port=<port>&s=<token> and posts the urlencoded fields `s` and
// `answer` to /answer. The token proves the answer came from the page this
// process opened.
//
// The answer is saved to .agents/artifacts/answers/<id>/<answer id>.json and
// printed to STDOUT as one JSON line. Diagnostics go to STDERR. The line can
// carry "notices", sentences for the user that are made here: a newer version
// and a donation note. "notices": false in config.json turns both off.
//
// Exit codes: 0 submitted, 1 error, 2 timed out.

import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "../dist/catalog.mjs";

const MAX_BODY_BYTES = 20_000_000; // fits 3.5MB of screenshots after urlencoding
const waitSec = Number(process.env.YOURTURN_TIMEOUT ?? 3600);
// SKILL.md on main says which version is the newest: main is what an update delivers.
const VERSION_URL =
  process.env.YOURTURN_VERSION_URL ?? "https://raw.githubusercontent.com/giuseppeg/skills/main/skills/yourturn/SKILL.md";
// Digits and dots only: the version ends up in a sentence an agent reads.
const VERSION = /^version:\s*(\d+\.\d+\.\d+)\s*$/m;
const DONATION_URL = "https://github.com/sponsors/giuseppeg";
const DAY = 86_400_000;
// A deployed page hands the answer over with a form POST, so the tab ends up on this page.
const SENT =
  '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">' +
  '<meta name="color-scheme" content="light dark"><title>Sent</title>' +
  '<body style="font-family: system-ui, sans-serif; text-align: center; padding-top: 20vh">Sent. You can close this tab.';
const TYPES = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml"
};

function logErr(msg) {
  process.stderr.write(`yourturn: ${msg}\n`);
}

function fail(msg) {
  logErr(msg);
  process.exit(1);
}

// On macOS, find the default browser's .app path so we can target it by name.
function macBrowser() {
  try {
    const js =
      'ObjC.import("AppKit");' +
      '$.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL(' +
      '$.NSURL.URLWithString("https://example.com")).path.js';
    return execFileSync("osascript", ["-l", "JavaScript", "-e", js], { encoding: "utf8" }).trim();
  } catch {
    // osascript missing or blocked — fall back to plain open.
    return "";
  }
}

function spawnDetached(cmd, cmdArgs, onErr) {
  const child = spawn(cmd, cmdArgs, { stdio: "ignore", detached: true });
  child.on("error", onErr);
  child.unref();
}

// Open the app URL. Chromium browsers on macOS get a new window so the page
// lands in front instead of hiding among tabs. Everything else opens a tab.
function openBrowser(url) {
  const onErr = () => logErr(`could not open browser, visit ${url}`);
  if (process.platform === "darwin") {
    const app = macBrowser();
    const chromium = /(Chrome|Chromium|Brave Browser|Microsoft Edge|Vivaldi)[^/]*\.app$/.test(app);
    // -n starts a second process that hands the flag to the running browser and exits.
    spawnDetached("open", chromium ? ["-na", app, "--args", "--new-window", url] : app ? ["-a", app, url] : [url], onErr);
    // The handoff opens the window without activating the browser.
    if (chromium) spawnDetached("open", ["-a", app], () => {});
    return;
  }
  // cmd reads a bare & as a command separator.
  if (process.platform === "win32") spawnDetached("cmd", ["/c", "start", "", url.replaceAll("&", "^&")], onErr);
  else spawnDetached("xdg-open", [url], onErr);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("body too large"));
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sha256(text) {
  return createHash("sha256").update(text).digest();
}

const usage = "usage: node open.mjs <id> [--target local|remote] [--url <base>] [--no-open]";
let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: { target: { type: "string" }, url: { type: "string" }, "no-open": { type: "boolean" } }
  });
} catch (err) {
  fail(`${err.message}\n${usage}`);
}
const [id] = args.positionals;
if (!id || !/^[a-z0-9][a-z0-9-]*$/.test(id)) fail(usage);

const root = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).stdout?.trim() || process.cwd();
const artifacts = join(root, ".agents", "artifacts");
const home = ["local", "remote"].find((folder) => existsSync(join(artifacts, folder, id, "entry.json")));
if (!home) {
  // Before the two folders there was one, site/.
  if (existsSync(join(artifacts, "site", id))) fail(`artifact '${id}' was made by an older yourturn, create it again`);
  fail(`artifact '${id}' not found in ${join(artifacts, "local")} or ${join(artifacts, "remote")}, run create.mjs first`);
}
const site = join(artifacts, home, id);
const entryPath = join(site, "entry.json");

// Everything that can fail is done before the wait, so an answer is never lost.
const configPath = join(artifacts, "config.json");
const config = z
  .looseObject({ url: z.string().optional(), public: z.boolean().optional(), notices: z.boolean().optional() })
  .safeParse(existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {});
if (!config.success) fail(`invalid ${configPath}:\n${z.prettifyError(config.error)}`);
const target = args.values.target ?? home;
if (target !== "local" && target !== "remote") fail(`unknown target '${target}'\n${usage}`);
if (target === "remote" && home === "local") {
  fail(
    `artifact '${id}' is in local/, which is never deployed. To publish it move its folder to ` +
      `${join(artifacts, "remote")} and deploy, see "Workflow" in SKILL.md`
  );
}
const url = args.values.url ?? config.data.url;
if (args.values.url && target === "local") fail("--url is for an artifact in remote/ that opens from its site");
if (target === "remote" && !/^https?:\/\/\S+$/.test(url ?? "")) {
  fail(`a remote artifact needs the address of the deployed site, set "url" in ${configPath} or pass --url`);
}
const localPath = join(artifacts, "config.local.json");
// Loose, because this file is written back with the times of the notices.
const local = z
  .looseObject({ author: z.string().optional(), updateCheckedAt: z.string().optional(), donationDueAt: z.string().optional() })
  .parse(existsSync(localPath) ? JSON.parse(readFileSync(localPath, "utf8")) : {});
const skill = fileURLToPath(new URL("../", import.meta.url));
const version = VERSION.exec(readFileSync(join(skill, "SKILL.md"), "utf8"))?.[1];
const author =
  local.author || spawnSync("git", ["config", "user.name"], { encoding: "utf8" }).stdout?.trim() || "anonymous";
mkdirSync(join(artifacts, "answers", id), { recursive: true });

// Nobody here can tell whether a deploy happened. A site behind a login
// answers this script with the login, so the browser is the only one to know.
// A deployed page is served by its host, so for that one this only waits.
const base = target === "remote" ? url.replace(/\/+$/, "") : null;
const path = `/${id}/`;
const html = readFileSync(join(site, "index.html"));
const entry = readFileSync(entryPath);

// What it can tell is the opposite: this script has no login, so a site that
// hands it the page hands it to anyone. That has to be the user's choice,
// said with "public": true in the config. It only sees the address it opens,
// another address of the same site can still be public.
if (base && config.data.public !== true) {
  const open = await fetch(`${base}${path}entry.json`, { signal: AbortSignal.timeout(3000) })
    .then(async (res) => res.ok && (await res.json()).id === id)
    .catch(() => false);
  if (open) {
    fail(
      `${base}${path} is public: it gave out the page with no login. Tell the user now. If they did not mean that, ` +
        `take the page down: delete ${site} and deploy again. If the site is meant to be public, put "public": true ` +
        `into ${configPath} and run this again.`
    );
  }
}

const token = randomBytes(32).toString("base64url");
let port = 0;
let done;
const answered = new Promise((resolve) => (done = resolve));

const server = createServer(async (req, res) => {
  const route = (req.url ?? "/").split("?")[0];
  const send = (status, type, body) => {
    res.writeHead(status, { "content-type": type });
    res.end(body);
  };

  // Reject any request not addressed to our loopback host. This defeats DNS
  // rebinding: a rebound attacker page reaches us with its own Host header, not
  // 127.0.0.1:PORT, so it never reads the page or posts an answer.
  if (req.headers.host !== `127.0.0.1:${port}`) return send(421, "text/plain", "misdirected request");

  if (req.method === "POST" && route === "/answer") {
    // Any web page can post a form here, so the token is the gate. There is no
    // Origin check: a deployed page posts from another origin.
    let body;
    try {
      body = new URLSearchParams(await readBody(req));
    } catch (err) {
      return send(400, "text/plain", String(err));
    }
    // Hashing gives equal-length buffers for the constant-time compare.
    if (!timingSafeEqual(sha256(body.get("s") ?? ""), sha256(token))) return send(403, "text/plain", "forbidden");
    const answer = body.get("answer") ?? "";
    try {
      JSON.parse(answer);
    } catch {
      return send(400, "text/plain", "answer is not JSON");
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(SENT, () => done(answer));
    return;
  }

  if (base) return send(404, "text/plain", "not found");
  if (req.method === "GET" && route === path) return send(200, "text/html; charset=utf-8", html);
  if (req.method === "GET" && route === `${path}entry.json`) return send(200, "application/json", entry);

  // The viewer in _core/ and the files of the page in assets/, like images.
  // Nothing else of the folder.
  const [, folder, rest] = route.startsWith(path) ? /^(_core|assets)\/(.+)$/.exec(route.slice(path.length)) ?? [] : [];
  if (req.method === "GET" && folder) {
    try {
      const file = decodeURIComponent(rest);
      if (!file.split(/[\\/]/).includes("..") && !file.includes("\0")) {
        const body = readFileSync(join(site, folder, file));
        res.writeHead(200, {
          "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
          "x-content-type-options": "nosniff",
          // The viewer files keep their names across versions, so they are checked again on every load.
          "cache-control": "no-cache",
          // An asset opened on its own, like an SVG, must not run scripts on the page's origin.
          ...(folder === "assets" ? { "content-security-policy": "sandbox" } : {})
        });
        res.end(body);
        return;
      }
    } catch {
      // a bad escape or a missing file, falls through to the 404 below
    }
  }
  send(404, "text/plain", "not found");
});

// Any free port. Every wait is then an origin of its own in the browser.
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
port = server.address().port;

const pageUrl = `${base ?? `http://127.0.0.1:${port}`}${path}#port=${port}&s=${token}`;
if (args.values["no-open"]) logErr(`open ${pageUrl} to continue`);
else {
  logErr(`serving at ${pageUrl}`);
  openBrowser(pageUrl);
}

// The version check, at most once a week. It runs during the wait, so it
// never delays the page or the answer, and it is silent when it fails: no
// network, a file that is not there, a version line it cannot read.
const checking =
  config.data.notices !== false && version && !(Date.now() - Date.parse(local.updateCheckedAt) < 7 * DAY)
    ? fetch(VERSION_URL, { signal: AbortSignal.timeout(1000) })
        .then(async (res) => VERSION.exec(await res.text())?.[1])
        .catch(() => undefined)
    : null;

const timer = waitSec > 0 ? setTimeout(() => done(null), waitSec * 1000) : null;
const line = await answered;
if (timer) clearTimeout(timer);
server.close();
server.closeAllConnections();
if (line === null) {
  logErr(`timed out after ${waitSec}s`);
  process.exit(2);
}

const at = new Date().toISOString();
// Compact UTC time plus the author, like 20261006T104512Z-g.
const answerId = `${at.replace(/[-:]|\.\d+/g, "")}-${author.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
const answer = JSON.parse(line);
writeFileSync(
  join(artifacts, "answers", id, `${answerId}.json`),
  JSON.stringify({ id: answerId, author, at, result: answer.result, feedback: answer.feedback, errors: answer.errors }, null, 2)
);

// The notices are made here and nowhere else, so a list a page sent under
// that name is dropped. Their times are saved only now: a wait that timed out
// showed nothing and must not use up the week or the month.
const notices = [];
const seen = {};
if (checking) {
  const latest = await checking;
  seen.updateCheckedAt = at;
  if (latest && latest.localeCompare(version, undefined, { numeric: true }) > 0) {
    // A skill copied into a project sits inside the repo of that project, so
    // only skills/yourturn of a checkout is a clone that can be pulled.
    const top = spawnSync("git", ["-C", skill, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).stdout?.trim();
    const pull = top && relative(top, skill) === join("skills", "yourturn");
    notices.push(
      `yourturn ${latest} is out, you have ${version}. Update it with ${pull ? `\`git pull\` in ${top}` : "`npx skills update`"}.`
    );
  }
}
// The donation note comes a week after the first answer in a project, then
// every two months. With no date yet this is the first answer.
const due = Date.parse(local.donationDueAt);
if (config.data.notices !== false && !(Date.now() < due)) {
  if (due) notices.push(`yourturn is free and made by one person. If it saves you time you can support it at ${DONATION_URL}.`);
  seen.donationDueAt = new Date(Date.now() + (due ? 60 : 7) * DAY).toISOString();
}
answer.notices = notices.length ? notices : undefined;
process.stdout.write(JSON.stringify(answer) + "\n");
if (Object.keys(seen).length) writeFileSync(localPath, JSON.stringify({ ...local, ...seen }, null, 2) + "\n");

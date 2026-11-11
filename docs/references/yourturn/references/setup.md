# Setup, once per project

Read this when `.agents/artifacts/config.json` is missing. `create.mjs` stops
without that file and sends you here.

Each project has its own setup in `.agents/artifacts/config.json`, under the
git top level or the current directory outside a repo. Nothing is shared
between projects. Ask the user in chat before the first artifact:

1. Should pages be **local** or **remote**? Local means local first: every
   page stays on this machine, and one goes to a site only when the user asks
   for it. Remote means every page is deployed, so it has an address that
   still works after the task and that the user can share.
2. Is there a site to deploy to, how is it published and what is its address?
   A remote setup needs one, a local setup can have one for the pages the
   user asks to publish. What gets published is the folder
   `.agents/artifacts/remote` as it is: static files, no build step. If the
   user has no site for it yet, help them make one on a host they already
   use, with their own CLI. Tell them plainly: a deployed page holds the code
   it shows, and whoever can open the site can read it. So the site needs a
   login in front of it unless it may be public.
3. Should artifacts and answers be committed to git?

Then write the two files and do not ask again. Tell the user one more thing,
once: pages come for explanations, reviews and decisions. If they want one
for every longer reply too, they can add this line to their own agent
instructions: _"When a reply would lay out options, need me to decide
something or run longer than about ten lines, use the yourturn skill and
answer with a page."_

## The config

```json
{
  "target": "remote",
  "deploy": "npx wrangler pages deploy .agents/artifacts/remote --project-name artifacts",
  "url": "https://artifacts.example.com"
}
```

- `target` is `"local"` or `"remote"`. A local setup with no site is just
  `{ "target": "local" }`.
- `deploy` is a command or plain instructions for you. It must publish the
  whole `.agents/artifacts/remote` folder as a static site, and nothing
  else.
- `url` is the address of that site. An artifact is then at `<url>/<id>/`.
  Leave it out when every deploy gets an address of its own, and say in
  `deploy` to pass that one with `--url`.
- `public` is `true` only when the user said the site may be public. Without
  it `open.mjs` stops when the site gives out a page with no login.
- `imports` is only there when a component of the project uses a package,
  see `components.md`.
- `notices` is left out. Set it to `false` only when the user wants no
  update check and no donation note, see "Result contract" in `SKILL.md`.

## The .gitignore

`.agents/artifacts/.gitignore` always lists `config.local.json`. Add `local/` and
`remote/` when artifacts are not committed and `answers/` when answers are
not.

## A private site is proven private

When the site must be private, prove it before a real page goes up. Deploy an
empty page first and fetch its addresses with no login: none may answer with
the page. Hosts have surprises here. On Vercel the first deploy of a project
becomes production whatever the flags, and the production domain is public on
the free plan. So that first deploy stays an empty page and real pages go up
with `--target preview`, which is behind the Vercel login. `open.mjs` checks
the one address it opens, see "Open it and wait" in `SKILL.md`. It cannot see
a second address of the same site, so this proof is still yours to do.

# yourturn

An agent skill that answers with a page instead of a wall of chat. The agent
writes the page, your browser opens it, you read and answer on it, and what
you said goes back to the agent.

- **Explanations.** How something works or what the agent just changed, in
  short sections with the real code and diffs inline. A page can be read
  aloud.
- **Code reviews.** A guided review: the big picture, the places that need
  your eye and the agent's comments on the lines. You comment on any line.
- **Decisions and forms.** Options laid out with a choice on each, or several
  fields at once.

You can comment on any sentence, attach an image or point at an element of
the page. Every page is saved as a folder under `.agents/artifacts/` in your
project, so it can be opened again later.

## Install

Installed with the [skills](https://www.skills.sh/docs) CLI:

```bash
npx skills add giuseppeg/skills --skill yourturn
```

It needs Node 20 or newer. No build or extra setup is needed, the viewer
ships prebuilt.

## When it triggers

The agent uses it when you ask to have something explained or walked through,
when you ask for a review, and when its reply would lay out options or need a
decision from you. A simple yes or no stays in chat.

### Make it trigger more

Until an agent loads a skill it only sees its name and description. If you
want pages more often, add a line like this to your global `AGENTS.md`:

```
When a reply would lay out options, need me to decide something or run longer
than about ten lines, use the yourturn skill and answer with a page.
```

## How it works

```
spec   agent ──stdin──► create.mjs ──► .agents/artifacts/local/<id>/   (or remote/<id>/)
page   agent ──► open.mjs <id> ──► browser tab
answer browser tab ──HTTP──► open.mjs ──stdout──► agent
```

Pages stay on your machine. A project can also set up a static site of its
own, so a page gets an address that can be shared. A review page holds whole
source files, so that site needs a login in front of it. The scripts stop a
page with source code on its way to the site until you were asked, and stop
again when the site turns out to be open to everyone.

## Good to know

- **New local pages load their libraries from loopback.** `open.mjs` serves
  the copies shipped in `dist/_core/vendor/`, and the browser policy limits
  scripts and fetches to the page's own origin. The manifest records the CDN
  source URLs and SHA-256 hashes before and after rewriting the imports.
- **One network call a week.** The skill fetches its own `SKILL.md` from
  GitHub to see whether a newer version is out. It sends nothing about your
  project.
- **A donation note.** After a week of use and then every two months, the
  agent shows one line with a link.

`"notices": false` in `.agents/artifacts/config.json` turns the last two off.

See [`SKILL.md`](SKILL.md) for the workflow and
[`references/authoring.md`](references/authoring.md) for the spec format and
components.

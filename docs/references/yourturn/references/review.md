# Code and PR reviews

Read this when the user asks to review code, a PR, a branch or a set of
changes. The page itself is written like any other, so read `authoring.md`
for the format and the components.

A review page is a **guided review**. The user gets the big picture, the
places that need their eye, the code behind each point and your review
comments on its lines. Reading a bare diff and dropping comments is something
other tools already do, so that is never the default here.

When the user asks to review code, a PR, a branch or a set of changes
("review this", "help me review", "let's review"), do not answer in chat and
do not ask first:

1. **Get it reviewed.** This is always part of a review, the user does not
   have to ask. If your harness has subagents, give the review to one: it did
   not write the code, so it reads it with fresh eyes. The change is read
   once, never twice:
   - You wrote the change or already know it: do not read it again. Tell the
     reviewer what it is for.
   - You have not seen the change: do not read it first. List it with
     `node scripts/changes.mjs`, pass on what the user or the PR says it is
     for, and let the reviewer do the reading.

   The reviewer only reads and reports back to you, so tell it to change
   nothing. Give it the exact change set (the diff command or the range).
   Ask for the intent of each part and for real problems, risks, missing
   tests and suggestions, each with its file and lines. With no subagents do
   the review yourself.

2. **Check the findings.** Read the lines each finding points at and drop
   what does not hold. This is the only reading you add.
3. **Build the guided review** from what is left, following "Guided review"
   below. You build the page, never the reviewer.

A user who only asks to explain or walk through changes gets a plain
explainer with no review. The raw diff is only for a user who asks for it,
see "Raw diff review" below.

## Guided review

Use it when the user asks to review a PR or a change set, their own or
someone else's. A user who only asks to explain changes gets a plain page
with no review. It is the same page with the same plain style. The review
comes first, see the steps above. Then write the page.

The reader should understand the change, hear the verdict, then deal with
each thing where they meet it. People act on a problem as soon as they see
it. So a problem is explained once and decided right there, and never held
back for the end.

1. `overview`: what the change does and why, in 1 to 3 sentences.
2. First section, the verdict. Its heading says it, like "Good to go", "Good
   to go after two fixes" or "Not yet". Then what the change touches, and one
   sentence per thing to be aware of. Only name each one, the detail comes
   below. Say so when there is nothing. Never pad.
3. One section per thing that is worth the reader's time, grouped by intent,
   not by file, from broad to specific. That is every problem that needs
   their decision, and what they should know even when nothing is wrong with
   it. Always show a new or changed contract: a type, an interface, a config
   key, a public API. The reader has to learn it. A section has:
   - A short `Text`: what this is and why it matters. For a problem, what is
     wrong and what would happen, in plain words. A hard part gets more
     explanation, never less: do not skip something because it is complex.
   - A git-backed `Diff` card, see "Writing rules" in `authoring.md`.
   - For a problem, a note in `comments` on the card, with an `author` like
     "Agent Reviewer". It is the same as the reader's comments on lines, only
     with an author. The `Text` already explained the problem, so do not say
     it again: the comment is one short sentence that points at the spot and
     gives the fix when you know it. Start a doubt with "Question:". Line
     numbers are new-file lines, check them against the file.
   - For a problem, the input for its decision right after the card: a
     `RadioGroup` with "Fix it" and "Leave it", or one option per way to fix
     it plus "Leave it". Nothing is picked and your recommendation is marked
     in its label, see "Inputs" in `authoring.md`. For code you should not
     change, like someone else's PR, ask whether to pass the finding on.

   When a section depends on a later one, say so in one sentence.
4. Last section, only when needed, "Smaller things": what belongs to no
   line, like a test that is missing, and the nits, one sentence each. One
   `RadioGroup` asks whether to fix the nits. No cards here.

Comments are not read aloud, which is one more reason the `Text` says the
problem. Skip `comments` on cards with nothing to flag. The page adds the
"Anything to add?" box itself.

## Raw diff review

Use this only when the user asks for the raw diff. A review is a guided one
by default, see the sections above.
This one shows the changes with no tour, for a user who wants to read them
alone and comment on lines.

A `Diff` with a `source` and no `path` shows the whole change, one card per
changed file. You write no code into the spec, `create.mjs` reads git.

```json
{
  "title": "Review the auth changes",
  "spec": {
    "root": "page",
    "elements": {
      "page": { "type": "Page", "props": { "width": "wide" }, "children": ["changes"] },
      "changes": { "type": "Section", "props": { "heading": "Changes" }, "children": ["all"] },
      "all": {
        "type": "Diff",
        "props": {
          "source": { "mode": "dirty-tree", "paths": ["src/auth.ts", "src/session.ts"] },
          "comments": [
            { "path": "src/auth.ts", "author": "Agent Reviewer", "startLine": 24, "endLine": 29, "body": "Validation now happens before the session is made." }
          ]
        }
      }
    }
  }
}
```

- Leave `paths` out to show every changed file. Give it to narrow the review.
- Make the page `"wide"`, so long lines fit.
- The outline lists the files under the heading of their section.
- Each of your `comments` names the `path` of its file. A path that is not in
  the change is an error.
- Files with no lines to show, like a binary, a symlink or a plain rename,
  are named in one line under the cards.
- The user's comments on lines come back in `result.comments` and their
  overall note in `result.comment`, like on any page.
- It is a normal page, so it can also have an `overview`, text before the
  cards and inputs after them, for example a "Ship it?" question.

A change may hold up to 100 files, 1 MB of patch per file and 10 MB in all.
Over that `create.mjs` fails and says which limit was hit, so narrow `paths`.
A file over 1 MB is shown as its patch only, the lines around its changes
cannot be expanded.

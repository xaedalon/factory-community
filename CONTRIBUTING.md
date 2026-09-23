# Contributing

The rules here are unusual, and a pull request written without knowing them will get comments that
look arbitrary. They are not house style for its own sake — each one exists because breaking it
already cost this project something. [`PROJECT.md`](PROJECT.md) records which.

## The short version

```bash
corepack enable pnpm
pnpm install
pnpm typecheck && pnpm lint && pnpm test          # all three, before you push
pnpm --filter @factory/web test:e2e               # the browser suite, when you touch the board
```

CI runs all four on every pull request — both platforms for the suite, the browser scenarios, and a
first-run job that clones, builds and asks the daemon for a page. Running them locally first is
faster than finding out from a red tick.

Chromium needs installing once for the browser suite:
`pnpm --filter @factory/web exec playwright install chromium`.

Node 24 or newer. macOS or Linux; on Windows, work inside WSL2 — see
[`docs/install.md`](docs/install.md).

## The `.feature` files are the specification

There are no separate spec documents, and there never will be. A `.feature` file beside the code is
the contract; the `.spec.ts` next to it is how the contract is executed. So:

- **A behaviour change begins with a scenario.** Not a test afterwards — a sentence in the feature
  file saying what is true, then the code that makes it true.
- **Write the scenario in the language of the problem**, not of the implementation. "A task does not
  start while it is waiting" is a scenario. "`dependencyStatus` returns `waiting`" is not.
- **A step that needs an `if` means the scenario is under-specified.** Split it.
- **Comments in feature files carry the reasoning.** Why this is the rule, what the alternative cost,
  what a reader would otherwise assume. They are read more often than the code.
- `Rule:` owns every scenario after it until the next one, so **a new `Rule:` goes at the end of the
  file**.

## Every guard is broken and watched to fail

A test that has never failed is a test nobody has checked. Before a guard is trusted:

1. break it deliberately — invert the condition, delete the check, reorder the branches;
2. run the suite and **watch the scenario fail**, naming the right thing;
3. restore it.

If the suite stays green, the guard is not covered and the scenario needs to change — or the guard is
dead code and should go. That has happened more than once here, and both outcomes are useful.

`pnpm mutate` does the three steps for you, and puts the file back whatever happens — including on
an interrupt, which matters for a script that edits source:

```bash
pnpm mutate --file packages/store/src/projects.ts \
  --find "if ((counts?.total ?? 0) > 0) {" --replace "if (false) {" \
  --suite packages/store

pnpm mutate --from mutations.json    # a whole round: [{ file, find, replace, suite?, describe? }]
```

It exits non-zero if any mutation survived — or could not be applied, because a mutation nobody ran
is not a mutation that passed. A survivor is not automatically a missing scenario: it can be an
equivalent mutant, and `SET NULL` in place of `RESTRICT` against a `NOT NULL` column is one, because
SQLite refuses both. Say which it was.

Say in the pull request which mutations you ran and what failed. "Three mutations broken and watched
to fail: …" is the shape.

## One implementation of one idea

The recurring failure in this codebase's history is *two implementations of one idea, where the wrong
one is the one nobody reads*. So:

- **One path resolver.** Every path flows from `packages/config/src/scopes.ts`. `process.cwd()`,
  `os.homedir()` and `os.tmpdir()` are banned everywhere else, by lint, with specs excepted.
- **Serve the rule, don't re-derive it.** The daemon serves a task's available actions; the board
  draws buttons from that list. A client that decided for itself would drift the first time the
  rules changed.
- **Definitions are edited, never regenerated.** A save must preserve comments, key order and every
  field the schema did not touch. `round-trip.feature` is the guard.
- **Hooks influence, events report.** If something needs to change an outcome it is a hook; if it
  needs to know what happened it is an event.

## The open core never imports commercial code

There is a commercial edition in a separate, private repository. It is a plugin: it loads through the
same capability host as any third-party plugin, and it passes the same conformance suite. Nothing in
this repository may import from it, and nothing in it may be required for this repository to build,
lint, test or run.

That is enforced three ways: separate pnpm workspaces, an eslint `no-restricted-imports` rule, and a
CI job that is a standalone checkout by construction. If a change here would need the commercial
workspace to pass, **widen `@factory/plugin-sdk`** instead — that package exists for exactly this.

## A file Factory wrote is a file Factory can load

Anything written to disk must be readable back through the schema that wrote it, before a rename or a
move is considered done. Serialization is lossless or it is broken.

## Commits

Present tense, explaining **why** rather than what — the diff already says what. A commit that fixes
something should say what the failure looked like, because the next person to read it is trying to
work out whether their problem is the same one.

`Co-Authored-By:` trailers are welcome, including for AI assistants that did the typing. This project
is built that way and says so.

## What gets rejected

- A behaviour change with no scenario.
- A guard nobody has watched fail.
- A second way to do something that already has a way.
- A new dependency without a sentence on why it is worth the install for somebody running this on
  their own machine. The web route is forty lines rather than a static-file plugin for this reason.
- A claim in a document that the code does not keep. If it is aspirational, it goes under
  `docs/proposals/` and says so.

## Where to start

`factory doctor` and `factory setup` are the two commands that tell you what state your installation
is in. [`docs/`](docs/) is short and worth reading end to end; `PROJECT.md` is long and is the
decision record — every increment, what it cost, and what was refused.

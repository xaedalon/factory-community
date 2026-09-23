# Xaedalon Factory

> **Don't replace your tools. Orchestrate them.**

Factory is a local-first orchestration layer for agentic software development. It runs the coding
agents you already have — Claude Code, Codex, Copilot, and whatever comes next — against your
repositories, sequencing them through workflows with tests, evidence, and human approval gates.

It is not a model, an IDE, or a coding agent. It decides *when* an agent runs, *what* it works on,
*what it may touch*, *who verifies the result*, and *what is recorded*.

This document is the source of truth, written as the project is built.

---

## Status

**Eighteen increments in, and the whole loop works**: author a workflow in the browser or by hand,
point a task at a repository, queue it, and the daemon gives it a worktree, runs the agents, keeps
what they printed and what they produced, stops at the gate you asked for, and continues when you
approve. From a terminal, from the board, or from Pro's desktop app — the same API either way.
**5,457 Gherkin steps green below the browser** across 50 feature files, 157 of them in a real
browser, and smoke runs against the real agent CLIs. Every one of those runs in CI, on macOS and
Linux, alongside a job that installs from a clean clone and asks the daemon for a page.

Since increment 17 an agent is also **confined to the workspace it was given**, handed an
environment with the credentials taken out, and stoppable — process tree and all. What that
guarantees, and where it stops, is [`docs/security/`](docs/security/); the short version is that
Factory is not a sandbox and says so.

Since increment 18 a task can **wait for another task**, so a project's order lives in the project
rather than in somebody's head: declare the graph, press *Queue all*, and the scheduler starts each
task when what it waits for is done. *Stop all* halts a project's work in one request.
[`docs/task-dependencies.md`](docs/task-dependencies.md) is the whole feature.

`factory setup` is where a new machine starts: what is still missing, and the command that fixes
each one. It is a registry, so the answer comes from whoever knows it — the provider plugins, the
engine, and Pro.

Increment 1 — **capability core + definition layer**. Authoring, storing, resolving, validating and
sharing workflow and phase definitions, plus a foreground runner that proves the contract is
executable. No persistence, no scheduler, no task lifecycle yet.

| Step | | |
|---|---|---|
| 0 | Both workspaces, toolchain, boundary enforcement | ✅ done |
| 1 | `@factory/events` — typed event bus | ✅ done |
| 2 | Capability host, registries, hooks, conformance suite | ✅ done |
| 3 | Definition schemas; `shell` + `agent` as registered built-ins | ✅ done |
| 4 | YAML parser/serializer, `writeNew` / `updateExisting` | ✅ done |
| 5 | `packages/config` — scope discovery and layered resolution | ✅ done |
| 6 | `packages/plugin-sdk` + the three provider plugins | ✅ done |
| 7 | `resolvePlan()` — definitions become an executable plan | ✅ done |
| 8 | `apps/cli` — init, list, show, why, doctor, capabilities | ✅ done |
| 9 | Bundles — self-contained export/import | ✅ done |
| 10 | `apps/daemon` — the definitions API | ✅ done |
| 11 | `apps/web` shell — list pages with scope and shadow badges | ✅ done |
| 12 | The builder — form mode, workflows and phases | ✅ done |
| 13 | Completing the authoring interface (YAML stays a view) | ✅ done |
| 14 | Import and export in the UI | ✅ done |
| 15 | `factory run` — the foreground executor | ✅ done |
| 16 | `factory-pro` desktop capability | ✅ done |

**Increment 1 complete.** 1,060 Gherkin steps below the browser, 44 in a real browser, 49 in
`factory-pro`.

---

## Increment 2 — the engine

Increment 1 built the definition layer and proved it executable. Increment 2 makes a workflow
something you *start* rather than something you run and watch: a task that outlives the command that
created it, a scheduler that decides when it moves, and a record of what happened.

| Step | | |
|---|---|---|
| 17 | `packages/store` — persistence with real migrations | ✅ done |
| 18 | The **Task** entity, and one module that owns every transition | ✅ done |
| 19 | Runs, steps and logs — what happened, kept | ✅ done |
| 20 | The engine — a task and a plan become a run, plus boot reconciliation | ✅ done |
| 21 | The scheduler — queue, concurrency cap, parallel and sequential lanes | ✅ done |
| 22 | Condition flags — `hasWorktree` and friends, set by the workflows that earn them | ✅ done |
| 23 | `on_fail` recovery, and loops (lifting the runner's refusal) | ✅ done |
| 24 | Tasks API and a live event stream | ✅ done |
| 25 | The task board — the screen the mockups describe | ✅ done |
| 26 | Doctor for a running installation (reconciliation landed in 20) | ✅ done |

**Decisions taken at the start of the increment**

- **`node:sqlite`, not `better-sqlite3`.** A native build means someone can clone Factory and fail
  to install it; an experimental API behind one wrapper module is the smaller risk, and swapping it
  is one file. WAL, foreign keys, transactions and `user_version` are all verified working. The
  experimental warning is suppressed inside the store by patching `process.emitWarning` before the
  import — no CLI flag, nothing for a caller to remember.
- **One module owns state transitions.** The prototype's worst bug class came from `approve`,
  `retry`, `run`, `archive` and the scheduler each calling `transition()` with their own pre- and
  post-logic, while the UI re-encoded the rules as scattered conditionals that drifted. Here every
  path goes through one place, and the API publishes the allowed actions for a state so no client
  has to guess.
- **Migrations are versioned and irreversible-by-default.** The prototype had fourteen idempotent
  `ALTER TABLE`s in a try/catch with no version record, so nobody could say what shape a database
  was in. `user_version` and an ordered list, applied in a transaction.

**What increment 2 added**

Tasks that outlive the command that made them, runs that record what happened, a scheduler that
decides what starts, an engine that runs it, a live API and the board that watches it. 1,787
Gherkin steps green below the browser plus 53 browser scenarios (`pnpm test:e2e`).

---

## Increment 3 — where the work happens

Everything so far ran wherever the daemon was started. That was the last thing standing between
Factory and its own premise: agents working in parallel need somewhere separate to work, and a
person running Factory has more than one repository.

| Step | | |
|---|---|---|
| 27 | **Projects** — a task belongs to a repository, not to the daemon's working directory | ✅ done |
| 28 | **Worktrees** — isolation that is earned: `hasWorktree` set by the workflow that creates one | ✅ done |
| 29 | **Evidence** — a phase's `artifact` collected and attached to the run | ✅ done |
| 30 | Examples and documentation, and the daemon serving the board | ✅ done |
| 31 | `factory task` — the board's work from the command line | ✅ done |
| 32 | Step retries — `retries` on any step, of any kind | ✅ done |
| 33 | **Pro's desktop shell** — an Electron window around the local engine | ✅ done |
| 34 | **Finding the agent** — configured, then PATH, then where things are installed | ✅ done |
| 35 | **The setup checklist** — a registry of what is still missing | ✅ done |
| 36 | **Projects that work in place** — no worktree, and one task at a time | ✅ done |

**What increment 3 added**

Projects, so work happens in a repository rather than wherever the daemon started. Worktrees, so
agents working at the same time are not in each other's files — as a step kind a workflow asks for,
with `hasWorktree` earned by the workflow that creates one. Evidence, so an approval is decided on
what was actually produced. `factory task`, so none of it requires a browser. Step retries, because
agent CLIs fail transiently. And the daemon serves the board itself, so a working installation is
one process.

2,085 Gherkin steps green below the browser, plus 58 browser scenarios (`pnpm test:e2e`), and a
smoke run against a real installation each time an increment closes.

**Measured against the plan's Community capability list**, everything is present except one thing
that needs no code: *environment isolation* beyond worktrees — a `hasEnvironment` flag, a workflow
that provides it and one that requires it, written the same way `worktree-create` is. `permission
controls` was removed deliberately; it belonged to a different project.

---

## Increment 4 — the board knows which project you are in

The board was built one page at a time and had no idea which repository you were working in. Tasks
from every project sat in one list, and — worse — the daemon resolved *definitions* through a single
scope chain built from its own working directory. A workflow committed to a repository was invisible
to that repository's own tasks unless you happened to launch the daemon inside it.

| Step | | |
|---|---|---|
| 37 | **A project's own scope chain** — definitions resolved from the project, not from the daemon's cwd | ✅ done |
| 38 | **The project rail** — a square per project, and what the board is about | ✅ done |
| 39 | **New task as a page**, with workflows as an ordered list | ✅ done |
| 40 | **Replanning a task** until it starts carrying the plan out | ✅ done |

**What increment 4 added**

`apps/daemon/src/chains.ts`: one answer to "which definitions can this project see", used by the
planner, the scheduler, the doctor and every definition route. `?project=<id>` on the definition,
bundle, scope and plan routes — on the writes as much as the reads, because once a list is filtered,
saving a workflow you opened from it has to land back in the project rather than forking a copy into
the daemon's own scope. An unknown id is 404, never a quiet fall back to somewhere else.

A rail of project squares left of the navigation, identity derived from the name (`apps/web/src/
identity.ts`) so adding a project needs no decision and no migration. Choosing one narrows the tasks,
the workflows, the phases and the scope chain. The choice is remembered in `localStorage` — the first
persisted UI state in the app.

A task's workflows are now shown as what they are: a numbered, reorderable list, editable everywhere
except `running` and `awaiting_approval`, refused by the daemon in those two states as well.

**Three bugs it fixed on the way**, all of them older than the feature:

- The engine planned every task with the daemon's chain, so a project's own workflows could not run.
- `TaskRepository.assign()` never reset `nextWorkflow`. A task blocked at the third of five,
  reassigned to two workflows and retried, resumed past the end of the list and completed having run
  nothing at all.
- `PATCH /api/tasks/:id` had no state guard: a running task's plan could be rewritten mid-run.

2,565 Gherkin steps green below the browser, plus 77 browser scenarios.

---

## Increment 5 — agents, environments, and what a project must own

One theme and three repairs. The theme: **a project's setup is its own.** Where a worktree goes
differs per repository; how an environment is built differs far more. Both shipped as built-ins
every project silently shared, and nothing said a project ought to have its own. Meanwhile an
agent's settings — provider, model, effort — were retyped into every step, so changing which model
did the work meant editing every phase that mentioned it.

| Step | | |
|---|---|---|
| 41 | **Agents** — a third definition kind, and `- agent: developer` on a step | ✅ done |
| 42 | **Environments** — opt-in per project, three built-in workflows, a page | ✅ done |
| 43 | **`override: required`** — a built-in that asks each project for its own copy | ✅ done |
| 44 | **Renaming a task**, and the left menu grouped into sections | ✅ done |
| 45 | **Bounded fields become controls**, including sets no schema can hold | ✅ done |

**What increment 5 added**

`agents/<name>.agent.yaml` resolves through the scope chain like anything else, so a project's own
agents work in that project for free. A step names one with `- agent: developer`, the same shorthand
`- run:` already had, and then **the only other thing it needs is a prompt**: the six fields an agent
answers for are declared `x-supersededBy: agent` and the builder stops asking. They stay valid — the
step still wins wherever it says something — but an override is offered rather than implied, and a
value already on a step is never hidden. Bundles carry the agents their phases reference, because
"self-contained" is a stated guarantee.

Environments are opt-in per project — `usesEnvironments` beside `usesWorktrees`, off by default
because Factory cannot build one unaided. Turning either setting on copies the definitions it needs
into the project's `.factory`, ready to edit and commit. Tracking is the `hasEnvironment` flag, not a
new table: `environment-create` earns it and `environment-delete` clears it, so the Environments page
cannot drift from what actually ran.

The requirement is **declared, never recognised**. A workflow says `override: required` about itself
and doctor reads the declaration — reported on *use*, so a project that never assigns
`worktree-create` never hears about it. The prototype switched on workflow names in the engine, and
that is the mistake this shape exists to avoid.

`x-options` on a step field names a catalogue the builder fills at render time — providers, agents,
models. A static enum cannot express these: which providers are installed is a fact about the
machine and which agents exist is a fact about the project. A plugin's step kind now gets a real
dropdown by declaring one, with no change to the UI.

**Four bugs it fixed on the way**, all older than the feature:

- A shell step's `working_dir` was parsed, documented, round-tripped and rendered in the builder, and
  **never read**. Deleted: where a step runs is the phase's and the project's business.
- `writeNew` crashed on a definition without `extensions`, so a POST that omitted it was a 500 —
  for every kind, not just agents.
- `SchemaFields` wrote `NaN` into a definition, and from there into YAML, for any numeric field
  typed into badly.
- The serializer-exhaustiveness suite enumerated kinds by hand, so a new kind could ship with an
  unverified writer and the suite would stay green. It now walks the field tables and asserts it
  checked all of them — a guard on the guard.

2,742 Gherkin steps green below the browser, plus the browser suite.

---

## Increment 6 — artifacts a task owns, under a directory Xaedalon owns

Three changes that turn out to be one idea.

`artifact` was a promise nobody was told about: a phase declared a path, the engine looked there
afterwards, and the agent's prompt went through verbatim — so you repeated the path by hand and
nothing checked the two halves matched until the run was over. `.factory` was the wrong name for a
shared idea, because Factory is one of a family of Xaedalon products and every one of them will need
somewhere to put files that belong to the product rather than to the repository. And a task had
nowhere for its output to live, which is why evidence only ever existed inside a database.

| Step | | |
|---|---|---|
| 46 | **`.xaedalon/.factory`** — the scope moves, the old path still read | ✅ done |
| 47 | **A task's own directory** — artifacts, versioned, gitignored | ✅ done |
| 48 | **`artifact` on an agent step**, with the path appended to the prompt | ✅ done |
| 49 | **`{{ task.artifacts }}`**, so a later phase can read an earlier one's work | ✅ done |

**What increment 6 added**

`packages/core/src/task/paths.ts` is the one module that answers "where does a Xaedalon product put
this" — shaped for the rest of the family, used by Factory today. A run writes
`.xaedalon/.factory/tasks/<task>/artifacts/<name>/<name>.md` plus a dated copy under `versions/`, in
the **project** rather than the worktree, because a worktree is deleted when the work in it ends.

An agent step names what it will produce — `artifact: analysis`, always Markdown, so a name is the
whole of it — and Factory appends the path to the prompt. That reverses an earlier judgement, and
the reason changes with it: the path is *derived* now, so nobody could have written it into the
prompt themselves, and telling the agent is the only way the promise can be kept. `describe` is still
computed from the prompt as written, so the run timeline shows what was asked for rather than
Factory's own sentence.

Both scopes moved. **Nothing is relocated for you** — the old path is still read and doctor names the
`git mv` — which matters more than it sounds: `openStore` creates a database at whatever path the
chain resolves, so a rename without that fallback would have shown an empty board while every task
and run sat unharmed where it had always been.

**Two bugs it fixed on the way:**

- `resolvePlan` had a **binary** `join` while `Join` is variadic, so `artifactFile(root, name, file)`
  silently dropped the filename. The prompt named `analysis/analysis.md` and the collector looked at
  `analysis/` — two implementations of one idea, and the one that was wrong was the one nobody read.
  There is one `joinPath` now, and a Rule that asserts the prompt and the plan name the same file.
- `run_evidence` was keyed `(run_id, phase)`, which two artifacts in one phase would have silently
  overwritten. Migration 10 rebuilds it keyed on `(run_id, name)`.

Pro no longer calls `homedir()` anywhere: the licence resolves through `userScopeRoot` in the SDK,
which is the mechanism binding rule 3 prescribes rather than a literal duplicated across the boundary.

The third copy of the same mistake was in prose: doctor told you to edit `.factory/config.yaml`, a
literal that survived the move and would have sent someone to a file that is not there.
`availability()` takes the config file from its caller now, and doctor resolves it from the chain, so
the message names the file that exists.

**Worktrees stay beside the project, not under `.xaedalon/`.** A worktree is a git checkout rather
than something a Xaedalon product wrote, and each project already stores its own absolute
`worktreesRoot` — so moving the default would leave two conventions side by side for no gain. Where
they go is the user's call; what the default and the projects page now both say is that they do not
belong *inside* the project, which is a directory the project's own tooling would walk and index.

2,853 Gherkin steps green below the browser, plus 88 browser scenarios. Verified end to end against
the real installation: a real agent, told a derived path, wrote to it; the engine collected it, wrote
a second version on the rerun, and `git status` never mentioned any of it.

---

## Increment 7 — a task's brief, and the vocabulary to write one in

| # | What | State |
|--:|------|-------|
| 50 | **A task has a description**, editable in place like its name | ✅ done |
| 51 | **`{{ task.description }}`**, so the brief reaches a prompt without being retyped | ✅ done |
| 52 | **A token dictionary** in the phase builder, served from core's own list | ✅ done |

Two pieces of feedback that turn out to share a cause: **the product knew things it never said.**

`{{ task.directory }}` has worked since increment 3 and nothing anywhere announced it — the only way
to discover a token was to read the daemon. And the vocabulary itself lived in four files with no way
to disagree loudly. `packages/core/src/plan/tokens.ts` is now the single list, and
`as const satisfies Record<keyof TaskContext, string>` makes drift a **build error in both
directions**: documenting a token that does not exist is an excess property, and adding a field
without documenting it fails the constraint. A type can only prove the keys match, so a scenario
plans a step using every documented token and asserts the rendered command contains no `{{`.

The dictionary is a collapsed `<details>` below the steps — once, not per step — and it is *served*,
not typed into the page: `GET /api/registries/tokens`, beside step-kinds and providers. The two
namespaces core cannot know, `workflow` and `phase`, come back marked `source: 'definition'` with no
keys, and the editor fills them from the `variables:` it is already holding.

A description is the other half. It is a **required** `string` defaulting to `''` (for prose, absent
and empty are the same state), it has its own `describe()` rather than a second argument to
`rename()` — that method carries a long warning about `directory` that has nothing to do with a
brief — and `''` is valid for a description where it is refused for a name. Both freeze while a task
is in flight, which is not tidiness: `{{ task.description }}` is read at plan time, so editing it
mid-run would change a later phase's prompt underneath a run already going.

`taskTokenValues` is total: every documented key present, `''` when the task has none. Otherwise the
dictionary promises `ticketId` and the resolver tells you it does not exist.

2,924 Gherkin steps green below the browser, plus 95 browser scenarios. Verified against the real
installation: a task created with a description, queued, and `{{ task.description }}` substituted
into the step it ran.

---

## Increment 8 — only offer what a project can actually run

| # | What | State |
|--:|------|-------|
| 53 | **Availability by flag** — a workflow gated on a facility a project has off is not offered | ✅ done |

A project with worktrees and environments both off was still offered all five workflows that manage
them. Nothing provides `hasWorktree` there, so choosing one makes a task that waits for ever.

The three-line fix was available and wrong: `PROJECT_SETTING_DEFINITIONS` maps a setting to workflow
names, and its own comment forbids using it for this — those names decide which *starter files* to
copy and nothing else, **so that renaming your copy of `worktree-create` breaks nothing.** So the
match is on the flag, which is the vocabulary conditions are already written in. `unavailableFor`
asks whether a workflow mentions — in `requires`, `provides` or `clears` — a flag the project can
never hold. A user's own `spin-up` that declares `provides: [hasEnvironment]` is hidden on its
conditions alone, and there is a scenario for exactly that.

**Marked, not filtered.** The listing carries `unavailable: { flag, setting }`; the task picker drops
those rows and the Workflows page keeps them, labelled `needs environments`. A file that exists has
to stay openable and deletable — and a workflow already in a task's plan is still shown, so a plan
made before the setting changed can be removed rather than silently disappearing.

2,929 Gherkin steps green below the browser, plus 97 browser scenarios.

---

## Increment 9 — approval asks before *or* after

| # | What | State |
|--:|------|-------|
| 54 | **`approval: before`** — ask, then run | ✅ done |
| 55 | **`approval: after`** — run, show what came out, then ask (what `required` always meant) | ✅ done |

Queueing `hello-world` greeted you and *then* asked permission. The code was not confused — the gate
was deliberately a **review** gate, which is what makes collecting an artifact at one worth doing.
It just could not express the other question anybody would ask of a gate: *may this happen at all?*

So `approval` is `none | before | after`, and `required` is still read, meaning `after` — that is what
every file already written means, and flipping them would fire their gates before the artifact they
exist to show you.

Everything turns on one number. `before` declines to `phaseIndex`, `after` to `phaseIndex + 1`, and
the engine — which already derives its resume point from what was skipped — needed no change. Both
ways of getting it wrong are worse than either behaviour alone: resume *past* an authorisation gate
and you approve a phase and then skip it; resume *into* one without remembering the answer and it asks
again for ever. Hence `RunOptions.approved`, and a scenario asserting the phase runs **exactly once**.

`hello-world` now asks first, which is what anyone running it expects.

3,013 Gherkin steps green below the browser, plus 97 browser scenarios.

---

## Increment 10 — four pieces of builder feedback

| # | What | State |
|--:|------|-------|
| 56 | **Deleting returns to the list**, carrying what it revealed | ✅ done |
| 57 | **Built-ins in their own table**, separate from what you wrote | ✅ done |
| 58 | **`repeat`** — a loop says how many times, 1 to 100 | ✅ done |
| 59 | **The phases picker looks like a picker** | ✅ done |

"I'm not able to add phases" turned out to be the most interesting of the four. The Add button
worked — driving the real UI proved it in a minute. What did not work was the *affordance*:
`PhaseListEditor` used a raw `<input list>`, and Chromium hides a datalist's arrow until the pointer
is over it. Seven phases were on offer and none of them were visible. It uses the shared `ComboInput`
now, which has drawn its own chevron since increment 5 — a second implementation of a control we had
already fixed once.

Deleting used to leave you on the editor of a definition that no longer existed, behind a banner with
a *Back* link. It navigates to the list instead, carrying the one sentence worth keeping: deleting a
copy can *reveal* a copy in a lower scope, so the name still resolves — to something else. On the
list, that sentence lands next to the row that proves it.

`repeat` bounds a loop that previously ran until somebody noticed. The count is **derived** from
completed runs at the same workflow position rather than stored, so nothing can disagree with it, and
`repeat: 1` runs once — an off-by-one only a scenario asserting "once, not twice" would catch.

3,066 Gherkin steps green below the browser, plus 101 browser scenarios.

---

## Increment 11 — a pipeline, and a token that only worked in the daemon

`todolist` now has the chain it was being built for: **analysis → design → implement → validate →
verify**, one workflow and one phase each, one agent step each, each declaring its own artifact and
reading its predecessors by `{{ task.artifacts }}/<name>/<name>.md`.

Writing them found a bug in Factory rather than in them. `factory run verify --dry-run` said
`"{{ task.artifacts }}" does not resolve — "task" has no "artifacts". Available: description, name.`
The wrapper was fine; the *token* failed, and only outside the daemon — which builds its context with
`taskTokenValues` (total since increment 7) while the CLI built one by hand from its flags. Same
idea, two implementations, and the hand-rolled one was the one nobody reads. The warning even
presented the two keys that happened to be set as though they were the whole vocabulary.

Fixed a level down, where the value is derived rather than in the caller that noticed:

```ts
task: asStrings({ ...blankTaskTokens(), ...(request.task ?? {}), artifacts })
```

`artifacts` last, deliberately — a caller's value for it is overridden rather than trusted, so the
path the prompt promises and the path the collector reads cannot diverge. The same failure as the
binary-`join` bug, this time prevented structurally instead of caught by a test.

3,085 Gherkin steps green below the browser, plus 101 browser scenarios.

---

## Increment 12 — workflows that pull in what they need, and remember what has run

| # | What | State |
|--:|------|-------|
| 60 | **`needs:`** — a workflow names its predecessor, and picking it brings in the chain | ✅ done |
| 61 | **Ticks replace the invisible cursor** — each entry says whether it is still to run | ✅ done |
| 62 | A workflow that has run **cannot be taken off** the task | ✅ done |

**The second half began as a wrong premise, and checking it was the useful part.** The report was
that re-running after a failure would repeat everything. It would not: `nextWorkflow` already
resumed, and a scenario called *"A retry resumes at the workflow that failed"* has been passing since
increment 3. But the cursor was an integer nothing rendered, and **any edit to the list reset it** —
including a reorder — because a position in the old list means nothing in the new one. Editing the
task is exactly what you do while fixing the failure, so the reset arrived at the worst moment.

A correct mechanism nobody can see is not a working feature. So the cursor is gone, replaced by a
tickbox per entry: unticked when the engine is finished with it, left ticked when it failed, and
never removable once it has run. `ran` is derived from the runs — a stored copy would disagree the
first time one was deleted — while `enabled` is stored, because it is the one thing the person sets.

`needs:` is the other half. A workflow names only the workflow before it and Factory walks the chain,
so ticking `verify` fills in analysis → design → implement → validate, and ticking it again on a list
that already has `implement` adds only the three that are missing.

3,259 Gherkin steps green below the browser, plus 107 browser scenarios. Migration 12 was rehearsed
against a copy of the real database before it was trusted: every row preserved, foreign keys clean.

---

## Increment 13 — progress that means something, and artifacts you can read

| # | What | State |
|--:|------|-------|
| 63 | **Progress counts phases** across the whole plan, not steps of the newest run | ✅ done |
| 64 | **An Artifacts section** on the task, and a page that renders one | ✅ done |
| 65 | The evidence header's path **links to the readable version** | ✅ done |

The counter read `0/1` through a five-workflow run, and it was not broken — it measured *steps of the
newest run*, exactly as its comment claimed. That comment was true when a task had one workflow. **A
correct sentence about a system that has changed underneath it reads exactly like a correct
sentence**, and nothing failed, so nothing drew attention to it. The interface reference settled
the replacement: both mockups count phases.

The first numerator I wrote had a bug the design review caught. Grouping by `(entry, phase)` across
every run means a failed attempt poisons its phase permanently — fail, fix, retry and it reports 1 of
3 for ever. **My own "ran twice" scenario missed it because both runs in it succeeded.** Grouping per
run first makes each attempt its own witness. Three smaller corners went the same way: a recovery
run's phases were credited to the entry that failed (the guard `#loopIsDone` already carries), a
phase listed twice read two of three for ever, and a phase with no steps could never count at all.

Artifacts are read out of the evidence rows rather than off disk — which is what evidence is copied
into the database *for*, and which means the route takes a task and a name, so **there is no path to
traverse**. The prototype's equivalent takes `?path=` and reads whatever it is handed. Its viewer
also renders agent-written Markdown through `v-html` with no sanitiser; here that is one
`MarkdownView` component with `DOMPurify` immediately above the `v-html`, and a scenario that was
confirmed to fail when the sanitiser is taken out.

3,365 Gherkin steps green below the browser, plus 112 browser scenarios.

---

## Increments 14–16 — where the work is, sessions by id, and the plugin seam

| # | What | State |
|--:|------|-------|
| 66 | **A workspace row** on the task: the directory, copyable, and a way in | ✅ done |
| 67 | **Session ids Factory chooses**, so a conversation can be resumed exactly | ✅ done |
| 68 | **`task-tool`**: the buttons on a task come from plugins | ✅ done |
| 69 | **Diffity** as a built-in plugin, and a **Plugins page** with switches | ✅ done |
| 70 | **`settings.json`** and an interface scale up to 3× | ✅ done |

Increment 14 shipped *without* its headline: the plan rested on `claude -c` resuming a task's
session, every check agreed, and running the command proved it false — Claude's interactive
`--continue` refuses the sessions `claude -p` creates, which is every session Factory makes. See
the build notes, "A flag that exists is not a flag that works". Increment 15 was the fix: Factory
mints the id, `--session-id` starts the session and `--resume` continues it, and the two are not
interchangeable.

Increment 16 was four requests that were one. "Open terminal" and "Open session" were buttons
written into the board with their commands resolved by name inside a route; adding a diff viewer the
same way would have made three, and a fourth would have been impossible. They are plugins now, and
so is Diffity.

**Two API changes**, recorded because this API is the contract a commercial edition builds on:

- `POST /api/tasks/:id/terminal` is **gone**, replaced by `POST /api/tasks/:id/tools/:tool`. The
  task detail's `workspace` lost `openable`, `command` and `session`, and gained a sibling `tools`.
- `GET /api/capabilities` is **gone**. It grouped what was installed by kind, which the
  `/api/registries/*` routes serve better, and it read the host — so it could show neither a plugin
  that was switched off nor one that failed to load. `GET /api/plugins` reads the catalogue, which
  is a superset.

Pro calls neither (`desktop/src/main.ts` uses `/api/tasks`, `/api/tasks/:id` and
`/actions/:action`), so nothing broke — but keeping either beside its replacement would have been
one idea with two implementations, which is the thing this codebase refuses.

## Increment 17 — autonomous inside the workspace, permissioned beyond it

| # | What | State |
|--:|------|-------|
| 71 | **Two execution profiles**, resolved project → installation → `default` | ✅ done |
| 72 | **A workspace boundary** that resolves what it is given | ✅ done |
| 73 | **A filtered environment**: credentials withheld, the provider's own kept | ✅ done |
| 74 | **`permissionArgs` per profile**, measured against the real CLIs | ✅ done |
| 75 | **A kill switch that kills a process tree**, and a cancel that cancels | ✅ done |
| 76 | **A disclaimer the daemon enforces for every client** | ✅ done |
| 77 | **A refusal reported, and a failed-and-refused run parked** | ✅ done |

The request was a disclaimer, a good default, and graceful handling when
something is blocked. Exploration found something more uncomfortable: **most of
the safety this rested on was declared rather than working.** Cancelling a run
flipped a database row while the agent ran to completion — and the engine's next
transition threw, and the scheduler swallowed it, so nothing was written down
anywhere. `child.kill()` signalled one pid, and a step is almost always
`bash -c '…'` whose work is a grandchild. Shutdown hard-exited after three
seconds while a step had half an hour left. `working_dir: /tmp` ran in `/tmp`,
because `joinPath` lets an absolute part restart the path. A client-supplied
`task.directory` became the agent's own directory. And the runner spawned every
child with `{ ...process.env }`, so every coding agent inherited the daemon's
cloud keys, registry tokens and SSH agent socket.

So the boundary and the containment were made real first, and only then
labelled. A `Default` profile announced on top of that list would have been the
one thing the standard forbids: implying stronger isolation than the
implementation provides.

**The flags were measured, not read.** Two configurations that read correctly in
`--help` did nothing useful: `--tools default` did not name Claude Code's
code-running tools back in (the session had no Bash at all), and
`--permission-mode dontAsk` means "do not ask, and deny". What ships was
observed by running it — a write inside the workspace OK, a shell command OK, a
write outside refused, shell redirection outside refused, and no hang. Codex is
not installed here, so its profile claims nothing at all and doctor says so.

Three discoveries changed the design:

- **A task's artifacts are not in its workspace.** `artifactsRoot` is under the
  project so an artifact outlives its worktree — so a confined agent is told to
  write outside its own working directory, and Default would have refused every
  artifact a worktree project ever promised. Hence `directoryFlag`.
- **"Allow for this project" cannot persist a permission class.** Factory does
  not mediate the action; the agent's CLI refuses it. The only lever is what
  Factory passes next time, so a grant is a **directory** — which is also §31 of
  the standard.
- **A refused agent does not fail.** `claude -p` exits 0 and reports the refusal
  in prose. So a denial is always *reported*, and only *parks* a run that also
  failed: parking one that succeeded would interrupt work that may be done, and
  not interrupting is the point of the profile.

**Three API changes**, recorded because this API is the contract a commercial
edition builds on:

- `POST /api/tasks/:id/actions/queue` and `…/retry` return **409** with the
  disclaimer until an installation has accepted it. No other action is gated —
  cancelling must never be.
- `POST /api/runs/stop` is new and ungated. `POST /api/settings/accept` is new.
- `GET /api/settings` gains `disclaimer` and `accepted`; `PATCH /api/settings`
  accepts `security.profile`; `PATCH /api/projects/:id` accepts `profile`
  (`null` clears it); `GET /api/tasks/:id` runs carry `profile`.

Deferred deliberately, and named in `docs/proposals/execution-profiles.md`:
network policy, secrets as resources, database policy, execution limits,
checkpoints, custom profiles, MCP resources, multi-root workspaces and
production labelling.

**Verified in a browser**, once the desktop app was quit — it holds
`127.0.0.1:7317`, which the suite needs. 132 scenarios pass, and the five new
ones found two bugs that nothing below the browser could have: the disclaimer
panel keyed off "nothing accepted" rather than "a run was refused", so it sat
over the board on load and blocked reading; and accepting it dismissed the panel
without doing the thing that had been refused, while the button said *Continue*.
Both are guarded — reverting either fails the scenario that found it.

## Increment 18 — one task waiting for another

| # | What | State |
|--:|------|-------|
| 78 | **A task dependency graph** in core: met, waiting, dead, and an order to queue in | ✅ done |
| 79 | **The relation in the store**, with itself, cross-project and rings refused at the door | ✅ done |
| 80 | **`mark_done`** — a person may finish a task by hand; `block` now reaches a queued task | ✅ done |
| 81 | **The scheduler holds a dependent**, and blocks one whose blocker can never finish | ✅ done |
| 82 | **What a task waits for, served** — derived per request, never stored | ✅ done |
| 83 | **Queue all and Stop all**, per project, one request each | ✅ done |
| 84 | **The board and the task page** — the header names the project, a row says what it waits for | ✅ done |
| 85 | **`factory task depends` and `factory project queue|stop`** | ✅ done |

`todolist`'s own `PROJECT.md` lists ten tasks with a dependency column, and it is
a **graph rather than a chain** — "tasks 3 and 4 can run at the same time; so can
7 and 8". Factory had nowhere to put that, so the order lived in somebody's head
and was enforced by queueing one task and watching.

**Exploration found no home for this, and two traps.** `needs`/`resolveNeeds`
relates workflow definitions *within one task's plan*, and the scheduler
explicitly refuses to gate on it. Flags are keyed `(task_id, flag)` and written
only by the engine onto the task whose own run just finished — and
`engine/src/doctor.ts` carries a comment left specifically to stop somebody
doing this: *"Flags belong to one task… no later workflow can set the flag in
time, and nothing else can set it at all."* Fourteen migrations and no `tasks`
column referenced `tasks`. So the relation is new; what is reused is the
scheduler's admission funnel, its `SkipReason` vocabulary and the single-door
`act`.

Decisions, taken because each had a defensible alternative:

- **Queueing always works; the scheduler holds.** The alternative — refusing to
  queue until the blockers are done — would make *Queue all* meaningless and
  keep a person at the keyboard, which is the thing this increment is for.
- **Dependencies are declared, never inferred.** Nothing reads branches, ticket
  ids or names. A guessed edge that is wrong is worse than no edge.
- **A ring is refused at the door.** The store is the only writer, so the stored
  graph is acyclic by construction — which is what lets `queueOrder` treat a
  ring as corruption rather than as an ordinary outcome to design around. The
  batch route still refuses one, because the walk cannot place a ring's members
  and carrying on would queue everything else and silently leave those out.
- **A dead blocker blocks its dependent.** Waiting for something cancelled is
  not waiting, it is stalling. `block` gained `queued` for this, and stays
  internal — a person has cancel.
- **`mark_done` is a separate action, not `complete` with its `internal` lifted.**
  `complete` is `from: ['running']`, so lifting it would offer the button on
  exactly the one state that corrupts things: the agent keeps going, the run row
  still says `running`, and the engine's own completion throws when it gets
  there.
- **Stop all leaves drafts and blocked tasks alone**, unlike the plan it was
  built from and unlike the global kill switch. Neither is happening, both are
  what *Queue all* picks up from, and one click must not quietly clear work
  somebody planned but never started.

**Two API changes:**

- `POST /api/projects/:id/queue` returns `{ queued, skipped }`, 409 with the
  disclaimer until an installation has accepted it, and 409 with `problems` for
  a ring. `POST /api/projects/:id/stop` returns
  `{ cancelled, signalled, killed }` and is never gated.
- `POST /api/tasks/:id/dependencies` and
  `DELETE /api/tasks/:id/dependencies/:blockerId` add and remove one edge, and
  pass the store's own refusal through as a 400. `GET /api/tasks` and
  `GET /api/tasks/:id` gain `blockers: [{ id, name, status }]`, derived per
  request the way `progress` is; `Task` gains `dependsOn: string[]`.

**The first real use found what 150 browser scenarios did not.** Queue all,
pressed against the actual `todolist`, queued nothing and said nothing: Tasks 7
to 10 have empty plans, the daemon reported all four in `skipped` with a reason
each, and the board threw that answer away. Every scenario had at least one
queueable task, so the report was always redundant with the rows changing state
— and the case worth specifying was the one where the button correctly does
nothing. The board now says what a batch did, names what it left alone, and has
five scenarios and five mutations on it.

**Three mutations survived their first round**, and each one taught something the
scenarios were missing. The self-dependency refusal survived because the ring
check catches a self-edge too — and explains it with "already waits for", which
is not what happened, so the scenario now pins the self case's own wording. The
missing-blocker check survived because leaving it out still produced a 400 — by
leaking a `TypeError` as its message. And "dead beats waiting" survived the
scheduler suite until a scenario gave one dependent two blockers, one cancelled
and one still running. The ring walk had a real bug that a scenario found:
`queueOrder` follows only the edges inside the set it is given, so checking
`[id]` alone walked straight past a ring three tasks long.

## Launch preparation — what an audit found

| # | What | State |
|--:|------|-------|
| 86 | **The documented first five minutes**, which did not work | ✅ done |
| 87 | **A platform promise with evidence behind it**: macOS and Linux in CI, Windows via WSL2 | ✅ done |
| 88 | **The browser suite in CI**, after eighteen increments on one laptop | ✅ done |
| 89 | **Public hygiene**: nothing cited that a reader cannot open | ✅ done |
| 90 | **The furniture**: contributing, security, conduct, templates, install, notice | ✅ done |

Before making Community public, the repository was audited against its own
tree, its full history and — the part that mattered — **a clean clone driven by
the commands the README gives**. That last one is the only check that found
anything serious, and it found the worst defect in the project:

```
pnpm install --frozen-lockfile   ok
pnpm build                       ok
  MISSING  apps/web/dist/index.html
GET /  → 404 {"message":"Route GET:/ not found",…}
```

The root `tsconfig` references `apps/cli` and `apps/daemon`; the board is built
by vite, and nothing invoked it. So `pnpm build` produced an engine and no
board, and the README's third sentence — "a web interface served from the same
process" — was false for every person who had ever followed the README. The
daemon knew: it printed *"the board is not built"* at startup, to a log nobody
reads, and then let Fastify answer `/` with its own JSON 404.

**Every test passed straight over it.** 5,457 steps below the browser, 157 in a
browser, and not one of them ran the documented commands in order. The lesson
is the increment-17 lesson at the level of the product rather than the code: a
guarantee nobody has watched fail is not a guarantee, and *"it installs
cleanly"* is a guarantee. There is now a `first-run` CI job that clones,
installs, builds, starts the daemon and asks it for a page.

`engines.node` said `>=20.11` while the store imported `node:sqlite`, which
does not exist before 22.5 — a crash at import rather than a version error, for
anybody on Node 20. Now `>=24`, which is what CI runs.

**The platform promise is measured, not asserted.** CI runs the suite on ubuntu
**and macos**; Windows is deliberately absent, because every shell step is
`bash -c` and stopping work signals a process group, so WSL2 is the honest
answer and `docs/install.md` says so rather than implying three platforms work.

**The browser suite now runs in CI.** It had never run anywhere but a laptop,
and it is the suite that caught three defects nothing below it could. No
fixture changes were needed — each scenario already started its own daemon with
an empty PATH, precisely so provider availability would be identical on a bare
runner. It had simply never been taken up on the offer.

**Hygiene.** Fourteen comments cited the prototype by a name only one machine
can resolve, including an absolute path in a Vue component; they say "the
prototype" now. Two rows of the specification index named feature files in the
commercial repository and are labelled *(not in this repository)*. A 1,687-line
aspirational standard moved to `docs/proposals/`, so its path says what its
banner always said. No token-shaped string appears in any commit of the
history; no absolute home path does either.

## After 0.1.0 — a task belongs to a project

| # | What | State |
|--:|------|-------|
| 91 | **`tasks.project_id` is `NOT NULL`**, with the migration that gets an existing database there | ✅ done |
| 92 | **Removing a project is refused** while anything is left in it, with the count | ✅ done |
| 93 | **The fallbacks deleted** — a dozen of them, across core, engine, daemon, board and CLI | ✅ done |
| 94 | **The scheduler's gates ask about the workflow about to run** | ✅ done |
| 95 | **Worktree removal leaves the worktree first** | ✅ done |

The column was nullable, and everything downstream carried a fallback for the
case. A task with no project ran **wherever the daemon happened to be started**
— `service.ts` spelled it out twice, for the workspace and again for artifacts
— which is what the doctor's own setup rule calls "fine for a demonstration and
wrong for work". Removing a project orphaned its tasks rather than refusing, so
this was not hypothetical: 21 tasks ended up project-less on one installation
simply because somebody tidied a list.

The justification, written into `projects.feature`, was that `factory run` in a
directory needs no project. **It was false.** `factory run` creates no task at
all — `apps/cli/src/commands/run.ts` touches neither repository; it plans
against the scope chain of wherever it was invoked and runs in the foreground.
So nothing was ever kept on a task's behalf by allowing one to belong nowhere.

Decisions, each with a defensible alternative:

- **Refuse the removal rather than cascade.** Deleting a project would delete
  the record of work that really happened; orphaning kept the record in a form
  nobody could use. Refusing keeps it by keeping the project, and the message
  names the count — including archived tasks, because the foreign key counts
  those too and a count that skipped them would promise a removal the database
  then refuses.
- **Delete the rows that are already orphaned.** There is nothing to give them.
  The migration says how many at boot, which is why `up()` can now return a
  note: deleting somebody's rows is a one-way door that runs unattended when a
  daemon starts, and "it is in the schema" is not telling them.
- **The definition library stays browsable without a project.**
  `chains.for(projectId?)` keeps its optionality — `factory --serve` has no
  projects at all, and the builder is useful before the first repository is
  added.
- **What remains of "no project" is corruption.** A project row that is not
  there now means a hand-edited database. Read paths tolerate it so the board
  can still draw the task and say what is wrong; anything that would *run*
  refuses and names the project it cannot find.

**The landmine, found by measuring rather than by worrying.** `migrate()` opens
its transaction before `up()` runs, and `PRAGMA foreign_keys` is a documented
no-op inside one. `DROP TABLE tasks` with enforcement on deletes the parent
rows first, firing every `ON DELETE CASCADE` child: every run, step, log,
artifact, flag, history row and dependency edge of **every task**, including the
ones being kept. A rebuild without the new `rebuildsForeignKeys` opt-in reports
`expected +0 to be 1` in its own scenario — the child row destroyed. That opt-in
toggles the pragma outside the transaction, and the migration ends with `PRAGMA
foreign_key_check` rather than assuming, in the same spirit as migration 15's
cycle check. It earned its place immediately: `task_flags` had been left out of
the orphan cleanup, and the check is what said so.

**Verified against a real database**, not only a seeded one — a copy of an
installation's own file at version 15, with 11 tasks, 1 orphan and 42 runs. The
orphan and its four runs went; the ten owned tasks kept all 38 runs, 38 steps,
63 logs, 37 artifacts, 44 history rows, 50 workflow entries and 9 edges, and
`foreign_key_check` came back empty.

**Two defects landed in the same branch**, because they live in the files this
one touched.

The scheduler's `#factsFor` read the *newest run's* workflow, falling back to
`workflows[0]`. Neither is what a queued task is about to run, so a task whose
first workflow had finished was admitted on the lane and the requirements of
work that was already over — agents ran in a project's own checkout because the
flag gate was asked about a workflow needing no worktree, and two `merge`
workflows overlapped because the lane gate was asked about the parallel one
before them. No scenario caught it: every one gave its task a single workflow,
so all three readings coincided. It now follows the task's state, mirroring
`Engine.start` — a running task is on its newest run's workflow, which after an
`on_fail` is a recovery workflow that is not in the list at all; anything else
is on what `start` would pick.

Worktree removal ran **inside the worktree it was removing**: the workspace is
resolved when the plan is made, while the worktree is still there. Git was left
with no current directory to read, so the prune never ran, the step failed, and
`clears: [hasWorktree]` never took effect — the task kept a flag for a worktree
that was gone. The step kind is given only a path, so the script now finds the
repository from the worktree while it still exists and moves there first. Both
halves are asserted with real git, because the old script exited 0 while
printing `fatal: Unable to read current working directory`.

**Mutation testing found two gaps and two equivalent mutants.** Dropping `NOT
NULL` from the rebuilt table and swapping `RESTRICT` back to `SET NULL` both
survived: every path to the database went through a repository that refused
first, so the constraints themselves were never exercised — the "declared and
inert" shape this codebase keeps paying for. Two scenarios now write straight
to the database and expect it to refuse. Afterwards, dropping `NOT NULL` fails;
`SET NULL` still survives and is genuinely equivalent, because SQLite refuses a
`SET NULL` action against a `NOT NULL` column. Reordering the orphan cleanup is
equivalent too, and for a reason worth writing down: the ids go into a temp
table first, so no delete reads `tasks` and the order cannot matter.

## After 0.1.0 — the things noticed while building something else

| # | What | State |
|--:|------|-------|
| 96 | **The two definition hooks run** — declared, documented and never called | ✅ done |
| 97 | **`stdin:` is honoured**, and `RunState 'declined'` has a writer | ✅ done |
| 98 | **One copy of the event vocabulary**, one of the hook names, `process.env` banned | ✅ done |
| 99 | **A project gets a scope**; a missing one is a 400 rather than a 500 | ✅ done |
| 100 | **A setting cannot be dropped silently** by a merge that was not told about it | ✅ done |
| 101 | **A step records the command it ran** | ✅ done |
| 102 | **A task can be moved to another project** | ✅ done |
| 103 | **Doctor reports a dead blocker** before the queue reaches it | ✅ done |
| 104 | **Export follows `needs`** | ✅ done |
| 105 | **The board says what to add first**, and `pnpm mutate` makes the discipline a command | ✅ done |

Things noticed while building something else are written down as they are
found — each one a file and a line rather than a feeling — and the list is kept
outside this repository, because most of its entries are about work in
progress. This is the session that worked through it: twenty-four entries
closed, each with the commit that closed it, and two of those closed as
decisions to leave them alone.

Four findings are worth repeating here, because they are about how this
codebase fails rather than about any one defect.

**A seam that is declared and never called is the recurring shape.** Both
definition hooks had been on the plugin SDK since the host was built: counted
in every conformance report, described in `docs/plugins.md`, and never invoked
once. `PlannedStep.stdin` was set from a descriptor, carried onto the planned
step, printed by `--dry-run` as `< file`, and dropped by a runner that
hard-coded `stdio: ['ignore', …]`. `RunState 'declined'` had no writer — and
that one was not cosmetic: `reject` left its run paused for ever, so a retry
*resumed past the gate that had just been refused*. A comment promising
`beforeStepRun` "once there is a Step type" was the same defect in prose, and
says why there is no third hook now instead.

**A guarantee enforced at one point is a hint everywhere else.**
`scheduling: sequential` was checked where the scheduler admits a task, and a
task stays `running` from its first workflow to its last — so a sequential
workflow anywhere but first was serialised against nothing. Two `merge`
workflows ran 20ms apart, twice. The lane is held by the engine now, around the
execution of each plan that asks for one, which is the unit the field is about.

**A constraint nothing exercises can be dropped without anybody noticing.** Two
mutations survived their first round — removing `NOT NULL` from the rebuilt
`tasks` table, and swapping `RESTRICT` back to `SET NULL` — because every path
to the database went through a repository that refused first. Two scenarios now
write straight to the database and expect it to refuse. (The second is an
equivalent mutant: SQLite raises on a `SET NULL` action against a `NOT NULL`
column, so the two spellings cannot be told apart.)

**A wire format that needs the receiver to know the vocabulary guarantees a
second copy of it.** `GET /api/events` named each SSE frame after its event,
which only reaches a client already listening for that name — so the board kept
its own list, with 14 of the 23 names in it, and an event missing from it was
one the board silently stopped updating for. Unnamed frames need no list at all.

The discipline itself is a command now. `pnpm mutate` takes a file, a string, a
replacement and a suite — or a JSON file of them — restores the source whatever
happens, and exits non-zero if a mutation survived *or could not be applied*,
because a mutation nobody ran is not a mutation that passed.

## Glossary

The vocabulary is deliberately small, and it is the vocabulary in the code.

| Term | Meaning |
|---|---|
| **Task** | A unit of requested work — a ticket, a bug, a feature. (The prototype called this a "Requirement".) |
| **Workflow** | An ordered list of phases, plus how it is scheduled and what happens when it fails. |
| **Phase** | A named group of steps, optionally gated on human approval. |
| **Step** | One operation inside a phase. `uses:` names its kind — `shell`, `agent`, or anything a plugin registers. |
| **Agent** | A name for the settings an agent step would otherwise repeat: provider, model, effort, persona. Not a provider — several agents can share one. |
| **Artifact** | A Markdown document an agent step promises to write. Named, never pathed: Factory decides where it goes, tells the agent, keeps every version and shows the latest. |
| **Environment** | Whatever a task needs beyond a checkout: a container, a database, seeded data. Factory never builds one; a project's own `environment-*` workflows do, and the `hasEnvironment` flag records that they did. |
| **Scope** | Where definitions live: `project` → `user` → `builtin`, resolved in that order. |
| **Capability** | A named contract core defines and something else provides. |
| **Plugin** | A package providing one or more capabilities. Pro is a plugin bundle; so is a provider. |
| **Provider** | An agent CLI behind a uniform interface: capabilities, model roles, command rendering. A provider is a **descriptor**, not a class — adding one is a YAML file. |
| **Bundle** | One self-contained YAML file holding a workflow plus every definition it needs. Its inner definitions are written by the same writers that produce definition files, so a bundle contains exactly what would sit on disk. |
| **Run** | One execution attempt of a workflow. |

---

## Binding rules

These are architecture, not style. Several are enforced mechanically; where they are, it says so.

1. **The open core never imports commercial code.** Community must install, build, test and run with
   `factory-pro/` deleted. *Enforced:* separate pnpm workspaces, an eslint `no-restricted-imports`
   ban, and the `community-standalone` CI job which deletes the directory before building.

2. **Editions are capabilities, not forks.** Core asks the host whether a capability is present and
   degrades by **absence**. There is no `edition` concept in core, no licence check, no `if (pro)`.
   Licensing lives inside the Pro plugin, which decides whether it registers at all.

3. **Pro is indistinguishable from a third-party plugin.** Same host, same manifest, same public SDK,
   and it passes the same conformance suite. If Pro ever needs something a third party cannot do,
   the SDK is incomplete — widen `@factory/plugin-sdk` rather than reaching into core.

   This has already happened twice, which is the rule working rather than a sign it is wrong: Pro
   needed the doctor-rule contract (it lives in `@factory/config`), and Pro's own tests needed
   `CapabilityHost` and `EventBus` to exercise a plugin at all. Both were added to the SDK, so a
   third party gets them too. Pro's typecheck resolves `@factory/*` through the linked package's
   `exports`, which point at its built `dist` — reaching past a public entry point does not resolve.

4. **Every built-in ships through the seams.** Parsing *and* planning both go through the step-kind
   registry — a kind that validates but cannot run is half a seam, and the half that fails later.
   The builder too: step editors are generated from each kind's own schema, published as JSON
   Schema, so a plugin's kind gets real labelled controls with no change to the UI. `shell` and `agent` are registered step kinds; the
   three providers are plugins; doctor checks are registered rules. A built-in that cannot be
   expressed through the extension API means the API is wrong.

   Capability *kinds* are open strings, not an enum core owns. If core had to declare every kind,
   Pro's `desktop` capability would need a core change — the exact coupling this design prevents.
   Core types only the kinds it consumes itself.

5. **One path resolver.** Every filesystem path flows from `packages/config/src/scopes.ts`, which
   takes its inputs explicitly — `resolveScopes({ cwd, env })` has no defaults, so the prototype's
   "called with no argument and silently ignored the environment" bug is untypeable. *Enforced:* an
   eslint ban on `process.cwd()`, `os.homedir()` and `os.tmpdir()` everywhere else (specs excepted).
   No module-level path constants — they freeze at import time.

   Scopes layer project → user → builtin, first match per name. The cost of layering is that "which
   file am I running?" stops being obvious, so it is answered rather than left to the user: every
   resolution carries what it shadows, and `explain` lists every path tried, present or not.

6. **A file Factory wrote is a file Factory can load.** Every write serializes, reads the result
   back through the schema, and refuses if it does not validate. Callers pass domain objects and
   nothing stops one being wrong — an older client, a script, a skipped validation — so the check
   lives at the write, where every path gets it.

7. **Serialization is lossless or it is broken.** The serializer is generated from a field table
   beside the schema, and an exhaustiveness test asserts the table covers every schema field. Adding
   a field without teaching the writer fails the build.

8. **Definitions are edited, not regenerated.** Writing an existing file patches the parsed YAML
   document, so comments, key order and formatting survive. Only new files are serialized wholesale.

9. **One editor, one source of truth.** The form is the only way to change a definition; YAML is a
   view. Two editors over one document means reconciling them on every switch, and that
   reconciliation is where a hand-written comment gets dropped. The preview is rendered by the
   daemon — the process that writes the file — rather than a second copy of the serializer in the
   browser, for the same reason: a guarantee beats a contract test between two implementations.

10. **Hooks influence; events report.** A hook runs during an operation and can add problems or
   change the value. An event is a fact that already happened and a subscriber cannot alter it. If a
   proposed hook has nothing to influence, it is an event.

11. **The `.feature` files are the specification.** There are no separate spec documents. Steps
   translate; they never decide. A step that needs an `if` means the scenario is under-specified.

---

## Layout

```
factory/                   a layout on a machine, not a checkout — see below
├── factory-community/     Apache-2.0 · its own pnpm workspace · publishable
│   ├── packages/
│   │   ├── core/          capability contracts, host, registries, schemas, resolvePlan
│   │   ├── events/        the typed event bus
│   │   ├── config/        scope discovery, layered resolution, settings, the plugin catalogue
│   │   ├── plugin-sdk/    the only surface plugins — and Pro — import
│   │   └── plugins/       provider-claude · provider-codex · provider-copilot
│   │                      task-terminal · task-session · task-diffity
│   └── apps/              daemon (127.0.0.1:7317) · web · cli
│
└── factory-pro/           proprietary · separate workspace · depends one-way on the above
    └── packages/          capability-desktop · desktop (the Electron shell)
```

**Two repositories, and the directory above them is neither.** Community and Pro are separate git
repositories with separate installs; the directory that holds both is a layout on a developer's
machine, and no commit contains the pair. So **nothing here may cite a file over there** — the build
notes and the interface mockups are not public, and a comment that sends a reader somewhere they
cannot go is worse than no comment. `pnpm verify:standalone` proves the split mechanically, by
moving `factory-pro/` aside and running the whole suite without it.

## Specification index

Gherkin lives beside the contract it specifies. This index is the one place to read the whole spec.

Two rows name features in the commercial workspace, which is a separate and private repository. They
are listed because the boundary is only meaningful if both halves are accounted for — Pro passes the
same conformance suite through the same plugin host — and marked so nobody goes looking for a file
this repository does not contain.

| Feature | Contract |
|---|---|
| `packages/events/features/event-bus.feature` | Delivery, isolation of a throwing subscriber, unsubscribe semantics |
| `packages/core/features/capability-host.feature` | Loading, discovery, degrade-by-absence, id conflicts, all-or-nothing registration |
| `packages/core/features/hooks.feature` | Collect vs transform pipelines, and how each handles a broken plugin |
| `packages/core/features/plugin-conformance.feature` | The one suite every plugin passes, Pro included |
| `packages/core/features/definition-schema.feature` | Workflow and phase validation; located, actionable errors |
| `packages/core/features/step-kinds.feature` | `uses:` resolves through the registry, so a plugin adds a kind with no core change |
| `packages/core/features/serializer-exhaustiveness.feature` | The writer covers every field the schema accepts |
| `packages/core/features/round-trip.feature` | Comments, key order and unedited fields survive a save |
| `packages/core/features/round-trip-properties.feature` | 1,000 generated definitions plus YAML's trap values |
| `packages/core/features/located-errors.feature` | Problems carry a file, line and column |
| `packages/config/features/scope-discovery.feature` | Finding `.factory`; `$HOME` is never a project |
| `packages/config/features/layered-resolution.feature` | Which definition wins, and what it shadows |
| `packages/config/features/scaffold.feature` | What turning a project setting on copies into the repository, and what it refuses to overwrite |
| `packages/config/features/scope-plugins.feature` | A project ships its plugins in its own repo |
| `packages/plugins/provider-claude/features/providers.feature` | Rendering, model roles, capability awareness, conformance |
| `packages/config/features/plan.feature` | Definitions become runnable processes; nothing executes |
| `apps/cli/features/cli.feature` | The command surface, exit codes and output, including `factory task`, `factory task depends` and `factory project queue|stop` |
| `packages/config/features/bundles.feature` | Sharing a workflow as one self-contained file |
| `apps/daemon/features/api.feature` | The definitions API: etags, scope-aware delete, registries |
| `apps/daemon/features/tasks-api.feature` | Tasks, runs, logs and the live stream — a queued task actually running, a project's own definitions, renaming, agents over HTTP, when a plan may be changed, what a task waits for, and queueing or stopping a whole project |
| `apps/web/features/definition-lists.feature` | What the pages render, in a real browser |
| `apps/web/features/builder.feature` | Authoring a workflow or phase without writing YAML |
| `apps/web/features/authoring.feature` | Delete, conflicts, phase references, and the YAML view |
| `apps/web/features/sharing.feature` | Export a bundle, preview an import, resolve a clash |
| `apps/web/features/task-board.feature` | The board: the project rail, the grouped menu, filters, both views, live updates, a task's ordered plan, renaming, environments, the disclaimer that gates a first run, Queue all and Stop all, the dependency picker, what an installation with no repository is told, and the settings page — theme, scale, and what agents may reach |
| `packages/core/features/run.feature` | Running a plan: order, failure, deadlines, approval gates |
| `packages/core/features/execution-profiles.feature` | Which profile applies: project over installation over `default`, and one name for each |
| `packages/core/features/workspace-boundary.feature` | What counts as inside the workspace, including `..`, a prefix sibling and a real symlink |
| `packages/core/features/agent-environment.feature` | What a step's process can see: credentials withheld, a provider's own kept, and every name said |
| `packages/core/features/processes.feature` | Stopping what Factory started: the group not the process, proved on a real grandchild |
| `packages/core/features/denials.feature` | Noticing an agent was refused something, from the wordings its CLI actually prints |
| `packages/core/features/task-dependencies.feature` | One task waiting for another: met, waiting, dead; the queue order; a ring caught |
| Pro's `desktop-capability.feature` *(not in this repository)* | Pro is a plugin: same host, same suite, no core changes |
| Pro's `shell.feature` *(not in this repository)* | The desktop shell: attach or start, the menu bar, what is worth a notification |
| `packages/store/features/store.feature` | Migrations, transactions, and the guards around both — including a rebuild that must not take its children with it, and what an upgrade that deletes rows says about it |
| `packages/store/features/tasks.feature` | The task lifecycle: one table of moves, what each state offers, what changing the plan does to its place in it, one task waiting for another, and finishing one by hand |
| `packages/store/features/runs.feature` | Runs, their steps, and output kept inside a budget |
| `packages/engine/features/engine.feature` | A task becomes runs: recording, gates, failure, and what a crash leaves |
| `packages/engine/features/scheduler.feature` | What runs next: order, capacity, lanes read from the task's own project, gates asked about the workflow about to run, a dependent held until its blockers are done, and why anything was skipped |
| `packages/engine/features/doctor.feature` | Doctor rules that only exist where a database does |
| `packages/store/features/projects.feature` | Projects: where work happens, checked when it is written, and removable only while nothing is left in them |
| `packages/core/features/worktree-steps.feature` | `uses: worktree` — isolation a workflow asks for, idempotently, and removed from outside the worktree |
| `packages/core/features/provider-resolution.feature` | Where the agent is on *this* machine, and what to say when it is nowhere |
| `packages/config/features/provider-config.feature` | `providers.<id>.command` — the way out when discovery cannot help |
| `packages/config/features/setup.feature` | What is still missing, contributed by whoever knows |
| `packages/store/features/projects.feature` (extended) | Whether a project gives each task a worktree, and what that costs |

**Verifying everything** (from `factory-community`, then `factory-pro`):

```bash
pnpm typecheck && pnpm lint && pnpm test     # both workspaces
pnpm --filter @factory/web test:e2e          # the browser scenarios
pnpm verify:standalone                       # Community with factory-pro/ moved aside
```

**Running the browser suite:** it starts a daemon on port **7317** per scenario, so nothing else may
be listening there — not a `factory-daemon` you left running, and not the desktop app. A stray one
answers the health check, the scenarios drive it instead of their sandbox, and the failures look
like product bugs in whatever page they happen to be on.

Always `pnpm test:e2e`, never `playwright test` on its own, and never two runs at once. `bddgen`
bakes each scenario's step bindings into `.features-gen/`, so a half-written or concurrently
rewritten copy fails with `bddTestData not found for test` — which reads like a broken page and is
nothing of the kind.

The same error survives deleting `.features-gen`, because **Playwright caches its compiled specs by
path** in `$TMPDIR/playwright-transform-cache-$UID`. A cached build of a spec whose scenarios have
since moved reports tests at line numbers that no longer exist, and the run looks up their data and
finds none. When the error persists after a clean regeneration, that cache is the answer:

```bash
rm -rf "$TMPDIR/playwright-transform-cache-$UID" .features-gen test-results
```

**Writing features:** the Gherkin runner strips leading whitespace from doc-strings, so nested YAML
goes in flow style (`variables: {region: eu-west-1}`) and anything whitespace-sensitive goes in
`features/fixtures/`. **Build every per-scenario fixture inside `Background`, never in
`BeforeEachScenario`** — the runner executes Background steps first, so anything created in
`BeforeEachScenario` does not exist yet. This has cost time twice; it fails every scenario at once
and the failures look like product bugs.

---

## Working on this

```bash
cd factory-community
pnpm install
pnpm test          # every .feature below the browser
pnpm test:e2e      # the browser ones (runs bddgen first — always use this script)
pnpm typecheck
pnpm lint
pnpm mutate        # break a guard on purpose and watch a scenario fail

pnpm dev           # the builder, on http://127.0.0.1:5317
node apps/daemon/dist/bin.js   # the daemon it talks to, on 127.0.0.1:7317
```

**Design tokens live in one place** — `apps/web/src/tokens.css`, via Tailwind 4's `@theme`. The
prototype declared its palette twice and the two had already drifted, so a colour depended on which
file you opened. The one exception is the project palette, in a plain `:root` block in the same
file: Tailwind 4 only emits theme variables that some generated utility references, and those are
read by name from JavaScript. In `@theme` they were tree-shaken away and every project square
rendered colourless.

Toolchain: pnpm 12.3 via corepack, TypeScript 5.9 (nodenext), vitest 5, eslint 10,
`@amiceli/vitest-cucumber` for Gherkin below the browser.

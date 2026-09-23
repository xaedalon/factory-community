# Writing workflows

A workflow is an ordered list of phases. A phase is an ordered list of steps. That is the whole
model, and everything else is a field on one of the three.

You can write these by hand, but the builder in the web interface produces exactly the same files —
including the comments you left in them, which a save never destroys.

## Workflow

```yaml
kind: factory.workflow/v1        # optional; identifies the document if present
name: development                # required, and the filename it resolves under
description: What this is for.
mode: once                       # or `loop`
interval: 30                     # seconds between iterations; only for a loop
scheduling: parallel             # or `sequential` — see below
variables:                       # available to every phase as {{ variables.x }}
  region: eu-west-1
conditions:
  requires: [hasWorktree]        # waits until the task has these flags
  provides: [hasWorktree]        # sets them when this workflow completes
  clears: [hasWorktree]          # unsets them when this workflow completes
on_fail: development-failure     # runs when a step fails, before the task blocks
phases: [analyse, implement]     # in order
```

**`scheduling`** is about other tasks, not about this workflow's phases — phases are always
sequential. `sequential` means "do not run this alongside other work": at most one sequential
workflow runs at a time, whatever the concurrency cap is. Use it for anything that touches a shared
resource: a port, a database, a deployment.

There is a second rule that serialises work, and the two are independent. A **project** can be set
to work in its own checkout rather than giving each task a worktree, and then at most one of *its*
tasks runs at a time — other projects are unaffected. `sequential` is global and comes from the
workflow; the project rule is per repository and comes from the project. A task waiting at an
approval gate keeps its project's working copy (its uncommitted changes are still in the tree) but
not its share of the concurrency cap.

**`mode: loop`** repeats the workflow rather than moving on to the next one. The task goes back into
the queue after each pass and waits `interval` seconds before it is eligible again. Cancel the task
to stop it.

**Conditions** are flags on the task, set by the workflows that earn them. Nothing in Factory knows
what `hasWorktree` means — a workflow declares that it provides it, another declares that it
requires it, and the scheduler does the rest. Invent your own: `hasSeedData`, `hasReviewedDesign`.

**`override: required`** says a project must supply its own copy of this workflow before it is used.
The built-in `worktree-*` and `environment-*` workflows declare it, because where a worktree goes
and what an environment is made of are facts about your repository and nothing shipped can guess
them. Turning on the matching project setting copies editable versions into `.xaedalon/.factory/`;
until a
project has its own, doctor names the file for any task about to run the built-in.

## Phase

```yaml
kind: factory.phase/v1
name: review
description: A second opinion, then a person decides.
approval: required               # or `none`
working_dir: packages/api        # relative to the workspace
variables:
  scope: api
steps: [...]
```

**`approval: required`** stops the run *after* the phase's steps — the point is to look at what they
produced. The task moves to `awaiting_approval` and the run remembers where to continue. Approving
resumes from the phase after the gate; the phases before it do not run again.

**`artifact`** moved to the agent step that writes it — see below. A phase could only say "something
in here produces this", not which step, and so not which agent to tell.

## Steps

Every step has a kind. `uses:` names it, and most kinds have a shorthand key that lets the common
case fit on one line.

```yaml
steps:
  - run: npm test                # `shell`, via its shorthand

  - uses: shell
    run: npm run build

  - agent: developer             # an agent definition, by name
    artifact: analysis           # → analysis.md, and the agent is told where
    prompt: Work out what needs doing.

  - uses: agent                  # or spell it out, as before
    prompt: Implement what {{ task.artifacts }}/analysis/analysis.md describes.
    provider: claude             # omit to use the configured default
    model: strong                # strong | balanced | fast, or a literal id
    effort: high
    subagent: implementer        # a named persona, mapped per provider
    session: task                # task | workflow | phase | none
    args: ['--verbose']          # appended verbatim

  - uses: worktree
    action: create               # or `remove`
    path: "{{ project.worktrees }}/{{ task.directory }}"
    branch: "{{ task.branch }}"
    from: origin/main            # optional starting point
```

**`retries`** and **`retry_delay`** work on any step, of any kind — core takes them out before the
kind's own schema sees them, so no plugin has to implement retrying to be retryable. `retries: 2`
means up to three runs in all. A step killed by its deadline is *not* retried: it was already given
as long as it was allowed, and doing that three times costs three times as long to reach the same
conclusion.

```yaml
  - uses: agent
    prompt: Implement it.
    retries: 2                   # two extra attempts
    retry_delay: 30              # seconds between them
```

**`model`** is a role rather than an id because ids move — GitHub retired a set of Copilot ids
mid-2026, and the CLI hard-errors on a stale one. Each provider maps `strong`/`balanced`/`fast` to
its own current ids, as data in the plugin. A literal id still works when you need one exactly.

**`session`** decides how much context an agent carries. `task` keeps one conversation across every
step of the task, which is what you want between analysis and implementation. `none` starts fresh,
which is what you want for a reviewer: one that watched the work happen tends to agree with it.

**`uses: worktree`** is idempotent: it does nothing if the directory is already there, uses an
existing branch if there is one, and creates the branch otherwise. Re-running a workflow after a
failure is the common case, not the rare one.

## Variables

`{{ task.name }}`, `{{ task.ticketId }}`, `{{ task.branch }}`, `{{ task.directory }}`,
`{{ project.name }}`, `{{ project.path }}`, `{{ project.branch }}`, `{{ project.worktrees }}`,
and anything you put in `variables:` as `{{ variables.x }}`.

Phase variables beat workflow variables, which beat project values. A recovery workflow also gets
`{{ project.failedWorkflow }}`, `{{ project.failedPhase }}` and `{{ project.failureReason }}`.

## Agent

```yaml
kind: factory.agent/v1
name: developer
description: Writes the code.
provider: claude       # omit and it falls back the way a step's does
model: strong          # a role, or a literal id
effort: high
subagent: implementer
session: workflow
args: []
```

An agent is a name for the settings a step would otherwise spell out every time.
`- agent: developer` on a step borrows all of them, so **the only other thing
that step needs is a prompt** — and the builder stops asking for the rest.

Anything the step does also set still wins, so one phase can raise the effort
without a second agent existing for it. The builder keeps those out of the way
rather than forbidding them: it offers "Override one", and a value already on a
step is always shown.

An agent is not a provider. A provider is *what is installed* — a CLI, its flags,
how a command is rendered. An agent is *how you want to use one*, and several can
share a provider and differ only in model or persona.

## Artifacts

An agent step names a document it will produce:

```yaml
- agent: analyst
  artifact: analysis
  prompt: Work out what the change involves.
```

Always Markdown, always in the task's own directory, so a **name** is the whole
of it. Factory works out the path, appends it to the prompt so the agent knows
where to write, keeps a dated copy of every run, and shows the latest on the
task page.

```
<repo>/.xaedalon/.factory/tasks/<task>/artifacts/analysis/
  analysis.md                          the latest
  versions/analysis-2026-09-13T…Z.md   one per run
```

A step that reads an artifact an earlier phase wrote says so itself, with
`{{ task.artifacts }}`:

```yaml
- agent: developer
  prompt: Implement what {{ task.artifacts }}/analysis/analysis.md describes.
```

A promise that is not kept is recorded and warned about — a step that said it
would write a report and did not is worth knowing about — but it does not fail
the run. Plenty of artifacts are legitimately optional.

Only agent steps may declare one: they are the only kind that can be *told*
where to write. A shell step's output is kept as that step's own log.

## Where files go

| Scope | Path | Precedence |
|---|---|---|
| project | `./.xaedalon/.factory` (found by walking up to the repository root) | highest |
| user | `~/.xaedalon/.factory`, or `$FACTORY_HOME` | middle |
| builtin | inside the installed package | lowest |

Factory is one of a family of Xaedalon products, so its files live under
`.xaedalon/` beside whatever else the family writes. A scope still at the old
`.factory` path is **still read** — `factory doctor` names it and the move that
fixes it, and nothing is relocated for you.

**Always at the project, never in a worktree.** A task's artifacts, the dated
copies of them and this ignore file are all written under the project's own
directory, whatever workspace the steps ran in — a worktree is deleted when the
work in it ends, and an artifact that disappears with the work it describes is
no better than no artifact. Worktrees themselves live *outside* the repository,
beside it, for the same reason a scope discovery must not climb out of one.
What does end up in a worktree is whatever the steps write there, which is a
project's own business: an environment built relative to the working directory
lives and dies with it, deliberately. The exception is `factory run`, which has
no project and so writes its artifacts beside the workspace you give it —
point it at a worktree and its output goes with that worktree.

`.xaedalon/` is ignored from the moment Factory creates it. `factory init` — and registering a
project on the board, which does the same thing — writes `.xaedalon/.gitignore` containing `*`, so
the directory and that file with it are invisible to git and adding a project changes nothing in
`git status`. Most repositories that exist are not using Factory, and trying it on your own machine
should not turn into a commit.

**Sharing is one edit**, and that file says how: replace the `*` with the three lines that ignore
only what a run produced — `.factory/tasks/`, `.factory/state/`, `.factory/.trash/` — and commit
`.xaedalon`. Deleting the file does the same thing; Factory writes the smaller version back the
next time one of its runs produces an artifact. A repository that already shares its definitions is
left exactly as it is: Factory never writes an ignore file over a directory it did not create.

Two consequences of ignoring them are worth knowing. `git clean -xdf` deletes ignored files, which
now means your definitions and the database if it lives in this repository — plain `git clean -fd`
leaves them alone. And your editor probably hides ignored paths in its file tree, so the notice the
board shows after registering a project may be the only place you see the files named.

The same name in two scopes is not an error: the higher one wins, and the fact that it hides another
is reported by `factory why <name>` and by `doctor`. Share `.xaedalon/.factory` and the workflow
travels with the repository.

**Travels, and arrives by itself.** A chain is resolved per *project*, from the path that project
points at — not from the directory the daemon was started in. So adding a repository as a project is
the whole step: its committed workflows, phases and agents are available to its tasks immediately,
with nothing to import, and `factory workflow list` prints `project` beside each. A repository that
gains a scope later is picked up on the next request rather than needing a restart.

The corollary of the default: a clone has whatever was committed and nothing else. A project whose
`.xaedalon/` is still ignored exists on one machine. The same goes for a **git worktree**, which
materialises tracked files only — so a worktree of a project that has not shared its definitions
contains no `.xaedalon/` at all. That breaks no run, because a project's chain is resolved from the
path the *project* points at rather than from the worktree, but `factory run` invoked inside such a
worktree finds no project scope.

[`xaedalon/sample-todolist`](https://github.com/xaedalon/sample-todolist) is a repository that does
this — clone it, add it, and its five-workflow pipeline is there.

What does **not** travel is settings: whether a project uses worktrees or environments, its execution
profile and its default branch are per-installation choices kept in Factory's database and set when
the project is added. Two people cloning one repository can want different answers. Plugins and
provider paths *are* declared in a scope's `config.yaml` (see [`plugins.md`](plugins.md)), but they
are loaded once when the daemon starts and apply installation-wide — a project may define its own
workflows, phases and agents, not its own plugins.

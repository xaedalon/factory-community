# Quickstart

Ten minutes, from nothing to an agent doing work you approved.

## 1. Build and start

Node 24 or newer, pnpm (`corepack enable pnpm`), git. macOS or Linux — on Windows, work inside
WSL2; see [`install.md`](install.md).

```bash
pnpm install
pnpm build                                      # engine, CLI and board
node apps/cli/dist/bin.js init --scope user     # ~/.xaedalon/.factory
node apps/daemon/dist/bin.js                    # serves 127.0.0.1:7317
```

`--scope user` writes `~/.xaedalon/.factory/config.yaml`, plus empty `workflows/` and `phases/`
directories. Without the flag, `init` inside a git repository writes a *project* scope in that
repository — right for a repository's own workflows, wrong for a first run. The daemon opens `~/.xaedalon/.factory/state/factory.db`, corrects anything a previous stop left
half-done, and starts the scheduler.

Check what is still missing before going further:

```bash
factory setup            # what is left, and the command that fixes each one
factory provider list    # the agents, and whether they were found
```

`setup` is the one to run on a new machine. If an agent is installed somewhere Factory cannot find,
it prints the configuration that points at it.

`provider list` marks each agent CLI as available or not. Factory never installs one for you — it
runs the CLI you already have, with the flags that CLI documents.

## 2. Add a project

A project is a repository Factory works in. Add one on the Projects page, or:

```bash
factory project add thing /full/path/to/thing     # --in-place for one task at a time
```

The path is checked when you add it, not when a run fails half an hour later. Use `--in-place` for a
repository where work should happen in the checkout itself rather than in a worktree per task.

## 3. Get a workflow

Import the example, then read it:

```bash
factory bundle import node_modules/@factory/core/examples/development.bundle.yaml
factory workflow show development
```

Or build one in the browser: **Workflows → New workflow**. The builder writes the same YAML, shows
it to you before saving, and refuses to write anything that will not load back.

## 4. Make a task and let it run

On the board: **New task**, give it a name and a branch, pick the project, and assign
`worktree-create` and then `development`. Press **Queue**.

From here nothing needs you until something does:

- the scheduler picks the task up when there is capacity;
- `worktree-create` gives it a worktree of its own, on its branch, and earns `hasWorktree`;
- `development` — which requires that flag — runs analyse, implement and verify in the worktree;
- the review phase writes its notes, and the task stops at `awaiting_approval`.

The board updates as this happens. It is reading a live event stream, not polling.

*Queue all* and *Stop all* appear in the header once a project is chosen — one queues every draft and
blocked task in dependency order, the other halts everything in flight. See
[`task-dependencies.md`](task-dependencies.md).

## 4b. Or do all of that from the terminal

```bash
factory task new "Add due dates" --workflow worktree-create --workflow development \
  --project thing --branch feature/due-dates
factory task list
factory task queue 3f9a1c20
factory task show 3f9a1c20      # state, runs, and what it will accept next
factory task logs 3f9a1c20      # every step of the newest run, and its output
factory task move 3f9a1c20 other-project   # created in the wrong one
```

`factory task` talks to the daemon over the same API the board uses. The eight characters the
listing prints are enough to type; an abbreviation that matches two tasks is refused rather than
guessed at.

## 5. Decide

Open the task. The review note is there as evidence, next to every step that ran and everything it
printed. **Approve** continues from the phase after the gate — the phases before it do not run
again. **Reject** blocks the task with the reason and ends the run it was asked about — a retry
afterwards starts the workflow again rather than continuing past the gate. From the terminal:
`factory task approve 3f9a1c20`.

If a step fails instead, `on_fail` runs the diagnosis workflow first, so the blocked task already
has an explanation attached when you open it.

## What to change first

- **`verify`** runs `npm test`. If that is not your project's command, this is the line to edit.
- **`model: strong`** is a role, not a model id. Each provider maps roles to its own current ids, so
  a phase keeps working when a vendor retires one.
- **the concurrency cap** is three tasks at once. A workflow marked `scheduling: sequential` never
  runs alongside other work, whatever the cap says.

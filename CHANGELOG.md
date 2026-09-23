# Changelog

What changed, per release. The reasoning behind each decision lives in
[`PROJECT.md`](PROJECT.md); this file is the short version, for somebody deciding whether to upgrade.

Versions follow [semantic versioning](https://semver.org). Until 1.0.0 the public surface — the
plugin SDK, the scope layout, the HTTP API — may still move, and a minor bump is where it will move.

## Unreleased

**Factory speaks the Model Context Protocol.** `factory mcp` serves it over stdio, so the coding
agent you already have can resolve the project you are standing in, list what that project can run,
create a task, queue it, follow the run and read what it produced. Point a client at it and there
is nothing else to configure:

```json
{ "mcpServers": { "factory": { "command": "factory", "args": ["mcp"] } } }
```

It is a client of the same HTTP API the board and the CLI use, so every guarantee that was already
there applies without a second copy: the disclaimer gate, the execution profile the project
resolves to, the workspace boundary, and a task's own list of what it will accept next.
[`docs/mcp.md`](docs/mcp.md) is the feature; [`docs/proposals/mcp.md`](docs/proposals/mcp.md) is
what it is built against, including what is deliberately left out.

*What it cannot do:* choose a profile — there is no parameter for one — accept the disclaimer for
you, or approve anything. `approve` and `reject` are not offered at all, because Factory cannot
tell your own session from an agent acting unasked inside it, and an approval an agent can give
itself is not a gate.

*Work that starts work is bounded.* An agent Factory launched could already reach the daemon;
serving MCP makes it ergonomic, so there are now limits on it, enforced by the daemon rather than
by the client asking. Every run records where it came from and how deep it is, every agent process
is told which run and task it is in, and an agent may not act on the task it is running inside or
approve what its own branch asked for.

```yaml
# ~/.xaedalon/.factory/settings.yaml — the defaults
orchestration:
  maxDepth: 3
  maxTasksPerRun: 10
```

*Upgrading:* a migration adds four nullable columns and one with a default of 0. Nothing is deleted
and nothing existing changes meaning — every run recorded before this was started by a person, and
depth 0 says so. `POST /api/tasks` and `POST /api/tasks/:id/actions/:action` now accept an optional
`initiator`, and `GET /api/projects/at?path=` is new: it answers which project a directory is in.

**A task belongs to a project.** `project_id` is required, and removing a project that still has
tasks in it is refused with the count rather than orphaning them. A task with no project ran
wherever the daemon happened to be started, wrote its artifacts beside it, could not be queued as a
batch or given a worktree, and disappeared from the board the moment any project was selected.

*Upgrading:* the migration **deletes tasks that belong to no project**, and everything recorded
about them — runs, logs, artifacts, history. It says how many at boot. Tasks that have a project
keep everything. If you have project-less tasks worth keeping, give them a project before
upgrading. `factory run` is unaffected; it never created a task.

*Also:* adding a project now creates its `.xaedalon/.factory` directory if the repository has none,
because everything a new project does needs it — the reply says whether one was created, and the
board lists it with whatever was copied in. `POST /api/tasks` requires `projectId` and answers 400
without one. `DELETE /api/projects/:id` answers 409 with the count while anything is left in the
project. `factory task new` falls into the only project there is, and otherwise asks which.

**Factory no longer puts anything in your `git status`.** The `.xaedalon/.gitignore` written when
Factory creates that directory now contains `*`, so the directory — and that file with it — is
invisible to git. Registering a project, or running `factory init`, leaves a repository exactly as
it was. Most repositories that exist are not using Factory, and trying it on your own machine
should not turn into a commit.

*Sharing is the opt-in, and one edit:* replace the `*` with the three lines the file names —
`.factory/tasks/`, `.factory/state/`, `.factory/.trash/` — and commit `.xaedalon`. Deleting the
file does the same thing. A repository that already committed its definitions is untouched:
Factory never writes an ignore file over a directory it did not create, and the narrow file it
writes beside an existing one now covers the database and bundle backups as well as task output,
neither of which was ignored before.

*Two consequences worth knowing:* `git clean -xdf` deletes ignored files, so it now takes your
definitions and the database if it lives in that repository — plain `git clean -fd` leaves them
alone. And your editor probably hides ignored paths, so the notice the board shows after
registering a project may be the only place you see the files named.

**`factory doctor` shows what the daemon found.** Half the rules need the database the daemon owns
— the ones about tasks, worktrees and what git can see of a project — and until now nothing printed
them: the command built its own host without a database, and the board declares the endpoint and
calls it from nowhere. It asks a running daemon and merges, deduplicating what both halves found,
and says plainly when there is no daemon to ask.

**Doctor reports what git can see of a project.** Silent for both coherent states — everything
ignored, everything committed — and a finding for the two that are not: a task's artifacts or the
database committed by accident, and definitions committed into a directory that has since been
ignored, where the workflows already there keep working while every new one is invisible.

**The event stream stopped naming its frames.** `GET /api/events` sent each event as an SSE frame
named after the event, which only reaches a client that already knows to listen for that name — so
every consumer kept its own copy of the event vocabulary, and the board's copy had 14 of the 23
names in it. A name missing from such a list is not an error anywhere: the board simply stops
updating for that event. Frames are ordinary `message` frames now, and the name is in the payload
where it cannot go out of date. A client that filtered on the SSE event name should read
`payload.name` instead.

**Plugins can refuse or adjust a definition.** `validateDefinition` and `beforeDefinitionWrite`
have been documented since the plugin host was built and were never called. They now run on the one
path every definition takes to disk — the API, the CLI, a bundle import, and the copies a project
is given when it turns worktrees on.

**A task can be moved to another project.** `PATCH /api/tasks/:id` takes `projectId`, and `factory
task move <id> <project>` takes the project by name. Refused while the task is in flight, and while
anything depends on it — an edge may only join two tasks in the same project.

**A step records the command it ran.** `run_steps.command` holds the rendered argv, shown on the
task page above that step's output. "What did this agent run, and with what authority?" could only
be answered by reading the phase file back, which is a different question once somebody has edited
it. Not the environment: the profile already records how much of it the step could see.

**Adding a project creates its scope.** A repository with no `.xaedalon/.factory` used to leave
every write that asked for the project scope failing with a 500 — including the copies made as the
project is registered. The reply says whether a scope was created, and the board lists it with the
definitions that went inside.

**Exporting a workflow follows `needs`,** not only `on_fail`, so a pipeline is one export rather
than five and a merge by hand.

**Doctor reports a task waiting for something that cannot finish** before it is queued.

**Fixed.** The scheduler's lane and flag gates asked about the newest run's workflow rather than the
one about to run, so a task whose first workflow had finished was admitted on the requirements of
work that was over — agents ran in a project's own checkout, and two `merge` workflows could
overlap; a sequential workflow anywhere but first in a task's list was never serialised at all, and
an approval gate let two of them resume together. Removing a worktree ran inside the worktree it
was removing, which left git with no current directory, so the prune never happened and
`hasWorktree` was never cleared. Rejecting an approval left its run paused for ever, and a retry
afterwards resumed past the gate that had just been refused. `stdin:` on a step was printed and
never opened. A migration that rebuilds a table no longer takes every run, log and history row of
every other task with it.

## 0.1.0 — 2026-09-21

The first release. Factory runs other people's coding agents against your repositories, in an order
you define, with tests, evidence and approval gates in between.

**Orchestration.** Workflows made of phases made of steps, resolved through a layered scope chain —
a project's own definitions, then yours, then the built-ins — so a workflow committed to a repository
travels with it. Tasks carry a list of workflows, `needs:` assembles the rest of the plan from the
one you picked, and `conditions:` decide when a workflow may start. One task can be made to wait for
another, and a blocker that can never finish moves its dependents to `blocked` with the reason rather
than leaving them looking about to run.

**The agents you already have.** Claude Code, Codex and GitHub Copilot, discovered on your PATH and
run as the CLI you already authenticated. No model inside Factory, no API key asked for. An agent
definition names a provider, a model role and a session scope; a step borrowing one can override any
of it.

**Isolation.** A git worktree per task where a project wants one, an environment per task where a
project defines one, and a scheduler that runs a project's tasks one at a time when they share a
working copy.

**What an agent may reach.** Two execution profiles. Default confines a run to its workspace, grants
the artifacts directory explicitly, filters credential-shaped variables out of the environment, and
leads its own process group so one click can stop an agent and everything it started. Full Access
removes the boundary and says so on every page. Nothing runs at all until somebody has read what an
agent run can reach.

**Evidence.** Every run records its steps, its logs and the artifacts its agents wrote, in SQLite
inside the scope. Artifacts live under the project rather than the worktree, so they outlive the work
that produced them.

**The board.** A web interface served from the same process on `127.0.0.1:7317` — tasks as a list or
a board, a workflow and phase editor, dependency editing, the setup checklist, and a **Light / Dark /
System** appearance setting.

**Getting it, and getting rid of it.** Runbooks any of the three agents can follow — `factory-setup`
and `factory-uninstall` — which explain themselves before acting, and stop short of accepting the
security notice or starting an agent for you.

**Known limits, stated rather than discovered.** macOS and Linux are supported and exercised in CI;
Windows needs WSL2, because every shell step is `bash -c` and stopping work signals a POSIX process
group. Node 24 or newer, because the store uses `node:sqlite`. Nothing is published to npm yet — the
CLI is reachable by path or by linking the workspace package.

Thanks to [@arturolinares](https://github.com/arturolinares) for the light theme, and for finding a
broken assertion on `main` that we had missed.

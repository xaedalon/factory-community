# Changelog

What changed, per release. The reasoning behind each decision lives in
[`PROJECT.md`](PROJECT.md); this file is the short version, for somebody deciding whether to upgrade.

Versions follow [semantic versioning](https://semver.org). Until 1.0.0 the public surface — the
plugin SDK, the scope layout, the HTTP API — may still move, and a minor bump is where it will move.

## Unreleased

**A task belongs to a project.** `project_id` is required, and removing a project that still has
tasks in it is refused with the count rather than orphaning them. A task with no project ran
wherever the daemon happened to be started, wrote its artifacts beside it, could not be queued as a
batch or given a worktree, and disappeared from the board the moment any project was selected.

*Upgrading:* the migration **deletes tasks that belong to no project**, and everything recorded
about them — runs, logs, artifacts, history. It says how many at boot. Tasks that have a project
keep everything. If you have project-less tasks worth keeping, give them a project before
upgrading. `factory run` is unaffected; it never created a task.

*Also:* `POST /api/tasks` requires `projectId` and answers 400 without one. `DELETE
/api/projects/:id` answers 409 with the count while anything is left in the project. `factory task
new` falls into the only project there is, and otherwise asks which.

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

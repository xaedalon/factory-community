# Xaedalon Factory

**Don't replace your tools. Orchestrate them.**

Factory runs *other people's* coding agents — Claude Code, Codex, GitHub Copilot — against your
repositories, in an order you define, with tests, evidence and human approval gates in between. It
does not contain a model, it does not want to replace your editor, and it never asks for your API
key: it runs the CLI you already have, the way you already run it.

It is local-first. One process on your machine, a SQLite file for what happened, and a web interface
served from the same process. Nothing leaves the machine unless a step you wrote sends it.

![The task board: six tasks in one project, three finished, one waiting for another, one blocked by a failing test](docs/images/board.png)

```bash
pnpm install
pnpm build                                        # engine, CLI and board
node apps/cli/dist/bin.js init --scope user       # ~/.xaedalon/.factory
node apps/daemon/dist/bin.js                      # http://127.0.0.1:7317
```

Or ask a coding agent to do it: Factory ships a setup runbook they can follow —
`/factory-setup` in Claude Code, or "set up Factory" in Copilot or Codex. It explains itself before
it starts, and stops short of the two decisions that are yours. See
[`docs/install.md`](docs/install.md).

**Requirements:** Node **24 or newer** (the store uses `node:sqlite`), pnpm via
`corepack enable pnpm`, and git. **macOS and Linux** are supported and tested; on Windows use
**WSL2** — steps run through `bash` and work is stopped by signalling process groups, neither of
which Windows provides. See [`docs/install.md`](docs/install.md).

Without `--scope user`, `init` inside a git repository creates a *project* scope in that
repository instead — which is what you want for a repository's own workflows, and not what you
want on your first run.

Then open the board, add the repository you want to work in, and give a task a workflow — or stay
in the terminal:

```bash
factory task new "Add due dates" --workflow worktree-create --workflow development
factory task queue 3f9a1c20        # the short id the listing prints is enough
factory task logs 3f9a1c20         # what ran, and what it printed
factory task approve 3f9a1c20
```

The CLI is a client of the same API the board uses, including the list of actions a task will
accept — so neither can offer a button the other would refuse.

---

## What it is

A **task** is a piece of work — a ticket, an issue, something you typed. It belongs to a **project**
(a repository) and is assigned one or more **workflows**.

A **workflow** is an ordered list of **phases**. A phase is an ordered list of **steps**. A step is
either a shell command, an agent invocation, a git worktree operation, or anything a plugin has
registered. Phases can declare an **artifact** — a file they promise to produce — and can require
**approval** before the workflow continues past them.

```yaml
# ~/.xaedalon/.factory/workflows/development.workflow.yaml
kind: factory.workflow/v1
name: development
conditions:
  requires: [hasWorktree]     # waits in the queue until a worktree exists
on_fail: development-failure  # runs this if a step fails, then blocks the task
phases: [analyse, implement, verify, review]
```

```yaml
# ~/.xaedalon/.factory/phases/review.phase.yaml
kind: factory.phase/v1
name: review
approval: required            # a person decides before anything continues

steps:
  - uses: agent
    model: balanced           # a role, not a model id — ids move, roles don't
    artifact: review          # → review.md; Factory tells the agent where
    prompt: Review the uncommitted changes.
```

A **run** is one attempt at one workflow for one task. Every step it took, everything they printed
and every artifact they promised is recorded, so "what did the agent actually do?" is a question
with an answer.

You never have to write that YAML by hand: the web interface builds workflows, phases and steps
through forms, and shows you the file it will write before it writes it.

## What it does while you are not watching

- **A scheduler** decides what starts: queue order, a concurrency cap, and one rule about lanes —
  a workflow marked `scheduling: sequential` never runs alongside other work. When it passes a task
  over, it says why.
- **Worktrees** keep parallel agents apart. `uses: worktree` creates one per task, on its own
  branch; everything after it runs in there, not in the checkout you are using. A project can opt
  out — work then happens in the repository itself, and that project runs one task at a time,
  because there is no safe way to share a working copy between two agents.
- **Condition flags** gate work on what has actually happened. A workflow declares
  `conditions.provides: [hasWorktree]`, another declares `requires: [hasWorktree]`, and the
  scheduler waits rather than running something that would do damage without it.
- **Approval gates** park a task instead of asking. The run stops, remembers the phase to continue
  from, and waits with its evidence attached where a person will find it.
- **Retries** are a field on any step: agent CLIs fail transiently, and `retries: 2` re-runs the
  step rather than blocking the task for a person to press a button.
- **Reconciliation** at boot closes runs a crash left marked as running, and blocks the tasks that
  were mid-flight — rather than restarting work that may have already pushed a branch.

## Extending it

One mechanism: **capabilities**. A plugin is a package that provides one or more, and core's own
built-ins go through the same door — `shell`, `agent` and `worktree` are registered step kinds, the
three providers are plugins, and every doctor check is a registered rule. If a built-in could not be
expressed as a plugin, the plugin API would be wrong.

```js
// .xaedalon/.factory/plugins/http.mjs, listed in its config.yaml
export default {
  name: 'acme-http',
  version: '1.0.0',
  register(context) {
    context.provide('step-kind', {
      id: 'http',
      summary: 'Makes an HTTP request.',
      schema: /* a zod schema */,
      plan: (step) => ({ describe: `GET ${step.url}`, command: 'curl', args: ['-sS', step.url] }),
    })
  },
}
```

The builder renders a form for that step kind from the schema it published. Nothing in the UI was
taught about it.

## Where things live

Definitions are files, because they are authored, reviewed and committed. They resolve through a
chain of scopes — **project** (`./.xaedalon/.factory`) wins over **user** (`~/.xaedalon/.factory`) wins over the
built-ins shipped in the package — and a definition hiding another is reported, never silent.

A project's directory is ignored by git the moment Factory creates it, so trying Factory on a
repository leaves that repository alone. Sharing the definitions with a team is one edit to
`.xaedalon/.gitignore`, which says how.

A project's directory is ignored by git the moment Factory creates it, so trying Factory on a
repository leaves that repository alone. Sharing the definitions with a team is one edit to
`.xaedalon/.gitignore`, which says how.

Tasks, runs and logs are not files. They are rows in `state/factory.db` in the writable scope,
because they are queried by state and written while something else is reading them.

## Examples

```bash
factory bundle import node_modules/@factory/core/examples/development.bundle.yaml
```

The example is a **bundle**: one file with a workflow and everything it needs, which is also what
`factory workflow export` produces and what the web importer accepts. It ships as an example rather
than as a built-in because a pipeline that runs `npm test` has no business resolving for a Rust
repository — copy it, read it, edit it.

## Setting it up on a new machine

```bash
factory setup
```

Says what is still missing and how to finish it — an agent to run work with, a repository to run it
in, a workflow worth running. It is a registry, so each part contributes what it knows: a provider
plugin knows how its agent is installed, the engine knows whether a repository has been added, Pro
knows whether it is licensed.

Finding an agent is four layers, because a machine is not knowable in advance:

1. **What you configured** — the way out when everything else fails:

   ```yaml
   # ~/.xaedalon/.factory/config.yaml
   providers:
     claude:
       command: /opt/agents/claude-nightly
   ```

2. **PATH** — what "installed" means to whoever installed it.
3. **The usual locations** — Homebrew (both architectures), `~/.local/bin`, bun, volta, nvm and the
   rest, so a fresh machine needs no configuration at all.
4. **And if it is nowhere**, the message names every directory it looked in and the config key above.

## Checking an installation

```bash
factory doctor
```

Reports definitions that do not parse, phases a workflow names that do not exist, an agent CLI that
is registered but not on PATH, a provider descriptor that has not been verified, tasks waiting on a
flag nothing sets, a project whose directory has moved, and a task claiming a worktree that is not
there. Rules are a capability, so a plugin adds its own.

## The interfaces

| | |
|---|---|
| `factory` | Definitions, scopes, plugins, `run`, `doctor`, and `task` — all with `--json` |
| `factory-daemon` | HTTP on `127.0.0.1:7317`, including a live event stream |
| the board | Tasks, runs, logs, evidence, and the builder, at the same address |
| `factory mcp` | The same contract again, for the coding agent you already have |

### From your coding agent

Factory runs coding agents. It can also be driven by one: `factory mcp` serves the Model Context
Protocol over stdio, so Claude Code, Codex, Copilot CLI or anything else that speaks it can resolve
the project you are in, create a task, pick a workflow, queue it and read what came back.

```json
{ "mcpServers": { "factory": { "command": "factory", "args": ["mcp"] } } }
```

It is a control surface, not a way round anything: the same disclaimer gate, the same execution
profile, the same workspace boundary. It cannot approve its own work, and how far work may start
work is bounded by the daemon rather than by the client asking.
[`docs/mcp.md`](docs/mcp.md) is the whole feature.

## Security

Factory coordinates autonomous coding agents that modify files and execute
development commands. The **Default** profile gives an agent broad authority
inside the active project's workspace — read, write, delete, run the tests,
install the dependencies, commit — while confining it to that workspace,
withholding credentials from its environment, and requiring permission for
anything outside. **Full Access** removes those boundaries, is never the
default, is chosen per project, and is marked on screen the whole time it is on.

Factory is not a sandbox, and says so: it constrains what it launches and what
that process can see, and an agent running arbitrary shell commands is not fully
containable by either. [`docs/security/`](docs/security/) sets out what is
enforced, what is not, and — per agent CLI — which of it has actually been
measured rather than read off a help page.

```bash
factory accept --show    # exactly what you are agreeing to
factory stop --all       # stop every agent, and cancel its task
```

## Contributing

The rules here are unusual and load-bearing — the `.feature` files *are* the specification, every
guard is broken and watched to fail before it is trusted, and the open core never imports commercial
code. [`CONTRIBUTING.md`](CONTRIBUTING.md) explains each one and what it cost to learn.

Found a boundary escape or a credential leak? [`SECURITY.md`](SECURITY.md) — privately, please.

## Licence

Apache-2.0, Copyright 2026 Alexander Duran. This is the whole product for a developer working alone, and it
is meant to stay that way: commercial editions add capabilities through the plugin system and are not
permitted to change the meaning of anything here.

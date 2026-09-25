# Installing

Factory is one Node process and a SQLite file. There is no service to register, no container, and
nothing to configure before the first run.

## What you need

| | |
|---|---|
| **Node 24 or newer** | The store uses `node:sqlite`, which does not exist before Node 22.5 and is only settled in 24. An older Node fails at import rather than at install. |
| **pnpm** | `corepack enable pnpm` — the version is pinned in `package.json` (`packageManager`), so corepack fetches the right one. |
| **git** | Factory works in repositories, and the worktree workflows use `git worktree`. |
| **A coding agent, if you want one to run** | Claude Code, Codex or GitHub Copilot CLI. Factory never installs one and never asks for an API key: it runs the CLI you already have. `factory provider list` says which it found. |

## Platforms

**macOS and Linux are supported.** Both are exercised by the test suite in CI, and macOS
additionally by the browser suite.

**Windows: use WSL2.** Not a preference — two things Factory does have no Windows equivalent today:

- every shell step runs as `bash -c '…'`, including the built-in worktree steps;
- stopping work signals a **process group** (`SIGTERM`, then `SIGKILL`), which is how one click can
  stop an agent whose actual work is a grandchild process.

Inside WSL2 both hold, and the board is reachable from a Windows browser at `127.0.0.1:7317`. Native
Windows support means replacing both mechanisms rather than patching around them, and it is not
pretended at until it is measured. See [`../PROJECT.md`](../PROJECT.md) for how this project treats
claims it has not watched fail.

## Or let your coding agent do it

Factory ships a runbook its own kind can follow:
[`skills/factory-setup/SKILL.md`](../skills/factory-setup/SKILL.md). It explains the whole plan
before touching anything, checks the prerequisites, builds, creates your scope, starts the daemon
and proves the board answers — and it deliberately stops short of accepting the security notice or
running anything, because both are yours to decide.

**If you already have this repository**, open your agent in it and ask:

| | |
|---|---|
| Claude Code | `/factory-setup`, or just "set up Factory" |
| GitHub Copilot | "set up Factory" — the CLI discovers the same skill from `.claude/skills/`, and reads `AGENTS.md` and `.github/copilot-instructions.md` too (`copilot skill list` and `copilot instruction list` show what it found) |
| Codex | "set up Factory" — `AGENTS.md` points at the same file |

**If you do not**, give your agent the one file first, then ask it in any directory:

```bash
# GitHub Copilot — it takes a URL directly
copilot skill add https://raw.githubusercontent.com/xaedalon/factory-community/main/skills/factory-setup/SKILL.md

# Claude Code
mkdir -p ~/.claude/skills/factory-setup && curl -fsSL \
  https://raw.githubusercontent.com/xaedalon/factory-community/main/skills/factory-setup/SKILL.md \
  -o ~/.claude/skills/factory-setup/SKILL.md

# Codex
mkdir -p ~/.codex/prompts && curl -fsSL \
  https://raw.githubusercontent.com/xaedalon/factory-community/main/skills/factory-setup/SKILL.md \
  -o ~/.codex/prompts/factory-setup.md
```

One file, three agents, and no second copy of the steps: the per-agent files in this repository are
pointers to that runbook rather than duplicates of it, so a fix to the install path is a fix
everywhere. Read it before you run it — it is a page and a half, and it is the same sequence the
rest of this document gives by hand.

Three more runbooks travel the same way, each swapping its name into the commands above:
`factory-mcp-install` points your agent at Factory over MCP so it can drive Factory rather than only
install it ([`mcp.md`](mcp.md) is what that gets you), `factory-mcp-uninstall` takes that back out,
and `factory-uninstall` removes Factory itself.

## Install

```bash
git clone https://github.com/xaedalon/factory-community.git
cd factory-community
corepack enable pnpm
pnpm install
pnpm build                                      # engine, CLI and board
```

`pnpm build` produces three things: the engine and daemon, the `factory` CLI, and the board that the
daemon serves from the same process. If the board is missing, the daemon starts anyway and says so
on `/` — the API is useful without it.

## First run

```bash
node apps/cli/dist/bin.js init --scope user     # ~/.xaedalon/.factory
node apps/daemon/dist/bin.js                    # http://127.0.0.1:7317
```

Then open `http://127.0.0.1:7317`.

Without `--scope user`, `init` inside a git repository creates a **project** scope in that
repository. That is the right thing for a repository's own workflows and the wrong thing for your
first run, when you want definitions that outlive any one checkout.

`factory setup` is the next command to run: it lists what is missing and the command that fixes each
one, and it asks the engine and the provider plugins rather than guessing.

## Putting `factory` on your PATH

Nothing is published to npm yet, so the CLI is reachable by path (`node apps/cli/dist/bin.js …`) or
by linking the workspace package:

```bash
pnpm --filter @factory/cli link --global        # then: factory task list
```

Undo it with `pnpm --filter @factory/cli unlink --global`.

## Where things are kept

| | |
|---|---|
| `~/.xaedalon/.factory/` | the user scope: `config.yaml`, `workflows/`, `phases/`, `agents/` |
| `~/.xaedalon/.factory/state/factory.db` | tasks, runs, logs and evidence — inside the scope, not beside it |
| `<repo>/.xaedalon/.factory/` | a project's own definitions. Ignored by git when Factory created the directory; committed once somebody shares them — see [workflows.md](workflows.md) |
| `FACTORY_HOME` | overrides the user scope — what the test suites use, and what a second installation on one machine would use |
| `FACTORY_PORT`, `FACTORY_WEB_PORT` | the daemon's port and the dev server's; both default to loopback only |

**Almost everything Factory writes lives under `.xaedalon/`** — the user scope in your home
directory, a project scope in a repository, and the database inside whichever scope is in force.
The database follows the *writable* scope, so a daemon started inside a repository that has its own
`.xaedalon/.factory/` keeps its database there rather than in your home.

**And git is told to ignore all of it.** The `.xaedalon/.gitignore` Factory writes when it creates
the directory contains `*`, so the directory hides itself and registering a project leaves your
`git status` exactly as it was. `git status --ignored` is how you see what is there, and your
editor's file tree probably hides it too. Two things follow: `git clean -xdf` deletes ignored
files, which now means your definitions and the database if it lives in this repository — plain
`git clean -fd` leaves them alone — and `git stash --all` takes them where `git stash -u` does not.
[workflows.md](workflows.md) says how to share them instead.

The exception is **worktrees**, and it is deliberate. A project that gives each task its own
worktree puts them at the path that project stores — by default `.factory-worktrees/<project>`
beside the repository, never inside it, because a worktree is a git checkout rather than a file a
Xaedalon product wrote, and a scope discovery that climbs out of one would find the wrong root.
`factory doctor` reports worktrees it can no longer find, and
[`security/workspace-boundary.md`](security/workspace-boundary.md) explains what that means for what
an agent may reach.

An installation made before that directory was named will have `~/.factory` instead. It keeps
working: the resolver prefers `~/.xaedalon/.factory` and falls back to the old path when only that
exists, database and all. `factory doctor` reports it as a warning and names the command —
`mv ~/.factory ~/.xaedalon/.factory` with nothing running — after which nothing reads the old path
again. A project scope moves the same way with `git mv`.

Nothing listens on anything but `127.0.0.1`, deliberately. A tool that runs coding agents against
your repositories has no business being reachable from the network.

## Uninstalling

```bash
factory stop --all        # agents first: cancelling is what kills their process groups
                          # then quit the desktop app if you have one
kill "$(lsof -ti:7317 -sTCP:LISTEN)"   # the daemon: the one process listening on its port
rm -rf <the checkout>
```

`-sTCP:LISTEN` matters. Without it, `lsof -ti:7317` also lists everything *connected* to the
daemon — a browser tab on the board is one, and each of the desktop application's helpers is
another — so the bare form has four pids on a machine with both open, and `kill` would take the
browser with it.

That is the software. Your **data is a separate decision**, and Factory will not make it for you:

| | |
|---|---|
| the scope | `factory config path` says where it is. `rm -rf <scope>` takes your definitions, settings, accepted notice, any Pro licence, and every task and run — the database holds the only copy of run logs and evidence. |
| a repository's `.xaedalon/` | your files. Usually **none** are committed, because Factory ignores the directory it creates: `git ls-files .xaedalon` says which are, if any, and those go with a commit rather than an `rm`. |
| artifacts | `<repo>/.xaedalon/.factory/tasks/*/artifacts/` — what the agents wrote, and usually the reason to keep a run. |
| worktrees | only if that project uses them, at the path it stores. `git worktree list`, then `git worktree remove` — never `rm -rf`, which leaves `.git/worktrees/` behind. The branches stay; they are your work. |

If you pointed a coding agent at Factory over MCP, that entry is in *its* configuration rather than
anywhere Factory owns, and it outlives all of this — `claude mcp remove factory` and
`copilot mcp remove factory`, or **`/factory-mcp-uninstall`**. Left behind, it points an agent at a
command that is no longer there.

Or ask your agent: **`/factory-uninstall`** in Claude Code, "uninstall Factory" in Copilot or Codex.
The runbook is [`../skills/factory-uninstall/SKILL.md`](../skills/factory-uninstall/SKILL.md) — it
takes an inventory before it stops anything, removes only what Factory installed, and prints the
command for everything that is yours.

## Upgrading

```bash
git pull
pnpm install
pnpm build
```

The daemon migrates its database on start and reconciles anything a previous stop left half-done —
`factory doctor` reports what it found.

---
name: factory-mcp-install
description: Point a coding agent at Factory's MCP server so it can create tasks, start workflows and read runs — choosing between every project on this machine and one repository. Use when the user asks to add Factory to their agent, connect Factory over MCP, or invokes /factory-mcp-install. Not for installing Factory itself (that is `factory-setup`).
---

# Adding Factory to a coding agent

You are pointing a coding agent — Claude Code, the Copilot CLI, or whatever else the person uses —
at `factory mcp`, so that it can resolve the project they are standing in, see what that project can
run, create a task, queue it and read what came back.

This is one entry in that agent's own configuration. It installs nothing, downloads nothing and
changes nothing about Factory: the server is a command that already exists in their checkout.

**Two different things are called a scope around here, and confusing them is expensive.** Factory's
scopes — `project`, `user`, `builtin` — decide which workflows a project gets, and they live in
`.xaedalon/.factory`. This runbook never touches them. What it writes is a *coding agent's own
configuration*: `~/.claude.json`, `~/.copilot/mcp-config.json`, or a `.mcp.json` in one repository.
Name the file rather than saying "user level", and you will not confuse them or yourself.

---

## Rule one: ask where, and say what the answer costs

**Before writing anything**, ask the one question this runbook exists to ask, and lead with the
default:

> Do you want Factory available to your agent **everywhere on this machine**, or **only in one
> repository**?
>
> Everywhere is what I'd suggest: one entry in your agent's own configuration, and it works in every
> project — including directories Factory has never heard of, where it will simply say so.
>
> One repository means a `.mcp.json` file **in that directory**. Three things follow, and none is a
> problem as long as you know: it will show up in your `git status`; Claude Code will hold it at
> *pending approval* until you approve it in a session; and it is Claude Code that reads it — the
> Copilot CLI keeps its servers in your home directory and does not report a repository one. If you
> use both, the everywhere option is the one that covers both.

Take *everywhere* if they do not say. Then proceed without further prompting unless something below
says to stop.

## Rule two: three things are theirs, not yours

1. **Never approve a project-scoped server for them.** Claude Code holds a `.mcp.json` entry at
   `⏸ Pending approval` on purpose — approving a server is agreeing to let it run. Tell them it is
   waiting and how to clear it. This is the same gate as Factory's own security disclaimer, which
   `factory-setup` also refuses to accept on anybody's behalf.
2. **Never commit `.mcp.json`.** Writing it into a repository is a change to their repository. Say
   it is there and let them decide between a commit and a line in `.gitignore`.
3. **Never install a coding-agent CLI.** Configure the ones that are there; report the ones that are
   not and leave them.

---

## 1. Check Factory is here, and how it is reached

```bash
command -v factory                  # a global shim, if they linked one
```

- **It answers** → the entry's command is `factory`, arguments `["mcp"]`.
- **It does not** → find the checkout and use the built CLI by absolute path:
  ```bash
  node <checkout>/apps/cli/dist/bin.js --help | head -1     # must print the usage line
  ```
  The entry is then `node` with `["<checkout>/apps/cli/dist/bin.js", "mcp"]`. **Discover that path;
  never type one from this document** — a checkout lives wherever they put it, and a wrong absolute
  path in a client config fails silently at every session start.

**If Factory is not installed at all**, stop. Say so and point at `factory-setup`, which is the only
copy of those steps. Do not install Factory as part of this.

## 2. Check a daemon is running, and on which port

`factory mcp` talks to the daemon and never starts one. Without it every tool answers
`DAEMON_UNAVAILABLE` and tells the agent to ask a person to start it.

```bash
factory setup                        # its last line says if the daemon is not answering
```

Use `setup` rather than `doctor` for this. `doctor` mentions the daemon only when it has other
problems to report — with nothing else wrong it prints `No problems found.` and returns — whereas
`setup` always ends with *"The daemon is not running, so this is only what the files can tell you."*
when it could not reach one. Measured both ways.

**The port matters more than it looks.** The daemon is at `$FACTORY_URL`, or
`127.0.0.1:$FACTORY_PORT`, default 7317 — and an MCP client starts `factory mcp` with whatever
environment *it* has, not the shell you are standing in.

```bash
echo "${FACTORY_URL:-unset}" "${FACTORY_PORT:-unset}"
```

- **Both unset** → the entry needs no environment.
- **Either is set** → the entry must carry it, or the server will talk to 7317 and find nothing.
  Both commands below take it: `claude … -e FACTORY_PORT=7417`, `copilot … --env FACTORY_PORT=7417`.

**If no daemon is running**, you may still write the entry — say that you have, and that nothing
will answer until they start one. Do not start a daemon for them as part of this; that is
`factory-setup`'s job and its decision.

## 3. Ask Factory which agents can consume an MCP server

Do not carry a list in your head. Factory knows, because each provider declares it:

```bash
factory provider list --json     # "supports" includes "mcp" for the ones that can
factory provider list            # and which of those are installed on this machine
```

Configure every provider that both declares `mcp` and is installed. Today that is Claude Code and
the Copilot CLI; a provider added later will appear here without this runbook changing.

Say which you found before you write anything.

## 4. Write the entry

Use each client's own command. Do not hand-edit JSON: the two clients' configuration files differ in
detail — Copilot's entries carry a `type`, Claude's do not — and each CLI knows its own format.

**Everywhere on this machine** — the default:

```bash
claude mcp add --scope user factory -- factory mcp     # ~/.claude.json
copilot mcp add factory -- factory mcp                 # ~/.copilot/mcp-config.json
```

**One repository** — run from inside that directory:

```bash
cd <the repository>
claude mcp add --scope project factory -- factory mcp  # writes ./.mcp.json
```

**This covers Claude Code and not the Copilot CLI**, and that is worth saying out loud rather than
discovering later. `copilot mcp add` writes the user configuration and takes no repository option,
and although its help says it loads a workspace `.mcp.json` or `.github/mcp.json`, `copilot mcp list`
reports neither — measured, in both that file's shape and Copilot's own. So if they use Copilot too,
offer them the choice honestly: the everywhere entry for Copilot alongside the repository one for
Claude Code, or Factory simply not being available to Copilot there. Do not write a file and claim
it works.

If the CLI is reached by path rather than as `factory`, the command and arguments change and nothing
else does:

```bash
claude mcp add --scope user factory -- node <checkout>/apps/cli/dist/bin.js mcp
```

## 5. Prove it, twice

First, that the client has it:

```bash
claude mcp list         # names "factory"
copilot mcp list        # names "factory", under "User servers:"
```

Check the client you actually configured. For a `.mcp.json` entry Claude Code will say
`⏸ Pending approval` — correct, and not a failure; see rule two. `copilot mcp list` will not name a
repository entry at all, for the reason in step 4.

One failure worth recognising, because it is the commonest and it names itself:

```
factory: factory mcp - ✘ Failed to connect — ENOENT: Executable not found in $PATH: "factory"
```

The entry names a command the client cannot find. Go back to step 1 and use the `node
<checkout>/apps/cli/dist/bin.js` form, which does not depend on a shim being on the client's PATH.

Then that the server itself answers, which is the only check that covers the whole path without a
client:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"check","version":"1"}}}' \
  | factory mcp
# one line of JSON back, with "serverInfo":{"name":"factory",...}
```

**Do not run a bare `factory mcp` as a check.** With a terminal on stdin it prints what it is for and
exits; with anything else it waits for a client, which is exactly right and looks like a hang.

## 6. Hand it over

Report, briefly:

- **what was written, and where** — the actual file, named: `~/.claude.json`,
  `~/.copilot/mcp-config.json`, or `<repo>/.mcp.json`
- **that the daemon has to be running**, and how they start it
- **for a `.mcp.json`**: that it is in their `git status` now, that committing it shares Factory with
  their team, and that Claude Code is holding it until they approve it in a session
- **what the agent can and cannot do** — it can create tasks, queue them and read runs; it cannot
  accept Factory's security notice and cannot approve anything, both of which stay with them.
  [`docs/mcp.md`](../../docs/mcp.md) is the short version
- **anything you could not finish**, named plainly

Then stop. Do not create a project, do not create a task, and do not queue anything.

---

## If they already have it

`claude mcp list` naming `factory` means it is already configured. Say so rather than adding a
second entry. Two things are worth checking rather than re-running:

- the command still resolves — `command -v factory`, or that the absolute path in the entry exists.
  A checkout that moved leaves an entry that fails at every session start.
- the port still matches, if one was pinned.

`claude mcp get factory` prints the entry as it stands.

## What this deliberately does not do

- It does not start a daemon. `factory mcp` never starts one either, and for the same reason: two
  processes opening one database is how a run in flight gets marked failed while its agent is still
  working.
- It does not approve anything, accept anything, or run a workflow.
- It does not edit a client's configuration by hand. If a CLI cannot add the entry, say so and stop
  rather than writing the file yourself.
- It does not touch `.xaedalon/`, the scope chain, or Factory's database. Nothing here is Factory's
  data.

## Reference

[`docs/mcp.md`](../../docs/mcp.md) — what the agent can do once this is done, which project it gets,
and what every refusal means. [`docs/proposals/mcp.md`](../../docs/proposals/mcp.md) — the standard
it is built against. [`skills/factory-mcp-uninstall/SKILL.md`](../factory-mcp-uninstall/SKILL.md) —
the other direction.

# Driving Factory from your coding agent

Factory runs coding agents. It can also be *driven* by one: `factory mcp` is a Model Context
Protocol server, so Claude Code, Codex, Copilot CLI or anything else that speaks MCP can resolve
the project you are standing in, create a task, pick a workflow, queue it, watch the run and read
what it produced.

```bash
factory mcp
```

Nobody types that. An MCP client starts it.

## Setting it up

Point a client at the `factory` command. There is nothing else to configure — no port, no token,
no project id.

```json
{
  "mcpServers": {
    "factory": { "command": "factory", "args": ["mcp"] }
  }
}
```

For Claude Code that is `~/.claude.json` under `mcpServers`, or `claude mcp add factory -- factory mcp`.
Other clients keep the same shape in their own file; the two lines above are all of it.

If `factory` is not on your `PATH`, give the full path to `apps/cli/dist/bin.js` with `node`:

```json
{ "command": "node", "args": ["/path/to/factory-community/apps/cli/dist/bin.js", "mcp"] }
```

**The daemon has to be running.** `factory mcp` talks to it, and never starts one: two processes
opening one database is how a run in flight gets marked failed while its agent keeps working. If
nothing answers, every tool says so and tells the agent to ask you to run `factory-daemon`.

Or have your agent do all of it: **`/factory-mcp-install`** in Claude Code, "add Factory to my MCP
servers" in Copilot. The runbook is
[`../skills/factory-mcp-install/SKILL.md`](../skills/factory-mcp-install/SKILL.md) — it asks whether
you want Factory everywhere or in one repository, checks the daemon and the port first, and says
what it wrote where. [`../skills/factory-mcp-uninstall/SKILL.md`](../skills/factory-mcp-uninstall/SKILL.md)
takes it back out.

## What the agent can do

| | |
|---|---|
| `factory_project_current` | Which project this directory is in, and how it matched |
| `factory_project_get` · `factory_project_list` | One project, or all of them |
| `factory_workflow_list` · `factory_workflow_get` | What this project can run, and what each one needs |
| `factory_phase_list` · `factory_phase_get` | The phases a workflow is made of |
| `factory_task_create` · `factory_task_update` | Make a piece of work, or change its plan |
| `factory_task_list` · `factory_task_get` | What is in the project, and what one task will accept next |
| `factory_task_act` | Queue it, cancel it, retry it, archive it, mark it done |
| `factory_workflow_create` | Write a workflow, or copy one that already exists — with `needs:` to chain it |
| `factory_run_get` · `factory_run_logs` | What happened, and what it printed |
| `factory_approval_list` | What is waiting for you |
| `factory_reliability_get` · `_drivers` · `_history` | How much to trust a task, what is holding it back, and how it got here |
| `factory_reliability_next_actions` | The highest-value thing to do next — `owner: "agent"` means you can do it |
| `factory_reliability_resolve_driver` · `_accept_driver` | Say a finding stopped being true, or record that a risk is being lived with |

**Queueing is what starts work, and cancelling is what stops it.** There is no run to start and
none to cancel: a run is what Factory does with a queued task, and cancelling a task kills its
process group. Both are `factory_task_act`.

**No tool sets a reliability score**, and accepting a critical or high risk is refused for an
agent — the daemon can tell, because Factory stamps the run into every agent process it launches.
An acceptance an agent can grant itself is not a gate, which is the same reason approving is absent.
Resolving is different and is offered: it is a claim evidence can check.

**A task carries the actions it will accept.** The agent is told what a task can do right now and
should use that rather than guess — the same list the board draws its buttons from.

## Which project the agent gets

The one the directory it was started in belongs to. A path anywhere inside a project resolves to
that project, and a path inside one of its worktrees resolves to the project *and* names the task
whose worktree it is.

```
~/projects/app/web/modules/custom  →  the project at ~/projects/app
```

Two projects with an equal claim on one directory are both named rather than picked between, and a
directory that belongs to no project is a refusal that says what to do. A tool call can always name
a project explicitly — by id, by name, or by a path — and that wins over the directory.

## What it cannot do

This is a control surface, not a way round anything.

- **It cannot choose how much authority a run gets.** There is no profile parameter, so there is
  nothing to bypass. A run gets what its project resolves to — see
  [`security/default-profile.md`](security/default-profile.md).
- **It cannot accept the disclaimer.** Queue something before anyone has agreed to what an agent run
  can reach and the agent is told what the disclaimer says and that a person has to run
  `factory accept`.
- **It cannot approve anything.** `approve` and `reject` are not offered. Factory can tell an agent
  it launched from your own session, but it cannot tell your session from an agent acting unasked
  inside it — and an approval an agent can give itself is not a gate, only a delay.
- **It cannot reach around the run it is in.** An agent Factory started may not queue, cancel or
  approve the task it is running inside.
- **It has exactly the authority you do.** The daemon is bound to 127.0.0.1 and has no
  authentication; `factory mcp` inherits that, the same as `factory` and `curl` already do. MCP
  neither widens it nor pretends to narrow it.

## Agents starting work for agents

An agent Factory launched can use Factory, which means work can start work. That is the useful part
— delegate the implementation, delegate its verification — and it is bounded:

```yaml
# ~/.xaedalon/.factory/settings.yaml
orchestration:
  maxDepth: 3          # how far work may start work. 0 means only people start it
  maxTasksPerRun: 10   # how many tasks one run's agent may ask for
```

Factory puts `FACTORY_RUN_ID`, `FACTORY_TASK_ID`, `FACTORY_PROJECT_ID` and
`FACTORY_ORCHESTRATION_DEPTH` into the environment of every agent it starts, and `factory mcp`
reads them from there. So a client's position in the tree is not something it tells Factory — it is
something Factory already stamped. A client outside Factory has none of them and is treated as a
person.

The limits are enforced by the daemon, not by this server. A rule only one client keeps is advice.

## When something goes wrong

Every refusal carries a code and a sentence. The ones worth knowing:

| | |
|---|---|
| `DAEMON_UNAVAILABLE` | Nothing is listening. Start `factory-daemon`. |
| `PROJECT_NOT_FOUND` | This directory is in no registered project. Add it, or name one. |
| `PROJECT_AMBIGUOUS` | Two projects claim this directory. The reply names both. |
| `NOT_ACCEPTED` | Nobody has agreed to what an agent run can reach. `factory accept`. |
| `ACTION_NOT_AVAILABLE` | That is not one of the actions the task offers; the reply lists them. |
| `RECURSION_LIMIT` · `FAN_OUT_LIMIT` | Work started work too deep, or too wide. |
| `SELF_ORCHESTRATION_BLOCKED` | An agent tried to act on the task it is running inside. |

**`factory setup` is the command to reach for**, not `factory doctor`. It always ends by saying
whether it could reach a daemon. `doctor` mentions one only when it has other problems to report:
with nothing else wrong it prints `No problems found.` and returns, so it cannot be relied on for
this. `factory config path` says where Factory's own files are.

**If the client reports a protocol error on startup**, check that nothing else is writing to stdout
— `factory mcp` writes protocol frames there and nothing else, and a shell profile that prints a
banner into a piped command will corrupt the stream.

## Where this is going

[`proposals/mcp.md`](proposals/mcp.md) is the standard this is built against, including what is not
built: `factory_delegate`, MCP Resources, MCP Prompts, an MCP capability policy and a remote
transport. It says what each is waiting on.

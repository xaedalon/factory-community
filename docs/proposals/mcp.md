# Xaedalon Factory — Factory as an MCP server

**Status:** Proposed implementation standard — a target, not a description

**Audience:** AI implementation agents, maintainers, security reviewers
**Scope:** Xaedalon Factory Community
**Primary goal:** Let an MCP-capable coding agent operate Factory programmatically, without giving
that agent a path around Factory's execution profiles, workspace boundary, disclaimer gate,
approvals or accountability model.

---

> **Read this second.** This document is the standard Factory is being built against, and parts of
> it are not built. It is kept here because a public repository should say what it is aiming at,
> not because it describes what ships.
>
> For what is true today:
>
> - [`../mcp.md`](../mcp.md) — the feature as it exists: setup, the tool catalogue, the limits
> - [`../security/default-profile.md`](../security/default-profile.md) — what an agent may do, and
>   what it may not. An MCP-created run is subject to all of it
> - [`../../PROJECT.md`](../../PROJECT.md) — the increment record, including what this cost
>
> **Implemented:** sections 1–14, 16–18 and 21–33 — the transport, the packaging, project
> resolution, the tool catalogue, bounded orchestration, the separation of authority, the profile
> and workspace guarantees, the errors, the tests and the documentation.
>
> **Not implemented, each with a section saying what it is waiting on:** client-declared workspace
> roots (§5), an MCP capability policy (§15), MCP Resources (§19), MCP Prompts (§20),
> `factory_delegate` (§35) and Streamable HTTP (§36).

---

# 1. Why Factory serves MCP

Factory's thesis is **agentic development by orchestration**: it runs the coding agents you already
have, decides when they run, what they work on, what they may touch, who verifies the result, and
what is recorded.

Serving MCP extends that one step:

> Factory is orchestration infrastructure that agents themselves can use.

The experience this is for:

```
Developer
   ↓
Coding agent (Claude Code, Codex, Copilot, …)
   ↓ MCP, over stdio
factory mcp
   ↓ HTTP, 127.0.0.1
Factory daemon
   ├── Projects
   ├── Tasks
   ├── Workflows and phases
   ├── Runs, steps, logs, evidence
   └── Approval gates
```

The developer does not open the board, create every object by hand, or copy ids between systems.
The agent does not become an unrestricted Factory administrator.

---

# 2. The non-negotiable rule

**MCP is a thin control surface over Factory, not a second backend.**

```
MCP tool  →  packages/mcp  →  the daemon's HTTP API  →  Service → Engine → Scheduler → providers
```

MCP handlers must not:

- open the SQLite database;
- duplicate workflow, scheduling or planning logic;
- spawn a provider;
- invent task, workflow or run semantics that the board and the CLI do not have;
- bypass execution profiles, approvals, the workspace boundary or the disclaimer gate.

**Why HTTP rather than in-process.** Factory's application layer is importable, so a second host is
mechanically possible and operationally wrong:

- `createService()` unconditionally runs `reconcile()`, which finishes every `running` run as
  **failed** and blocks its task. A second process starting while a run is in flight corrupts the
  live installation's state.
- The event bus is process-local. A second host's writes would never reach `GET /api/events`, so
  the board would not redraw.
- Process handles are in memory. A second host's `stopAll` reports `signalled: 0` while the agents
  keep running.
- Migrations run on open, so a newer binary would migrate the schema underneath an older daemon.

The CLI settled this already, and its reasoning is the reasoning here:

> Tasks are not files, and the CLI does not open the database: the daemon owns it, and the scheduler
> that decides what runs lives there too. So the CLI is a client of the same API the board uses —
> and everything it can do, the board can do, because there is one contract rather than two.

MCP is the third client of that one contract.

---

# 3. Transport

**stdio, first and for now.**

```bash
factory mcp
```

```json
{
  "mcpServers": {
    "factory": { "command": "factory", "args": ["mcp"] }
  }
}
```

- No extra network service.
- No Xaedalon account.
- Local-first.
- **stdout carries MCP protocol frames and nothing else. Every diagnostic goes to stderr.**

The framing is newline-delimited JSON-RPC 2.0 over an injected duplex, so the whole protocol is
specified without spawning a process — the same discipline that already makes the CLI testable.
The transport sits behind an interface so Streamable HTTP (§36) is a later addition rather than a
rewrite.

**No SDK.** The official `@modelcontextprotocol/sdk` brings express, hono, jose, ajv, cors and a
dozen more into every install of a local-first tool, for a server that speaks stdio. This project
writes a forty-line web route rather than take a static-file dependency, and the same judgement
applies here. The cost is accepted and named: **we own protocol conformance**, and the negotiated
protocol version is asserted in a scenario so a bump is a deliberate, visible change.

---

# 4. Packaging

MCP ships **inside Factory Community**. There is no second install.

```
packages/mcp     the protocol, the tool surface, project resolution
apps/cli         one case in dispatch() — `factory mcp`
```

`packages/mcp` depends on `@factory/core` and `zod`, and on nothing else. It reaches the daemon
through the same `DaemonClient` the CLI uses.

---

# 5. Project context resolution

The requirement:

```bash
cd ~/projects/my-project
claude
```

…and Factory resolves the right project.

Priority:

1. an explicit `project` — id, name or path — in the tool call;
2. the working directory `factory mcp` was started in;
3. longest-prefix ancestor match;
4. an ambiguity error naming the candidates.

**Client-declared workspace roots are not consulted, and that is deferred rather than refused.**
Reading them means the server making a `roots/list` request *of the client*, which is the only
thing in this surface that needs server-to-client correlation — and a stdio server is started in
the directory the person is working in, so it buys nothing today. It is worth doing the first time
a client turns up whose roots differ from its working directory.

So:

```
/home/user/projects/app/web/modules/custom/foo
```

resolves to the registered project at `/home/user/projects/app`, and says how:

```json
{ "projectId": "…", "name": "app", "root": "/home/user/projects/app", "matchedBy": "ancestor" }
```

**The match is served by the daemon, not computed by the client** — `GET /api/projects/at?path=`.
The board and `factory task new` want the same answer, and a client that decided for itself would
drift the first time the rule changed.

**Worktrees resolve too.** A task's worktree lives under the project's `worktreesRoot`, so a path
inside one resolves to the project *and* names the task, from the directory alone:

```json
{ "projectId": "…", "name": "app", "matchedBy": "worktree", "task": { "id": "…", "name": "…" } }
```

That second half is not a convenience. It is an identity Factory can check that no client can claim
for itself — see §16.

**Never pick arbitrarily.** Two candidates is an error with both names in it.

---

# 6. Tool design

Tools are strongly typed, schema-validated, small, domain-oriented, stable and safe by default.

- Naming: `factory_<noun>_<verb>`, snake case.
- Schemas are written in zod and published as JSON Schema with `z.toJSONSchema()` — the same
  mechanism the daemon already uses to publish step-kind schemas to the builder, so there is one
  way to describe a schema to a client.
- Not every internal method is exposed. A tool exists because an agent needs it, not because a
  route exists.

**A naming hazard, because three different things here are called "tool":**

| | |
|---|---|
| a **task tool** | a button on a task — `POST /api/tasks/:id/tools/:tool` |
| a provider's `supports: mcp` | that agent CLI can *consume* MCP servers |
| an **MCP tool** | what Factory *serves*, and what this document is about |

Every document and feature file says which one it means in its first paragraph.

---

# 7. The tool catalogue

| Tool | What it does |
|---|---|
| `factory_project_current` | Resolve the project from the current context; says how it matched |
| `factory_project_get` | One project, by id, name or path |
| `factory_project_list` | Every registered project |
| `factory_task_list` | Tasks, filtered by project, state or activity |
| `factory_task_get` | One task: state, runs, progress, blockers, artifacts, workspace, and the actions it currently offers |
| `factory_task_create` | A new task in a project, optionally with workflows |
| `factory_task_update` | Name, description, workflows, project |
| `factory_task_act` | Do one of the actions the task offers |
| `factory_workflow_list` | Workflows available to a project, with what each needs |
| `factory_workflow_get` | One workflow, and where it came from |
| `factory_workflow_create` | Write a workflow; `from:` copies an existing one |
| `factory_phase_list` / `factory_phase_get` | Phases, as definitions |
| `factory_run_get` | A run with its steps and evidence |
| `factory_run_logs` | Bounded output, by run or by step |
| `factory_approval_list` | What is waiting for a person, and why |

**There is no `factory_run_start` and no `factory_run_cancel`, deliberately.** Nothing in Factory
starts a run directly: queueing a task is what starts work, and cancelling a task is what stops it —
the engine kills the process group on any transition to `cancelled`. Both are `factory_task_act`,
and a second path would be a second way to do something that already has a way.

**`factory_task_act` is one tool, not eight.** The daemon serves a task's available actions and the
tool offers exactly those. A client that kept its own copy of the state machine would disagree with
the board the first time the rules changed.

---

# 8. What Factory does not have, and what that means

Honesty about the model matters more than a tidy tool list.

| The word | In Factory |
|---|---|
| **Approval** | Not an entity. A phase declares `approval: none \| before \| after`; the engine has nobody to ask, so it *parks* the run and moves the task to `awaiting_approval`. Approving and rejecting are task actions. `factory_approval_list` is that state plus the paused run and the phase it stopped at. |
| **Phase** | First-class as a *definition* — its own kind, directory, schema and routes. Not first-class in persistence: a run step records a phase *name*. So phases are read and written as definitions, and no phase table is invented for MCP. |
| **Resource** | Does not exist. See §19 and `execution-profiles.md` §33. |
| **Strategy** (bug-fix, feature, research) | Does not exist. A workflow is the unit. Inventing a strategy vocabulary inside MCP would be exactly the MCP-only semantics §2 forbids — see §35. |
| **Run ancestry** | Did not exist; this standard adds it. See §10. |

---

# 9. Runs are asynchronous

Queueing a task returns immediately. The scheduler admits work on its own and hands it to the
engine without waiting.

MCP must never block a tool call for the duration of a workflow. Monitoring is
`factory_task_get`, `factory_run_get` and `factory_run_logs`.

A queued task that is not running yet says why, in the scheduler's own words — *at capacity*, *the
project runs one task at a time*, *a sequential workflow is already running*, *a required flag is
not set*, *a task it depends on is not done*. That sentence is served, never re-derived.

---

# 10. Ancestry and bounded orchestration

MCP makes recursion easy:

```
Agent A  →  factory mcp  →  Task/Run B  →  agent  →  factory mcp  →  Task/Run C
```

An agent Factory launched could already reach the daemon — it is on 127.0.0.1, there is no auth,
and `FACTORY_URL` survives the credential filter. MCP does not create that reach; it makes it
ergonomic, which is reason enough to bound it.

**Every run carries where it came from:**

```
run.origin_run_id      the run whose agent asked for this work
run.depth              0 for work a person started
task.created_by        a label, e.g. "mcp:claude-code/2.1"
task.created_by_run_id the run whose agent created it
```

```
Run 100   depth 0
└── Run 101   depth 1
    └── Run 102   depth 2
```

**Limits**, per installation, in settings:

```yaml
orchestration:
  maxDepth: 3
  maxTasksPerRun: 10
```

Exceeding one is refused with an actionable error, recorded, and changes nothing that is already
running.

**The limits are enforced by the daemon, not by the MCP client.** The precedent is the disclaimer
gate, which lives in the route for the same reason:

> it is here rather than in the browser because the browser is not the only client: the CLI and
> `curl` start runs too, and a disclaimer only the web app enforces is advice rather than a gate.

---

# 11. Self-orchestration

An agent must not be able to deadlock or recurse into its own run.

**Deterministic rule:** an initiator may not `queue`, `cancel` or `approve` the task it is itself
running inside. The refusal names the task and says what to do instead — delegate to a new task, or
let the run finish.

This is not a heuristic, because the identity is not self-reported (§16).

---

# 12. Approval separation of authority

> **An agent cannot approve escalation of its own authority.**

This flow must fail:

```
Agent asks Factory for work  →  the run parks at an approval gate  →  the same agent approves it
```

The rules, in the daemon, for every client that carries an initiator:

- an initiator may not approve the task it is running inside;
- an initiator may not approve a task it created;
- nor any task whose creator is in its own ancestry chain;
- MCP never creates an approval bypass.

**And over MCP, `approve` and `reject` are not offered at all.** That is stronger than the rules
above, and it is the only form that does not depend on knowing who is typing: Factory can tell an
agent it launched from a person's own session — the first carries the run it is inside, the second
carries nothing — but it cannot tell a person's session from an agent acting unasked *in* that
session, because they are the same process with the same environment.

`factory_approval_list` reports what is waiting. A person answers it, at the board or from a
terminal.

This is why the initiator is recorded on the **task**, not only on the run.

---

# 13. Execution profiles

An MCP-created run uses Factory's normal profile resolution: project → installation → `default`.

**MCP is given no profile lever at all.** `factory_task_create` and `factory_task_act` take no
profile parameter, so there is nothing to bypass and nothing to audit. Changing a project's profile
stays with the board and the CLI, where a person is.

Queueing before the installation has accepted the disclaimer is refused, and the MCP error carries
the disclaimer text so the agent can tell its human to run `factory accept`. Stopping work is never
gated — refusing to stop something because nobody agreed to a notice is the most hostile possible
reading of a safety feature.

---

# 14. Workspace and resource policy

Everything an MCP-triggered run does is subject to what already applies:

- the workspace boundary, and the canonical-path checks behind it;
- the credential-filtered environment;
- the provider's own permission flags;
- standing directory grants;
- denial reporting, and the parking of a run that failed *and* was refused something.

**MCP adds no filesystem or shell authority of its own.** It creates tasks and moves them through
states; the work is done by the same engine, in the same workspace, under the same profile.

---

# 15. An MCP capability policy — not implemented

A future installation may want to say what an MCP client may *ask* for, separately from what the
resulting run may *do*:

```yaml
mcp:
  project_read: allow
  task_create: allow
  task_act: allow
  workflow_create: allow
  approval_respond: restricted
```

Two distinct questions, and both would be enforced:

1. may this client request this Factory operation?
2. what authority does the resulting run have?

Not built. Today the answer to (1) is "whatever the daemon's API allows any local client", which is
the CLI's authority, and (2) is §13.

---

# 16. Session and initiator metadata

Captured where available: client name, client version, MCP protocol version, session id, workspace
roots.

**Self-reported metadata is used for labels and never for authority.** A client that calls itself
anything at all still cannot approve its own work, because its position in the orchestration tree
comes from two things it does not control:

- the environment Factory stamped into the agent process it launched —
  `FACTORY_RUN_ID`, `FACTORY_TASK_ID`, `FACTORY_PROJECT_ID`, `FACTORY_ORCHESTRATION_DEPTH`;
- the worktree its working directory resolves to (§5).

---

# 17. Errors

Actionable, and never a bare status.

Bad:

```
500
```

Good:

```
Cannot resolve a Factory project from the current directory.

  /home/user/tmp

Run the agent from a registered project, or pass project.
```

Codes:

```
PROJECT_NOT_FOUND
PROJECT_AMBIGUOUS
TASK_NOT_FOUND
WORKFLOW_NOT_FOUND
RUN_NOT_FOUND
VALIDATION_ERROR
NOT_ACCEPTED
ACTION_NOT_AVAILABLE
RECURSION_LIMIT
SELF_ORCHESTRATION_BLOCKED
APPROVAL_SEPARATION
DAEMON_UNAVAILABLE
```

The sentence is the one the daemon wrote. Secrets never appear in an error, and neither does a path
the caller did not already supply.

---

# 18. Tool output

Optimised for an agent: structured, stable ids, explicit state, a short summary, and what to do
next.

```json
{
  "runId": "…",
  "state": "awaiting_approval",
  "task": { "id": "…", "name": "Fix the updater race" },
  "phase": "publish",
  "approval": { "required": true, "byAPerson": true },
  "next": "A person has to approve this. You cannot: you created it."
}
```

No raw object dumps. Logs, runs, tasks, projects and workflows are all bounded and paginated, and
a truncated log says how much it lost.

---

# 19. MCP Resources — not implemented

Read-only state could be exposed as MCP Resources:

```
factory://project/current
factory://project/{id}
factory://task/{id}
factory://run/{id}
```

Not built, and not built mechanically: a resource for every tool would be two surfaces to keep in
step, which is this codebase's recurring failure. It is worth doing only where it improves
interoperability with a client that prefers resources, and that case has not been measured yet.

Separately, and confusingly close in wording: `execution-profiles.md` §33 proposes MCP servers as
Factory **resources** an agent may be *given*. That is the other direction, and also unbuilt.

---

# 20. MCP Prompts — not implemented

Reusable prompts (`delegate-feature`, `verify-current-change`) may be useful. Operational behaviour
must never depend on them. Tools are the required interface.

---

# 21. Daemon lifecycle

`factory mcp` **connects to a daemon and never starts one.**

Nothing in this repository has ever started a daemon on a user's behalf, and a silently duplicated
daemon means two processes reconciling and migrating one database. When none is listening, every
tool returns `DAEMON_UNAVAILABLE` with the sentence the CLI already uses:

```
Cannot reach the Factory daemon at http://127.0.0.1:7317.
Start it with "factory-daemon", then try again.
```

---

# 22. CLI integration

```bash
factory mcp          # serve, over stdio
factory doctor       # includes the MCP checks
```

`factory doctor` already carries the only MCP-relevant thing that is a *problem*: whether a daemon
is answering, which it says when it cannot merge the running checks. Nothing else here has a
failure state — a directory that resolves to no project is the ordinary case in a home directory,
and an orchestration limit is a setting rather than a fault.

So no MCP doctor rule ships, and a separate `factory mcp doctor` was considered and refused: one
command that tells you what state your installation is in is better than two, and a check that
fires on normal use is a check people learn to ignore.

---

# 23. Logging

```
stdout  →  MCP frames only
stderr  →  diagnostics
```

Useful fields when a diagnostic is written: session, tool, project id, task id, run id, duration,
result, error code. **Never a secret, and never a token-shaped value.**

---

# 24. Configuration

MCP requires no setup beyond pointing a client at `factory mcp`. Nobody wires project ids into a
client config; workspace-based resolution (§5) is what makes that unnecessary.

Optional, in settings:

```yaml
orchestration:
  maxDepth: 3
  maxTasksPerRun: 10
```

---

# 25. Tests

The `.feature` files are the specification. There are no separate spec documents.

**Protocol.** Handshake and version negotiation, tool listing, a call, a malformed frame, an
unknown method, a notification, and **stdout carrying frames only while diagnostics go to stderr**.

**Project resolution.** Explicit id; a declared root; the working directory; an ancestor; a
worktree resolving to its project and its task; two candidates refused by name; nothing matched.

**Tools.** Each tool's input schema, output shape, `next` sentence, and every error code.

**Security.** MCP cannot select a profile; an agent cannot approve its own escalation; depth and
fan-out are refused at the daemon; an ambiguous context never picks a project; malformed input is
rejected; nothing secret reaches an output or an error.

**Regression.** The board and the CLI still pass, on both platforms, plus the browser suite and the
first-run job.

Every guard is broken deliberately and watched to fail before it is trusted, with `pnpm mutate`,
and the pull request says which.

---

# 26. Manual verification

A suite cannot tell you whether a real client connects. So, in a throwaway installation with its
own scope and port:

1. a real MCP-capable agent connects and lists the tools;
2. it resolves the project from a subdirectory;
3. it creates a task, inspects workflows, picks one, queues it;
4. it reads the run and bounded logs;
5. it meets the disclaimer gate before the installation has accepted it;
6. it meets an approval boundary and cannot answer it;
7. cancelling actually kills the process group — checked with `ps`, not with a database row.

A client that was not run is listed as **unverified**. Compatibility is never claimed from a
specification.

---

# 27. Documentation

| | |
|---|---|
| [`../mcp.md`](../mcp.md) | What exists: setup per client, the tool catalogue, resolution, limits, troubleshooting |
| this file | What it is being built against |
| [`../../PROJECT.md`](../../PROJECT.md) | Why it is shaped this way, and what it cost |

The README carries one short section, because a person choosing Factory should know they can drive
it from the agent they already have.

---

# 28. Example use cases

**Delegate implementation.** The agent resolves the project, creates a task, lists the workflows
the project offers, queues it, and reports the run id. Factory coordinates the rest.

**Verify a change.** The agent creates a task pointed at a verification workflow, queues it, polls
the run, and reads the evidence.

**Parallel research.** The agent creates several tasks and queues them; the scheduler runs what
capacity and the project's own rules allow, and the fan-out limit bounds the rest.

---

# 29. Performance

Reads are one HTTP call to a process on the loopback interface. Starting work returns a scheduling
acknowledgement, never a completed workflow. Logs, runs, tasks, projects and workflows are bounded
and paginated. No tool returns a large payload; artifact *content* is one explicit call away from
the listing that names it.

---

# 30. Backward compatibility

MCP adds routes and columns; it changes no existing contract. Where it needed something the
application layer did not expose — resolving a path to a project — that was added to the daemon for
every client rather than computed inside MCP.

---

# 31. Community and Pro

Factory MCP is **Community**. Basic MCP orchestration is not a paid feature.

Pro may later add convenience — configuring clients from the desktop app, richer diagnostics, a
visualisation of an orchestration tree — through the plugin SDK, like anything else.

---

# 32. No provider lock-in

The surface speaks Factory's vocabulary: project, task, workflow, phase, run, agent, provider,
approval. Never `claudeTask`, never `claudeRun`. The same tools serve every client and every
provider.

---

# 33. Local-first

```
local MCP client  →  local `factory mcp`  →  local Factory daemon
```

No Xaedalon service, no account, no source leaving the machine.

**One thing said plainly rather than implied:** the daemon has no authentication. It is bound to
127.0.0.1 and has exactly the authority of whoever started it. `factory mcp` inherits that
authority, which is the same authority `factory` and `curl` already have. MCP does not widen it,
and does not pretend to narrow it.

---

# 34. Out of scope

A cloud MCP gateway, a Team control plane, enterprise auth, a public MCP registry, remote agent
hosting, and a second workflow engine. None of them is needed for a robust local implementation,
and each would make one harder.

---

# 35. `factory_delegate` — deferred, and why

The attractive version:

```json
{ "objective": "Implement OAuth support", "strategy": "feature", "verification": "standard" }
```

Factory has no `strategy` and no `verification` vocabulary. A workflow is the unit, and workflows
come from the scope chain — a project's own, the user's, the built-ins. Mapping "feature" to a
workflow inside MCP would put a vocabulary in the control surface that the board and the CLI do not
have, which is the MCP-only semantics §2 forbids.

**What it is waiting on:** a first-class notion of a workflow *template* or *intent* in core, that
the board and the CLI use too. When that exists, `factory_delegate` is a thin call over it. Until
then, `factory_workflow_list` plus `factory_task_create` is one extra round trip and no invented
vocabulary.

---

# 36. Streamable HTTP — deferred

stdio covers the local case, which is the case Factory is for. The transport is behind an interface
so HTTP is an addition rather than a rewrite. It is not built because a remote MCP endpoint on a
daemon with no authentication would be the single worst thing in this repository.

---

# 37. Definition of done

A developer runs:

```bash
cd ~/projects/example
<their MCP-capable agent>
```

and the agent can connect, resolve the project, inspect workflows, create a task, queue it, query
it asynchronously, read bounded logs and evidence, see what is waiting for a person, and cancel —

while Factory guarantees:

```
MCP cannot bypass execution profiles
MCP cannot bypass the workspace boundary or the credential filter
MCP cannot select Full Access
MCP cannot bypass the disclaimer gate
an agent cannot approve its own escalation
an agent cannot queue, cancel or approve the task it is running inside
recursive orchestration is bounded, by the daemon
the board and the CLI are unchanged
stdout stays protocol-clean
inputs are validated and errors are useful
```

---

# 38. Final principle

> Factory is successful here when it can be operated by both people and agents through the same
> orchestration model, and an agent's route in is not a route around the profiles, permissions,
> approvals, boundaries, limits and accountability that apply to everybody else.

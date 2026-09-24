# What Factory already has

The Reliability specification asks for an audit before any code is written (§76), because the
fastest way to get this wrong is to build a second copy of something Factory already does. This is
that audit: every component the feature touches, what it is today, and what happens to it.

Read with [`../../Reliability-System-Plan-CLAUDE.md`](../../Reliability-System-Plan-CLAUDE.md),
which is the adapted plan and records where it departs from the specification.

**Classification:** `REUSE` — used as it is · `EXTEND` — gains something · `NEW` — did not exist ·
`OUT_OF_SCOPE` — deliberately untouched.

---

## Task model and storage

| | |
|---|---|
| **Where** | `packages/core/src/task/state.ts` · `packages/store/src/tasks.ts` |
| **What it is** | Eight states with one transition table (`MOVES`), and `TaskRepository.act()` as the single door every state change passes through. Workflows per task are rows with a stable `entry_id`; flags are rows; `progress` is **derived per request** in the daemon, never stored. |
| **Verdict** | `REUSE` |

`MOVES` is the model for the driver status table — one table, no transition anywhere else. `progress`
being derived is the precedent for deriving the current reliability projection rather than storing
it.

**`task_history`** (`migrations.ts:43`) is the closest existing analogue to an assessment history:
insert-only, ordered by `id`, never updated, cascade-deleted with the task. `REUSE` as a pattern.

---

## Workflow and run model

| | |
|---|---|
| **Where** | `packages/core/src/run/runner.ts` · `packages/engine/src/engine.ts` · `packages/store/src/runs.ts` |
| **What it is** | `runPlan` returns `RunResult { status, steps, problems, skipped, denials }`. `StepOutcome` carries `exitCode`, `timedOut`, `attempts` and `denials`. The engine records runs, steps and logs, collects evidence, then decides a verdict. |
| **Verdict** | `REUSE` — it is the entire input side |

`RunStatus` already distinguishes `completed · failed · declined · timed-out · refused`, and
`RunResult.denials` already de-duplicates refusals across a run. A refused *command* already parks
the run. This is exactly the material a deterministic evaluator needs, and none of it is currently
kept past the run.

---

## Evidence and artifact model

| | |
|---|---|
| **Where** | `packages/core/src/task/paths.ts` · `packages/store/src/runs.ts` (`attachEvidence`, `artifactsForTask`) · `Engine.#collectEvidence` |
| **What it is** | An agent step declares `artifact: <slug>`; the file is `…/tasks/<dir>/artifacts/<name>/<name>.md`, under the **project** so it outlives the worktree. After a run the engine stats and reads each one, writes a dated copy under `versions/`, and stores it in `run_evidence` with a 256 KB content budget, marking `missing` or `truncated` rather than dropping it. |
| **Verdict** | `REUSE`, referenced and never copied |

This is a real evidence model and the specification's §19 list is mostly satisfied by it: a document
exists or does not, has a size, has versions, and is attributable to a run and a phase.

What it cannot express is a *result* — a test that passed, a command that was refused, a gate that
failed. Those live in `run_steps.exit_code`, `run_logs` and `RunResult.denials`, and the last of
those is never persisted at all.

**`reliability_observations` is `NEW` for exactly that gap**: a small normalised note of what an
assessment saw, referencing artifacts by path rather than duplicating them. Without it the
explanation of a score cannot be reconstructed once the logs have been trimmed.

---

## Event system

| | |
|---|---|
| **Where** | `packages/events/src/index.ts` · `apps/daemon/src/routes/events.ts` |
| **What it is** | One typed registry, `FactoryEvents`, currently 23 names. `EventBus.emit` is synchronous and ordered; a throwing subscriber is reported, never propagated. `GET /api/events` streams the bus **verbatim** over SSE with the name in the payload and no `event:` field. |
| **Verdict** | `EXTEND` — eleven `reliability.*` names added to the registry |

The absent `event:` field is load-bearing here: a new event name needs no client change to reach
every open board. Every page already reloads on any event.

**Hooks influence, events report** (binding rule 10). Assessment changes nothing about the run, so
it is not a hook. It is called directly by the engine and reports what it did as events.

---

## Where a post-run subsystem hooks in

`Engine.#runOne`, immediately after `#collectEvidence` and before the verdict switch. The comment
already there states the reason, and it is the same one: *collected before the verdict is recorded,
so evidence is already there when the task lands in front of a person.*

A `run.completed` subscriber was considered and rejected: that event is emitted **inside**
`RunRepository.finish`'s transaction, so a subscriber that writes must defer with `queueMicrotask`,
and the ordering against the verdict becomes a race. `EXTEND` the engine.

---

## UI task layout and right sidebar

| | |
|---|---|
| **Where** | `apps/web/src/pages/TaskDetailPage.vue` |
| **What it is** | A two-column body. The wide column holds evidence, the plan and the steps, ordered with `:style="{ order: N }"`. **A right sidebar already exists** — `data-testid="task-rail"`, 21rem — holding the workspace, dependencies, artifacts, runs and history. Only the workspace section has card chrome. |
| **Verdict** | `EXTEND` |

The card goes first in the rail, reusing the workspace card's chrome. The graph and the drivers list
go in the wide column with their own `order`. Nothing needs restructuring.

The page reloads wholesale on any event behind a 120 ms debounce, so reliability updates arrive with
no client change.

---

## Graph and chart library

**There is none.** The only `<svg>` in the application is `AppIcon.vue`. No chart dependency, no
`polyline`, no `viewBox` anywhere else. The nearest prior art is the progress bar, hand-written from
two spans and a `--color-track` background, repeated in three places.

**Verdict: `NEW`, hand-rolled SVG.** `CONTRIBUTING.md` rejects a dependency without a sentence on why
it is worth the install, and one polyline with points on it is not that sentence.

`--text-metric` (30px, line-height 1) already exists in `tokens.css` for a single large number,
which is precisely the score.

---

## `.xaedalon/.factory` conventions

| | |
|---|---|
| **Where** | `packages/config/src/scopes.ts` · `packages/core/src/task/paths.ts` |
| **What it is** | `SCOPE_DIR = '.xaedalon/.factory'`. Scopes layer project → user → builtin, first match per name, and every resolution carries what it shadows. **Every path in the product flows from `scopes.ts`**, enforced by an eslint ban on `process.cwd()`, `os.homedir()` and `os.tmpdir()` everywhere else. |
| **Verdict** | `REUSE` |

The specification's suggested `.xaedalon/factory/tasks/<id>/reliability.json` is not adopted — see the
plan's decision table. The database already sits under this scope at `state/factory.db`.

---

## Schema and version conventions

| | |
|---|---|
| **Where** | `packages/store/src/migrations.ts` · `migrate.ts` |
| **What it is** | An ordered list stamped into `PRAGMA user_version`, sequential from 1 with **no gaps**, each in its own transaction. Editing a shipped migration is forbidden. Highest today is **20**. |
| **Verdict** | `EXTEND` — migration 21 |

Conventions the new tables follow: nullable means *nobody has said* and must differ meaningfully
from a default; prose is `NOT NULL DEFAULT ''` so a token never resolves to `"null"`; booleans are
`INTEGER NOT NULL DEFAULT 0|1`; timestamps are ISO-8601 `TEXT`.

**JSON in a TEXT column** follows `projects.granted_directories`: written with `JSON.stringify`,
read through a total parser that never throws and degrades to empty, so a hand-edited row cannot
make a task unloadable. It is used only for a small set read whole with its owner and never queried
across owners — `task_dependencies` is the counter-example that earned a table instead.

---

## CLI

| | |
|---|---|
| **Where** | `apps/cli/src/main.ts` · `commands/` · `daemon.ts` |
| **What it is** | Hand-rolled argument parsing, one `switch` in `dispatch`, one `USAGE` literal. Commands return `CommandResult { lines, exitCode, json? }` and never exit. `--json` is applied once at the end. **The CLI does not open the database** — it is an HTTP client of the same API the board uses, and says so when there is no daemon. |
| **Verdict** | `EXTEND` — one new command file, one `case`, `USAGE` lines, one scenario |

---

## Local API

| | |
|---|---|
| **Where** | `apps/daemon/src/routes/` · `apps/daemon/src/service.ts` |
| **What it is** | Routes are thin adapters; `server.ts` states the rule that anything implemented in a route is something the open core cannot offer. `{ error }` with 400/404, `{ problems }` when a validator produced them, **409 for a well-formed request the state refuses** — carrying the extra keys a client acts on. Actions ride on every task payload and are validated against that same list before being performed. |
| **Verdict** | `EXTEND` — a new route file, and a `reliability` summary on the task detail payload |

`Service` is where the repositories, engine and scheduler are wired, and where the stateful doctor
rules are contributed as a plugin through `runtime.load`. The reliability repository joins it there.

---

## MCP

| | |
|---|---|
| **Where** | `packages/mcp/src/` |
| **What it is** | Sixteen tools built with `defineTool`, zod schemas published as JSON Schema. `FactoryApi` is HTTP only — no database, no engine. A refused tool is a **result** with `isError`, not a protocol error. |
| **Verdict** | `EXTEND` — six tools |

The authority model is already built and is reused rather than restated: `AGENT_ACTIONS` excludes
`approve` and `reject` because Factory cannot tell a person's session from an agent acting unasked
inside it; `initiatorFrom` reads the run Factory stamped into the agent's environment and attaches
it to every mutation; and the daemon enforces independently, *because a rule only one client
enforces is advice*. Accepting a high-severity driver joins that list.

---

## Execution profiles

| | |
|---|---|
| **Where** | `packages/core/src/security/profile.ts` · `denials.ts` |
| **Verdict** | `REUSE`, and it is an evidence source |

`resolveProfile({ project, installation })` is the precedent for project-over-installation
resolution, which the agent evaluator's model setting copies exactly — absent is not the same as the
default.

`Denial { id, describe, path?, command?, evidence }` is already the shape of an actionable finding
with a remedy. A refused command becomes a regression or environment driver directly, with its
`evidence` as the driver's evidence and the CLI's own words rather than a paraphrase.

---

## Provider abstraction

| | |
|---|---|
| **Where** | `packages/core/src/providers/` · `packages/plugins/provider-*/` |
| **What it is** | A provider is a descriptor, not a class: flags, model roles and capabilities are data. `render(request)` produces argv. `permissionArgs` is read in exactly one place. A provider may also supply a structured-output reader. |
| **Verdict** | `REUSE` — the agent evaluator renders through it like any other agent step |

Model **roles** (`strong` / `balanced` / `fast`) rather than ids are what let a project name a
powerful model without naming a version that will be retired.

---

## Workflow completion hooks

There is no hook seam after a run — `HookRegistry` covers definition validation and writes only. The
engine calls its post-run work directly. `EXTEND` the engine; do not invent a hook, because a hook
that cannot influence anything is an event (binding rule 10).

---

## Definition schema and serialization

| | |
|---|---|
| **Where** | `packages/core/src/schema/workflow.ts` · `fields.ts` · `yaml/serialize.ts` |
| **Verdict** | `EXTEND` — an optional `reliability:` block |

Adding a field to a workflow touches four places, and the build fails if any is missed. That is the
design working:

1. `workflowShape` — optional, **no default**, so a save cannot add empty keys, exactly as
   `conditions` does.
2. `WORKFLOW_FIELDS` in `fields.ts` — the serializer is generated from this table and an
   exhaustiveness test asserts it covers every schema key.
3. The fully-populated YAML literal in `serializer-exhaustiveness.spec.ts`.
4. `workflowArb` in `round-trip-properties.spec.ts`, **including the absent case** — an absent block
   must stay absent through a save.

And `resolve.ts`, where a schema field nothing consumes is treated as a defect.

---

## Capability seam

| | |
|---|---|
| **Where** | `packages/core/src/capabilities.ts` · `host.ts` · `packages/plugin-sdk/src/index.ts` |
| **Verdict** | `EXTEND` — a `reliability-evaluator` kind |

Capability kinds are **open strings**, not an enum core owns, so a new kind needs no permission.
Registration is all-or-nothing and a duplicate `(kind, id)` is refused naming the owning plugin.

Binding rule 4 — *every built-in ships through the seams* — is why the deterministic evaluator is
provided as a capability rather than called directly. A built-in that cannot be expressed through
the extension API means the API is wrong.

---

## Settings and policy

| | |
|---|---|
| **Where** | `packages/config/src/settings.ts` |
| **What it is** | A JSON file in the **user** scope, deliberately not `config.yaml` (hand-written, carries comments) and not the database (per-repository). Every leaf has a `.default()`, every group has a group default, and the *values* live in core beside the rules that consume them. Absence means defaults and no problem; a file that will not parse means defaults and a reported problem, never a throw. |
| **Verdict** | `EXTEND` |

`DEFAULT_ORCHESTRATION_LIMITS` is the model `DEFAULT_RELIABILITY_POLICY` copies: a named constant in
core, referenced by the schema's `.default()` rather than restated. Zero configuration is a
requirement (§50), and this is how it is met.

Per-project settings are **columns on the project row**, not a file — that is where the evaluator's
model selection goes.

---

## Tests

| | |
|---|---|
| **Where** | `**/features/*.feature` + paired `*.spec.ts`; `apps/web/features/` for the browser |
| **What it is** | The `.feature` files **are** the specification (binding rule 11). Steps translate; they never decide. `Rule:` owns every scenario after it. Browser scenarios use `data-testid` throughout and assert layout **geometrically**. `pnpm mutate` breaks a guard and watches it fail, exiting non-zero if a mutation survives. |
| **Verdict** | `EXTEND` — five new feature files, four extended |

---

## Out of scope

`OUT_OF_SCOPE`, and named so nobody wonders whether they were forgotten: the scheduler and its lanes,
worktrees and environments, bundles beyond shipping one file and one import route, the disclaimer and
profile gates, the plugin catalogue, and everything in §84 of the specification — team dashboards,
merge gates, calibrated probability models and telemetry.

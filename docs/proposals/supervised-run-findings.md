# What a supervised run found, and what is left of it

**Status:** Triage. Some of this is built; the rest is here so nobody has to
derive it again.

**Where it came from.** Ten tasks were driven through Factory's MCP server end
to end on 2026-09-23, each checked against a specification before the next
started. The work came out right — and it took a person watching to make that
true. Without one, Factory would have said **done** at least four times over
broken work.

The findings that made Factory *silently wrong* were fixed on the branch that
produced this document. Everything else is below, with what was measured
attached and what each item is waiting on. Where a measurement contradicts the
original report, the measurement is here too: three of them changed what the
fix should be.

---

## Fixed

| | What it was | What was done |
|---|---|---|
| P0-1 | The Default profile could no longer run dev commands on Claude Code 2.1.281 | `--allowedTools` with the package managers, each entry measured. `docs/security/providers.md` has the table, including what does **not** work. |
| P0-2 | A refused command was invisible: the run completed and the agent reported success | `--output-format stream-json`, a reader on the provider capability, and a refused *command* parks the run whatever its exit code said. |
| P0-3 | Validate and verify could pass without evidence | `{{ project.check }}`, the built-in `project-check` phase, and a step whose command resolves to nothing is refused at plan time. |
| P1-4 / P1-5 | The `design` workflow ran zero steps; `progress.total` did not match | One defect, not two: the workflow was `phases: []`. A plan with no steps is now an error, the parser warns, and doctor reports it. |
| — | Not in the report: `args:` on a step or agent file could widen the execution profile | Refused at plan time, derived from each provider's own Full Access arguments. |

### Three corrections the measurements forced

1. **A denial pattern on the CLI's wording would not have worked.** The report's
   first recommendation was to match the refusal's phrasing. Factory sees the
   agent's prose, and the agent *paraphrases*: the CLI said "no approval
   **surface**" and the agent's own report of the same event said "no approval
   **interface**". A pattern on either would have missed the run that produced
   the report. The structured event kind — `{"type":"system",
   "subtype":"permission_denied"}` — is what is matched instead.

2. **Most of the report's suggested allow-list could not be used.** It named
   fifteen entries including `node`, `python`, `npx`, `make`, `cargo` and `go`,
   and asked for each to be re-measured. Re-measuring removed most of them:
   `--restricted` confines Claude Code's own file tools and the shell's
   redirection, and cannot confine what a child interpreter does with its own
   syscalls. `Bash(node *)` wrote outside the workspace on the first attempt,
   and so did a bare `Bash`. The list that shipped is the four package
   managers — see the open question below for the rest.

3. **P1-4 and P1-5 were one defect.** The `design.workflow.yaml` on disk was
   `phases: []`. `resolvePlan` returned a plan with zero phases, `runPlan`
   returned `completed` in about 3 ms, and the same file contributed 0 to
   `progress.total` — which is exactly the `total: 4` on five workflows.

---

## Open question for the owner

**Should the Default profile's allow-list cover build tools that are not
package managers?**

Today a check command of `cargo test`, `go test ./...` or `make check` is
refused when an **agent** runs it — loudly now, as a parked run naming the
command, but refused. The gate itself is unaffected: a `shell` step is started
by Factory, not by an agent.

- *For:* the same argument that put `pnpm test` on the list. Running the
  project's own build is what the profile exists to allow, and a Rust or Go
  project currently gets an agent that cannot compile anything.
- *Against:* none of them has been measured here, and this codebase's rule is
  that an unmeasured flag is worse than no flag. `make` in particular runs
  whatever the Makefile says, which is arbitrary shell — no different in
  principle from `pnpm exec`, but worth saying out loud rather than discovering.
- *Recommended default:* the report's own second suggestion, which is better
  than widening the shipped list. Let a **project** extend the allow-list
  without replacing it — `security.allowCommands:` in its `config.yaml`, merged
  into `--allowedTools` — so a Rust repository says `cargo` once, in the
  repository it is true of, and the shipped default stays the measured minimum.
  Then measure `cargo`, `go` and `make` on their own and promote only the ones
  where a write outside the workspace is still refused.

  Note that `--allowedTools` is variadic and a repeated flag *replaces* rather
  than appends, so merging has to happen before the argv is built — which is
  also why a step's own `args` may no longer pass that flag.

**Blocking?** No. It changes who Factory is useful to, not whether it is
correct.

---

## The MCP surface

These are the gaps that made the supervised run reach for the app. Most are
thin wrappers over routes that already exist — that is said per item, because
it is the difference between an afternoon and an increment.

### P1-1 — No way to create a project, phase or agent

`factory_project_current` returned `PROJECT_NOT_FOUND` and there was no tool to
add the repository; phases were created in the app; the `developer-haiku` agent
was written as a YAML file by hand.

**Thin wrappers.** `POST /api/projects` and `PATCH /api/projects/:id` already
exist and now accept `check` as well. Phases and agents go through the same
definition write path the builder uses, which already returns `problems[]`.

```text
factory_project_add     (path, name?, usesWorktrees?, usesEnvironments?, profile?, check?)
factory_project_update  (project, usesWorktrees?, usesEnvironments?, profile?, check?)
factory_phase_create    (project?, name, description?, approval?, steps[])
factory_phase_update    (project?, name, …same fields)
factory_agent_list/get/create/update
```

### P1-2 — No way to set task dependencies or workflow `needs`

The ten-task graph had to be drawn in the app, and because the UI makes a chain
easiest, T3‖T4 and T7‖T8 never ran in parallel although the specification
allowed it. `factory_workflow_create` also cannot set `needs:`.

**Half of this is a one-line bug** and goes to the MCP pull request rather than
here: `factory_workflow_create`'s zod schema omits `needs`, so an agent that
passes it has it silently stripped. The rest — `dependsOn` on task create and
update, `factory_task_link`/`_unlink`, a `factory_workflow_update` — is new
surface over routes that already exist.

### P1-3 — A `done` task cannot be re-run

Every workflow is `enabled:false` once a task is done, the only action is
`archive`, and `task_update(workflows=…)` changes nothing — so the user
re-enabled workflows in the app twice. A **cancelled** task keeps its unrun
workflows enabled and can be re-queued at once, so the behaviour depends on how
the task stopped, which is surprising.

**Real work, and a product question inside it.** `factory_task_act(action:
'rerun', from, through?)` needs a decision about what re-running means for
artifacts and flags before it is written.

### P1-6 — Liveness and stall detection

T7's implement ran for more than eleven minutes — roughly ten times the others
— and `factory_run_logs` returned `lines: []` for the running run. The agent
was looping on one failing assertion, writing straight quotes where the
specification needed curly ones.

**Half of this is done.** The stream reader now writes a trace line per tool
call to the run's stderr as it goes, so a running agent is no longer silent and
the commands it ran are in the log. What is left:

- `since` cursor on `factory_run_logs`, so a supervisor can tail rather than
  re-read;
- a stall heuristic — "the same command failed N times", "no new tool call for
  M minutes" — surfaced as a warning on the task;
- the tool trace as structured data on `run_get`, rather than only as log
  lines. That needs somewhere to put it, which means a migration.

### P1-7 — No way to wait for a task except polling

The supervisor polled `task_get` in sleep loops about thirty times.
`factory_task_wait(task, until, timeoutSeconds)` as a long poll, or MCP
notifications. **New surface**; the event bus it would read from already
exists.

### P1-8 — Parallel tasks share one working copy when worktrees are off

The project had `usesWorktrees: false`, so every task ran in the main checkout.
The graph allowed T3‖T4 and T7‖T8; had they run together they would have edited
the same files. The workflows had no commit step either, so everything piled up
uncommitted.

**Partly already true and undocumented.** The scheduler runs one task at a time
for a project without worktrees — that is enforced, and `project.ts` says why.
What is missing is saying so anywhere a person looks: `project_current` should
report it, and the board should show it beside the setting.

### P2-3 — MCP responses are verbose

Every `task_get`, `task_list`, `task_update` and `task_act` echoes the full
description — about 1 KB here, and `task_list` with eleven tasks came to about
12 KB. `verbose: false` as the default for list, act and update. **Thin**, and
worth doing early: it costs the calling agent context on every single call.

---

## Everything else

### P2-1 — Agents leave their task's scope

Every task listed its **Files** and agents still built parts of later tasks
early: T2 added T9's label, T4 drew T6's checkbox, T8 drew T9's count, and T7's
first attempt rewrote T6's labels and broke a passing test. Two defects passed
every phase and showed up only in a browser.

Two separable proposals: an optional `scope.files` on a task, checked against
the diff after implement; and a browser or end-to-end step kind for the layer
unit tests missed. The first is the cheaper one and catches an agent editing
another task's tests, which is the failure that actually cost time here.

### P2-2 — The default phase prompts are too thin

The prompts were one line each and never mentioned the previous phase's
artifact, `{{ task.artifacts }}`, or a specification file.

**This was in the plan for the fixed branch and was deliberately left out.**
Factory ships no starter workflow set in the open core — there is no `analysis`
or `implement` phase to put a better prompt in — so shipping prompts means
deciding what every new project is given, which is a product decision rather
than an implementation one. Worth doing; worth doing as its own decision.

### P2-4 — The provider CLI version is not recorded or checked

`providers.md` recorded a measurement against 2.1.273; P0-1 appeared on 2.1.281
with nothing to warn about the drift. Record the CLI version on each run, and
have `factory doctor` re-run the confinement probe when the installed version
differs from the last measured one. This is the finding that would have caught
P0-1 before a person did, and it is the one with the best ratio of work to
value.

### P2-5 — Approval gates

All ten tasks stopped after `analysis`, and the supervisor could only report
"waiting for you" in chat. Notify on `awaiting_approval`, show the artifact
inline with the approval, and consider "approve the rest of this chain".

### P2-6 — Small inconsistencies

- `factory_workflow_create(from: …)` writes a `kind:` line the source file did
  not have. Pick one and be consistent.
- Artifact directories come from the **original** task name, so a rename leaves
  nothing linking them. Use the task id, or show the directory in `task_get`.
- `factory_task_update` refuses a description-only edit on a running task.
  Descriptions matter at the next attempt, not the current one.
- The sample repository's `README.md` describes a pipeline that project no
  longer has.

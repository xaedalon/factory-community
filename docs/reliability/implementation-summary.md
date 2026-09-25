# What was built

The specification is `Xaedalon Factory Reliability System.md`, 86 sections. The
adaptation to the Factory that exists is `Reliability-System-Plan-CLAUDE.md` at
the repository root, which carries a decision table for every departure. This is
what came out.

## Built

| | Where |
|---|---|
| Domain model, policy defaults | `packages/core/src/reliability/model.ts`, `policy.ts` |
| The arithmetic — weights, caps, coverage, deltas, explanation | `packages/core/src/reliability/score.ts` |
| Driver lifecycle, ownership, attention, next actions | `packages/core/src/reliability/drivers.ts` |
| Observations from a run's facts | `packages/core/src/reliability/observations.ts` |
| The evaluator contract and `normalize()` | `packages/core/src/reliability/evaluator.ts` |
| The deterministic evaluator | `packages/core/src/builtins/reliability.ts` |
| The agent evaluator | `packages/plugins/reliability-agent/` |
| Three tables, migration 21, and the repository | `packages/store/src/reliability.ts` |
| Judging after every run, and never failing one | `packages/engine/src/reliability.ts` |
| Six HTTP routes, and the summary on the task payload | `apps/daemon/src/routes/reliability.ts` |
| Spawning the agent that reads the work | `apps/daemon/src/reliability-agent.ts` |
| `factory reliability <task> [history\|drivers\|assess\|next]` | `apps/cli/src/commands/reliability.ts` |
| Six MCP tools, two of them guarded | `packages/mcp/src/tools/reliability.ts` |
| The card, the graph, the drivers list | `apps/web/src/components/reliability/` |
| The five-stage pipeline, and one click to import it | `packages/core/examples/reliability.bundle.yaml` |

Seven feature files, 8,124 unit scenarios in the suite, 205 in a real browser.

## Measured, not asserted

The pipeline was driven end to end on 2026-09-24 against a throwaway repository
with the bundle imported and a stub agent on `PATH`, through the real daemon on
its own port and its own `FACTORY_HOME`.

```text
 #  workflow    score   coverage   delta
 1  analysis     68.8       25%   +68.8
 2  design       75.8       45%    +7.0
 3  implement    82.8       70%    +7.0
 4  validate     89.8       90%    +7.0
 5  verify       95.0      100%    +5.2
```

And the run that matters, the same pipeline with a check command that fails:

```text
 4  validate     80.0       75%    -2.8
    driver  [high/agent] open — A check failed: bash -c 'npm test'
    cap     failedRequiredValidation → 80
```

The score fell while coverage rose, and the fall names what caused it. That is
the pair the whole subsystem exists for.

Resolving that driver gave back its impact — raw 83.5 → 84.5 — and left the
effective score at 80, because the ceiling is about the *observation* and the
last observed gate is still red. A green run lifts it; resolving a finding does
not. Worth knowing before reading the number.

The authority model, asked live:

```text
POST .../drivers/<id>/accept  with an agent initiator
→ 409  "Accepting a high risk is a person's decision. An acceptance an
        agent can grant itself is not a gate."
        actions: investigate, resolve, invalidate, supersede
```

## Departures from the specification

Each is in the plan's decision table with its reasoning; these are the ones a
reader of the spec will notice.

| Spec says | Factory does | Why |
|---|---|---|
| `.xaedalon/factory/tasks/<id>/reliability.json` | SQLite, migration 21 | Task state already lives there, and a second source of truth is the thing this codebase keeps paying for |
| A `current` projection | Derived: newest row + open drivers | Two indexed queries. A stored copy goes stale |
| Staleness stored | Derived from `considered_run_id` | Nothing to write means nothing to write wrongly |
| Judging when a workflow opts in | Every run that reaches a verdict | Any workflow can change the project, including one written this morning |
| The five workflows as built-ins | An importable bundle | A pipeline that runs `npm test` has no business resolving for a Rust repository |
| A fixed evaluator model | A project setting | A weekend project and a payments service do not want the same model |
| §81's illustrative 93/94/97/95/98 | 68.8/75.8/82.8/89.8/95.0 | Those numbers assume a task that began with requirements already understood. Factory starts from nothing observed, and the shape — rising, then falling when validation finds something — is what was being specified |

## Not built, on purpose

The specification's own §84 non-goals: team dashboards, merge gates, calibrated
probability models, telemetry. And no mandatory completion threshold — a
reliability target is informational, which is §41.

## Uncalibrated

These are heuristics. The weights (15/10/20/20/20/15), the ceilings, the
baseline of 60, the evidence weights and the `maxDriverImpact` of 15 are all
judgements, chosen so the numbers behave sensibly across the cases in
`reliability-scoring.feature` and measured once against a real pipeline.

**Nothing here has been validated against post-merge defects or rollbacks.** A
95 is not a 95% chance of anything. What the numbers are is *explainable*: every
one traces to evidence a person can disagree with, which a hidden model would
not offer.

The honest use is comparative — this task against that one, this task now
against this task an hour ago — and as a pointer at the drivers, which are the
actual product.

## Found while building, and fixed

Three defects of the same shape: a fact declared at one layer and never supplied
by another. All three typechecked, and all three were invisible to the unit
scenarios that constructed the value by hand.

- **`scoreImpact` was inert.** Drivers carried an impact that produced ceilings
  but never moved a dimension. Fixing it meant removing the failure penalty from
  the evidence model, or one problem was charged twice.
- **The workflow declaration never arrived.** The engine handed the plan's
  YAML-spelled `reliability:` block straight through as the TypeScript-spelled
  declaration. Both shapes are entirely optional, so it compiled and delivered
  `undefined` for every field whose name differed. A declared workflow earned the
  coverage of an undeclared one.
- **`checkCommand` was never supplied.** The one expectation Factory can credit
  without being told — a green run of the project's own check command — was
  reachable only from a test that passed the command in by hand. The measured
  pipeline reached 85% coverage before this was fixed and 100% after.

And one the CLI showed: `↑ +5.200000000000003`. Two scores each rounded to one
decimal, subtracted, is not a number rounded to one decimal.

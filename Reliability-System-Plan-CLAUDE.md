# Reliability — the implementation plan

**Source:** `Xaedalon Factory Reliability System.md` (86 sections). That document is the product
specification. This one is what it becomes against the Factory that exists, and it is the document
to read before changing anything under `reliability/`.

Where the two disagree, this one wins and says why. §76 of the source asks for exactly that: audit
first, adapt, do not duplicate existing concepts. The audit is
[`docs/reliability/current-state.md`](docs/reliability/current-state.md).

**Status: built.** Everything below exists, on `feature/reliability`. What came out — including the
measurements, the three defects found while building it and what remains uncalibrated — is
[`docs/reliability/implementation-summary.md`](docs/reliability/implementation-summary.md). The
user-facing documentation is [`docs/reliability/`](docs/reliability/).

---

## What the feature is

Factory can tell you a task is `done`. It cannot tell you how much to trust that.

Reliability is a task-level, evidence-backed judgement that answers four questions at any moment:

1. How reliable is the current solution?
2. Why is the score at that level?
3. What unresolved factors are holding it down?
4. Which of those should an agent handle, and which need a person?

> **Reliability directs attention. It does not merely display confidence.**

The score is the summary. The product is the drivers, the evidence, the coverage, the history, the
next actions and the routing.

---

## The one rule everything else serves

An agent never sets the score.

```
Workflow / agent
      │
      ▼
Observations + findings + unknowns        what was seen
      │
      ▼
Evaluators                                 classify, propose
      │
      ▼
normalize()                                clamp, reject, attribute
      │
      ▼
Deterministic score engine                 Factory decides
      │
      ▼
Task reliability state
```

This removes self-scoring bias, score inflation, provider drift and opaque movement. It is also the
authority boundary: `normalize()` is the single function an evaluator's output must survive, and
nothing downstream trusts an evaluator again.

---

## Two numbers, not one

| | |
|---|---|
| **Reliability** | Given the evidence available, how trustworthy does the solution appear? |
| **Evidence Coverage** | How much of the evidence a sufficiently verified solution would have has actually been collected? |

Both are shown together, always. Without coverage, an early analysis that found nothing wrong looks
identical to a fully verified implementation.

```
Reliability       93        Reliability       98
Evidence Coverage 41%       Evidence Coverage 96%
```

**The score is non-monotonic.** It may fall. Validation discovering a regression is the feature
working, not failing:

```
Analysis 93 → Design 94 → Implementation 97 → Validation 95 → Verification 98
```

**More evidence can coexist with lower reliability.** A failed validation *lowers* the score and
*raises* coverage in the same assessment. That pair is the single most important scenario in the
suite.

---

## Dimensions and weights

Six dimensions, weights summing to 100, configurable but never hardcoded in a component:

| Dimension | Weight | Measures |
|---|--:|---|
| Understanding | 15 | Is the problem clearly understood? |
| Precedent | 10 | Does existing evidence support the direction? |
| Design | 20 | Is the approach coherent and compatible? |
| Implementation | 20 | Does the intended solution exist and work locally? |
| Regression Safety | 20 | Does existing behaviour remain intact? |
| Verification | 15 | How strong and independent is the final check? |

```
raw = Σ(dimension × weight) / 100
```

**Caps, because a weighted average cannot express a known serious risk.** A critical open driver
caps the effective score at 70 however good the average is. Every assessment records the raw score,
the effective score, every cap applied and why.

**100 is rare by design.** A completed task usually lands 94–99. 100 requires essentially complete
expected evidence, no meaningful unresolved drivers, no active caps, and verification satisfied.

---

## Drivers are the product

A driver is something that materially changes trust. They are first-class, not a rendering of the
score.

- **Type** — requirement, understanding, precedent, architecture, compatibility, implementation,
  regression, testing, verification, security, performance, migration, dependency, environment,
  product_decision, unknown.
- **Severity** — critical, high, medium, low, info. Related to score impact, not identical to it.
- **Status** — open, investigating, resolved, accepted, invalidated, superseded. A status table,
  the way `task/state.ts` has one; nothing transitions except through it.
- **Owner** — agent, developer, either, external. This is the routing, and it is what makes the
  feature answer *what can Factory keep working on without me?*
- **Recommended action** — workflow, agent_investigation, developer_decision, manual_review,
  external_research.

`accepted` means a person accepted the remaining risk, with who, when and why. Acceptance never
erases history.

---

## Decisions taken against the source document

| § | The source says | What is built | Why |
|---|---|---|---|
| 29 | `.xaedalon/factory/tasks/<id>/reliability.json` | SQLite, migration 21 | Task state already lives in the database. §29 itself forbids a second source of truth, and a JSON file beside it would be one. |
| 30 | One JSON blob with an embedded `current` projection | Three tables, and **no stored projection** | The current state is the newest assessment plus the open drivers — two indexed queries. A stored copy is the *two implementations of one idea* this codebase keeps paying for. |
| 19 | A new evidence model | Reference `run_evidence` and `run_steps`; add only a small `reliability_observations` record | Artifacts already have a home, a path and a version history. What is missing is the normalised note of *what an assessment saw*, which is what makes the explanation answerable months later. |
| 21–22 | AI classifies evidence | Two evaluators behind one capability kind: deterministic (always, free) and agent (project-configured model) | The deterministic layer makes every scenario reproducible. The agent layer is where judgement lives. Owner's decision: the model is selectable per project. |
| 24 | Workflows declare `reliability:` to contribute | Assessment runs after **every** run that reaches a verdict | Owner's correction: any workflow can change the project, including ones a developer writes. The block refines; its absence never means invisible. |
| 41 | `reliability_target` with policy modes | Informational only | An uncalibrated heuristic must not become a mandatory gate. §41 says so itself. |
| 81 | A five-workflow lifecycle | An importable bundle, plus a one-click import on the project page | Factory ships no opinion about your pipeline. A bundle nobody can find is a bundle nobody uses, hence the button. |
| 9, 81 | `verification_not_performed` caps at 92; analysis lands at 93 | The verification cap waits until everything else is evidenced, and an early assessment lands far below 93 | Two things the specification's own numbers cannot both have. Applied from the moment implementation lands, a 92 ceiling binds through validation and the score **stops moving** — the dimensions and drivers become invisible exactly where the work is. And an analysis-only task reading 93 is the over-confidence §6 says the two numbers exist to prevent. Measured through the five phases against a real repository: **68.8 → 75.8 → 82.8 → 89.8 → 95.0**, coverage **25 → 45 → 70 → 90 → 100**. The shape §5 asks for is intact and the pair reads honestly at every step. |

---

## Shape

```
packages/core/src/reliability/
  model.ts          types
  policy.ts         DEFAULT_RELIABILITY_POLICY — weights, caps, expected evidence
  score.ts          rawScore · applyCaps · coverage · delta · explain      (pure)
  drivers.ts        status table · sorting · attention · nextActions       (pure)
  observations.ts   run outcome + evidence → Observation[]
  evaluator.ts      RELIABILITY_EVALUATOR_KIND · the contract · normalize()

packages/core/src/builtins/reliability.ts     the deterministic evaluator
packages/plugins/reliability-agent/           the agent evaluator
packages/store/src/reliability.ts             ReliabilityRepository · migration 21
packages/engine/src/reliability.ts            assessReliability(...)
apps/daemon/src/routes/reliability.ts         HTTP
apps/cli/src/commands/reliability.ts          factory reliability …
packages/mcp/src/tools/reliability.ts         four reads, two guarded mutations
apps/web/src/components/reliability/          card · graph · drivers
packages/core/examples/reliability.bundle.yaml
```

`score.ts` and `drivers.ts` are pure functions over injected facts, like
`task/orchestration.ts`. They can be specified without a database, a clock or a run.

---

## Triggers

`Engine.#runOne` calls `assessReliability` immediately after `#collectEvidence` and before the
verdict is recorded — the same position and the same reason: the judgement should already be there
when the task lands in front of a person.

It runs for every run that reaches a verdict: completed, failed, refused or timed out. Also on
driver resolution, driver acceptance, human clarification, and an explicit `assess`.

**A failed assessment never fails the run.** The workflow completed; reliability could not be
recalculated. That is a warning on the run and a *Retry assessment* button, not a failure.

**The agent evaluator is not run on every verdict.** It runs when the run produced new artifact
evidence or ended badly, at most once per run, and only where the project has enabled it and a
provider is available. The deterministic evaluator always runs and costs nothing.

---

## Authority

Reliability must not become an authority bypass.

- No surface anywhere sets a score. There is no such route, command or tool, and a scenario asserts
  the tool does not exist.
- An agent cannot mark its own high-severity risk accepted. Accepting a `critical` or `high` driver
  is refused for an agent initiator exactly as `approve` is — Factory stamps `FACTORY_RUN_ID` into
  every agent process, and the daemon reads it. An acceptance an agent can grant itself is not a
  gate.
- Actor identity is recorded on every manual resolution, acceptance and override.
- Evaluation uses the ordinary provider, profile and privacy rules. No hidden cloud evaluation, and
  nothing is sent anywhere the task was not already authorised to send it.

---

## Versioning

Every assessment stores `scoringModelVersion`. History stays interpretable when the rules change,
and old assessments are **never silently recalculated** under new ones. A correction is a new
assessment that supersedes, not an edit.

---

## What is not built

The source's §84 non-goals: team dashboards, enterprise merge gates, calibrated probability models,
telemetry, global benchmarks, incident correlation, predictive defect models. Also no mandatory
completion threshold.

Build a transparent, local-first, explainable system first.

---

## The final test of any change here

> Reject any implementation that makes the score easier to calculate but harder to explain.
>
> Reject any implementation that increases apparent confidence without increasing evidence.

The feature must never reduce to *"AI says this is 95% correct."* It has to mean: Factory has
evidence, here is what it is, here is what remains uncertain, here is how much that matters, and
here is who should deal with it next.

# Workflows and reliability

## Every run is judged

Including ones you wrote this morning and told Factory nothing about. Any
workflow can change the project, so the judgement follows *what a run did*
rather than whether its workflow opted in.

Judging happens immediately after a run's evidence is collected and before its
verdict is recorded — so how much to trust a task is already there when the task
lands in front of somebody.

Runs that reach any verdict are judged: completed, failed, refused, timed out. A
failure is evidence. Skipping it would mean the score only ever moved on good
news.

**A judgement that cannot be made never fails the run.** The workflow completed;
reliability could not be recalculated. That is a warning on the run and a retry
offer. Turning "the evaluator crashed" into "your work failed" is how a feature
gets switched off.

## Declaring what a workflow contributes

Optional, and it *refines* rather than enables:

```yaml
kind: factory.workflow/v1
name: validate
reliability:
  contributes:
    - regressionSafety
  expected_evidence:
    - integration_checks
  evaluate_after_run: true
phases: [validate, project-check]
```

| | |
|---|---|
| `contributes` | which dimensions this workflow's findings are attributed to |
| `expected_evidence` | which coverage keys a successful run earns |
| `evaluate_after_run` | `false` to skip judging entirely — for the handful that change nothing worth judging, like creating a worktree |

Without the block Factory still sees the exit codes, the refusals and the
artifacts, which is most of the value. What it cannot do is give coverage credit,
because [guessed coverage is worse than none](evidence-coverage.md).

## The bundle

Factory ships the five-stage lifecycle Reliability was designed around, as a
bundle rather than as built-ins — a pipeline that runs `npm test` has no business
resolving for a Rust repository.

```bash
factory bundle import node_modules/@factory/core/examples/reliability.bundle.yaml
```

or one click on the project's page, which does the same thing through the same
import path, preview and all.

```text
analysis  → understanding, precedent
design    → design
implement → implementation
validate  → regression safety     ← the stage that can lower the score
verify    → verification
```

Each declares its predecessor with `needs:`, which is how Factory knows the
order — doctor reports a task whose workflows are out of order or missing one.
It does **not** pull them in: a task gets the workflows it is given, and running
`verify` alone is a legitimate thing to want. Put all five on the task to run the
pipeline.

The prompts ask for pasted command output and for *blocked* rather than a pass,
because a claim that the tests pass is not evidence that the tests pass.

Every agent step needs a provider. Factory ships three provider plugins and
resolves one only when a step names it or exactly one is enabled, so on a stock
installation the first run of any bundle — this one or `development` — refuses
with *"3 are installed"* until the two you do not use are switched off on the
plugins page. Recorded in [`../../improvements.md`](../../improvements.md): the
daemon has no way to set a default provider, and it should.

`validate` ends with the built-in `project-check` phase, which runs
`{{ project.check }}` — the project's own check command, set on its page or
detected when it was added. That command is also the one thing Factory can credit
as evidence without being told: a step running exactly it and exiting zero earns
`regression_checks`, which is worth about 15 points of coverage.

A project without a check command makes that phase refuse to plan, which is
louder and more honest than a gate that passes because `bash -c ''` exits 0.

## Evaluators

Two, behind one capability kind (`reliability-evaluator`).

**Deterministic** — always, free, in core. Everything it produces restates
something Factory observed. It has no opinions, which is what makes it
reproducible and impossible to flatter.

**Agent** — reads the artifacts and proposes findings with reasoning. It costs
tokens, so it runs only when a run produced new artifact evidence or ended badly,
at most once per run, and only where the project has it enabled. The model is a
project setting, because a powerful model is usually wanted and which one is the
project's business. [`evaluators.md`](evaluators.md) has the whole of it.

Whatever either returns crosses `normalize()` once, and nothing downstream trusts
an evaluator twice. A third party can add a third evaluator through the same
door; see [`../plugins.md`](../plugins.md).

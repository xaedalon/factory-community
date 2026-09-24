# Evidence coverage

> How much of the evidence a sufficiently verified solution would have has
> actually been collected?

Weighted, never counted. Counting evidence objects would let an agent raise
coverage by writing three documents about the same thing.

```text
coverage = satisfied expected weight / total expected weight
```

## What Factory expects

| Key | Dimension | Weight |
|---|---|--:|
| `requirements_understood` | understanding | 10 |
| `constraints_identified` | understanding | 5 |
| `precedent_examined` | precedent | 10 |
| `technical_approach` | design | 12 |
| `compatibility_considered` | design | 8 |
| `implementation_exists` | implementation | 12 |
| `build_success` | implementation | 8 |
| `targeted_tests` | implementation | 5 |
| `regression_checks` | regression safety | 15 |
| `integration_checks` | regression safety | 5 |
| `acceptance_criteria` | verification | 5 |
| `independent_review` | verification | 5 |

Every one is something Factory can *observe* — a document that exists, a command
that exited zero, a gate that ran. An expectation Factory cannot check is one
that is never satisfied, which would make 100% unreachable and the number
meaningless.

## Credit is deliberately hard to earn

A piece of evidence counts only when:

- **a workflow declared it**, through its
  [`reliability:` block](workflow-integration.md) — or
- **the project's own check command ran green**, which is the one thing Factory
  can infer without being told.

Never guessed from an artifact's name. Guessed coverage reads as "this has been
verified" when what happened is that somebody wrote a document.

A project that imports the reliability bundle gets full credit with no effort. A
project that writes its own workflows gets findings and dimension movement
immediately, and coverage once it adds four lines saying what each stage
collects.

**One rule to know when writing your own.** A declaration's *first* key is
credited against an artifact actually arriving; the rest are credited once the
run completes. So a workflow that declares one key and writes no artifact earns
nothing, and the same workflow declaring two earns the second. The artifact is
the strongest evidence a workflow produces, and the first key is the one attached
to it. Whether that asymmetry should survive is
[recorded as an improvement](../../improvements.md).

## A failed check is evidence *about* the code

It does not satisfy the expectation it was about:

```text
pnpm test exited 1
  → coverage for `regression_checks`:  not satisfied
  → a finding, owned by the agent:     "A check failed: pnpm test"
  → regression safety:                 down by the finding's impact
```

The evidence *exists* — the check ran, which is more than could be said before —
so coverage of the run's other declared keys still rises. That is the pair the
whole feature is for: **more evidence, less reliability.**

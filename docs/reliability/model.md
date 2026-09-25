# The model

What the pieces are called, and what each one is for.

## Dimensions

Six, weighted, summing to 100.

| Dimension | Weight | What it measures |
|---|--:|---|
| Understanding | 15 | Is the problem clearly understood? |
| Precedent | 10 | Does existing evidence support the direction? |
| Design | 20 | Is the approach coherent and compatible? |
| Implementation | 20 | Does the intended solution exist and work locally? |
| Regression safety | 20 | Does existing behaviour remain intact? |
| Verification | 15 | How strong and independent is the final check? |

Design, implementation and regression safety carry the most because they are
where solutions actually fail: a well-understood problem solved with an
incompatible approach is still broken. Precedent carries the least because it is
the weakest evidence there is — somebody else solved something similar is
encouraging and proves nothing about this case.

Verification is 15 rather than higher because it is *capped* separately. A
solution nobody verified does not need its average dragged down; it needs a
ceiling, which is a different and more honest instrument.

## States

```text
unassessed    nobody has looked
assessed      the judgement reflects the evidence
stale         work has happened since the judgement
```

**`unassessed` is not `0`.** A task nobody has looked at is not a task that
failed, and every surface shows the state rather than a zero.

Staleness is *derived*: an assessment records the newest run it took into
account, so a run that finished after it means the judgement is behind the work.
Nothing is written down, so nothing can be written down wrongly.

## Assessments

One judgement, at one moment. Append-only: an assessment is never edited because
interpretation changed, and a correction is a later assessment that supersedes.
Each carries the whole arithmetic that produced it and the `scoringModelVersion`
it was produced under, so history stays interpretable when the rules change.

Ordering is a sequence, not a timestamp — two assessments in the same
millisecond are possible, and ordering by time would be a coin toss.

## Drivers

Something that materially changes how much the current solution can be trusted.
First-class, not a rendering of the score. See [`drivers.md`](drivers.md).

## Observations

The small, durable note of what an assessment *saw*: a command refused, a gate
failed, an artifact promised and missing. Artifacts are referenced by path, never
copied — but without this record the explanation of a score could not be
reconstructed once the run logs were trimmed, and they are, on a budget.

## Scoring model version

Stamped on every assessment. History is **never silently recalculated** under new
rules: an old assessment stays interpretable because it says which rules produced
it. Calibration may change weights, caps and impact rules without rewriting
anything.

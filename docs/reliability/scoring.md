# Scoring

Everything here is a pure function over values somebody else looked up
(`packages/core/src/reliability/score.ts`). Nothing reads a database, asks a
provider or knows what time it is.

## The order, which never varies

```text
dimensions from evidence
  + active drivers adjust the dimension each one names
  ↓
weighted average                    → raw score
  ↓
ceilings from known risks           → effective score
  ↓
delta against the previous judgement
```

## The weighted average

```text
raw = Σ(dimension × weight) / 100
```

The working is *carried*, not recoverable: every assessment stores one line per
dimension with its score, its weight and its contribution. "Why 95?" has to be
answerable, and an answer assembled later from the same inputs would be a second
implementation of this function — the kind where the wrong one is the one nobody
reads.

## Why a driver moves a dimension, not the total

A driver is a **named reason one dimension is worse than its evidence
suggests**. Applying its impact to the total would make two findings in different
dimensions indistinguishable, and the breakdown would stop explaining the number
above it.

It also means resolving a driver gives back exactly what it took, which only
works because the driver is what took it.

A failure on its own — an observation with no driver — does *not* lower a
dimension. Counting it both as evidence and as a finding would charge twice for
one problem, and resolving the driver would then return half of it.

## Ceilings

A weighted average cannot express "there is an unresolved critical finding". It
can only dilute it, and dilution is how a 96 ships with a hole in it.

| Ceiling | At | When |
|---|--:|---|
| `criticalOpenDriver` | 70 | A critical finding is still open |
| `failedRequiredValidation` | 80 | A gate ran and failed |
| `implementationNotExecuted` | 85 | No evidence the implementation exists |
| `blockingRequirementAmbiguity` | 85 | An unresolved `requirement` finding |
| `verificationNotPerformed` | 92 | Nothing independent has looked |

**The lowest wins; they do not compound.** Two ceilings of 80 and 70 mean 70, not
56 — a score that fell further than any stated reason explains is exactly the
unexplained movement this subsystem exists to end.

Two of these are narrower than they look, and deliberately:

- **`failedRequiredValidation` keys off a failed gate, not off a regression
  finding.** Discovering a regression and characterising it is the system
  working, and it already costs the score through the finding's own impact.
  Being red right now is a different fact.
- **`verificationNotPerformed` waits until everything else is evidenced.**
  Applied from the moment implementation lands, a 92 ceiling binds through
  validation and the score *stops moving* — the dimensions and the drivers
  become invisible exactly where the work is happening. A number that does not
  move stops being read.

## Deltas

Every assessment after the first says why it moved, in the terms a person would
use:

```text
95 → 92 (-3)

- New checkout regression finding      -4
- Browser verification completed        +1
```

A ceiling's cause carries what the ceiling actually cost — the distance from
where the score would have landed down to the ceiling — and only the *binding*
one claims it. A cause of `0` beside a twelve-point drop was the first version of
this, and it is precisely what a delta explanation must not do.

## Where the numbers land

Measured through the five stages the bundle ships, against a real repository
through the real daemon:

| | analysis | design | implement | validate | verify |
|---|--:|--:|--:|--:|--:|
| Reliability | 68.8 | 75.8 | 82.8 | 89.8 | 95.0 |
| Coverage | 25% | 45% | 70% | 90% | 100% |

An analysis-only task reading 68.8 with 25% coverage is the honest pair. Reading
93 would be the over-confidence the two numbers exist to prevent.

And the same pipeline where the check command fails, which is the pair the whole
feature is for:

| | analysis | design | implement | validate |
|---|--:|--:|--:|--:|
| Reliability | 68.8 | 75.8 | 82.8 | **80.0** |
| Coverage | 25% | 45% | 70% | 75% |

More evidence, less reliability — and the assessment names the finding that did
it rather than leaving somebody to guess.

**100 is rare by design.** A completed task usually lands 94–99, and the gap
between 97 and 100 is where the evidence nobody collected lives.

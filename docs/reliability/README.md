# Reliability

Factory can tell you a task is `done`. Reliability is how it tells you how much
to trust that.

```bash
factory reliability <task>          # the score, and what is holding it back
factory reliability <task> next     # the highest-value thing to do about it
```

It is not a confidence number. It is a standing, evidence-backed judgement that
answers four questions at any moment:

1. How reliable is the current solution?
2. Why is the score at that level?
3. What unresolved factors are holding it down?
4. Which of those should an agent handle, and which need you?

> **Reliability directs attention. It does not merely display confidence.**

The score is the summary. The product is the drivers, the evidence, the
coverage, the history and the routing.

## Two numbers, always together

| | |
|---|---|
| **Reliability** | Given the evidence available, how trustworthy does the solution appear? |
| **Evidence coverage** | How much of the evidence a sufficiently verified solution would have has actually been collected? |

```text
Reliability       93        Reliability       98
Evidence coverage 41%       Evidence coverage 96%
```

Either alone misleads. A 93 with 41% coverage is "nothing has gone wrong yet and
we have barely looked"; a 93 with 96% is "we looked hard and it is good". Showing
only the first is how a confidence number becomes flattery.

## The score can go down, and that is the point

```text
analysis 68.8 → design 75.8 → implement 82.8 → validate 89.8 → verify 95.0
coverage  25%          45%             70%            90%          100%
```

A validation that discovers a regression has *learned something*. The score may
fall while coverage rises, and a model that could not say both at once would
have to hide one of them. [`scoring.md`](scoring.md) has the arithmetic.

## No agent ever sets the score

An agent asked how good its own work is answers 98, every time.

```text
Workflow / agent
      │
      ▼
Observations + findings          what was seen
      ▼
Evaluators                        classify, propose
      ▼
normalize()                       clamp, reject, attribute
      ▼
Deterministic score engine        Factory decides
      ▼
Task reliability state
```

There is no route, command or MCP tool that sets a score — not a refusing one,
none at all. [`drivers.md`](drivers.md) covers the rest of the authority model,
including why an agent may *resolve* a critical finding but not *accept* it.

## The documents

| | |
|---|---|
| [`model.md`](model.md) | The six dimensions, the states, and what each thing is called |
| [`scoring.md`](scoring.md) | Weights, ceilings, deltas, and how "why 95?" is answered |
| [`evidence-coverage.md`](evidence-coverage.md) | What counts as evidence, and why coverage is hard to earn |
| [`drivers.md`](drivers.md) | Findings, ownership, the lifecycle, and who may accept a risk |
| [`evaluators.md`](evaluators.md) | The two evaluators, the model a project chooses, and the authority boundary |
| [`workflow-integration.md`](workflow-integration.md) | The `reliability:` block, the bundle, and when judging happens |
| [`storage.md`](storage.md) | The three tables, and the two things deliberately not stored |
| [`mcp.md`](mcp.md) | What an agent can ask and do |
| [`current-state.md`](current-state.md) | What Factory already had, audited before any of this was written |
| [`implementation-summary.md`](implementation-summary.md) | What was built, what was not, and what is uncalibrated |

## What it is not

These are **heuristics**, not calibrated probabilities. Nothing here has been
validated against post-merge defects or rollbacks, and the numbers should not be
presented as odds. What they are is *explainable*: every one is a judgement a
person can disagree with and trace to its evidence, which is a property a hidden
model would not have.

A reliability target is informational in Community. An uncalibrated heuristic
should not become a mandatory gate.

# Drivers

The score is the summary. Drivers are the product.

A driver is something that materially changes how much the current solution can
be trusted — with a name, a size, and an **owner**. The owner is what makes this
feature answer the question worth asking:

> What can Factory keep working on without me?

and its twin, which is the one that saves time:

> Where is my judgement actually required?

## Owners

| | |
|---|---|
| `agent` | Factory can be sent at it |
| `developer` | needs your judgement |
| `either` | either of you |
| `external` | depends on somebody else |

A red check is `agent`: something Factory can work on. A refused command is
`developer`, because the remedy is the provider's allow-list or the project's
execution profile and neither is the agent's to change.

## Severity, and what it does

`critical · high · medium · low · info`

Severity and score impact are related and not identical: severity says how bad
the thing is, impact says how far it moves the number. Only `critical` applies a
ceiling on its own. A ceiling that fired on every `high` finding would stop the
number moving, and a number that does not move stops being read.

## The lifecycle

One transition table (`packages/core/src/reliability/drivers.ts`), because a move
allowed in two places is a move that disagrees with itself.

```text
open ──investigate──▶ investigating
  │                        │
  ├──resolve───────────────┼──▶ resolved ──reopen──▶ open
  ├──accept────────────────┼──▶ accepted
  ├──invalidate────────────┼──▶ invalidated ──reopen──▶ open
  └──supersede─────────────┴──▶ superseded
```

Four end states meaning four different things:

| | |
|---|---|
| `resolved` | the thing is no longer true |
| `accepted` | it is still true, and somebody decided to live with it |
| `invalidated` | it was never true |
| `superseded` | a later finding replaced it |

An accepted risk **cannot be reopened**. Overriding somebody's decision is a new
finding, not a state change on the old one. And acceptance never erases anything:
the finding stays in the record with who accepted it, when, and why.

## An agent cannot accept its own serious risk

Accepting a `critical` or `high` finding is refused for an agent. This is the
same hole as an agent approving its own work, closed the same way — the daemon
decides, on a fact the client cannot fake: Factory stamps the run into every
agent process it launches, and a caller carrying one is an agent.

An agent may still **resolve** a critical finding. Resolving is a claim evidence
can check; accepting is a decision about what matters. And an agent may accept a
`low` finding, because requiring a person for every one of those is how a gate
becomes noise and stops being read.

An acceptance demands a reason — asked for by the MCP schema before anything is
sent, and by the board before the request is made. An acceptance nobody explained
is indistinguishable afterwards from one nobody meant.

## Resolving a finding is not the same as a green run

Resolving gives back exactly what the finding took — its impact leaves the
dimension it was charged to, and the raw score rises by it. What it does **not**
do is lift a ceiling, because a ceiling is about an *observation* rather than a
finding. Measured on a real task:

```text
validate failed   raw 83.5  →  effective 80.0   cap failedRequiredValidation
driver resolved   raw 84.5  →  effective 80.0   cap still applies
```

The gate is still red until something runs it again. That is the honest reading:
saying a finding is dealt with is a claim, and the next run is what checks it.

## Order

Severity, then cost, then age. **Not chronological**, which is the order a list
naturally arrives in and the order that buries the critical finding under four
notes about naming.

## Next actions

Ranked by how far resolving each would actually move the score — which accounts
for a ceiling the finding is holding, not just its own impact. A critical finding
costing 2 that also holds a ceiling is offered before a medium one costing 6;
ranking on impact alone would send somebody at the wrong thing.

A recommendation naming a workflow the project does not have is dropped rather
than carried, because the board would otherwise draw a Run button with nothing
behind it. A finding with no usable recommendation still appears: knowing that
the highest-impact uncertainty has no obvious next step is itself worth knowing.

The numbers are **estimates**. Resolving one usually turns up evidence that moves
others.

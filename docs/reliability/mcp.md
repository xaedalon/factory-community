# Reliability over MCP

Six tools. The full surface is in [`../mcp.md`](../mcp.md); this is what they are
for.

## Reading

| | |
|---|---|
| `factory_reliability_get` | The score, the coverage, the breakdown, active ceilings, and how much is waiting for whom |
| `factory_reliability_drivers` | What is holding it back. `owner: "agent"` is the list you can work through |
| `factory_reliability_history` | Every judgement, with what moved it |
| `factory_reliability_next_actions` | The highest-value thing to do, ranked |

`next_actions` is the one that matters. An agent that can ask *what is the
highest-value thing I can do about this task without a person* is an agent that
can keep working, and that question is the entire point of the owner field.

An unassessed task comes back as three words and a suggestion, not a shape full
of nulls — a field that says nothing costs context and reads as meaningful.

## Changing something

| | |
|---|---|
| `factory_reliability_resolve_driver` | Say a finding stopped being true |
| `factory_reliability_accept_driver` | Record that a risk is being lived with |

**Resolving is a claim evidence can check**, so an agent may make it.
**Accepting is a decision about what matters**, so the daemon refuses it for a
critical or high finding when the caller carries a run Factory stamped. An
acceptance an agent can grant itself is not a gate — the same argument that keeps
approving off this surface entirely.

Accepting demands a reason, refused by the schema before anything is sent.

## What is absent

**No tool sets a score.** Not a refusing one — none at all. One scenario asserts
both halves: no tool by that name, and no tool whose schema takes a score
anywhere. A tool that does not exist is a stronger guarantee than one that says
no.

# Factory's documentation

What you might want, in the order most people want them.

| | |
|---|---|
| [`install.md`](install.md) | What you need, which platforms, where things are kept — and how to remove it again. |
| [`quickstart.md`](quickstart.md) | Build it, start it, run the built-in workflow. Fifteen minutes. |
| [`workflows.md`](workflows.md) | Writing a workflow: phases, steps, agents, artifacts, approval gates. |
| [`plugins.md`](plugins.md) | Adding a capability — a step kind, a provider, a button on a task, a doctor rule. |
| [`task-dependencies.md`](task-dependencies.md) | One task waiting for another, marking one done by hand, and the two whole-project buttons. |
| [`mcp.md`](mcp.md) | Driving Factory from the coding agent you already have, and what it may not do. |
| [`reliability/`](reliability/) | How much to trust a task, what is still uncertain, and who should deal with it. |
| [`security/`](security/) | What an agent may reach, and what it may not. |

## Security

Start with [`security/default-profile.md`](security/default-profile.md). It is
the profile every project gets, and it is short.

| | |
|---|---|
| [`default-profile.md`](security/default-profile.md) | What an agent may do without asking, and what it may not |
| [`profiles.md`](security/profiles.md) | Writing a profile of your own: what it can widen, and what it cannot |
| [`full-access.md`](security/full-access.md) | What turning the boundary off means, and how you are reminded |
| [`workspace-boundary.md`](security/workspace-boundary.md) | What counts as inside — and what is not enforced |
| [`providers.md`](security/providers.md) | Per agent CLI: what it confines, what Factory adds, what has been measured |

## Where this is going

| | |
|---|---|
| [`proposals/execution-profiles.md`](proposals/execution-profiles.md) | The safety standard Factory is being built against. **A target, not a description** — most of it is not built. It lives under `proposals/` so the path says so. |
| [`proposals/mcp.md`](proposals/mcp.md) | The standard the MCP server is built against, and what is deliberately left out of it. Most of this one *is* built; the header says which parts are not. |
| [`proposals/supervised-run-findings.md`](proposals/supervised-run-findings.md) | Ten tasks driven through Factory end to end with somebody watching: what it got silently wrong, what was fixed, and what is left — with the measurements attached. |


## Elsewhere

[`../PROJECT.md`](../PROJECT.md) is the source of truth for what has been built,
in what order, and every decision that shaped it — including the binding rules
the architecture is held to and an index of every `.feature` file, which is
where the specification actually lives.

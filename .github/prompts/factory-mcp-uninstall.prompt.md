---
mode: agent
description: Take Factory's MCP server back out of this coding agent's configuration.
---

<!-- The editor's prompt-file convention. The Copilot CLI does not read this: it discovers skills
     from `.github/skills/`, `.agents/skills/` and `.claude/skills/`, and finds this one in the
     last of those — verified with `copilot skill list`. -->

Read `skills/factory-mcp-uninstall/SKILL.md` at the root of this repository and follow it exactly.

It is the only copy of the steps. Before you begin: this removes **no Factory data** — no tasks,
runs, history or definitions — and saying so first is most of the job; find where the entry actually
is before removing it; and never delete a `.mcp.json` that holds another server, or one that is
committed.

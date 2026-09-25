---
mode: agent
description: Point this coding agent at Factory's MCP server, everywhere or in one repository.
---

<!-- The editor's prompt-file convention. The Copilot CLI does not read this: it discovers skills
     from `.github/skills/`, `.agents/skills/` and `.claude/skills/`, and finds this one in the
     last of those — verified with `copilot skill list`. -->

Read `skills/factory-mcp-install/SKILL.md` at the root of this repository and follow it exactly.

It is the only copy of the steps. Before you begin: ask whether they want Factory available
everywhere on this machine or only in one repository, and default to everywhere; say that a
repository install writes a `.mcp.json` which will appear in their `git status`; and never approve a
project-scoped server on their behalf, because that gate is a person's.

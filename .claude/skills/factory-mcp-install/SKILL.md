---
name: factory-mcp-install
description: Point a coding agent at Factory's MCP server so it can create tasks, start workflows and read runs — choosing between every project on this machine and one repository. Use when the user asks to add Factory to their agent, connect Factory over MCP, or invokes /factory-mcp-install. Not for installing Factory itself (that is `factory-setup`).
---
# Adding Factory to a coding agent

The runbook is
[`skills/factory-mcp-install/SKILL.md`](../../../skills/factory-mcp-install/SKILL.md), at the root
of this repository. **Read it now and follow it exactly.**

One copy of the steps, every supported agent pointing at it — the same arrangement as
`factory-setup`, and for the same reason: a fix to what gets written into somebody's configuration
has to be a fix everywhere.

Three things it says that matter before you open it. Ask first whether they want Factory available
everywhere on this machine or only in one repository, and default to everywhere. A repository
install writes a `.mcp.json` that will show up in their `git status`, so say so before writing it.
And never approve a project-scoped server on their behalf — Claude Code holds those at *pending
approval* on purpose, and that gate is a person's.

---
name: factory-mcp-uninstall
description: Take Factory's MCP server back out of a coding agent's configuration — find where it actually is, remove the entry, and leave everything else alone. Use when the user asks to disconnect Factory from their agent, remove the Factory MCP server, or invokes /factory-mcp-uninstall. Not for removing Factory itself (that is `factory-uninstall`).
---
# Taking Factory back out of a coding agent

The runbook is
[`skills/factory-mcp-uninstall/SKILL.md`](../../../skills/factory-mcp-uninstall/SKILL.md), at the
root of this repository. **Read it now and follow it exactly.**

One copy of the steps, every supported agent pointing at it, for the reason all four of these
runbooks share: the rules about what a tool may touch on somebody's machine must not exist in three
places.

Three things it says that matter before you open it. This removes **no Factory data** — no tasks,
runs, history or definitions — and saying that first is most of the job. Find where the entry
actually is before removing it, because an entry added everywhere and one added in a repository look
the same to whoever asked. And never delete a `.mcp.json` that holds another server, or one that is
committed.

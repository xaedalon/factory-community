---
name: factory-mcp-uninstall
description: Take Factory's MCP server back out of a coding agent's configuration — find where it actually is, remove the entry, and leave everything else alone. Use when the user asks to disconnect Factory from their agent, remove the Factory MCP server, or invokes /factory-mcp-uninstall. Not for removing Factory itself (that is `factory-uninstall`).
---

# Taking Factory back out of a coding agent

You are removing the entry that points a coding agent at `factory mcp`. That is all this does, and
saying so first is the job, because "uninstall Factory's MCP server" sounds like it deletes
something.

**It removes no Factory data.** Not a task, not a run, not a log, not an artifact, not a workflow,
not a project, not the database, not a scope. The agent stops being able to *ask* Factory things.
Everything Factory knows is exactly where it was, and the board and the CLI reach all of it.

What you are editing is a **coding agent's own configuration** — `~/.claude.json`,
`~/.copilot/mcp-config.json`, or a `.mcp.json` inside one repository. Factory's own scopes live in
`.xaedalon/.factory` and are a different thing entirely; this runbook never goes near them. If you
find yourself about to touch a path with `.xaedalon` in it, stop: that is
[`factory-uninstall`](../factory-uninstall/SKILL.md)'s business, and its default is to keep it.

---

## Rule one: find it before you remove it

**Before removing anything**, ask each client where its entry actually is. It may not be where
anybody remembers putting it — an entry added everywhere and an entry added in one repository look
identical to the person who asked for them.

```bash
claude mcp list        # and `claude mcp get factory` for the one entry
copilot mcp list
```

Then say what you found and what you will do:

> Factory is configured in *<the files you found>*. I'll take those entries out. Nothing of
> Factory's own is touched — no tasks, no runs, no history, no definitions — and no other MCP server
> you have configured is touched either. Factory itself stays installed and the board keeps working.

## Rule two: four things you must never do

1. **Never hand-edit a client's configuration.** Use its own `mcp remove`. Measured: Claude Code
   takes its entry out of a `.mcp.json` and leaves every other server in the file untouched, which
   is the thing a careless `rm` gets wrong. Let it.
2. **Never remove a committed `.mcp.json` quietly.** `git ls-files .mcp.json` says whether it is
   tracked. If it is, removing the file is a change to their repository and to their team's: name
   the `git rm .mcp.json` and stop.
3. **Never touch anything under `.xaedalon/`.** Not the scope, not the database, not the artifacts.
   Nothing in this runbook has a reason to.
4. **Never remove another MCP server.** `factory` is the only name here. If the entry was called
   something else, use the name it actually has, from the listing.

---

## 1. Inventory

Run the listings above and read them properly. Three things are worth noticing:

- **Where each entry lives.** `claude mcp get factory` prints it, starting with the scope — *User
  config (available in all your projects)* or *Project config (shared via .mcp.json)* and the file's
  path. When both hold one, the user entry is the one it reports.
- **`⏸ Pending approval`.** A `.mcp.json` entry Claude Code has never been told to trust. It is
  still an entry and still comes out; the approval decision is separate and is dealt with in step 3.
- **Which client has it.** Configuring both and removing one is a common way to end up confused
  later.

If neither client names it, go to *If it is not installed* at the bottom.

## 2. Ask which, and take them out

**One place holds it** — the ordinary case — then rule one has already named it and said you would
remove it. Do that; do not ask the same question twice.

**Several hold it**, which is how somebody ends up with Factory configured everywhere *and* in one
repository, then ask, with the default being all of them:

> I found it in *<these>*. Take it out of all of them, or just one?

Then, for whichever applies:

```bash
claude mcp remove factory      # from whichever scope holds it
copilot mcp remove factory
```

**If two scopes hold it, the bare command refuses** rather than guessing — it names both files and
changes nothing. That is the right answer, not a failure. Take them out one at a time, from inside
the repository for the project one:

```bash
claude mcp remove --scope project factory
claude mcp remove --scope user factory
```

Claude Code edits the file itself and leaves every other server in it alone. Show them the result
rather than describing it:

```bash
cat <repo>/.mcp.json
```

- **Other servers are still in it** → done. Nothing else to do to that file.
- **It is now `{"mcpServers": {}}`** → the client leaves the empty file behind. Removing it is their
  call: `git ls-files .mcp.json` says whether it is tracked, and if it is, name the
  `git rm <repo>/.mcp.json` rather than running it.

## 3. Clear the approval, if there was one

Claude Code remembers which project-scoped servers were approved and which were rejected, per
project. Removing the entry does not clear that memory, and a stale decision is confusing the next
time somebody adds a `.mcp.json` there.

Mention it; run it only if they ask, because it resets **every** project-scoped server's decision in
that project, not just Factory's:

```bash
claude mcp reset-project-choices
```

## 4. Prove it is gone

```bash
claude mcp list        # no "factory"
copilot mcp list       # no "factory"
```

Both listings, not one. And if a `.mcp.json` was edited rather than removed, show the file: the
other servers are still in it, which is the thing they will want to see.

## 5. Report

Say plainly:

- **what came out, and from which file** — named, not described
- **what was left and why** — a tracked `.mcp.json` they have to `git rm`, other servers in a file
  you edited, an approval decision you did not reset
- **that Factory is untouched**: still installed, daemon still running if it was, every task, run
  and artifact exactly where it was. The board and `factory` reach all of it
- **how to come back**: [`factory-mcp-install`](../factory-mcp-install/SKILL.md), or the two lines in
  [`docs/mcp.md`](../../docs/mcp.md)

---

## If they want Factory gone too

This runbook is not that, and should not grow into it. Say so and point at
[`factory-uninstall`](../factory-uninstall/SKILL.md), which takes an inventory first, removes only
what Factory installed, and names the command for everything that is theirs.

Doing this one first is still the right order: an MCP entry left behind points a coding agent at a
command that no longer exists, and the failure it produces at every session start explains itself
badly.

## If it is not installed

Say so and stop: *"Factory is not configured as an MCP server for any agent here — there is nothing
to remove."*

Check the listings first rather than removing hopefully, because the two clients disagree about what
a second removal is. Measured: `claude mcp remove factory` on a server that is not there says *No
MCP server named "factory"* and carries on; `copilot mcp remove factory` answers `Error: Server
"factory" not found.` That error means it was already gone, not that something went wrong — say
which, and do not go looking for a fault.

Running this twice must be safe, and the second run should be boring.

## Reference

[`docs/mcp.md`](../../docs/mcp.md) — what the entry was for.
[`skills/factory-mcp-install/SKILL.md`](../factory-mcp-install/SKILL.md) — the other direction.
[`skills/factory-uninstall/SKILL.md`](../factory-uninstall/SKILL.md) — removing Factory itself,
which is a different and much larger thing.

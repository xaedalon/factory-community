# Agents working in this repository

Factory orchestrates coding agents, and it is built by them. This file is the entry point for any
agent that reads `AGENTS.md` — Codex among them.

## Installing Factory

Read [`skills/factory-setup/SKILL.md`](skills/factory-setup/SKILL.md) and follow it exactly.

That file is the **only** copy of the install runbook. Claude Code finds it through
`.claude/skills/factory-setup/SKILL.md`, Copilot through `.github/prompts/factory-setup.prompt.md`
and `.github/copilot-instructions.md`, and you through this line. Three pointers, one set of steps:
a fix to the install path is a fix for every agent, which is the same rule the codebase holds itself
to — one implementation of one idea.

Two of its rules before you begin: **explain the whole plan to the person before running anything**,
and **never accept Factory's security disclaimer for them**. Nothing runs until a human has read
what an agent run can reach, and that gate exists for every client, including you.

## Driving Factory

Factory serves the Model Context Protocol, so you can operate it rather than only install it:
resolve the project you are standing in, see what it can run, create a task, queue it, follow the
run. Point your client at `factory mcp` and read [`docs/mcp.md`](docs/mcp.md).

Two things it will not let you do, before you try: it will not accept the security disclaimer —
that is a person's, and the refusal says so — and it will not approve anything, because an
approval an agent can give itself is not a gate.

## Removing Factory

Read [`skills/factory-uninstall/SKILL.md`](skills/factory-uninstall/SKILL.md) and follow it exactly.
Its default is to remove the software and keep the data: a checkout and a global shim are Factory's,
but the scope holds somebody's history and a repository holds their committed definitions and the
artifacts their agents wrote. Name the command for those and leave them alone.

## Changing this repository

[`CONTRIBUTING.md`](CONTRIBUTING.md) is the real answer and is short. The three rules that decide
whether a change is acceptable, none of them guessable:

1. **The `.feature` files are the specification.** A behaviour change begins with a scenario, in the
   language of the problem rather than the implementation. There are no separate spec documents and
   there never will be.
2. **Every guard is broken and watched to fail** before it is trusted — invert the condition, run the
   suite, watch the right scenario fail, restore. A test that has never failed is a test nobody has
   checked. Say in the pull request which mutations you ran.
3. **One implementation of one idea.** The recurring failure here is two implementations where the
   wrong one is the one nobody reads. Every path flows from `packages/config/src/scopes.ts`;
   `process.cwd()`, `os.homedir()` and `os.tmpdir()` are banned elsewhere by lint. The open core
   never imports commercial code — widen `@factory/plugin-sdk` instead.

## Before you push

```bash
pnpm typecheck && pnpm lint && pnpm test
pnpm --filter @factory/web test:e2e     # if the board changed
```

CI runs the suite on macOS and Linux, the browser scenarios in Chromium, and a first-run job that
clones, builds and asks the daemon for a page. Running them locally first is faster than finding out
from a red tick.

## Where to read next

[`PROJECT.md`](PROJECT.md) is the decision record — every increment, what it cost, and what was
refused. It is long, and it is the fastest way to understand why anything here is shaped the way it
is. [`docs/`](docs/) is short and worth reading end to end.

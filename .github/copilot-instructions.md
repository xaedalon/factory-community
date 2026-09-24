# Working in this repository with Copilot

**Installing or setting up Factory** — read `skills/factory-setup/SKILL.md` and follow it exactly.
It is the single copy of that runbook; every supported agent points at it.

**Removing Factory** — read `skills/factory-uninstall/SKILL.md` and follow it exactly. It keeps the
user's data by default and names the command for anything that is theirs.

**Pointing an agent at Factory over MCP** — read `skills/factory-mcp-install/SKILL.md` and follow
it exactly. It asks where before it writes anything, and defaults to everywhere on the machine.
`skills/factory-mcp-uninstall/SKILL.md` is the other direction; it removes no Factory data.

**Changing anything here** — read [`CONTRIBUTING.md`](../CONTRIBUTING.md) first. Three rules decide
whether a change is acceptable, and none of them is guessable:

- The `.feature` files **are** the specification. A behaviour change begins with a scenario, written
  in the language of the problem, not of the implementation.
- Every guard is broken deliberately and watched to fail before it is trusted. A test that has never
  failed is a test nobody has checked.
- The open core never imports commercial code, and every path flows from
  `packages/config/src/scopes.ts` — `process.cwd()`, `os.homedir()` and `os.tmpdir()` are banned
  elsewhere, by lint.

Before pushing: `pnpm typecheck && pnpm lint && pnpm test`, and
`pnpm --filter @factory/web test:e2e` if the board changed. CI runs all of it on macOS and Linux.

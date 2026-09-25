# Writing a plugin

Everything Factory can be extended with goes through one mechanism, and its own built-ins use it.
`shell`, `agent` and `worktree` are registered step kinds; Claude, Codex and Copilot are provider
plugins; every `doctor` check is a registered rule. If a built-in could not be written as a plugin,
the plugin API would be wrong, and we would rather find that out now.

## The shape

```js
export default {
  name: 'acme-http',
  version: '1.0.0',
  register(context) {
    context.provide('step-kind', { /* a capability */ })
    context.hook('validateDefinition', (definition) => [])
    context.events.on('run.completed', (event) => { /* … */ })
  },
}
```

`register` is called once with a context carrying six things:

- **`provide(kind, capability)`** — register a capability. Kinds are open strings; `step-kind`,
  `provider`, `doctor-rule`, `setup-step`, `terminal` and `task-tool` are the ones Factory looks
  for, and nothing stops a plugin defining its own kind for another plugin to consume. A capability
  id must match `/^[a-z][a-z0-9-]*$/`: they appear in YAML and in URLs.
- **`hook(name, fn)`** — take part in a decision. There are exactly two, and both run on the one
  path every definition takes to disk — the API, the CLI, a bundle import and the copies a project
  is given when it turns worktrees on:
  - **`validateDefinition`** is asked first, and collects problems. Any of severity `error` refuses
    the write. Every handler runs even if an earlier one threw, so a broken plugin cannot hide the
    real reasons; a handler that throws contributes a problem naming itself.
  - **`beforeDefinitionWrite`** is the last chance to adjust or refuse. Return
    `{ action: 'continue', value }` — with `value.definition` replaced, if you are adjusting — or
    `{ action: 'reject', problems }`. The first rejection wins, and a handler that throws is read as
    a rejection: carrying on would write a value somebody was in the middle of refusing.

  What a hook returns is still read back from disk before the write is kept, so a definition a
  plugin adjusted into something Factory cannot load is refused like any other.
- **`events`** — the event bus. Events report what already happened; a subscriber cannot veto one.
- **`host`** — ask what else is installed. `host.has('terminal')` is how a feature degrades by
  absence rather than by checking which edition it is running in.
- **`env`** — the environment, handed over rather than read. A plugin never touches
  `process.env`, so what it does cannot depend on how the process was started.
- **`settings(kind, id)`** — what the installation said about a capability you are about to
  provide. This is how a machine-specific path reaches a plugin:

  ```yaml
  # ~/.xaedalon/.factory/config.yaml
  providers:
    claude:
      command: /opt/agents/claude-nightly
  ```

  Read it *while registering*: it is seeded before any plugin loads and does not change
  afterwards.

Registration is all-or-nothing: if any capability in a plugin is rejected, none of them are
registered, so a plugin is never half-loaded. A plugin that provides no capability and no hook is
rejected too — it could not affect anything, which is almost always a bug. And two plugins cannot
claim the same `kind:id`: the first to register wins and the second fails whole, so a conflict is
reported rather than silently resolved.

Built-ins load before anything a scope declares, so a project plugin claiming a core id is reported
as conflicting with core rather than the other way round.

## Installing one

```yaml
# .xaedalon/.factory/config.yaml
kind: factory.scope/v1
scope: project
plugins:
  - ./plugins/http.mjs
```

A project ships its plugins in its own repository. They load when the scope does, and a plugin that
will not load is reported as a problem rather than crashing the process — `doctor` has to keep
working precisely when something is misconfigured.

A path beginning `./` belongs to the scope that declared it. Anything else is left alone, so Node
resolves it as a package. The module may export the plugin as `default` or as `plugin`.

## Switching one off

```json
// ~/.xaedalon/.factory/settings.json — Factory's own file, beside your config
{ "plugins": { "disabled": ["./plugins/http.mjs"] } }
```

Or from the board's Plugins page, or `factory plugins disable <id>`.

*Disabled* means **not loaded**: the module is never imported, so it contributes no capabilities and
no hooks, and its doctor rules do not run. That is why the id is *how the plugin got here* — a
built-in by its manifest name, a plugin your scope declares by the specifier you wrote. A declared
plugin's name is only knowable after importing it, and not importing it is the whole point.

Two consequences worth knowing. The step kinds and the built-in doctor rules cannot be switched
off, because nothing parses or runs without them. And because the capability host has no unload, a
plugin switched off while Factory is running stays loaded until the next start — the board and
`doctor` both say so rather than leaving you to find out.

## A step kind

```js
context.provide('step-kind', {
  id: 'http',
  displayName: 'HTTP request',
  summary: 'Makes an HTTP request.',
  schema: z.object({ url: z.string().min(1), method: z.enum(['GET', 'POST']).optional() }),
  sugarKey: 'url',                       // lets `- url: https://…` stand alone
  plan: (step, context) => ({
    describe: `${step.method ?? 'GET'} ${step.url}`,
    command: 'curl',
    args: ['-sS', '-X', step.method ?? 'GET', step.url],
  }),
})
```

`schema` is a zod schema, and it is the only description of the fields anyone needs: the daemon
publishes it as JSON Schema and the builder renders a form from it. A kind without `plan` can be
written but not run, and `doctor` says so rather than letting a workflow fail at the moment it
matters.

## A provider

A provider turns an agent step into a command line. What makes one worth writing is the descriptor:
the flags, the model-role map and the capability list live as **data**, so a vendor renaming a flag
is an edit to a YAML file rather than a code change.

```yaml
# provider.yaml
kind: factory.provider/v1
id: acme
displayName: Acme Code
summary: Acme's coding agent.
command: acme
supports: [non_interactive, session_resume]
models: { strong: acme-large, balanced: acme-mid, fast: acme-small }
promptFlag: '-p'
modelFlag: '--model'
session:
  mode: id
  idFlag: '--session-id'
  resumeFlag: '--resume'
```

```js
// index.mjs — four lines, because a provider is data
import { defineProviderPlugin } from '@factory/plugin-sdk'
import { fileURLToPath } from 'node:url'

export default defineProviderPlugin({
  name: 'acme-provider',
  version: '1.0.0',
  descriptorFile: fileURLToPath(new URL('./provider.yaml', import.meta.url)),
})
```

`supports` is drawn from a fixed list, and the schema is closed: an unknown field is an error with
a suggestion rather than a value silently ignored. Copy the shape from
[`provider-claude/provider.yaml`](../packages/plugins/provider-claude/provider.yaml), which is the
one CI keeps honest.

Mark a descriptor `provisional: true` if you have not verified it against the real CLI. `doctor`
reports provisional providers, because a flag someone guessed is worse than one nobody wrote.

A step's own `args:` cannot widen the profile it runs under. Anything in your `full-access` list
that the confined profile does not already pass is refused at plan time, derived — you write
nothing. Add `forbiddenArgs:` for what derivation cannot see: a flag that grants authority without
appearing in either list, or one whose *repetition replaces* what Factory passed. Claude Code's
`--allowedTools` is the second kind: it is variadic, so a step passing it again does not add to the
allow-list, it becomes the allow-list.

### Reading a structured transcript

One part of a provider cannot be data: a transcript format is a parser. If your CLI can emit its
session as machine-readable events, pass a reader and Factory will use it.

```js
import { LineBuffer } from '@factory/plugin-sdk'

const acmeStream = () => {
  const lines = new LineBuffer()
  const read = (raw) => raw.flatMap((line) => {
    const event = JSON.parse(line)
    if (event.kind === 'denied') {
      return [{ refused: { tool: event.tool, command: event.command, evidence: event.reason } }]
    }
    if (event.kind === 'say') return [{ log: { text: `${event.text}\n`, stream: 'stdout' } }]
    return []
  })
  return { push: (chunk) => read(lines.push(chunk)), end: () => read(lines.end()) }
}

export default defineProviderPlugin({ /* … */ stream: acmeStream })
```

Three things come out of a reader, and each has one job:

| | |
|---|---|
| `log` | what a person reads. Put the agent's prose on `stdout` and anything you add on `stderr`. |
| `scan` | text the log does not carry, offered to the descriptor's `denialPatterns`. A tool *result* belongs here: it is where the CLI's own wording lives. |
| `refused` | a refusal stated as a fact. With a `command`, Factory **parks the run** — see [`security/default-profile.md`](security/default-profile.md). |

Report `refused` only for a genuine permission refusal, never for a command that merely exited
non-zero: a failing test suite is not a permissions problem, and parking every red build is the
fastest way to have this turned off. Prefer whatever your CLI states structurally — an event kind,
a field — over its wording. Factory's own reader was written after a wording pattern was measured
missing the exact run it was written for, because the CLI said "no approval surface" and the agent's
summary of it said "no approval interface".

A provider with no reader is read as plain text, exactly as before.

## A doctor rule

```js
context.provide('doctor-rule', {
  id: 'acme-token',
  summary: 'The Acme token is set.',
  check: ({ env }) =>
    env.ACME_TOKEN === undefined
      ? [{ severity: 'warning', message: 'ACME_TOKEN is not set; acme steps will fail.', rule: 'acme.noToken' }]
      : [],
})
```

A rule that throws is reported and the other rules still run. Losing every check because one plugin
misbehaved is the opposite of what `doctor` is for.

## A reliability evaluator

An evaluator classifies what Factory observed and proposes findings. It **cannot** return a score —
there is no field for one, and everything it returns crosses `normalize()` before anything else sees
it. That is deliberate: an agent asked how good its own work is answers 98, every time.

```js
context.provide('reliability-evaluator', {
  id: 'acme-lint-history',
  summary: 'Checks whether this task touched files that keep coming back.',
  // Optional. Absent means always. The agent evaluator uses it to decline a
  // run that produced nothing worth paying to read.
  wants: ({ latest }) => latest.some((o) => o.kind === 'artifact'),
  evaluate: ({ observations, drivers }) => ({
    dimensions: { regressionSafety: { score: 70, rationale: 'three of these files churn weekly' } },
    drivers: [{
      title: 'checkout.ts has changed in five of the last six tasks',
      type: 'regression', severity: 'medium', owner: 'developer',
      dimension: 'regressionSafety', scoreImpact: -4,
    }],
    // Ids of existing drivers this evaluator believes are no longer true.
    resolves: [],
    summary: 'Churn is the weak part.',
  }),
})
```

Every evaluator registered runs, and one that throws is a warning on the run rather than a failed
run — the deterministic one's judgement still stands. What `normalize()` refuses, and why the bound
on `scoreImpact` is the important one, is in
[`reliability/evaluators.md`](reliability/evaluators.md).

To ask an agent, use `input.agent` rather than spawning anything: the host renders the command,
filters the environment and enforces the deadline, and hands you back text. It is absent when there
is nothing to ask — say so through `wants` and be skipped.

## A task tool

A tool is a button on a task. It answers with a directory and, optionally, argv — and performs
nothing itself, which is what lets the same tool work where a terminal can be opened and where it
cannot.

```js
context.provide('task-tool', {
  id: 'acme-docs',
  displayName: 'Acme docs',
  summary: 'Opens our runbook for this task.',
  order: 40,
  run: 'detached',
  offer: ({ task, workspace, env }) =>
    workspace === undefined
      ? { unavailable: 'Factory cannot find the project this task belongs to.' }
      : { command: { command: 'open', args: [`https://runbook.acme.test/${task.id}`] } },
})
```

- **`offer`** may be async, and returns one of three things. A command means "ready". An
  `unavailable` reason means the button is drawn **disabled with that reason** — a control that
  only appears once a task is in the right state is one nobody knew to look for. `undefined` means
  the tool does not apply to this task at all and is not drawn.
- **`run`** is `terminal` (handed to whatever can open one; `Copies:` in the tooltip when nothing
  can) or `detached` (started by the daemon, which needs nothing installed).
- **`order`** defaults to 100, so a third party lands after the three Factory ships —
  `open-terminal` 10, `open-session` 20, `diffity` 30.
- A tool that throws is reported as unavailable and the others still answer; one that hangs is
  given two seconds. Losing every button on the page because one plugin misbehaved is the opposite
  of the point.

Looking for the binary you are about to run is a question the SDK answers, so a plugin need not
re-derive PATH:

```js
import { commandAvailability } from '@factory/plugin-sdk'

const found = commandAvailability('acme', env, {
  extraDirectories,          // handed to `offer`, assembled once per request
  label: 'Acme',
  hint: 'Install it with `npm install -g acme`.',
})
if (!found.available) return { unavailable: found.reason }
```

Use `found.path` rather than the bare name when you got one: a detached child inherits the same
PATH, and a name found only in a version manager's directory would fail with "command not found" on
something you just reported as available.

The three Factory ships are ordinary plugins and are the examples worth reading —
[`task-terminal`](../packages/plugins/task-terminal/src/index.ts),
[`task-session`](../packages/plugins/task-session/src/index.ts) and
[`task-diffity`](../packages/plugins/task-diffity/src/index.ts).

## Conformance

Every plugin — including the commercial ones — passes the same suite:

```js
import { assertPluginConformance, checkPluginConformance } from '@factory/plugin-sdk'

// Throws, with every failed check named. What a test wants.
await assertPluginConformance(plugin)

// Or read the report yourself: { plugin, passed, checks, provides, hooks }.
const report = await checkPluginConformance(plugin)
```

It checks the obvious things (a name, a version, a `register` that does not throw, ids that are
slugs) and one less obvious one: registering the plugin twice into two fresh hosts must produce the
same result. A plugin holding module-level state fails there, which is the cheapest place to find it.

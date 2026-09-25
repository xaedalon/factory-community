# Improvements

Things noticed while building something else. Each is specific, actionable and
not already tracked — the bar `CLAUDE.md` sets for an issue — and each says what
it cost to find, because that is usually the argument for doing it.

Nothing here is required for anything already shipped to work.

## 1. The daemon has no default provider, so every bundle refuses its first run

Factory ships three provider plugins. `chooseProvider` resolves one when a step
names it, when the scope configuration names a default, or when exactly one is
installed. The daemon never passes `defaultProvider` — only `factory run
--provider` does — so on a stock installation every agent step in every shipped
bundle refuses:

```text
This step does not say which agent to use, and 3 are installed
(claude, codex, copilot). Set "provider:" on the step, or a default in
the scope configuration.
```

The workaround is real and discoverable — switch the two you do not use off on
the plugins page — but it is a cliff on the first run of the first bundle
somebody imports, and the message names a scope configuration key nothing in the
board can set.

**Found by:** the reliability bundle's end-to-end run, which refused until two
plugins were disabled. `development.bundle.yaml` has had the same behaviour for
as long as it has shipped.

**Shape of the fix:** a `providers.default` setting beside `security.profile`,
resolved the way the profile is — project over installation — and passed to
`planWorkflow` from the daemon. A picker on the settings page listing the
providers actually installed.

## 2. `factory.stdin` and other declared-but-unsupplied facts

Two were found in one afternoon, both the same shape: a field declared on an
interface, populated in a unit scenario by hand, and never supplied by anything
in production. `RunFacts.checkCommand` and the `evaluate_after_run` /
`expected_evidence` half of the reliability declaration. Both are fixed.

The class is worth a guard rather than a habit. An all-optional interface passed
between two layers cannot be checked by the compiler, and a unit test that
constructs the value itself can never notice.

**Shape of the fix:** where a fact crosses a layer, give the producing side a
scenario at *its* layer that asserts the field arrives — the way
`packages/engine/features/reliability.feature` now does for the declaration.
Cheaper than a lint rule and it reads as documentation.

## 3. Every other form still puts its banner where it was put

`ProjectEditPage` and `NewTaskPage` now show a failure that belongs to no field
at the *top* of the form, and anything that belongs to a field under that field.
The remaining pages — settings, plugins, scopes, the task detail — put theirs
near the top already, but by habit rather than by rule: nothing asserts it, and
the next form added will put its banner wherever the last one did.

Only one page routes a message to the field it is about (`placeError` in
`ProjectEditPage`, by matching the daemon's sentence). That matching is a guess
about wording, and it is the wrong shape: the daemon knows which field it
refused and says so on `Problem.field`, which the client already carries and
almost nothing reads.

**Shape of the fix:** a `FormErrors` helper that takes an `ApiError` and routes
by `problems[].field`, falling back to the banner; the routes that refuse a
field send `field` with the message. Then `placeError`'s string matching goes.

## 4. `factory bundle import --scope project` crashes outside a project

`writeTarget` throws a written-out sentence when the chain has no scope of the
kind asked for, and the CLI's dispatch does not catch it — so importing into a
project scope from a directory that has none prints a Node stack trace:

```
Error: No project scope in this chain. Available: user, builtin
    at writeTarget (packages/config/dist/store.js:137:15)
```

The sentence inside is the right one. It is the delivery that is wrong: a
mistyped `--scope` reads as a crash in Factory rather than as a thing the person
did.

**Found by:** importing the profile bundle from the wrong directory while
verifying custom profiles end to end.

**Shape of the fix:** catch it where the other command failures are caught and
return it as a `failed([...])` like every other refusal. One `try` in the
dispatch, or a `writeTargetOrProblem` beside the throwing one.

## 5. "The daemon did not start" — the browser suite's own flake

One scenario in a full `pnpm --filter @factory/web test:e2e` failed with

```
Error: The daemon did not start.
```

— an infrastructure failure rather than an assertion, in a scenario about phase
variables that has nothing to do with what was being changed. It passed alone
and passed on a re-run of the whole suite.

`startDaemon` spawns a daemon per scenario and polls `/api/health` a hundred
times, and `refuseIfTaken` checks the port first with a 1 s timeout. Two hundred
daemon starts in one run on a machine also running vitest is enough for one of
them to lose that race.

**Shape of the fix:** the wait is already bounded and the failure message is
already good; what is missing is what it waited for. Report the elapsed time and
the last health response with the refusal, so the next person can tell "it never
came up" from "it came up too slowly" without re-running anything.

## 6. `git.feature` fails under a saturated machine, and it is the deadline

Seen six times — twice on 2026-09-24 and four times on 2026-09-25, each time in
a full `pnpm test` (60 workers) and each time passing when the file is run alone.
Several came in the run immediately after a six-minute Playwright suite, which is
the load this deadline cannot survive, but the latest did not — so the trigger is
machine load generally rather than that suite in particular:

```
FAIL  packages/core/features/git.spec.ts > A question with an answer
        > Then the answer is yes            expected undefined to be 0
        > And it names the committed file
```

Both assertions fail together, which is what `answer === undefined` looks like —
and `systemGitQuery` returns `undefined` for a timeout as deliberately as it does
for "not a repository". `GIT_DEADLINE_MS` is **2 s**, which is right in a daemon
answering a page and tight on a machine running fifty-nine vitest workers that
are each forking git.

So: not a product defect, and not a flake to shrug at either — a production
deadline being measured by a test that cannot control the load.

**Shape of the fix:** let `systemGitQuery` take the deadline, defaulting to
`GIT_DEADLINE_MS`, and have this spec pass a generous one. The scenario is about
*classifying* git's answers, not about how fast git is, and the timeout path has
a scenario of its own that sets it deliberately.

## 7. `needs:` describes an order nothing acts on

A workflow's `needs:` is read by doctor (to report a task whose workflows are out
of order) and by the bundle exporter (to gather the closure). Assigning `verify`
to a task does not pull in `validate`, and nothing offers to.

That may be right — a task gets the workflows it is given — but it means the
five-stage pipeline is five names somebody has to type in the right order, and
the board has the information to offer better.

**Shape of the fix:** on the task's workflow picker, when a chosen workflow
`needs` one that is not on the task, offer to add it. An offer, not an
expansion: `verify` alone is a legitimate thing to want.

## 8. Coverage credit for a declaration is asymmetric

`observationsFrom` credits a declaration's *first* expected-evidence key against
an artifact actually arriving, and the rest on the run completing. A workflow
that declares one key and writes no artifact earns nothing; the same workflow
declaring two earns the second.

It is not wrong — the artifact is the strongest evidence a workflow produces —
but the asymmetry is invisible from the YAML, and a workflow author cannot see
why their one declared key earned nothing.

**Shape of the fix:** credit every declared key on a completed run, and let the
artifact carry the *first* key only when there is an artifact to carry it. Or
keep the rule and say it in `evidence-coverage.md`, which currently does not.

## 9. The interpreter list is written twice, and only one copy is enforced

`packages/core/src/schema/profile.ts` exports `INTERPRETERS`, which the parser
uses to warn on `commands: [node]`. `apps/web/src/pages/ProfileEditPage.vue`
declares the same fourteen names again as a literal, to warn while the list is
being typed.

Both copies are right today. They are two copies of a security judgement, and
the board's is the one a profile author actually reads — so if core's list grows,
the warning the author sees goes stale silently, which is the failure this
project already refuses elsewhere (a flag that reads correctly and does nothing).

The board deliberately does not depend on `@factory/core` — only on
`@factory/store` — so the fix is not an import.

**Shape of the fix:** serve the list. `/api/registries/providers` already carries
`commandAllowFlag` and `commandDenyFlag` so the editor can be honest about what
a CLI cannot honour; the interpreter names belong in a registry route beside
them, with the board's literal deleted. Failing that, a test that reads both
files and diffs the lists — the same guard-on-the-guard shape as
`serializer-exhaustiveness`.

## 10. `lint` reads directories `.gitignore` excludes

`build/` and `release/` are in `.gitignore` because a working tree may hold
Factory Pro's packaged desktop output and neither belongs in a commit. ESLint has
its own ignore list and does not read `.gitignore`, so `pnpm lint` walks into
them: a `build/` directory produced by Pro — or a scratch file left in one —
fails the gate with errors in code that is not part of this repository.

Found by leaving a one-off script in `build/`, which failed `pnpm lint` with
thirteen `no-undef` errors about `console` and `process` while every source file
was clean.

**Shape of the fix:** add `build/`, `release/` and `test-results/` to the ESLint
config's `ignores`, so the two ignore lists agree about what is not ours.

## 11. Copilot has a reasoning-effort flag and the descriptor says it has none

`packages/plugins/provider-copilot/provider.yaml` carries the comment "No effort
setting; a phase that sets one gets a doctor warning rather than silently having
it ignored", and declares no `effortFlag`. Measured against GitHub Copilot CLI
1.0.89-1 on 2026-09-25, `copilot --help` says otherwise:

```text
--reasoning-effort <level>
    Set the reasoning effort level
    [possible values: none, minimal, low, medium, high, xhigh, max]
```

Two consequences, and the second is new. A phase or agent that sets an effort for
Copilot is warned it will be ignored — which is now wrong advice. And the
reliability judge, which reads the same `effortFlag` through
`checkProviderSettings`, both warns wrongly *and* drops the effort a project
chose, so a Copilot judge always thinks at whatever the CLI defaults to.

**Shape of the fix:** `effortFlag: '--reasoning-effort'` and the seven
`effortValues` above, then delete the comment. Wants one end-to-end measurement
first — that the flag is accepted with `-p` and not only interactively — because
this descriptor has been wrong in the other direction before: two configurations
read correctly in `--help` and did nothing, which is why
`docs/security/providers.md` has a section called "Configurations that read
correctly and did not work".

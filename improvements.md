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

Seen twice on 2026-09-24, both times in a full `pnpm test` (59 workers), both
times passing when the file is run alone:

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

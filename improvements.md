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

## 4. `needs:` describes an order nothing acts on

A workflow's `needs:` is read by doctor (to report a task whose workflows are out
of order) and by the bundle exporter (to gather the closure). Assigning `verify`
to a task does not pull in `validate`, and nothing offers to.

That may be right — a task gets the workflows it is given — but it means the
five-stage pipeline is five names somebody has to type in the right order, and
the board has the information to offer better.

**Shape of the fix:** on the task's workflow picker, when a chosen workflow
`needs` one that is not on the task, offer to add it. An offer, not an
expansion: `verify` alone is a legitimate thing to want.

## 5. Coverage credit for a declaration is asymmetric

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

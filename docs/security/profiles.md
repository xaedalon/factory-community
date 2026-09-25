# Writing a profile

Factory ships two profiles and neither of them changes. **Default** confines the
agent to the workspace and lets it run four package managers. **Full Access**
removes the boundary entirely and is marked on screen the whole time it is on.

A custom profile is the third position: *yes to this one command, in this
repository, because I know what it costs.*

```yaml
kind: factory.profile/v1
name: build-tools
description: Default, plus the build tools this repository needs.
extends: default
commands: [cargo, make, go]
deny_commands: ['docker system prune']
providers:
  copilot:
    args: ['--disallow-temp-dir']
```

`.xaedalon/.factory/profiles/build-tools.profile.yaml`, layered project → user →
builtin like every other definition, editable on the board, shareable in a
bundle.

## What it changes, and what it cannot

**It widens which commands may run. It never widens where they may write.**

A custom profile is confined by construction — `isConfined` answers by
exception, so every name that is not `full-access` keeps the workspace boundary,
the credential filter and the directory grants. There is no key that turns those
off, and `extends: default` is the only base: extending Full Access would be
Full Access with a friendlier name and no warning banner.

A profile that passes what Full Access passes is **refused when it is saved**,
naming the argument. That set is derived from each installed provider's own
flags rather than listed here, so it stays true as descriptors change.

## The allow-list is not the whole story

Read-only commands are auto-approved whatever a list says. `git status`,
`git log`, `cat` and `find` already work under the Default profile — listing
them buys nothing, and a profile whose entries change nothing is a profile whose
author is misled by it.

What an entry buys is commands with **side effects**. That is why the shipped
example is `cargo`, `make`, `go`, `gradle`, `mvn` and `docker`, and why none of
the read-only tools appear in it. [`providers.md`](providers.md) has the
measurements.

## Only one CLI can honour it

| | |
|---|---|
| **Claude Code** | `--allowedTools` and `--disallowedTools`, with prefix rules |
| **Copilot** | four coarse switches, no per-command concept |
| **Codex** | nothing; its descriptor is provisional and says so |

A profile's `commands:` reach Claude Code. Under the other two they change
nothing, and Factory says so — on the profile page while it is being written,
and as a warning on the run. An absence that is not reported is a flag that
reads correctly and does nothing, which is the mistake this project has already
made once.

`deny_commands:` is asked separately, because the answer can differ: a CLI may
have an allow-list and no deny-list, and then the allowing half of a profile
lands while the forbidding half does not. Claude Code has both. The profile page
names the providers missing each half under the field it belongs to, rather than
one note for both — a denial is the half somebody writes *because* they are being
careful, so it is the worse one to lose quietly.

`providers.<id>.args` is the way out: raw arguments, appended verbatim, for what
the portable vocabulary cannot express. They are never "unsupported", because
there is nothing to translate.

## Interpreters

`--restricted` confines Factory's own file tools and the shell's redirection. It
**cannot** confine what a child process does with its own syscalls, so an entry
that ends in an interpreter hands that entry the whole filesystem.
`Bash(node *)` was measured writing outside the workspace on the first attempt.

A profile may still allow one. That is the point of a profile — the risk is the
owner's to take. Factory warns, names the measurement, and saves it.

## Where it is chosen

**On a project, under "Authority".** Not on an agent, a workflow or a phase, and
that absence is the point: a definition that could name its own authority would
be a definition that grants itself authority, and the repository is exactly what
an agent can edit. An agent file saying `profile: anything-goes` would be the
same hole as `args: ['--permission-mode', 'bypassPermissions']`, which is refused
at plan time — spelled more politely and just as wide.

So authority comes from outside the definitions: the project row, or the
installation setting. That is also what lets a workflow be shared, imported,
forked and edited freely — none of it can change what the work may reach.

Two tasks in one repository needing different authority means **two projects**
pointed at the same path, which Factory allows; only the name has to be unique.

## Trying one

```bash
factory profile list                       # built-ins and what this chain defines
factory profile show build-tools           # one, and where it came from
factory run <workflow> --dry-run --profile build-tools
```

The last one prints the argv the profile produces, which is the only way to see
what it actually did without running anything.

Then choose it on the project's page. **Not on the settings page** — the
installation-wide setting stays Default or Full Access on purpose. A profile is
resolved through the chain of the project that names it, and a profile defined in
one repository does not exist for any other; an installation-wide setting naming
one would refuse to plan everywhere except where it was written. A profile
belongs to the repository it is true of.

 A project naming a profile no scope
defines **refuses to plan** rather than falling back to Default, because falling
back would quietly change what the run may do.

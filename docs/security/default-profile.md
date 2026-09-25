# The Default profile

What an agent may do when nobody has said otherwise.

```bash
factory accept --show    # what you are agreeing to
factory profile          # which profile new projects get
```

Factory runs other people's coding agents against your repositories. The Default
profile is the answer to "how much of my machine does that give them?", and the
answer is meant to be useful rather than merely reassuring: an agent that cannot
run your tests is an agent you will switch the profile off for.

## What it allows, without asking

Inside the task's workspace — its own git worktree where the project uses them,
the checkout otherwise — an agent may read, create, edit, move and delete files.
No approval, no prompts, no interruptions.

**Which commands it may run is a short allow-list, and which one depends on the
CLI.** [`providers.md`](providers.md) has it per provider. Under Claude Code it
is the package managers — `npm`, `pnpm`, `yarn`, `bun` — and nothing else, so
installing dependencies and running the project's tests work, and `git`,
`docker` and `curl` do not.

The list exists because Claude Code auto-approves *edits* but not *commands*.
Without it, an agent under this profile could not run `pnpm install` at all:
measured against 2.1.281, it was refused, carried on, exited 0 and wrote a
report full of ticks for work it had not done. A profile that breaks `npm test`
on an unfamiliar repository is a profile everyone turns off on their first
afternoon.

**The list is not the only thing that decides.** Claude Code auto-approves *read-only* commands
whatever the list says, so an agent under this profile can already run `git status`, `cat` a file in
the repository and `find` its way around. What the list governs is commands with a side effect —
which is why `cargo`, `make`, `go` and `docker` are refused and `pnpm` is not.
[`providers.md`](providers.md) has the measurements.

**If this list is not enough, write a profile rather than reaching for Full
Access.** A custom profile adds commands to this one and changes nothing else —
the boundary, the credential filter and the directory grants all still apply.
[`profiles.md`](profiles.md) is how.

It is worth being exact about what the list costs. `pnpm test` runs your
project's own code and `pnpm exec` runs anything, so **inside those commands the
workspace boundary does not hold.** That is why the list is package managers and
nothing else: an interpreter would be the same hole with none of the reason.
`Bash(node *)` was measured writing outside the workspace on the first
attempt — it is not on the list and will not be.

## What it does not allow

- **Writing outside the workspace.** The agent CLI is launched with flags that
  confine its file tools to the working directory. What that covers varies by
  provider — [`providers.md`](providers.md) says exactly how much, per CLI.
- **Credentials that look like credentials.** Cloud keys, registry tokens, the
  SSH agent socket and anything whose name contains `TOKEN`, `SECRET`,
  `PASSWORD`, `CREDENTIAL` or ends `_API_KEY` are withheld from the process.
  The one exception is the agent's own credential, which its provider declares.
- **A phase that names a directory outside the workspace.** `working_dir: /tmp`
  is refused at plan time rather than run there.
- **A step that asks for more authority in its own arguments.** `args:` on a
  step, or on an agent file, is appended after the profile's flags — so
  `args: ['--permission-mode', 'bypassPermissions']` was Full Access with no
  setting changed and nothing said. It is refused at plan time now, naming the
  argument. What counts is derived from each provider's own Full Access flags,
  so it stays true as descriptors change.

  The refusal also shows **what this profile already passes for that flag**,
  because the common case is not somebody reaching for authority. It is somebody
  told that a step needs `args: ['--allowedTools', 'Bash(pnpm *)']` to run
  `pnpm` — which it does not, and which would *replace* the list above rather
  than add to it, since `--allowedTools` is variadic. Seeing the granted list
  makes the answer obvious: delete the line.

When something is withheld, the run says so against the step that lost it —
names only, never values. When an agent is refused something, the refusal is
recorded on the run, with the path or the command the refusal named.

**The gate is not an agent.** A workflow's check command runs as a `shell`
step, started by Factory rather than by a coding agent, so the allow-list has
nothing to do with it: `make check` and `cargo test` work there whatever an
agent may run. [`../workflows.md`](../workflows.md) is the whole feature.

## What it is not

**Factory is not a sandbox, and the Default profile does not make it one.** It
constrains what Factory launches and what that process can see. An agent running
arbitrary shell commands is not fully containable by either: a command can read
anything your user can read, and nothing here prevents it. Network access is not
restricted at all in this version.

What you get is a meaningful reduction in blast radius and an honest account of
where it stops. Use Factory on work you can review and revert.

## What happens when something is refused

Three cases, because a refused agent does not always fail — and because what it
was refused matters more than whether it did.

- **A command was refused.** The run is *paused*, whatever its exit code said.
  A refused `pnpm install` means the install did not happen, the tests that ran
  afterwards ran against nothing, and every tick in the report after that point
  was written without it. The task moves to awaiting approval naming the exact
  command, and approving continues from the phase it was refused in.
- **A path was refused and the run failed.** Also paused: it was going to stop
  either way, so keeping its place is strictly better than blocking it.
- **A path was refused and the run succeeded.** Left alone. The work that
  mattered may well be done — the agent writes somewhere else and carries on —
  and interrupting it would defeat the point. The refusal is recorded either
  way, so nobody has to find out by reading a transcript.

The remedy for a path is to allow the directory for that project. The remedy for
a command is to add it to the provider's allowed tools, in its descriptor. Both
are also answered by running that project under [Full Access](full-access.md).

Factory can only park what it can see, and seeing a refused command needs the
provider to say so as a fact rather than in prose. Claude Code does;
[`providers.md`](providers.md) says which others have been measured.

## Where the setting lives

```
~/.xaedalon/.factory/settings.json   security.profile, and what you accepted
```

A project overrides the installation's choice, and a project that has never
chosen follows it — so changing the installation's default changes every project
that has not picked for itself. Set a project's on the Projects page, or read
the installation's with `factory profile`.

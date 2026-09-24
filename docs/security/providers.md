# What each agent CLI enforces

Per provider: how autonomy is enabled, what the CLI confines for itself, what
Factory adds, and — separately — **which of it has actually been measured.**

This page exists because the honest answer differs per CLI, and because a
security page that averaged them would be wrong about all three.

## Claude Code

**Measured** against 2.1.281 on 2026-09-24, and before that against 2.1.273 on
2026-09-15, by running the real CLI against a throwaway workspace and reading
what happened.

| | |
|---|---|
| Default | `--restricted --tools Bash,Edit,Write,Read,Glob,Grep,… --permission-mode acceptEdits --permission-prompts none --allowedTools 'Bash(npm *),Bash(pnpm *),Bash(yarn *),Bash(bun *)'` |
| Full Access | `--permission-mode bypassPermissions` |
| Extra directories | `--add-dir <path>` |

What was observed under Default, in a neutral directory:

```text
write a file in the workspace        OK
write a file outside the workspace   REFUSED
shell redirection outside it         REFUSED
run `pnpm --version`                 OK    <- the allow-list; see below
run `git --version`                  REFUSED
```

The refusals are the useful part. `--restricted` confines the file tools *and*
the shell's writes, which is more than the flag's own description promises. The
run never blocks waiting for a person, because `--permission-prompts none`
denies anything that would prompt rather than waiting for an answer nobody is
there to give.

### Why there is an allow-list, and why it is this one

`acceptEdits` auto-approves **edits**, not **commands**. Against 2.1.281 a
session with `Bash` in `--tools` and no allow-list was refused `pnpm --version`
— and then carried on, exited 0, and reported the work as done. That is the
whole reason the `--allowedTools` flag is there.

What each candidate was measured doing:

| added to Default | dev command | write outside the workspace |
|---|---|---|
| *(nothing)* | `pnpm --version` **denied** | refused |
| `Bash(pnpm *)` | allowed | refused — **boundary holds** |
| `Bash` | allowed | **written to `/tmp` — boundary gone** |
| `Bash(node *)` | allowed | **written to `/tmp` — boundary gone** |

Rows three and four are why the list is package managers and nothing else.
`--restricted` confines Claude Code's own file tools and the shell's
redirection; it cannot confine what a child interpreter does with its own
syscalls. `node -e "require('fs').writeFileSync('/tmp/…')"` escaped on the first
attempt. Any entry that ends in an interpreter — `node`, `python`, `sh`, `env`
— removes the boundary the profile exists to provide.

Package managers are not innocent either: `pnpm test` runs the project's own
code and `pnpm exec` runs anything. The trade is deliberate and
[`default-profile.md`](default-profile.md) states it. The difference is that
running the project's tests is the thing the profile is *for*.

### The allow-list is not the whole story

Measured 2026-09-24, with the Default flags above, in a throwaway repository:

| command | |
|---|---|
| `git status --short`, `git log`, `git diff` | **allowed** |
| `cat README.md` | **allowed** |
| `find . -type f -name '*.md'` | **allowed** |
| `cat X; echo ---; which git; git status` (one compound command) | **allowed** |
| `git -C <path> status` — and `git -C .` | **refused** |
| `lsof -iTCP:5180` | **refused** |
| `echo … > <outside the workspace>` | **refused** — the boundary holds |

**Claude Code auto-approves read-only commands whatever `--allowedTools` says.** The list governs
commands with *side effects*. So an agent under the Default profile can already read the repository
it is working in, run `git status`, and look around — none of which needs a flag.

`-C` is refused as a flag, wherever it points, including at the working directory itself:
`--restricted` reads it as an attempt to leave the confined directory. An agent that wants
`git status` should ask for `git status`, standing where it already is.

This matters when reading a refusal. "The agent could not run `git -C … status`" is the boundary
working, not a missing allow-list entry, and adding `git` to a list will not change it.

`--allowedTools` is variadic (`<tools...>` in `--help`), and a repeated
variadic option **replaces** rather than appends. Four flags would leave only
the last in force — which looks like it works. Factory passes one flag with a
comma-separated value.

**You do not need to pass it yourself, and a step that tries is refused.** The
table above is what every agent step already gets. A step saying
`args: ['--allowedTools', 'Bash(pnpm *)']` would not add `pnpm` — it already has
`pnpm` — it would replace the list and lose `npm`, `yarn` and `bun`. If a
command you need is genuinely not on the list, run it in a `shell` step, which
an agent's allow-list does not govern.

### Configurations that read correctly and did not work

Recorded so nobody tries them again.

- `--tools default` does **not** name the code-running tools back in — the
  session had no Bash at all.
- `--permission-mode dontAsk` means "do not ask, and deny": it refused every
  write.
- A project `.claude/settings.json` whose `permissions.allow` names
  `Bash(git --version)` does **not** grant it: the command was still refused, so
  the allow-list cannot be delegated to the project and has to be a flag.
- **Known limitation:** in `--print` mode a settings file that fails validation
  is ignored silently. Factory does not rely on one, for that reason.

## GitHub Copilot CLI

**Reasoned, not measured.** Probing it needs a GitHub login and spends the
user's Copilot quota, so what follows is read off `--help` for 1.0.83 — and it
is a smaller claim than Claude's, because it describes flags being *withheld*
rather than a mode being relied on.

| | |
|---|---|
| Default | `--allow-all-tools` |
| Full Access | `--allow-all` |
| Extra directories | `--add-dir <path>` |

This CLI verifies file paths by default. `--allow-all-paths` is documented as
"Disable file path verification and allow access to any path", and
`--allow-all-urls` does the same for the network. Factory used to pass both, so
it was switching off confinement the provider already had; Default no longer
passes either. `--allow-all-tools` is unchanged and is required for
non-interactive use.

**What this necessarily allows:** Copilot needs a GitHub token to work, so
Default passes `GH_TOKEN`/`GITHUB_TOKEN` through. A Copilot step can therefore
reach GitHub with your credentials — including pushing. That is the cost of the
provider needing the credential at all, and it is written here rather than
implied.

**Not known:** how this CLI words a refusal. Factory therefore detects none of
them for Copilot, and will not pretend to until somebody runs it and reads the
output.

## OpenAI Codex

**Nothing has been measured.** The CLI is not installed on the machine this
descriptor was written on, and its descriptor is marked `provisional` for that
reason — `factory doctor` says so out loud.

| | |
|---|---|
| Default | *(nothing)* |
| Full Access | *(nothing)* |

Codex's documentation describes a `--sandbox workspace-write` mode that looks
like exactly the right Default. It is deliberately **not** configured here.
Writing a flag that reads correctly and does nothing is a mistake this project
has now made three times — `claude -c`, `diffity --new`, and `--tools default`
— and the third was inside this very increment.

Under Default, a Codex run is confined by Factory's own boundary and filtered
environment, and by nothing the CLI does. Doctor reports that too.

## The general shape

Factory's own guarantees do not vary by provider: the working directory, the
filtered environment, the refused `working_dir`, the process group and the kill
switch. Everything in the table above is *in addition* to those, and is the
part that differs.

If you add a provider, say what its refusals look like in its descriptor's
`denialPatterns` — and say nothing if you have not seen one.

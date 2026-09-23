---
name: factory-uninstall
description: Remove Xaedalon Factory from this machine — stop its agents, take out the software, and report exactly what was left and why. Use when the user asks to uninstall, remove or get rid of Factory, or invokes /factory-uninstall. Not for removing one project or task from Factory (that is the board, or `factory project`).
---

# Removing Factory

You are removing **Xaedalon Factory** from the machine you are running on, for the person you are
talking to, without taking anything of theirs with it.

That last clause is the whole job. Factory writes in four places, and only two of them are its own:

| | Whose |
|---|---|
| the checkout it was built in | Factory's |
| the scope in force, and the database inside it | Factory's, but it is **their history** |
| `.xaedalon/` inside each repository — definitions, usually ignored by git rather than committed, and task artifacts | **theirs** |
| a worktree, at whatever path that project stores, and the branch it was made on | **theirs**, and a git checkout besides |

Do not assume the scope is in their home directory. `FACTORY_HOME` overrides it, `FACTORY_SCOPES`
replaces the chain outright, an installation older than the rename has `~/.factory` — and the
**database follows the writable scope**, so a daemon started inside a repository with its own
`.xaedalon/.factory/` keeps its database *in that repository*. Read the paths; never type them.

The default is therefore: **remove the software, keep the data.** Everything else is named, with the
command, and left alone. This project's own doctor rule puts it best, about a scope it will not move
for you:

> Reported rather than moved. It is somebody's repository, the database may be inside it, and a tool
> that quietly relocates either is a tool nobody should trust with the other. Naming the exact
> command is the useful half.

---

## Rule one: inventory first, and tell them what you found

**Before stopping or deleting anything**, ask Factory where everything is — while it can still
answer — and show them. Then say what you are about to do:

> Here is what Factory has on this machine: *<the inventory>*. I'll stop its agents and the daemon,
> then remove the checkout and anything Factory installed outside it. I will **not** touch your
> scope — your definitions, settings and the history of every task — nor anything inside your
> repositories. I'll print the exact command for each of those so you can decide separately.

## Rule two: four things you must never do

1. **Never delete a tracked file.** A committed definition is theirs. Name the `git rm` and stop.
2. **Never delete an artifact without being asked.** They are what the agents produced — the reason
   somebody keeps a run at all.
3. **Never remove anything Factory did not install**: not the agent CLIs (Factory never installed
   them), not Node, pnpm or git, and never a repository.
4. **Never force past a refusal.** `git worktree remove` declining a dirty tree is the right answer.

---

## 1. Inventory, while Factory can still answer

Run these from the checkout. Everything here is a *read*.

```bash
node apps/cli/dist/bin.js config path            # every scope, and which is writable
curl -sf http://127.0.0.1:7317/api/projects      # each project: path, usesWorktrees, worktreesRoot
curl -sf http://127.0.0.1:7317/api/tasks         # what is running, and what is queued
command -v factory; pnpm ls -g --depth 0 2>/dev/null | grep -i factory
lsof -ti:7317 -sTCP:LISTEN                       # is a daemon running at all
```

Take the paths from those answers rather than from this document. The scope is not always
`~/.xaedalon/.factory`: `FACTORY_HOME` overrides it, and an installation made before the directory
was renamed has `~/.factory` — which on such a machine is the **live scope**, not a scratch
directory. The database is `<scope>/state/factory.db`.

**If the daemon is not running**, either start it for the inventory and stop it again, or work from
`config path` alone — and say which you did. An inventory that had to guess must announce itself.

Then three things easy to miss:

```bash
find ~ -type d -name .xaedalon -not -path '*/node_modules/*' 2>/dev/null
```

- **Stray scopes.** `factory run` in an arbitrary directory makes the agent write
  `<cwd>/.xaedalon/.factory/tasks/local/artifacts/…`, so a `.xaedalon/` can exist anywhere somebody
  once ran a workflow. That `find` lists **every** scope — the user scope and each project's
  included — so read it against the inventory: the ones it turns up that no project accounts for are
  the strays, and each is a separate decision.
- **`<scope>/.trash/<timestamp>/`** — copies of definitions a bundle import replaced, kept as cheap
  insurance. Those are *their previous work*. Say they are there before anything removes the scope.
- **Copies of these runbooks** in an agent's own configuration:
  `~/.claude/skills/factory-{setup,uninstall}`, `~/.copilot/skills/…`,
  `~/.codex/prompts/factory-*.md`.

Report it grouped, with sizes — *Factory's own* first, *theirs* second — and stop there until they
answer.

## 2. Stop everything, in the one safe order

```bash
node apps/cli/dist/bin.js stop --all      # agents first
```

Order matters and is not arbitrary. `stop --all` cancels the tasks, and cancelling is what makes the
engine kill each agent's **process group**; kill the daemon first and you orphan whatever it spawned,
which is the exact failure the kill switch was built to fix.

Then quit the desktop application if one is running — it holds the daemon — and stop the daemon
itself. **Find it by the port it holds:**

```bash
lsof -ti:7317 -sTCP:LISTEN               # the one process listening: the daemon
kill "$(lsof -ti:7317 -sTCP:LISTEN)"
curl -sf http://127.0.0.1:7317/api/health    # must fail now
lsof -ti:7317 -sTCP:LISTEN                   # must print nothing
```

**`-sTCP:LISTEN` is load-bearing, and leaving it off has already picked the wrong process.** Without
it, `lsof -ti:7317` lists every process holding *any* socket on that port — which includes each
connected client. Measured on a machine with the desktop application open and the board open in a
browser: four pids, one of them **Google Chrome Helper**, and `kill "$(lsof -ti:7317)"` would have
taken the browser with it. The desktop app contributes several of its own, because Electron's
helpers inherit the descriptor. With the flag, one pid — the listener.

Not by a recorded pid and not by a pattern either, both of which were tried here and both of which
killed the wrong thing:

- a pid file written as `… &` then `echo $!` **after a compound command** holds the *shell's* pid,
  not node's, so the signal goes to a wrapper and the daemon carries on;
- `pgrep -f "apps/daemon/dist/bin.js"` matches **any process whose command line mentions that
  string** — including the shell running these very instructions, which is what it matched.

The listening socket is unambiguous because only one process can hold it.

Stopping before touching the database is not tidiness. The store runs in WAL mode, so while it runs
there is a `factory.db-wal` and a `factory.db-shm` beside it. **A clean stop checkpoints them away** —
measured: after the daemon exits, `state/` holds `factory.db` alone. If you still see the sidecars
after stopping, something is still attached; find it before deleting anything.

**If a task is `running` or `awaiting_approval`, stop and say so.** The first has an agent mid-edit;
the second has a person waiting at a gate. Continue only if they tell you a second time.

## 3. Remove what is Factory's

Name each one with its size before it goes:

```bash
du -sh <checkout>
rm -rf <checkout>
```

Then, only if the inventory found them:

```bash
pnpm --filter @factory/cli unlink --global        # if `command -v factory` found a shim
rm -rf ~/.claude/skills/factory-setup ~/.claude/skills/factory-uninstall
rm -rf ~/.copilot/skills/factory-setup ~/.copilot/skills/factory-uninstall
rm -f  ~/.codex/prompts/factory-setup.md ~/.codex/prompts/factory-uninstall.md
```

A desktop application, if there is one: quit it (you did in step 2) and move it to the Bin. Its
licence lives inside the user scope, so it stays or goes with the scope — not separately.

## 4. Report what you left, and how to remove it

This is the half people remember. For each, give the fact and the command, and run neither.

**The user scope.** Say what it holds, read from it rather than assumed: how many definitions, the
settings (including whether the security notice was accepted), whether a Pro licence is there, and
the task and run counts from the database. Then:

```bash
# everything Factory recorded: definitions, settings, licence, and every task and run
cp -a <scope> <scope>.backup && rm -rf <scope>
```

Say what that costs, because it is more than a database: **run logs and evidence live in the
database, not in files** — including the text of every artifact as it was when it was collected. A
deleted database is the only copy gone. A stray `settings.json.tmp` from an interrupted write goes
with the directory; the WAL sidecars will already be gone if the daemon stopped cleanly.

Verify a backup before trusting it — `cp -a` then `diff -r`, which is two seconds and the
difference between a backup and a hope.

**Each repository's `.xaedalon/`.** Per project, from `git -C <repo> ls-files .xaedalon`:

- **tracked** definitions — `git -C <repo> rm -r --cached .xaedalon/.factory` and a commit, or
  `git rm -r` to delete them as well. Their repository, their commit.
- **untracked** ones, and the `.xaedalon/.gitignore` Factory wrote — an ordinary `rm -rf`. This is
  now the usual case, because that file ignores the whole directory including itself: `git status`
  will not list any of it and `git ls-files` returns nothing. **Say what is there before removing
  it** — `ls -R <repo>/.xaedalon` — because this is the one step in this runbook where git cannot
  tell them what they are about to lose.

**Artifacts**, per project, with size:

```bash
du -sh <repo>/.xaedalon/.factory/tasks          # what the agents wrote, by task
```

Those are analysis documents, review notes and verification output. Deleting them is a decision,
not a step.

**Worktrees** — only for a project whose `usesWorktrees` is on, and only at the path that project
stores:

```bash
git -C <repo> worktree list --porcelain         # the authoritative list, including any Factory forgot
git -C <repo> worktree remove <path>            # refuses a dirty tree; that refusal is correct
git -C <repo> worktree prune
```

Three things to say rather than discover:

- **`git worktree remove`, never `rm -rf`.** `git worktree add` wrote administrative files inside
  the repository at `.git/worktrees/<name>/`; removing the directory by hand leaves those behind and
  only `remove` or `prune` clears them.
- **`--force` discards uncommitted work.** If a tree is dirty, show them what is in it and let them
  decide. Do not reach for the flag because it makes the command succeed.
- **The branch survives, and should.** Factory made it (`git worktree add -b <branch>`) and nothing
  in Factory ever deletes one. List the branches its tasks used — they are the work — and leave them
  to `git branch -d` if they want.

Afterwards, a `.factory-worktrees/<project>/` left empty is Factory's own and `rmdir` is enough.

**Environments.** If a project has `usesEnvironments` on, whatever exists was created by *that
project's* `environment-*` workflows — Factory's built-in ones are deliberately inert and only print
a message telling the project to write its own. So you cannot know what is out there: name the
project's own `environment-delete` workflow, say it must run before the software goes, and stop.

## 5. Finish

Say plainly:

- what was removed, with sizes;
- what was left, and the command for each;
- that Factory is gone from this machine and nothing starts at login — there was never a service or
  a launch agent;
- how to come back: the setup runbook, and that an untouched scope means their projects, tasks and
  history are still there when they do.

One thing not worth a step: the board keeps the project they last chose in their browser's
`localStorage` for `127.0.0.1:7317`. It is a single preference, it belongs to the browser, and
clearing site data removes it if they care.

---

## If they want it all gone

Only when they say so, and never as the default. Then, in this order: everything above, then the
scope — **with a verified backup first**:

```bash
cp -a <scope> ~/factory-scope-backup-<date>
diff -r <scope> ~/factory-scope-backup-<date> && rm -rf <scope>
```

Repositories remain theirs even then. Offer the per-repository commands from step 4 and let them
run them, or run them one at a time with an explicit yes for each, naming the files.

## Platforms

macOS and Linux directly. **Windows: inside WSL2**, where the installation is — a Factory installed
under WSL2 is invisible to PowerShell, and `rm -rf` on `/mnt/c/...` is not the same operation as
deleting a Linux path. The desktop application is macOS only.

## If Factory is not installed

Say so and stop. No checkout, no scope, nothing on the port: *"There is nothing here to remove."*
Running this twice must be safe, and the second run should be boring.

## Reference

In the checkout while it still exists: [`docs/install.md`](../../docs/install.md) for where things
live, and [`skills/factory-setup/SKILL.md`](../factory-setup/SKILL.md) for the other direction.

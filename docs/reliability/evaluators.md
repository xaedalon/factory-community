# Evaluators

An evaluator classifies evidence and proposes findings. It does **not** return a
score. There is no field it could return one in, and that is the rule the whole
subsystem turns on: an agent asked how good its own work is answers 98, every
time, and a system that stores that answer has built a flattery machine with a
database behind it.

```text
Observations  ──▶  Evaluator  ──▶  normalize()  ──▶  score engine
   what Factory      dimensions      clamp, drop,      Factory
   saw               and findings    bound, note       decides
```

Two ship. Both are registered through the `reliability-evaluator` capability
kind, so a third party's is an addition rather than a fork — see
[`../plugins.md`](../plugins.md).

## The deterministic evaluator

Always. Free. In core, and provided through the capability seam like every other
built-in.

Everything it produces restates something Factory observed:

| What it saw | What it says | Who owns it |
|---|---|---|
| A command was refused | `Could not run <command>` | developer — the remedy is the profile or an allow-list |
| A path was refused | `Refused a path outside the workspace` | developer |
| A gate exited non-zero | `A check failed: <command>` | agent — a red check is something Factory can be sent at |
| An artifact was promised and is missing | `<name> was promised and is not there` | agent |

It has no opinions, which is what makes it reproducible and impossible to
flatter. What it cannot do is notice that the requirements were ambiguous, that
the approach fights the architecture it landed in, or that the new tests assert
the bug.

## The agent evaluator

`@factory/reliability-agent`. Reads the work and proposes findings with
reasoning.

It costs tokens on every run it agrees to, so most of its care is in declining.
It says no when:

- the project has chosen no model, or has switched judging off;
- no agent CLI is installed;
- this run produced nothing (`latest` is empty);
- this run produced nothing worth reading — an approval and nothing else has not
  changed the project, and paying for a re-read of the same evidence is how a
  per-run cost becomes a per-run waste.

It says yes when an artifact arrived, something was refused, or something went
red.

### The prompt

Built from observations Factory recorded, never from the agent's own account of
its work. Asking an agent to summarise itself and then judging the summary is a
machine for laundering a claim into a fact.

It carries the task, the observations, the findings already open, the evidence
keys this policy expects and the six dimensions. It asks for JSON. **It does not
ask for a score** — asking for something that would be thrown away only teaches
the model that its judgement of the total is wanted.

### Reading the answer

Forgivingly, then narrowly. Every CLI wraps JSON differently and some apologise
first, so a bare object, a fenced block and an object with prose around it are
all read. An answer that is not JSON, or is JSON but not an object, **fails** —
returning an empty judgement for an unreadable answer would report "nothing was
wrong".

A failure here is loud in the plugin and quiet downstream: `assessReliability`
turns a failed evaluator into a warning on the run, and the deterministic one's
judgement still stands.

### Which agent, which model, how hard

Three settings, and the same three an agent definition carries — because it is the
same question asked of the same CLIs.

```text
Settings page  → What reads the work → claude · strong · high
Project page   → Judged by           → codex  · o3     · (follows the installation)
```

**A project's answer beats the installation's, field by field.** Not as a trio: a
project that named a model before a provider could be named keeps that model and
inherits the provider, and a rule that took the three together would have quietly
stopped judging exactly those projects. `resolveJudge` in `@factory/core` is the
one place that decides, so the board and the daemon cannot disagree.

Empty everywhere means nothing reads the work. That is not the same as switching
judging off: the free evaluator runs either way, and naming a model is what adds
one that can read. Switching judging off keeps the trio, so turning it back on is
one click rather than three decisions.

The model is passed as `RenderRequest.model`, so a role (`strong`, `balanced`,
`fast`) or a literal id both work; the effort is passed as `RenderRequest.effort`.

### When it cannot be asked

| | |
|---|---|
| nothing named anywhere | the first provider whose binary is on this machine, silently — nobody stated anything, so nothing was disappointed |
| a named provider whose command is missing | **no judgement, and one warning** (`reliability.judgeUnavailable`). Factory does **not** ask a different one |
| a named provider nobody registered | the same rule, saying which of the two it was |
| an effort the provider has no flag for | it still asks, and says the effort was ignored (`provider.effortUnsupported`, the same warning an agent step gets) |

**No fallback is deliberate.** The trio is one decision; honouring two thirds of
it means asking Claude for a Codex model id and billing somebody for a pairing
they never chose. Refusing the *run* would be worse — the workflow succeeded, and
only the reading of it did not happen.

The warning a person is most likely to see is on the project page, the moment the
provider is chosen: that is where the absence is created. The run-time problem is
the backstop for a CLI uninstalled later.

### How it is asked

The engine renders and spawns; what crosses the plugin seam is a prompt going out
and text coming back. The evaluator never learns that processes exist.

- `session: none` — a judgement is a question asked once. A session id would make
  the second assessment of a task continue the first one's conversation, which is
  how an evaluator learns to agree with itself.
- The project's execution profile, and its environment filter.
- Three minutes, then the process group is stopped.
- The answer is capped: a CLI that narrates its whole session should not be able
  to take the daemon's memory with it.

## normalize()

Everything either evaluator returns passes through here, and what comes out is
the only thing anything downstream sees.

| | |
|---|---|
| A dimension Factory does not have | dropped, with a note |
| A score outside 0–100 | clamped, with a note |
| A finding with no title | dropped — nobody could act on it |
| A severity or owner outside the vocabulary | dropped |
| `scoreImpact` beyond `maxDriverImpact` (15) | bounded |
| A recommendation naming a workflow the project lacks | dropped — the board would draw a button with nothing behind it |
| A resolution for an id that does not exist | dropped |

Every correction becomes a warning `Problem` on the run, so a rejected claim is
visible rather than silent.

The bound on impact is the important one. An evaluator returning `-80` on a
single finding has set the score by another name. That is the difference between
"this evaluator thinks this is very bad" and "this evaluator decides".

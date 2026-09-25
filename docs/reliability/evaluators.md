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

### Which model

A project setting. A weekend project and a payments service do not want the same
model, and neither wants one named in Factory's source spending their tokens.

```text
Project page → Judged by → claude-opus-5-5
```

Empty means nothing reads the work. That is not the same as switching judging
off: the free evaluator runs either way, and naming a model is what adds one that
can read. Switching judging off keeps the model, so turning it back on is one
click rather than two decisions.

The string is passed to the provider as `RenderRequest.model`, so a role
(`strong`, `balanced`, `fast`) or a literal model id both work.

### Which CLI asks it

The first provider whose binary is actually on this machine, in registration
order — Claude, Codex, Copilot. Registered is not the question; runnable is.
Factory ships three provider plugins and almost nobody has three CLIs installed.

Two installed CLIs means the first is used rather than a planning error on a run
that succeeded. It matters only in that the model a project names has to be one
that provider understands.

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

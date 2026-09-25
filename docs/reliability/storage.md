# Storage

SQLite, migration 21, in the database task state already lives in. The
specification suggested a JSON file per task; it also forbids a second source of
truth, and task state is here.

## Three tables

**`reliability_assessments`** — append-only history. There is no `update` and
there is not going to be one: a judgement is never edited because interpretation
changed, and a correction is a later assessment that supersedes. A history that
can be rewritten is not evidence of anything.

Ordering is `sequence`, not a timestamp. Two assessments in the same millisecond
are possible — one scenario freezes the clock and proves the timestamps really
are identical — so ordering by time would be a coin toss. The sequence is taken
inside the transaction that inserts.

**`reliability_drivers`** — every finding, whatever became of it, with who
accepted it and why when somebody did.

**`reliability_observations`** — the small, durable note of what each assessment
*saw*. Artifacts are referenced by path, never copied; a 200 KB document
duplicated here would be a second copy that goes stale. But without this the
explanation of a score cannot be reconstructed once the run logs are trimmed,
and they are, on a budget.

Two columns on `projects`, not one nullable model: `reliability_model` (nullable)
and `reliability_enabled` (`INTEGER NOT NULL DEFAULT 1`).

Two, because "nobody has said" and "switched off" are different positions.
Unlike `profile`, there is no installation-level fallback to inherit — a project
that names no model has no agent evaluator, and falling back to a model named in
Factory's own source would spend somebody's tokens on a decision they never made.
Switching judging off keeps whatever model was chosen, so turning it back on is
one click rather than two decisions.

## Two things deliberately not stored

**The current score.** It is the newest assessment plus the drivers still
active — two indexed queries. A stored copy would be a second source of truth for
something the history already says, and the two disagree the first time an
assessment is replayed. `progress` on a task is derived for exactly this reason.

**Staleness.** An assessment records the newest run it took into account, so a
run that finished after it means the judgement is behind the work. Nothing has to
be written down, and nothing can be written down wrongly.

The assembly lives in one function on the daemon's `Service`, so the task detail
payload and the reliability routes cannot describe the same task differently.

## JSON columns

`dimensions`, `caps`, `explanation`, `recommended_action` and `evidence_refs` are
JSON in TEXT — a small set, read whole with its owner, never queried across
owners, which is the line `projects.granted_directories` drew.

Every read goes through a parser that **degrades to empty and never throws**. A
score reading zero is a bug worth seeing; a board that will not open is a bug
that hides every other one. A dimension the column omits is filled in, because a
missing key is indistinguishable from zero downstream.

## Deletion

Everything cascades from the task. Deleting a task takes its judgement, its
findings and its observations with it.

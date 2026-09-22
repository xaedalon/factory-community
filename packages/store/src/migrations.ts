import type { Migration } from './migrate.js'

/**
 * Factory's own migrations, in order.
 *
 * Append only. Editing one that has shipped means two databases claiming the
 * same version with different schemas, which is exactly the state the version
 * number exists to make impossible.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    describe: 'tasks, their workflow assignments, and their history',
    up: (db) => {
      db.exec(`
        CREATE TABLE tasks (
          id              TEXT PRIMARY KEY,
          name            TEXT NOT NULL,
          ticket_id       TEXT,
          branch          TEXT,
          directory       TEXT,
          state           TEXT NOT NULL,
          queue_position  INTEGER,
          blocked_reason  TEXT,
          created_at      TEXT NOT NULL,
          updated_at      TEXT NOT NULL,
          completed_at    TEXT
        );

        -- The board's main query is "everything in this state, in order", and
        -- the scheduler's is "the next queued one".
        CREATE INDEX tasks_by_state ON tasks (state, queue_position);

        CREATE TABLE task_workflows (
          task_id   TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          position  INTEGER NOT NULL,
          workflow  TEXT NOT NULL,
          PRIMARY KEY (task_id, position)
        );

        -- Why a task is where it is. The prototype could not answer that
        -- without reading log files, so every question started with archaeology.
        CREATE TABLE task_history (
          id       INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          at       TEXT NOT NULL,
          action   TEXT NOT NULL,
          from_state TEXT NOT NULL,
          to_state   TEXT NOT NULL,
          detail   TEXT
        );

        CREATE INDEX task_history_by_task ON task_history (task_id, id);
      `)
    },
  },
  {
    version: 2,
    describe: 'runs, their steps, and the output those steps produced',
    up: (db) => {
      db.exec(`
        CREATE TABLE runs (
          id            TEXT PRIMARY KEY,
          -- Null on purpose: \`factory run\` runs a workflow without a task, and
          -- refusing to record those would mean the only runs anyone could look
          -- back at are the ones the board started.
          task_id       TEXT REFERENCES tasks(id) ON DELETE CASCADE,
          workflow      TEXT NOT NULL,
          state         TEXT NOT NULL,
          attempt       INTEGER NOT NULL DEFAULT 1,
          -- Which of the task's workflows this run is. A resume continues with
          -- the ones after it.
          workflow_index INTEGER NOT NULL DEFAULT 0,
          -- Where a paused run picks up: the phase after the approval gate.
          resume_phase  INTEGER,
          started_at    TEXT NOT NULL,
          finished_at   TEXT,
          detail        TEXT,
          -- Bytes dropped from output that belongs to the run rather than a step.
          dropped_bytes INTEGER NOT NULL DEFAULT 0
        );

        -- "This task's runs, newest first" is what a task page opens with.
        CREATE INDEX runs_by_task ON runs (task_id, started_at DESC);
        -- Boot reconciliation asks only one question: what is still running?
        CREATE INDEX runs_by_state ON runs (state);

        CREATE TABLE run_steps (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id        TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          phase         TEXT NOT NULL,
          step_index    INTEGER NOT NULL,
          describe      TEXT NOT NULL,
          uses          TEXT NOT NULL,
          state         TEXT NOT NULL,
          exit_code     INTEGER,
          started_at    TEXT NOT NULL,
          finished_at   TEXT,
          detail        TEXT,
          dropped_bytes INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX run_steps_by_run ON run_steps (run_id, id);

        CREATE TABLE run_logs (
          id      INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id  TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          -- Null for output the run produced outside any step: creating a
          -- worktree, resolving the plan, the engine explaining itself.
          step_id INTEGER REFERENCES run_steps(id) ON DELETE CASCADE,
          at      TEXT NOT NULL,
          stream  TEXT NOT NULL,
          text    TEXT NOT NULL,
          bytes   INTEGER NOT NULL,
          -- Part of the head, which is kept whatever else is dropped.
          pinned  INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX run_logs_by_step ON run_logs (run_id, step_id, id);
      `)
    },
  },
  {
    version: 3,
    describe: 'the flags a task has earned',
    up: (db) => {
      db.exec(`
        -- Flags are facts about a task: it has a worktree, it has an
        -- environment. A workflow declares which ones it provides or clears,
        -- and a workflow that requires one waits until it holds. Rows rather
        -- than columns, because the set of flags belongs to whoever writes the
        -- workflows, not to Factory.
        CREATE TABLE task_flags (
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          flag    TEXT NOT NULL,
          set_at  TEXT NOT NULL,
          PRIMARY KEY (task_id, flag)
        );
      `)
    },
  },
  {
    version: 4,
    describe: 'where a task is in its workflow list, and when it may next run',
    up: (db) => {
      db.exec(`
        -- Where the engine starts. A retry after a failure resumes the workflow
        -- that failed instead of repeating the ones that already worked.
        ALTER TABLE tasks ADD COLUMN next_workflow INTEGER NOT NULL DEFAULT 0;
        -- Set between iterations of a loop workflow. The scheduler passes over a
        -- queued task whose time has not come.
        ALTER TABLE tasks ADD COLUMN runnable_at TEXT;
      `)
    },
  },
  {
    version: 5,
    describe: 'projects, and the project a task belongs to',
    up: (db) => {
      db.exec(`
        CREATE TABLE projects (
          id             TEXT PRIMARY KEY,
          name           TEXT NOT NULL UNIQUE,
          path           TEXT NOT NULL,
          default_branch TEXT NOT NULL,
          -- Never inside the repository; see core/task/project.ts for why.
          worktrees_root TEXT NOT NULL,
          is_repository  INTEGER NOT NULL DEFAULT 1,
          created_at     TEXT NOT NULL
        );

        -- ON DELETE SET NULL rather than CASCADE: removing a project from
        -- Factory is a bookkeeping act, and it must not delete the record of
        -- work that was done in it.
        ALTER TABLE tasks ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;
      `)
    },
  },
  {
    version: 6,
    describe: 'evidence: the artifacts a phase promised and what it produced',
    up: (db) => {
      db.exec(`
        -- One row per phase that declared an artifact, whether or not the file
        -- turned up. A promise that was not kept is exactly the thing worth
        -- recording: the prototype had no way to notice.
        CREATE TABLE run_evidence (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id       TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          phase        TEXT NOT NULL,
          -- Absolute path, so a person can open the real file.
          path         TEXT NOT NULL,
          content      TEXT,
          -- Size on disk, which is not the size of what is stored when the
          -- content was truncated or the file was binary.
          bytes        INTEGER NOT NULL DEFAULT 0,
          truncated    INTEGER NOT NULL DEFAULT 0,
          missing      INTEGER NOT NULL DEFAULT 0,
          collected_at TEXT NOT NULL,
          UNIQUE (run_id, phase)
        );
      `)
    },
  },
  {
    version: 7,
    describe: 'how many times a step had to run',
    up: (db) => {
      db.exec(`
        -- A step that succeeded on its third attempt is not the same as one
        -- that succeeded first time, and the difference is what tells someone
        -- their agent or their test is flaky.
        ALTER TABLE run_steps ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1;
      `)
    },
  },
  {
    version: 8,
    describe: 'whether a project gives each task its own worktree',
    up: (db) => {
      db.exec(`
        -- Every project that exists today was added when a worktree per task was
        -- the only behaviour, so that is what they keep.
        ALTER TABLE projects ADD COLUMN uses_worktrees INTEGER NOT NULL DEFAULT 1;
        -- Except the ones that never could: a worktree needs a repository.
        UPDATE projects SET uses_worktrees = 0 WHERE is_repository = 0;
      `)
    },
  },
  {
    version: 9,
    describe: 'whether a project gives each task its own environment',
    up: (db) => {
      db.exec(`
        -- Off for everything that exists, and off for anything added later
        -- unless it asks. Factory cannot build an environment on its own, so
        -- claiming a project has one would be a lie with consequences: a
        -- workflow gated on hasEnvironment would wait forever.
        ALTER TABLE projects ADD COLUMN uses_environments INTEGER NOT NULL DEFAULT 0;
      `)
    },
  },
  {
    version: 10,
    describe: 'evidence belongs to the artifact that was promised, not to the phase',
    up: (db) => {
      // An artifact is a step's promise now, and a phase can hold several steps
      // — so `UNIQUE (run_id, phase)` would let two artifacts in one phase
      // overwrite each other, silently keeping whichever ran last.
      //
      // Rebuilt rather than altered: SQLite cannot drop a constraint. Existing
      // rows take their phase's name as the artifact name, which is what they
      // were in all but spelling.
      db.exec(`
        CREATE TABLE run_evidence_new (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id       TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          phase        TEXT NOT NULL,
          -- What the step called it. The file is always <name>.md.
          name         TEXT NOT NULL,
          -- Absolute path, so a person can open the real file.
          path         TEXT NOT NULL,
          content      TEXT,
          bytes        INTEGER NOT NULL DEFAULT 0,
          truncated    INTEGER NOT NULL DEFAULT 0,
          missing      INTEGER NOT NULL DEFAULT 0,
          collected_at TEXT NOT NULL,
          UNIQUE (run_id, name)
        );

        INSERT INTO run_evidence_new
          (id, run_id, phase, name, path, content, bytes, truncated, missing, collected_at)
        SELECT id, run_id, phase, phase, path, content, bytes, truncated, missing, collected_at
          FROM run_evidence;

        DROP TABLE run_evidence;
        ALTER TABLE run_evidence_new RENAME TO run_evidence;
      `)
    },
  },
  {
    version: 11,
    describe: 'a task carries what it is for, not just what it is called',
    up: (db) => {
      // Prose, so '' is the empty value rather than NULL. A description is
      // either written or not yet written; two ways to spell "none" would show
      // up as `{{ task.description }}` resolving to the string "null".
      db.exec(`ALTER TABLE tasks ADD COLUMN description TEXT NOT NULL DEFAULT ''`)
    },
  },
  {
    version: 12,
    describe: 'which of a task\'s workflows are still to run, one row at a time',
    up: (db) => {
      // A cursor nobody can see. `tasks.next_workflow` recorded how far a task
      // had got, and it was right — a retry did resume — but nothing showed it,
      // and any edit to the list reset it to zero because a position in the old
      // list means nothing in the new one. Per-entry state survives an edit and
      // can be drawn as a tickbox.
      //
      // `entry_id` rather than position as the handle: position is what moves
      // when you reorder, which is precisely the edit that must not lose state.
      db.exec(`
        ALTER TABLE task_workflows ADD COLUMN entry_id TEXT;
        ALTER TABLE task_workflows ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
      `)
      // Deterministic, not random: a migration whose output differs per run is
      // one nobody can reason about afterwards. Unique by construction, because
      // (task_id, position) already is.
      db.exec(`UPDATE task_workflows SET entry_id = task_id || '#' || position`)
      db.exec(`CREATE UNIQUE INDEX task_workflows_entry ON task_workflows (task_id, entry_id)`)

      // Runs point at the entry they were for, not the position it happened to
      // hold. **No foreign key on purpose**: `assign` deletes and re-inserts
      // every row, so ON DELETE CASCADE here would wipe a task's whole run
      // history every time somebody saved its list.
      db.exec(`ALTER TABLE runs ADD COLUMN entry_id TEXT`)
      db.exec(`
        UPDATE runs SET entry_id = (
          SELECT w.entry_id FROM task_workflows w
          WHERE w.task_id = runs.task_id AND w.position = runs.workflow_index
        )
      `)
      db.exec(`CREATE INDEX runs_by_entry ON runs (task_id, entry_id)`)

      // The translation. Everything before the cursor has run, so it unticks;
      // everything at or after it stays ticked. A done task has the cursor at
      // the end and unticks entirely; a fresh one has it at zero and unticks
      // nothing; a looping one sits *at* its entry, which stays ticked.
      //
      // Without this every in-flight task would start again from its first
      // workflow on upgrade — the exact bug this replaces, inflicted once on
      // the way in.
      db.exec(`
        UPDATE task_workflows SET enabled = 0
        WHERE position < (SELECT t.next_workflow FROM tasks t WHERE t.id = task_workflows.task_id)
      `)

      // Dropped, not left unread: a column nothing reads is a second answer to
      // "what runs next" waiting for someone to believe it.
      //
      // DROP COLUMN rather than the rebuild-and-rename that migration 10 uses.
      // That pattern is safe for a table with no children; `tasks` has four
      // that cascade on delete, so dropping it would take every run, every
      // history row and every assignment with it.
      db.exec(`ALTER TABLE tasks DROP COLUMN next_workflow`)
    },
  },
  {
    version: 13,
    describe: "the agent session a task's steps share",
    up: (db) => {
      // Two columns rather than one, because they are two facts and both are
      // needed to resume: the id names the conversation, the provider decides
      // which CLI flag opens it. Deriving the provider later from the task's
      // phases would let an edit to a phase disagree with what actually ran.
      //
      // Purely additive, like migration 11's `description` — no rebuild, no
      // index, nothing to translate. Every existing task has no session, which
      // is the truth: `-c` was resuming by "most recent conversation here" and
      // left no id behind for anything to record.
      db.exec(`
        ALTER TABLE tasks ADD COLUMN session_id TEXT;
        ALTER TABLE tasks ADD COLUMN session_provider TEXT;
      `)
    },
  },
  {
    version: 14,
    describe: 'how much authority a project grants, and what a run was given',
    up: (db) => {
      // Three columns, two questions.
      //
      // `projects.profile` is nullable and null means "not stated", which is
      // not the same as `default`: a project that has never been asked follows
      // the installation's choice, so changing that choice actually changes the
      // projects that never chose. Storing `default` for everyone would freeze
      // every existing project against a setting they had no chance to see.
      //
      // `projects.granted_directories` is a JSON array of absolute paths the
      // project has allowed beyond its workspace, for good.
      //
      // Directories rather than permission *classes*, because a class is not
      // something Factory can honour. Factory does not mediate the action — the
      // agent's own CLI refuses it — so the only lever Factory has is what it
      // passes on the next invocation, and `--add-dir` is the one that was
      // measured to work. A grant is therefore a concrete thing: one more
      // directory inside the effective boundary, which is also what §31 of the
      // standard describes.
      //
      // Text rather than a table because it is a small set, read whole, always
      // with its project, and never queried across projects — the shape
      // `task_workflows` needed a table for, this does not.
      //
      // `runs.profile` is what the run was actually given, recorded rather than
      // derived. Deriving it later would read today's project setting and
      // describe a run that happened under a different one, which is the same
      // trap `session_provider` was added to avoid in migration 13. Null for
      // every run that already exists, because nothing knew.
      db.exec(`
        ALTER TABLE projects ADD COLUMN profile TEXT;
        ALTER TABLE projects ADD COLUMN granted_directories TEXT;
        ALTER TABLE runs ADD COLUMN profile TEXT;
      `)
    },
  },
  {
    version: 15,
    describe: 'one task waiting for another',
    up: (db) => {
      // A table rather than a column, because this is asked in both directions:
      // "what blocks me" for the gate, and "what do I block" for the board. A
      // JSON column — the shape `projects.granted_directories` takes — is right
      // for a small set always read whole with its owner, and wrong here.
      //
      // `ON DELETE CASCADE` on both sides. An edge naming a task that has been
      // deleted is a dependency nothing can ever satisfy, and the dependent
      // would wait for a row nobody can find.
      //
      // The reverse index is for the board: it draws "what is waiting for this"
      // on a task page, which is a lookup by blocker.
      db.exec(`
        CREATE TABLE task_dependencies (
          task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          depends_on_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          PRIMARY KEY (task_id, depends_on_id)
        );
        CREATE INDEX task_dependencies_by_blocker
          ON task_dependencies(depends_on_id);
      `)
    },
  },
  {
    version: 16,
    describe: "a project's own square: a chosen hue and chosen letters",
    up: (db) => {
      // Both nullable, and null keeps exactly the behaviour that was here
      // before: the square is derived from the name. `identity.ts` argues for
      // that derivation and the argument still holds — adding a project should
      // need no decision from anybody, and a name is enough to be consistent
      // everywhere without storing a thing.
      //
      // What it cannot do is survive a rename, which changes the hash and so
      // changes the colour of a square somebody had already learned. And with
      // six hues, two projects collide often enough to matter. So this is an
      // override, not a replacement: unset means derived, set means chosen.
      //
      // `tone` is an index into the six `--color-project-N` hues rather than a
      // hex. The palette is deliberately closed — tokens.css says a seventh
      // meaning for colour does not go there — and storing a free colour would
      // let a project sit outside it.
      db.exec(`
        ALTER TABLE projects ADD COLUMN tone INTEGER;
        ALTER TABLE projects ADD COLUMN initials TEXT;
      `)
    },
  },
  {
    version: 17,
    describe: 'a task cannot exist without a project',
    // The rebuild below drops `tasks`, which every run, step, log, evidence row,
    // history row, workflow entry and dependency edge points at with ON DELETE
    // CASCADE. See `rebuildsForeignKeys` in migrate.ts: without this, the drop
    // takes all of them.
    rebuildsForeignKeys: true,
    up: (db) => {
      // Migration 5 made `project_id` nullable with ON DELETE SET NULL,
      // reasoning that removing a project is bookkeeping and must not delete the
      // record of work. Right about the record, wrong about the remedy:
      // orphaning a task does not keep it usable. It ran wherever the daemon
      // happened to be started, wrote its artifacts beside it, could not be
      // queued as a batch or given a worktree, and vanished from the board the
      // moment any project was selected. Removal is refused now instead, which
      // keeps the record by keeping the project.
      //
      // Foreign keys are off for this whole transaction, so ON DELETE CASCADE
      // does not fire and the orphans' children are deleted by hand — exactly
      // what the cascade would have done. The ids go into a temp table first,
      // which is what makes the order below irrelevant: every delete reads the
      // captured list rather than `tasks`, so removing the tasks early would
      // not strand anything. `PRAGMA foreign_key_check` at the end is what
      // proves no table was forgotten — `task_flags` was, once.
      const orphans =
        db.get<{ n: number }>('SELECT count(*) AS n FROM tasks WHERE project_id IS NULL')?.n ?? 0

      db.exec(`
        CREATE TEMP TABLE orphan_tasks AS SELECT id FROM tasks WHERE project_id IS NULL;

        DELETE FROM run_logs WHERE run_id IN
          (SELECT id FROM runs WHERE task_id IN (SELECT id FROM orphan_tasks));
        DELETE FROM run_evidence WHERE run_id IN
          (SELECT id FROM runs WHERE task_id IN (SELECT id FROM orphan_tasks));
        DELETE FROM run_steps WHERE run_id IN
          (SELECT id FROM runs WHERE task_id IN (SELECT id FROM orphan_tasks));
        DELETE FROM runs WHERE task_id IN (SELECT id FROM orphan_tasks);
        DELETE FROM task_workflows WHERE task_id IN (SELECT id FROM orphan_tasks);
        DELETE FROM task_flags WHERE task_id IN (SELECT id FROM orphan_tasks);
        DELETE FROM task_history WHERE task_id IN (SELECT id FROM orphan_tasks);
        DELETE FROM task_dependencies
          WHERE task_id IN (SELECT id FROM orphan_tasks)
             OR depends_on_id IN (SELECT id FROM orphan_tasks);
        DELETE FROM tasks WHERE id IN (SELECT id FROM orphan_tasks);
        DROP TABLE orphan_tasks;
      `)

      // ON DELETE RESTRICT rather than CASCADE: a project is removable only
      // while nothing is left in it, and `ProjectRepository.remove` refuses
      // first so the message can name the count. This is the backstop for
      // anything that goes round the repository — belt to NOT NULL's braces,
      // which refuses a SET NULL action on its own.
      db.exec(`
        CREATE TABLE tasks_new (
          id                TEXT PRIMARY KEY,
          name              TEXT NOT NULL,
          description       TEXT NOT NULL DEFAULT '',
          project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
          ticket_id         TEXT,
          branch            TEXT,
          directory         TEXT,
          state             TEXT NOT NULL,
          queue_position    INTEGER,
          blocked_reason    TEXT,
          created_at        TEXT NOT NULL,
          updated_at        TEXT NOT NULL,
          completed_at      TEXT,
          runnable_at       TEXT,
          session_id        TEXT,
          session_provider  TEXT
        );

        INSERT INTO tasks_new (
          id, name, description, project_id, ticket_id, branch, directory, state,
          queue_position, blocked_reason, created_at, updated_at, completed_at,
          runnable_at, session_id, session_provider
        )
        SELECT
          id, name, description, project_id, ticket_id, branch, directory, state,
          queue_position, blocked_reason, created_at, updated_at, completed_at,
          runnable_at, session_id, session_provider
        FROM tasks;

        DROP TABLE tasks;
        ALTER TABLE tasks_new RENAME TO tasks;

        -- The board's main query is "everything in this state, in order", and the
        -- scheduler's is "the next queued one". Recreated because the index went
        -- with the old table.
        CREATE INDEX tasks_by_state ON tasks (state, queue_position);
      `)

      // Proving the invariant rather than assuming it, the way migration 15
      // checks for cycles. With enforcement off for this transaction, nothing
      // else would notice a child left pointing at a task that is gone.
      const violations = db.all('PRAGMA foreign_key_check')
      if (violations.length > 0) {
        throw new Error(
          `Rebuilding tasks left ${violations.length} foreign key violation(s): ` +
            JSON.stringify(violations),
        )
      }

      // Deleting somebody's tasks is a one-way door and this runs unattended when
      // a daemon starts, so the count is carried out to the migration log rather
      // than left only in the schema.
      return orphans > 0
        ? `deleted ${orphans} task(s) that belonged to no project, and everything recorded about them`
        : undefined
    },
  },
  {
    version: 18,
    describe: 'a step records the command it actually ran',
    up: (db) => {
      // Nullable, because every step recorded before this ran without anybody
      // writing it down, and a skipped step never ran one at all. Null is the
      // truth in both cases; a default would invent a command that was never
      // executed.
      db.exec('ALTER TABLE run_steps ADD COLUMN command TEXT')
    },
  },
]

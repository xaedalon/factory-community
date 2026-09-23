import { randomUUID } from 'node:crypto'
import type { EventBus } from '@factory/events'
import {
  isExecutionProfile,
  isRunFinished,
  type Evidence,
  type ExecutionProfile,
  type LogStream,
  type LogView,
  type Run,
  type RunState,
  type RunStep,
  type StepState,
} from '@factory/core'
import type { Database } from './sqlite.js'

/**
 * Runs, steps and their output, on disk.
 *
 * One attempt at one workflow is one row in `runs`; every step it reached is a
 * row in `run_steps`; everything printed is a row in `run_logs` attached to the
 * step that printed it. That shape is chosen so the questions people actually
 * ask — what ran, what failed, what did it say — are single queries rather than
 * a search through log files named after timestamps.
 */

/**
 * How much output one step may keep, and how much of the beginning is kept
 * whatever happens.
 *
 * A step that prints forever is not a rare case: a dev server started by
 * mistake, a watcher, an agent in a retry loop. When the budget is exceeded the
 * middle goes, because the beginning says what was asked and the end says how
 * it ended, and those are the two parts anyone reads.
 */
export const DEFAULT_LOG_BUDGET_BYTES = 1024 * 1024
export const DEFAULT_LOG_HEAD_BYTES = 64 * 1024

/**
 * How much of an artifact is kept in the database.
 *
 * The file itself stays where the phase wrote it — this is a copy, so the
 * evidence survives the worktree being removed, and so a person can read it
 * without a filesystem. A test report or a review note is kilobytes; anything
 * much larger is a build output that belongs on disk, not in a row.
 */
export const DEFAULT_EVIDENCE_BYTES = 256 * 1024

interface RunRow {
  id: string
  task_id: string | null
  workflow: string
  state: string
  attempt: number
  workflow_index: number
  entry_id: string | null
  resume_phase: number | null
  started_at: string
  finished_at: string | null
  detail: string | null
  profile: string | null
  origin_run_id: string | null
  depth: number
  dropped_bytes: number
}

interface StepRow {
  id: number
  run_id: string
  phase: string
  step_index: number
  describe: string
  uses: string
  state: string
  exit_code: number | null
  attempts: number
  started_at: string
  finished_at: string | null
  detail: string | null
  dropped_bytes: number
  command: string | null
}

interface EvidenceRow {
  id: number
  run_id: string
  phase: string
  name: string
  path: string
  content: string | null
  bytes: number
  truncated: number
  missing: number
  collected_at: string
}

export interface RunRepositoryOptions {
  readonly db: Database
  readonly events?: EventBus
  readonly now?: () => string
  readonly newId?: () => string
  /** Bytes of output kept per step. Lowered in tests so the trimming is testable. */
  readonly logBudgetBytes?: number
  /** Bytes of the beginning that are never dropped. */
  readonly logHeadBytes?: number
  /** Bytes of an artifact kept in the database. */
  readonly evidenceBytes?: number
}

export interface StartRun {
  readonly workflow: string
  readonly taskId?: string
  readonly attempt?: number
  readonly workflowIndex?: number
  /**
   * The task-workflow entry this run is for.
   *
   * Position moves when a list is reordered; this does not, which is what lets
   * a resumed run find its own entry and a loop count its own iterations.
   */
  readonly entryId?: string
  /** How much authority this run is given. Straight off the plan. */
  readonly profile?: ExecutionProfile
  /** The run whose agent asked for this work, when an agent did. */
  readonly originRunId?: string
  /** How far from the person who started all this. Defaults to 0: they did. */
  readonly depth?: number
}

export interface StartStep {
  readonly phase: string
  readonly index: number
  readonly describe: string
  readonly uses: string
  /**
   * What it actually ran, as a line somebody could paste.
   *
   * Absent for a step that ran no process — a skipped one — and for every step
   * recorded before this existed.
   */
  readonly command?: string
}

export interface FinishStep {
  readonly state: StepState
  readonly exitCode?: number
  readonly detail?: string
  /** More than one means the step was retried. */
  readonly attempts?: number
}

export class RunRepository {
  readonly #db: Database
  readonly #events: EventBus | undefined
  readonly #now: () => string
  readonly #newId: () => string
  readonly #budget: number
  readonly #head: number
  readonly #evidence: number

  constructor(options: RunRepositoryOptions) {
    this.#db = options.db
    this.#events = options.events
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#newId = options.newId ?? (() => randomUUID())
    this.#budget = options.logBudgetBytes ?? DEFAULT_LOG_BUDGET_BYTES
    this.#head = options.logHeadBytes ?? DEFAULT_LOG_HEAD_BYTES
    this.#evidence = options.evidenceBytes ?? DEFAULT_EVIDENCE_BYTES
  }

  start(input: StartRun): Run {
    const id = this.#newId()
    const now = this.#now()

    // Checked here rather than left to the foreign key, because "FOREIGN KEY
    // constraint failed" tells whoever is reading the daemon's log nothing
    // about which id was wrong.
    if (input.taskId !== undefined) {
      const task = this.#db.get<{ id: string }>('SELECT id FROM tasks WHERE id = ?', input.taskId)
      if (task === undefined) {
        throw new Error(`Cannot start a run for task ${input.taskId}: no such task.`)
      }
    }

    this.#db.run(
      `INSERT INTO runs
         (id, task_id, workflow, state, attempt, workflow_index, entry_id, profile,
          origin_run_id, depth, started_at)
       VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.taskId ?? null,
      input.workflow,
      input.attempt ?? 1,
      input.workflowIndex ?? 0,
      input.entryId ?? null,
      input.profile ?? null,
      input.originRunId ?? null,
      input.depth ?? 0,
      now,
    )
    this.#events?.emit('run.started', { runId: id, workflow: input.workflow })
    return this.#require(id)
  }

  get(id: string): Run | undefined {
    const row = this.#db.get<RunRow>('SELECT * FROM runs WHERE id = ?', id)
    return row === undefined ? undefined : hydrateRun(row)
  }

  /** A task's runs, newest first: a task page wants the latest attempt at the top. */
  forTask(taskId: string): Run[] {
    return this.#db
      .all<RunRow>('SELECT * FROM runs WHERE task_id = ? ORDER BY started_at DESC, rowid DESC', taskId)
      .map(hydrateRun)
  }

  /**
   * Runs still marked running.
   *
   * After a crash these are lies — nothing is running any more — and boot
   * reconciliation closes them. Keeping the question here means reconciliation
   * does not have to know how a run is stored.
   *
   * Paused runs are deliberately not included. One is waiting for a person, not
   * for a process, and closing it on restart would throw away the work it holds.
   */
  running(): Run[] {
    return this.#db
      .all<RunRow>("SELECT * FROM runs WHERE state = 'running' ORDER BY started_at")
      .map(hydrateRun)
  }

  finish(id: string, state: RunState, options: { detail?: string } = {}): Run {
    return this.#db.transaction(() => {
      const run = this.get(id)
      if (run === undefined) throw new Error(`No run ${id}.`)
      // A second verdict on the same run means two things believe they own it.
      // Losing the first one quietly is how a failed run ends up looking fine.
      if (isRunFinished(run.state)) {
        throw new Error(`Run ${id} already finished as "${run.state}"; cannot finish it again.`)
      }

      const now = this.#now()
      this.#db.run(
        'UPDATE runs SET state = ?, finished_at = ?, detail = ? WHERE id = ?',
        state,
        now,
        options.detail ?? null,
        id,
      )
      this.#events?.emit('run.completed', {
        runId: id,
        workflow: run.workflow,
        ok: state === 'completed',
      })
      return this.#require(id)
    })
  }

  /**
   * Stop at an approval gate, remembering where to continue.
   *
   * Not `finish`: a paused run is still owned by whoever started it, and the
   * phases before the gate must not run a second time when someone approves.
   */
  pause(id: string, resumePhase: number, detail?: string): Run {
    const run = this.#require(id)
    if (run.state !== 'running') {
      throw new Error(`Run ${id} is "${run.state}"; only a running run can pause.`)
    }
    this.#db.run(
      "UPDATE runs SET state = 'paused', resume_phase = ?, detail = ? WHERE id = ?",
      resumePhase,
      detail ?? null,
      id,
    )
    return this.#require(id)
  }

  /** Pick a paused run back up. */
  resume(id: string): Run {
    const run = this.#require(id)
    if (run.state !== 'paused') {
      throw new Error(`Run ${id} is "${run.state}"; only a paused run can resume.`)
    }
    this.#db.run("UPDATE runs SET state = 'running', detail = NULL WHERE id = ?", id)
    return this.#require(id)
  }

  /** The run this task is waiting on, if it is waiting on one. */
  pausedFor(taskId: string): Run | undefined {
    const row = this.#db.get<RunRow>(
      "SELECT * FROM runs WHERE task_id = ? AND state = 'paused' ORDER BY started_at DESC LIMIT 1",
      taskId,
    )
    return row === undefined ? undefined : hydrateRun(row)
  }

  /** Highest attempt recorded for this task and workflow. Zero when there is none. */
  attempts(taskId: string, workflow: string): number {
    const row = this.#db.get<{ attempt: number | null }>(
      'SELECT MAX(attempt) AS attempt FROM runs WHERE task_id = ? AND workflow = ?',
      taskId,
      workflow,
    )
    return row?.attempt ?? 0
  }

  startStep(runId: string, input: StartStep): RunStep {
    const now = this.#now()
    const inserted = this.#db.run(
      `INSERT INTO run_steps (run_id, phase, step_index, describe, uses, state, started_at, command)
       VALUES (?, ?, ?, ?, ?, 'running', ?, ?)`,
      runId,
      input.phase,
      input.index,
      input.describe,
      input.uses,
      now,
      input.command ?? null,
    )
    const id = Number(inserted.lastInsertRowid)
    this.#events?.emit('step.started', {
      runId,
      phase: input.phase,
      index: input.index,
      uses: input.uses,
    })
    return this.#requireStep(id)
  }

  finishStep(stepId: number, outcome: FinishStep): RunStep {
    const step = this.#requireStep(stepId)
    const now = this.#now()
    this.#db.run(
      `UPDATE run_steps
          SET state = ?, exit_code = ?, finished_at = ?, detail = ?, attempts = ?
        WHERE id = ?`,
      outcome.state,
      outcome.exitCode ?? null,
      now,
      outcome.detail ?? null,
      outcome.attempts ?? 1,
      stepId,
    )

    if (outcome.state === 'completed') {
      this.#events?.emit('step.completed', {
        runId: step.runId,
        phase: step.phase,
        index: step.index,
        exitCode: outcome.exitCode ?? 0,
      })
    } else if (outcome.state !== 'skipped') {
      this.#events?.emit('step.failed', {
        runId: step.runId,
        phase: step.phase,
        index: step.index,
        exitCode: outcome.exitCode ?? -1,
        message: outcome.detail ?? `Step ${step.describe} ${outcome.state}.`,
      })
    }
    return this.#requireStep(stepId)
  }

  /** A step that never ran, recorded so the run shows what it did not reach. */
  skipStep(runId: string, input: StartStep, detail?: string): RunStep {
    const step = this.startStep(runId, input)
    return this.finishStep(step.id, {
      state: 'skipped',
      ...(detail === undefined ? {} : { detail }),
    })
  }

  /**
   * Which phases of a task have actually been carried out.
   *
   * **Grouped per run first**, then deduplicated. That is the whole subtlety:
   * grouping across every run of an entry means a failed attempt poisons its
   * phase for ever, because the `failed` row and the later `completed` row sit
   * in the same group. Fail at phase two, fix it, retry successfully, and the
   * phase would still never count — on the most-travelled path through the
   * engine. Per run, each attempt is its own witness and a later success
   * overrules an earlier failure without anything being deleted.
   *
   * A phase counts when some one run recorded steps for it and every one of
   * them says `completed`. A `running` or `failed` row vetoes that run's
   * witness; a phase skipped after an earlier failure has `skipped` rows and is
   * vetoed too, which is what lets a blocked task honestly read 5 of 7.
   *
   * Joined to `task_workflows` on the workflow *name* as well as the entry, for
   * the reason `#loopIsDone` gives about the same thing: a recovery run started
   * by `on_fail` is stamped with the entry of the workflow that *failed*, so
   * without the name its phases would be credited to a workflow it was never
   * part of. The join also drops runs whose entry has since left the list, and
   * rows from before entries existed.
   */
  completedPhases(taskId: string): { entryId: string; workflow: string; phase: string }[] {
    return this.#db.all<{ entryId: string; workflow: string; phase: string }>(
      `SELECT entry_id AS entryId, workflow, phase FROM (
         SELECT r.entry_id AS entry_id, r.workflow AS workflow, s.phase AS phase,
                SUM(CASE WHEN s.state <> 'completed' THEN 1 ELSE 0 END) AS unfinished
           FROM runs r
           JOIN run_steps s      ON s.run_id   = r.id
           JOIN task_workflows w ON w.task_id  = r.task_id
                                AND w.entry_id = r.entry_id
                                AND w.workflow = r.workflow
          WHERE r.task_id = ?
          GROUP BY r.id, r.entry_id, r.workflow, s.phase
       )
       WHERE unfinished = 0
       GROUP BY entry_id, workflow, phase`,
      taskId,
    )
  }

  /**
   * Entries that have a run which finished.
   *
   * A finished run means every phase of it was carried out — `runPlan` only
   * returns `completed` after the phase loop runs to the end — so this credits
   * the lot. It is not redundant with the query above: a phase whose `steps:`
   * list is empty is a *warning*, not an error, so it never writes a step row
   * and could never be counted from rows alone. Without this, a workflow ending
   * in an empty phase would sit at four of five on a finished task for ever.
   */
  completedEntries(taskId: string): { entryId: string; workflow: string }[] {
    return this.#db.all<{ entryId: string; workflow: string }>(
      `SELECT DISTINCT r.entry_id AS entryId, r.workflow AS workflow
         FROM runs r
         JOIN task_workflows w ON w.task_id  = r.task_id
                              AND w.entry_id = r.entry_id
                              AND w.workflow = r.workflow
        WHERE r.task_id = ? AND r.state = 'completed'`,
      taskId,
    )
  }

  steps(runId: string): RunStep[] {
    return this.#db
      .all<StepRow>('SELECT * FROM run_steps WHERE run_id = ? ORDER BY id', runId)
      .map(hydrateStep)
  }

  /**
   * Keep a chunk of output.
   *
   * Called as the process prints, so it is deliberately cheap: one insert, and
   * the trim only does work once a step is over budget.
   */
  append(input: {
    runId: string
    stepId?: number
    stream: LogStream
    text: string
  }): void {
    if (input.text === '') return
    const bytes = Buffer.byteLength(input.text, 'utf8')
    const stepId = input.stepId ?? null

    this.#db.transaction(() => {
      const pinnedBytes = this.#groupBytes(input.runId, stepId, { pinnedOnly: true })
      const pinned = pinnedBytes < this.#head ? 1 : 0

      const inserted = this.#db.run(
        'INSERT INTO run_logs (run_id, step_id, at, stream, text, bytes, pinned) VALUES (?, ?, ?, ?, ?, ?, ?)',
        input.runId,
        stepId,
        this.#now(),
        input.stream,
        input.text,
        bytes,
        pinned,
      )
      this.#trim(input.runId, stepId, Number(inserted.lastInsertRowid))
    })
  }

  /**
   * Record what a phase produced — or did not.
   *
   * Called once per phase that declared an artifact, so a row exists either
   * way: "the review phase promised a report and there isn't one" is a fact
   * worth keeping, and the prototype had no way to notice it.
   */
  attachEvidence(input: {
    runId: string
    phase: string
    /** What the step called the artifact. The key, now that a phase can hold several. */
    name: string
    path: string
    content?: string
    /** Size on disk. Differs from the stored content when truncated or binary. */
    bytes?: number
    missing?: boolean
  }): Evidence {
    const full = input.content ?? ''
    const truncated = full.length > this.#evidence
    const content = input.missing === true ? null : truncated ? full.slice(0, this.#evidence) : full

    this.#db.run(
      `INSERT INTO run_evidence (run_id, phase, name, path, content, bytes, truncated, missing, collected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (run_id, name) DO UPDATE SET
         phase = excluded.phase, path = excluded.path, content = excluded.content,
         bytes = excluded.bytes, truncated = excluded.truncated, missing = excluded.missing,
         collected_at = excluded.collected_at`,
      input.runId,
      input.phase,
      input.name,
      input.path,
      content,
      input.bytes ?? Buffer.byteLength(full, 'utf8'),
      truncated ? 1 : 0,
      input.missing === true ? 1 : 0,
      this.#now(),
    )
    return this.evidence(input.runId).find((entry) => entry.name === input.name) as Evidence
  }

  /** What a run produced, in the order the phases ran. */
  evidence(runId: string): Evidence[] {
    return this.#db
      .all<EvidenceRow>('SELECT * FROM run_evidence WHERE run_id = ? ORDER BY id', runId)
      .map(hydrateEvidence)
  }

  /**
   * Every artifact a task has produced, newest run first.
   *
   * Joined through `runs` because evidence belongs to a run while a person
   * thinks in terms of the task: `analysis` that ran twice is one artifact with
   * two versions, not two artifacts. Ordering newest-first means the caller can
   * take the first row per name and have the current one without a second
   * query.
   *
   * A run with no task — `factory run` — is excluded: its evidence belongs to
   * nothing anyone can open.
   */
  artifactsForTask(taskId: string): Evidence[] {
    return this.#db
      .all<EvidenceRow>(
        `SELECT e.* FROM run_evidence e JOIN runs r ON r.id = e.run_id
         WHERE r.task_id = ?
         ORDER BY r.started_at DESC, r.rowid DESC, e.id`,
        taskId,
      )
      .map(hydrateEvidence)
  }

  /** Output for one step, or — with no step — the run's own output. */
  logs(runId: string, options: { stepId?: number } = {}): LogView {
    const stepId = options.stepId ?? null
    const rows = this.#db.all<{ at: string; stream: string; text: string }>(
      stepId === null
        ? 'SELECT at, stream, text FROM run_logs WHERE run_id = ? AND step_id IS NULL ORDER BY id'
        : 'SELECT at, stream, text FROM run_logs WHERE run_id = ? AND step_id = ? ORDER BY id',
      ...(stepId === null ? [runId] : [runId, stepId]),
    )
    return {
      lines: rows.map((row) => ({ at: row.at, stream: row.stream as LogStream, text: row.text })),
      dropped: this.#dropped(runId, stepId),
    }
  }

  #trim(runId: string, stepId: number | null, newestId: number): void {
    let total = this.#groupBytes(runId, stepId, {})
    if (total <= this.#budget) return

    let dropped = 0
    while (total > this.#budget) {
      // Never the newest row, and never the pinned head: the end of the output
      // is where the failure is, and the beginning is where the command is. A
      // single chunk larger than the whole budget therefore survives, which is
      // the right answer — truncating it would leave output that looks complete
      // and is not.
      const victim = this.#db.get<{ id: number; bytes: number }>(
        stepId === null
          ? `SELECT id, bytes FROM run_logs
              WHERE run_id = ? AND step_id IS NULL AND pinned = 0 AND id <> ? ORDER BY id LIMIT 1`
          : `SELECT id, bytes FROM run_logs
              WHERE run_id = ? AND step_id = ? AND pinned = 0 AND id <> ? ORDER BY id LIMIT 1`,
        ...(stepId === null ? [runId, newestId] : [runId, stepId, newestId]),
      )
      if (victim === undefined) break
      this.#db.run('DELETE FROM run_logs WHERE id = ?', victim.id)
      total -= victim.bytes
      dropped += victim.bytes
    }

    if (dropped === 0) return
    if (stepId === null) {
      this.#db.run('UPDATE runs SET dropped_bytes = dropped_bytes + ? WHERE id = ?', dropped, runId)
    } else {
      this.#db.run(
        'UPDATE run_steps SET dropped_bytes = dropped_bytes + ? WHERE id = ?',
        dropped,
        stepId,
      )
    }
  }

  #groupBytes(runId: string, stepId: number | null, options: { pinnedOnly?: boolean }): number {
    const pinned = options.pinnedOnly === true ? ' AND pinned = 1' : ''
    const row = this.#db.get<{ total: number | null }>(
      stepId === null
        ? `SELECT SUM(bytes) AS total FROM run_logs WHERE run_id = ? AND step_id IS NULL${pinned}`
        : `SELECT SUM(bytes) AS total FROM run_logs WHERE run_id = ? AND step_id = ?${pinned}`,
      ...(stepId === null ? [runId] : [runId, stepId]),
    )
    return row?.total ?? 0
  }

  #dropped(runId: string, stepId: number | null): number {
    if (stepId === null) {
      return this.#db.get<{ dropped_bytes: number }>(
        'SELECT dropped_bytes FROM runs WHERE id = ?',
        runId,
      )?.dropped_bytes ?? 0
    }
    return this.#db.get<{ dropped_bytes: number }>(
      'SELECT dropped_bytes FROM run_steps WHERE id = ?',
      stepId,
    )?.dropped_bytes ?? 0
  }

  #require(id: string): Run {
    const run = this.get(id)
    if (run === undefined) throw new Error(`No run ${id}.`)
    return run
  }

  #requireStep(id: number): RunStep {
    const row = this.#db.get<StepRow>('SELECT * FROM run_steps WHERE id = ?', id)
    if (row === undefined) throw new Error(`No step ${id}.`)
    return hydrateStep(row)
  }
}

// Built by assignment rather than spreading nulls, for the same reason as tasks:
// under exactOptionalPropertyTypes an absent key and one set to undefined are
// different types, and the difference escapes into every consumer.
function hydrateRun(row: RunRow): Run {
  const run: Record<string, unknown> = {
    id: row.id,
    workflow: row.workflow,
    state: row.state as RunState,
    attempt: row.attempt,
    workflowIndex: row.workflow_index,
    ...(row.entry_id === null ? {} : { entryId: row.entry_id }),
    depth: row.depth,
    startedAt: row.started_at,
  }
  if (row.task_id !== null) run.taskId = row.task_id
  if (row.resume_phase !== null) run.resumePhase = row.resume_phase
  if (row.finished_at !== null) run.finishedAt = row.finished_at
  if (row.detail !== null) run.detail = row.detail
  if (isExecutionProfile(row.profile)) run.profile = row.profile
  if (row.origin_run_id !== null) run.originRunId = row.origin_run_id
  return run as unknown as Run
}

function hydrateStep(row: StepRow): RunStep {
  const step: Record<string, unknown> = {
    id: row.id,
    runId: row.run_id,
    phase: row.phase,
    index: row.step_index,
    describe: row.describe,
    uses: row.uses,
    state: row.state as StepState,
    attempts: row.attempts,
    startedAt: row.started_at,
  }
  if (row.exit_code !== null) step.exitCode = row.exit_code
  if (row.finished_at !== null) step.finishedAt = row.finished_at
  if (row.detail !== null) step.detail = row.detail
  if (row.command !== null) step.command = row.command
  return step as unknown as RunStep
}

function hydrateEvidence(row: EvidenceRow): Evidence {
  const evidence: Record<string, unknown> = {
    id: row.id,
    runId: row.run_id,
    phase: row.phase,
    name: row.name,
    path: row.path,
    bytes: row.bytes,
    truncated: row.truncated === 1,
    missing: row.missing === 1,
    collectedAt: row.collected_at,
  }
  if (row.content !== null) evidence.content = row.content
  return evidence as unknown as Evidence
}

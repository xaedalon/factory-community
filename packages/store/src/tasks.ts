import { randomUUID } from 'node:crypto'
import type { EventBus } from '@factory/events'
import {
  applyAction,
  availableActions,
  queueOrder,
  taskDirectory,
  type AvailableAction,
  type BlockerFacts,
  type Task,
  type TaskWorkflowEntry,
  type TaskAction,
  type TaskEdge,
  type TaskState,
} from '@factory/core'
import type { Database } from './sqlite.js'

/** One task a dependent is waiting for, ready to be decided on and named. */
export interface Blocker extends BlockerFacts {
  readonly id: string
  readonly name: string
}

/**
 * Tasks, on disk.
 *
 * The state machine lives in @factory/core and is pure; this is the part that
 * writes it down. Every state change goes through `act`, which calls the one
 * transition function and records what happened — so there is no route that
 * changes a task's state without the rules and the history both applying.
 */

export interface TaskHistoryEntry {
  readonly at: string
  readonly action: string
  readonly from: TaskState
  readonly to: TaskState
  readonly detail?: string
}

interface TaskRow {
  id: string
  name: string
  description: string
  project_id: string | null
  ticket_id: string | null
  branch: string | null
  directory: string | null
  state: string
  queue_position: number | null
  runnable_at: string | null
  blocked_reason: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
  session_id: string | null
  session_provider: string | null
}

export interface TaskRepositoryOptions {
  readonly db: Database
  readonly events?: EventBus
  /** Injected so tests get deterministic timestamps and ids. */
  readonly now?: () => string
  readonly newId?: () => string
}

/**
 * A workflow in a list, as a caller may give it.
 *
 * A bare name is the common case and keeps every existing caller working. The
 * object form is how a reorder keeps its entries (`id`) and how a tickbox is
 * saved (`enabled`) — one shape through one door, rather than a second route
 * into the same rows with its own copy of the rules.
 */
export type WorkflowSelection =
  | string
  | { readonly id?: string; readonly workflow: string; readonly enabled?: boolean }

/**
 * Refusing to take a workflow off a task that has already run it.
 *
 * A named class rather than a message the route matches on: the daemon turns
 * this into a 409 and needs to know it is *this* refusal, not a database error.
 */
export class WorkflowHasRunError extends Error {
  override readonly name = 'WorkflowHasRunError'
  constructor(
    task: string,
    readonly entries: readonly TaskWorkflowEntry[],
  ) {
    super(
      `Cannot take ${entries.map((entry) => `"${entry.workflow}"`).join(' and ')} off ` +
        `"${task}": already run. Untick instead of removing.`,
    )
  }
}

export interface CreateTask {
  readonly name: string
  /** What the work is for. Stored as '' when unwritten, never NULL. */
  readonly description?: string
  /** Required. A task with nowhere to happen runs wherever the daemon started. */
  readonly projectId: string
  readonly ticketId?: string
  readonly branch?: string
  readonly directory?: string
  readonly workflows?: readonly WorkflowSelection[]
}

export class TaskRepository {
  readonly #db: Database
  readonly #events: EventBus | undefined
  readonly #now: () => string
  readonly #newId: () => string

  constructor(options: TaskRepositoryOptions) {
    this.#db = options.db
    this.#events = options.events
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#newId = options.newId ?? (() => randomUUID())
  }

  create(input: CreateTask): Task {
    // Checked here rather than left to the NOT NULL column, so the refusal says
    // what is missing instead of surfacing a constraint name.
    if (input.projectId === undefined || input.projectId.trim() === '') {
      throw new Error('A task needs a project: it decides where the work happens.')
    }
    const now = this.#now()
    const id = this.#newId()
    // Slugged whether it was supplied or derived, and then made unique.
    //
    // A supplied one used to be stored verbatim, and it arrives from a client:
    // `POST /api/tasks {"directory": "../../escape"}` became the worktree path,
    // the artifacts root, and the directory the agent itself runs in. The
    // guarantee worth having is structural rather than a list of bad inputs —
    // `taskDirectory` maps everything outside `[a-z0-9]` to a dash, so the
    // result is a single path segment and cannot climb out of anything.
    //
    // `#freeDirectory` now covers the supplied case too: two tasks sharing a
    // directory would share a worktree and an artifacts root.
    const directory = this.#freeDirectory(taskDirectory(input.directory ?? input.name))

    return this.#db.transaction(() => {
      this.#db.run(
        `INSERT INTO tasks (id, name, description, project_id, ticket_id, branch, directory, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
        id,
        input.name,
        input.description?.trim() ?? '',
        input.projectId,
        input.ticketId ?? null,
        input.branch ?? null,
        directory,
        now,
        now,
      )
      this.#assign(id, input.workflows ?? [])
      const task = this.get(id)
      if (task === undefined) throw new Error('Task vanished immediately after being created.')
      this.#events?.emit('task.created', { taskId: id, name: task.name })
      return task
    })
  }

  get(id: string): Task | undefined {
    const row = this.#db.get<TaskRow>('SELECT * FROM tasks WHERE id = ?', id)
    return row === undefined ? undefined : this.#hydrate(row)
  }

  /**
   * Tasks in a state, queue order first, then oldest first.
   *
   * Built up from clauses rather than as three literal statements. That was the
   * shape before `projectId`, and adding a third dimension to it would have
   * meant six statements and the wrong one being edited.
   */
  list(
    options: { state?: TaskState; includeArchived?: boolean; projectId?: string } = {},
  ): Task[] {
    const where: string[] = []
    const values: (string | number)[] = []

    if (options.state !== undefined) {
      where.push('state = ?')
      values.push(options.state)
    } else if (options.includeArchived !== true) {
      where.push("state <> 'archived'")
    }
    if (options.projectId !== undefined) {
      where.push('project_id = ?')
      values.push(options.projectId)
    }

    const rows = this.#db.all<TaskRow>(
      `SELECT * FROM tasks${where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`}` +
        ' ORDER BY queue_position, created_at',
      ...values,
    )
    return rows.map((row) => this.#hydrate(row))
  }

  /** What can be done to this task right now, for a client that should not guess. */
  actions(id: string): AvailableAction[] {
    const task = this.get(id)
    return task === undefined ? [] : availableActions(task)
  }

  /**
   * Change a task's state.
   *
   * The single door. The rules come from core, the history is written here, and
   * both happen in one transaction so a recorded transition is always one that
   * actually took effect.
   */
  act(
    id: string,
    action: TaskAction,
    options: { reason?: string; until?: string } = {},
  ): Task {
    return this.#db.transaction(() => {
      const task = this.get(id)
      if (task === undefined) throw new Error(`No task ${id}.`)

      const now = this.#now()
      const result = applyAction(task, action, {
        now,
        ...(options.reason === undefined ? {} : { reason: options.reason }),
        ...(options.until === undefined ? {} : { until: options.until }),
      })
      const next = result.task

      this.#db.run(
        `UPDATE tasks
            SET state = ?, queue_position = ?, blocked_reason = ?, updated_at = ?,
                completed_at = ?, runnable_at = ?
          WHERE id = ?`,
        next.state,
        next.queuePosition ?? null,
        next.blockedReason ?? null,
        next.updatedAt,
        next.completedAt ?? null,
        next.runnableAt ?? null,
        id,
      )

      // Queued tasks go to the back. Done here rather than in the state machine
      // because position depends on every other task, which a pure function
      // cannot see.
      if (next.state === 'queued') {
        this.#db.run(
          `UPDATE tasks SET queue_position =
             (SELECT COALESCE(MAX(queue_position), 0) + 1 FROM tasks WHERE state = 'queued')
           WHERE id = ?`,
          id,
        )
      }

      this.#db.run(
        `INSERT INTO task_history (task_id, at, action, from_state, to_state, detail)
         VALUES (?, ?, ?, ?, ?, ?)`,
        id,
        now,
        action,
        result.from,
        next.state,
        options.reason ?? null,
      )

      this.#events?.emit('task.transitioned', {
        taskId: id,
        action,
        from: result.from,
        to: next.state,
      })

      const stored = this.get(id)
      if (stored === undefined) throw new Error('Task vanished during a transition.')
      return stored
    })
  }

  /**
   * Replace the workflows a task will run, keeping what each entry knows.
   *
   * The old version rewrote the list and sent the task back to the start of it,
   * because the only record of progress was a position in the *old* list. Now
   * each entry carries its own state, so an edit keeps it — which is the whole
   * point: fixing a failure usually means touching the task, and that used to
   * cost you every workflow that had already succeeded.
   *
   * Entries are matched to the new list in two passes. **Ids first**, so a
   * reorder is unambiguous; then **by name, left to right, preferring one that
   * has run.** That preference is load-bearing rather than tidy: with `[hello
   * (ran), hello]` cut down to `[hello]`, matching the un-run one first would
   * refuse a removal that is perfectly legal.
   *
   * Anything left over is a removal, and a removal of something that has run is
   * refused outright — nothing is written, so the call is all or nothing.
   */
  assign(id: string, selection: readonly WorkflowSelection[]): Task {
    return this.#db.transaction(() => {
      const before = this.get(id)
      if (before === undefined) throw new Error(`No task ${id}.`)

      const wanted = selection.map((entry) =>
        typeof entry === 'string' ? { workflow: entry } : entry,
      )
      const unclaimed = new Map(before.workflows.map((entry) => [entry.id, entry]))
      const claims = new Array<TaskWorkflowEntry | undefined>(wanted.length)

      wanted.forEach((entry, at) => {
        // An id this task does not have is treated as a new entry rather than
        // an error: a stale client should not get a 500.
        if (entry.id !== undefined && unclaimed.has(entry.id)) {
          claims[at] = unclaimed.get(entry.id)
          unclaimed.delete(entry.id)
        }
      })

      wanted.forEach((entry, at) => {
        if (claims[at] !== undefined) return
        const matches = [...unclaimed.values()].filter(
          (candidate) => candidate.workflow === entry.workflow,
        )
        const chosen = matches.find((candidate) => candidate.ran) ?? matches[0]
        if (chosen === undefined) return
        claims[at] = chosen
        unclaimed.delete(chosen.id)
      })

      const removed = [...unclaimed.values()].filter((entry) => entry.ran)
      if (removed.length > 0) throw new WorkflowHasRunError(before.name, removed)

      this.#db.run('DELETE FROM task_workflows WHERE task_id = ?', id)
      wanted.forEach((entry, position) => {
        const claimed = claims[position]
        this.#db.run(
          `INSERT INTO task_workflows (task_id, position, workflow, entry_id, enabled)
           VALUES (?, ?, ?, ?, ?)`,
          id,
          position,
          entry.workflow,
          claimed?.id ?? this.#newId(),
          (entry.enabled ?? claimed?.enabled ?? true) ? 1 : 0,
        )
      })
      this.#db.run('UPDATE tasks SET updated_at = ? WHERE id = ?', this.#now(), id)

      const task = this.get(id)
      if (task === undefined) throw new Error(`No task ${id}.`)
      this.#events?.emit('task.assigned', {
        taskId: id,
        workflows: wanted.map((entry) => entry.workflow),
      })
      return task
    })
  }

  /**
   * Change what a task is called.
   *
   * The name only, never the directory. `directory` is the task's identity on
   * disk: the daemon joins it with the project's worktree root to decide where
   * steps run, doctor checks the same path still exists, and the worktree the
   * task is working in was created at it. Re-deriving it from a new name would
   * move the workspace out from under work already in progress and orphan the
   * directory holding it — which is precisely why `taskDirectory` exists
   * separately from the name in the first place.
   */
  rename(id: string, name: string): Task {
    const trimmed = name.trim()
    if (trimmed === '') throw new Error('A task needs a name.')

    return this.#db.transaction(() => {
      const before = this.get(id)
      if (before === undefined) throw new Error(`No task ${id}.`)
      if (before.name === trimmed) return before

      this.#db.run(
        'UPDATE tasks SET name = ?, updated_at = ? WHERE id = ?',
        trimmed,
        this.#now(),
        id,
      )
      const task = this.get(id)
      if (task === undefined) throw new Error(`No task ${id}.`)
      this.#events?.emit('task.renamed', { taskId: id, name: trimmed, was: before.name })
      return task
    })
  }

  /**
   * What the task is for.
   *
   * Its own method rather than a second argument to `rename`, because the two
   * are different promises: a name is an identifier people search by and the
   * rename doc explains at length what it must *not* touch, while a description
   * is prose that nothing else derives from. Blurring them would put that
   * warning in front of an edit it does not apply to.
   *
   * Trimmed to '' rather than removed, so `{{ task.description }}` resolves to
   * an empty string instead of warning about a key that is not there.
   */
  describe(id: string, description: string): Task {
    const trimmed = description.trim()

    return this.#db.transaction(() => {
      const before = this.get(id)
      if (before === undefined) throw new Error(`No task ${id}.`)
      if (before.description === trimmed) return before

      this.#db.run(
        'UPDATE tasks SET description = ?, updated_at = ? WHERE id = ?',
        trimmed,
        this.#now(),
        id,
      )
      const task = this.get(id)
      if (task === undefined) throw new Error(`No task ${id}.`)
      this.#events?.emit('task.described', { taskId: id, description: trimmed })
      return task
    })
  }

  /**
   * Write down the agent session this task's steps are sharing.
   *
   * Called once, by the engine, **after** the process that started the session
   * has actually spawned. That ordering is the whole point: an id recorded at
   * plan time would outlive a spawn that failed — no CLI on PATH, a worktree
   * that had gone — and every later run would ask to resume a conversation
   * that was never had, which the CLI refuses. With nothing recorded, the next
   * run simply starts one.
   *
   * Idempotent, and the first writer wins: a task keeps the session it has, so
   * a later run cannot replace it with one whose earlier phases are missing.
   */
  rememberSession(id: string, session: { id: string; provider: string }): Task {
    return this.#db.transaction(() => {
      const before = this.get(id)
      if (before === undefined) throw new Error(`No task ${id}.`)
      if (before.session !== undefined) return before

      this.#db.run(
        'UPDATE tasks SET session_id = ?, session_provider = ?, updated_at = ? WHERE id = ?',
        session.id,
        session.provider,
        this.#now(),
        id,
      )
      const task = this.get(id)
      if (task === undefined) throw new Error(`No task ${id}.`)
      return task
    })
  }

  /**
   * Untick an entry: the engine is done with it.
   *
   * Not a transition: finishing one workflow of several does not change what
   * state the task is in, and putting it through the machine would mean
   * inventing an action for something nobody asked for.
   */
  finished(id: string, entryId: string): Task {
    this.#db.run(
      'UPDATE task_workflows SET enabled = 0 WHERE task_id = ? AND entry_id = ?',
      id,
      entryId,
    )
    this.#db.run('UPDATE tasks SET updated_at = ? WHERE id = ?', this.#now(), id)
    const task = this.get(id)
    if (task === undefined) throw new Error(`No task ${id}.`)
    return task
  }

  /** What is currently true about this task. */
  flags(id: string): string[] {
    return this.#db
      .all<{ flag: string }>('SELECT flag FROM task_flags WHERE task_id = ? ORDER BY flag', id)
      .map((row) => row.flag)
  }

  /**
   * What a dependent needs to know about one blocker, plus the name to say it
   * with.
   *
   * Shaped here rather than at each caller so the scheduler and the API cannot
   * disagree about it. `completedAt` is the part that has to be right:
   * `archived` is reachable from `done` and from `draft` alike, so it is the
   * only thing that tells "finished, then put away" from "put away", and a
   * caller spreading an undefined key into it under
   * `exactOptionalPropertyTypes` would have it read as finished.
   */
  blocker(id: string): Blocker | undefined {
    const task = this.get(id)
    if (task === undefined) return undefined
    return task.completedAt === undefined
      ? { id: task.id, name: task.name, state: task.state }
      : { id: task.id, name: task.name, state: task.state, completedAt: task.completedAt }
  }

  /** The tasks this one is waiting for, oldest edge first. */
  dependsOn(id: string): string[] {
    return this.#db
      .all<{ depends_on_id: string }>(
        'SELECT depends_on_id FROM task_dependencies WHERE task_id = ? ORDER BY rowid',
        id,
      )
      .map((row) => row.depends_on_id)
  }

  /** Every edge among a project's tasks, for ordering a batch or drawing a graph. */
  dependenciesIn(projectId: string): TaskEdge[] {
    return this.#db
      .all<{ task_id: string; depends_on_id: string }>(
        `SELECT d.task_id, d.depends_on_id
           FROM task_dependencies d
           JOIN tasks t ON t.id = d.task_id
          WHERE t.project_id = ?
          ORDER BY d.rowid`,
        projectId,
      )
      .map((row) => ({ taskId: row.task_id, dependsOn: row.depends_on_id }))
  }

  /**
   * Make one task wait for another.
   *
   * Three refusals, all at the door rather than at the moment the graph is
   * walked. A graph Factory wrote is a graph Factory can order, which is what
   * lets `queueOrder` treat a ring as corruption rather than as an ordinary
   * outcome to design around.
   *
   * Adding an edge twice is not an error — it is what pressing the button twice
   * looks like.
   */
  dependOn(id: string, blockerId: string): Task {
    return this.#db.transaction(() => {
      const task = this.get(id)
      if (task === undefined) throw new Error(`No task ${id}.`)
      const blocker = this.get(blockerId)
      if (blocker === undefined) throw new Error(`No task ${blockerId}.`)

      if (id === blockerId) {
        throw new Error(`"${task.name}" cannot depend on itself.`)
      }
      // Ids, so this compares what the graph is keyed by. Both are always set
      // now — a task cannot exist without a project — so this is the plain
      // question it looks like.
      if (task.projectId !== blocker.projectId) {
        throw new Error(
          `"${task.name}" and "${blocker.name}" are in different projects, ` +
            `and a dependency between projects has no owner.`,
        )
      }

      // Checked here because this is the only place an edge is added, so the
      // stored graph is acyclic by construction. Walked with the edge already
      // hypothetically in place.
      const edges = [
        ...this.dependencies(),
        { taskId: id, dependsOn: blockerId },
      ]
      // Every node in the graph, not just this task: `queueOrder` follows only
      // the edges inside the set it is given, so ordering `[id]` alone would
      // walk straight past a ring three tasks long.
      const nodes = new Set<string>()
      for (const edge of edges) {
        nodes.add(edge.taskId)
        nodes.add(edge.dependsOn)
      }
      const ring = queueOrder([...nodes], edges).problems.find(
        (problem) => problem.rule === 'dependencies.cycle',
      )
      // The message names the pair rather than the chain, because any ring
      // found here is the one just proposed: nothing else writes an edge, so
      // the rest of the graph was already acyclic when it went in.
      if (ring !== undefined) {
        throw new Error(
          `"${task.name}" cannot wait for "${blocker.name}": that would make a ring, ` +
            `because "${blocker.name}" already waits for "${task.name}", however far around.`,
        )
      }

      this.#db.run(
        `INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)
         ON CONFLICT(task_id, depends_on_id) DO NOTHING`,
        id,
        blockerId,
      )
      this.#db.run('UPDATE tasks SET updated_at = ? WHERE id = ?', this.#now(), id)
      // The same event any other change to a task emits. A dependency decides
      // when work starts, which is a fact about the task worth waking a board
      // for — and inventing an event name would mean widening the browser's
      // hard-coded list as well.
      this.#events?.emit('task.assigned', {
        taskId: id,
        workflows: task.workflows.map((entry) => entry.workflow),
      })
      return this.get(id) as Task
    })
  }

  /** Stop one task waiting for another. Removing an edge that is not there is not an error. */
  independ(id: string, blockerId: string): Task {
    return this.#db.transaction(() => {
      const task = this.get(id)
      if (task === undefined) throw new Error(`No task ${id}.`)
      this.#db.run(
        'DELETE FROM task_dependencies WHERE task_id = ? AND depends_on_id = ?',
        id,
        blockerId,
      )
      this.#db.run('UPDATE tasks SET updated_at = ? WHERE id = ?', this.#now(), id)
      this.#events?.emit('task.assigned', {
        taskId: id,
        workflows: task.workflows.map((entry) => entry.workflow),
      })
      return this.get(id) as Task
    })
  }

  /**
   * Every edge there is.
   *
   * Whole-table on purpose. The ring check needs it per write, and the
   * scheduler needs it once a tick to gate every queued task at once — asking
   * per task would read the same table N times to answer one question.
   */
  dependencies(): TaskEdge[] {
    return this.#db
      .all<{ task_id: string; depends_on_id: string }>(
        'SELECT task_id, depends_on_id FROM task_dependencies ORDER BY rowid',
      )
      .map((row) => ({ taskId: row.task_id, dependsOn: row.depends_on_id }))
  }

  /**
   * Record what a workflow earned and what it invalidated.
   *
   * Both in one call, in one transaction, because a workflow that replaces a
   * worktree provides and clears in the same breath and a reader must never see
   * the half-applied state.
   */
  changeFlags(
    id: string,
    change: { set?: readonly string[]; clear?: readonly string[] },
  ): Task {
    const set = change.set ?? []
    const clear = change.clear ?? []

    return this.#db.transaction(() => {
      const task = this.get(id)
      if (task === undefined) throw new Error(`No task ${id}.`)
      const now = this.#now()

      for (const flag of set) {
        this.#db.run(
          'INSERT OR REPLACE INTO task_flags (task_id, flag, set_at) VALUES (?, ?, ?)',
          id,
          flag,
          now,
        )
      }
      for (const flag of clear) {
        this.#db.run('DELETE FROM task_flags WHERE task_id = ? AND flag = ?', id, flag)
      }

      if (set.length > 0 || clear.length > 0) {
        this.#events?.emit('task.flags.changed', { taskId: id, set: [...set], cleared: [...clear] })
      }
      return this.get(id) as Task
    })
  }

  /**
   * Remove a task and everything recorded about it.
   *
   * Cascades to its workflows, its history and its runs, which is why the
   * foreign keys are declared and `PRAGMA foreign_keys` is on: a task deleted
   * with its runs left behind is a set of rows nothing can ever reach again.
   */
  delete(id: string): boolean {
    const removed = this.#db.run('DELETE FROM tasks WHERE id = ?', id).changes > 0
    if (removed) this.#events?.emit('task.deleted', { taskId: id })
    return removed
  }

  history(id: string): TaskHistoryEntry[] {
    return this.#db
      .all<{ at: string; action: string; from_state: string; to_state: string; detail: string | null }>(
        'SELECT at, action, from_state, to_state, detail FROM task_history WHERE task_id = ? ORDER BY id',
        id,
      )
      .map((row) => ({
        at: row.at,
        action: row.action,
        from: row.from_state as TaskState,
        to: row.to_state as TaskState,
        ...(row.detail === null ? {} : { detail: row.detail }),
      }))
  }

  /**
   * A directory name no other task is using.
   *
   * Two tasks called "Fix the build" would otherwise share a worktree, and the
   * second one would quietly work in the first one's checkout.
   */
  #freeDirectory(base: string): string {
    for (let suffix = 1; suffix < 1000; suffix += 1) {
      const candidate = suffix === 1 ? base : `${base}-${suffix}`
      const taken = this.#db.get<{ id: string }>(
        'SELECT id FROM tasks WHERE directory = ?',
        candidate,
      )
      if (taken === undefined) return candidate
    }
    return `${base}-${this.#newId()}`
  }

  /** The create path: nothing to preserve, because nothing has happened yet. */
  #assign(id: string, selection: readonly WorkflowSelection[]): void {
    this.#db.run('DELETE FROM task_workflows WHERE task_id = ?', id)
    selection.forEach((entry, position) => {
      const wanted = typeof entry === 'string' ? { workflow: entry } : entry
      this.#db.run(
        `INSERT INTO task_workflows (task_id, position, workflow, entry_id, enabled)
         VALUES (?, ?, ?, ?, ?)`,
        id,
        position,
        wanted.workflow,
        this.#newId(),
        (wanted.enabled ?? true) ? 1 : 0,
      )
    })
  }

  #hydrate(row: TaskRow): Task {
    // `ran` is derived rather than stored, for the reason `#loopIsDone` gives
    // about repeat counts: a column would be a second copy of what the runs
    // already say, and the two would disagree the first time a run was removed.
    //
    // A `refused` run does not count. Nothing ran — the workflow name never
    // resolved — and if it counted, a typo could never be taken off the list,
    // which is a poor trap for a rule whose headline is "you cannot remove what
    // has run".
    const workflows = this.#db
      .all<{ entry_id: string; workflow: string; enabled: number; ran: number }>(
        `SELECT w.entry_id, w.workflow, w.enabled,
                EXISTS (
                  SELECT 1 FROM runs r
                  WHERE r.task_id = w.task_id AND r.entry_id = w.entry_id AND r.state <> 'refused'
                ) AS ran
         FROM task_workflows w WHERE w.task_id = ? ORDER BY w.position`,
        row.id,
      )
      .map((entry) => ({
        id: entry.entry_id,
        workflow: entry.workflow,
        enabled: entry.enabled === 1,
        ran: entry.ran === 1,
      }))
    const flags = this.flags(row.id)
    const dependsOn = this.dependsOn(row.id)

    // Built by assignment rather than spreading nulls: an absent optional and
    // one explicitly set to undefined are different types here, and the
    // difference escapes into every consumer.
    const task: Record<string, unknown> = {
      id: row.id,
      name: row.name,
      description: row.description,
      state: row.state as TaskState,
      workflows,
      flags,
      dependsOn,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
    if (row.project_id !== null) task.projectId = row.project_id
    if (row.ticket_id !== null) task.ticketId = row.ticket_id
    if (row.branch !== null) task.branch = row.branch
    if (row.directory !== null) task.directory = row.directory
    if (row.queue_position !== null) task.queuePosition = row.queue_position
    if (row.runnable_at !== null) task.runnableAt = row.runnable_at
    if (row.blocked_reason !== null) task.blockedReason = row.blocked_reason
    if (row.completed_at !== null) task.completedAt = row.completed_at
    // Both or neither. One without the other is not half an answer, it is an
    // id nothing can open — so it is treated as no session at all rather than
    // handed on for a caller to trip over.
    if (row.session_id !== null && row.session_provider !== null) {
      task.session = { id: row.session_id, provider: row.session_provider }
    }
    return task as unknown as Task
  }
}

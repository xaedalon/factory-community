/**
 * What a task is, and how it is allowed to move.
 *
 * This module is pure — no database, no clock, no side effects — because the
 * state machine is the part that has to be obviously correct, and the prototype
 * proved how it goes wrong when it is not in one place. There, `approve`,
 * `retry`, `run`, `archive` and the scheduler each called `transition()` with
 * their own pre- and post-logic, and the UI re-encoded the same rules as
 * scattered conditionals. The rules drifted, and the bug that followed let a
 * blocked task be started in a way nothing had anticipated.
 *
 * So: one table of allowed moves, one function that applies them, and an
 * `actions` list the API publishes so no client has to re-derive any of it.
 */

export const TASK_STATES = [
  /** Created, but not ready to go — typically no workflows assigned yet. */
  'draft',
  /** Ready. The scheduler may pick it up. */
  'queued',
  /** A run is in progress. */
  'running',
  /** Paused at a gate, waiting for a person. */
  'awaiting_approval',
  /** Stopped by a failure. Needs someone to look. */
  'blocked',
  /** Finished successfully. */
  'done',
  /** Stopped deliberately. */
  'cancelled',
  /** Out of the way, but not deleted. */
  'archived',
] as const

export type TaskState = (typeof TASK_STATES)[number]

/**
 * Note what is *not* a state: which lane a task runs in.
 *
 * The prototype had `active_parallel` and `active_sequential` as separate
 * states, so every rule about running had to be written twice and a task could
 * be in the wrong half of the machine. Scheduling is a property of the workflow
 * being run, not of the task, so there is one `running`.
 */

/**
 * One workflow in a task's list, and what has happened to it.
 *
 * This replaced an integer cursor on the task. The cursor was *correct* — a
 * retry did resume where it left off — but nothing on screen showed it, and
 * editing the list reset it, because a position in the old list means nothing
 * in the new one. State per entry survives an edit and can be drawn.
 */
export interface TaskWorkflowEntry {
  /**
   * Stable across reorders, and the handle everything else uses.
   *
   * Position is what moves when you reorder, which is exactly the edit that
   * must not lose what an entry knows.
   */
  readonly id: string
  readonly workflow: string
  /** Whether it is still to run. Unticked by the engine when it is finished. */
  readonly enabled: boolean
  /** Whether a run of it was ever started. Derived; it is why it cannot be removed. */
  readonly ran: boolean
}

export interface Task {
  readonly id: string
  readonly name: string
  /**
   * What the work is for, in the words of whoever asked for it.
   *
   * Always a string — '' when nobody has written one. Not optional, because
   * `{{ task.description }}` has to resolve to something, and "absent" and
   * "empty" are the same thing for prose.
   */
  readonly description: string
  /**
   * The project this work happens in.
   *
   * Required. It used to be optional, and a task without one ran in whatever
   * directory the daemon was started in, could not be queued as a batch and
   * could not be given a worktree. It decides where, so there is no task
   * without it.
   */
  readonly projectId: string
  readonly ticketId?: string
  readonly branch?: string
  /** Directory name for a worktree, when the task has one. */
  readonly directory?: string
  readonly state: TaskState
  /** Workflows to run, in order, and which of them are still to go. */
  readonly workflows: readonly TaskWorkflowEntry[]
  /**
   * What is true about this task right now: `hasWorktree`, `hasEnvironment`,
   * whatever the workflows in use declare. Set by the workflows that earn them.
   */
  readonly flags: readonly string[]
  /**
   * Tasks this one cannot start until they are done.
   *
   * Ids, not names: a task can be renamed and the graph must not move with it.
   * Always the same project — a cross-project graph has no owner, and the
   * controls that act on it are project-level.
   *
   * Whether they are *satisfied* is not stored. It is derived from their states
   * by `dependencyStatus`, so the scheduler and the board share one answer
   * rather than keeping two that can disagree.
   */
  readonly dependsOn: readonly string[]
  /** Ordering within the queue. Null when not queued. */
  readonly queuePosition?: number
  /**
   * Not before this time. Set between iterations of a loop workflow; the
   * scheduler passes over a queued task that is still waiting.
   */
  readonly runnableAt?: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly completedAt?: string
  /** Why it is blocked, when it is. */
  readonly blockedReason?: string
  /**
   * The agent session every step of this task shares, once one exists.
   *
   * Absent until an agent process has actually started for the task — recorded
   * then, and not at plan time, because an id written down for a session that
   * was never created is a task that can never run again. So its presence
   * means "there is a conversation with this id", which is what both the next
   * run and the person opening a terminal need to know.
   *
   * The provider travels with it: which CLI owns the session decides which
   * flag resumes it, and reading that back off the definitions later would let
   * an edit to a phase disagree with what actually ran.
   */
  readonly session?: { readonly id: string; readonly provider: string }
  /**
   * Who asked for this task, when it was not a person at a keyboard.
   *
   * A label an MCP client gave for itself — `mcp:claude-code/2.1` — which is
   * self-reported and is read by people, never by a rule. What the rules use is
   * the run below, which a client cannot claim because Factory stamped it into
   * the environment of the process it launched.
   */
  readonly createdBy?: string
  /** The run whose agent asked for this task. Absent when a person did. */
  readonly createdByRunId?: string
}

/**
 * The workflow the engine would run next: the first one still ticked.
 *
 * `undefined` for a task with nothing left, which the display sites must say
 * rather than falling back to the first — showing a finished task's first
 * workflow as "current" was never honest.
 */
export const nextEntry = (task: Task): TaskWorkflowEntry | undefined =>
  task.workflows.find((entry) => entry.enabled)

/** Just the names, for the places that only ever wanted those. */
export const workflowNames = (task: Task): string[] =>
  task.workflows.map((entry) => entry.workflow)

/**
 * The things a person or the scheduler can ask for.
 *
 * Named as intents rather than target states, because "retry" and "queue" reach
 * the same state for different reasons and a UI should say which it means.
 */
export const TASK_ACTIONS = [
  'queue',
  'start',
  'idle',
  'await_approval',
  'approve',
  'reject',
  'block',
  'complete',
  'mark_done',
  'retry',
  'cancel',
  'archive',
  'restore',
] as const

export type TaskAction = (typeof TASK_ACTIONS)[number]

interface Move {
  readonly from: readonly TaskState[]
  readonly to: TaskState
  /** Shown on a button. */
  readonly label: string
  /** Only the engine or scheduler may ask; never offered to a person. */
  readonly internal?: boolean
}

const MOVES: Record<TaskAction, Move> = {
  queue: { from: ['draft', 'blocked', 'done', 'cancelled'], to: 'queued', label: 'Queue' },
  start: { from: ['queued', 'awaiting_approval'], to: 'running', label: 'Start', internal: true },
  // Between iterations of a loop workflow. Back in the queue, but not before
  // its interval has passed — a loop that re-queued itself with no wait would
  // spin the scheduler at whatever speed the machine allows.
  idle: {
    from: ['running'],
    to: 'queued',
    label: 'Wait for the next iteration',
    internal: true,
  },
  // The engine parks a task here when a phase needs a person. Without a move
  // into `awaiting_approval` nothing could legitimately reach it, and the only
  // way to test approval would be to write the state behind the machine's back
  // — which is exactly the hole the prototype's scattered rules left open.
  await_approval: {
    from: ['running'],
    to: 'awaiting_approval',
    label: 'Await approval',
    internal: true,
  },
  approve: { from: ['awaiting_approval'], to: 'running', label: 'Approve' },
  reject: { from: ['awaiting_approval'], to: 'blocked', label: 'Reject' },
  // `queued` is here for the dependency gate: a queued task whose blocker can
  // never finish would otherwise sit in the queue for ever looking like it was
  // about to run, which is the one state the board exists to make obvious.
  block: {
    from: ['queued', 'running', 'awaiting_approval'],
    to: 'blocked',
    label: 'Block',
    internal: true,
  },
  complete: { from: ['running'], to: 'done', label: 'Complete', internal: true },
  // "I did this myself." A separate action rather than lifting `complete`'s
  // `internal`, because `complete` is `from: ['running']` and offering it there
  // is the one case that corrupts state: the agent keeps going, the run row
  // stays `running`, and the engine's own `complete` then throws.
  //
  // Not from `running` for that reason, and not from `awaiting_approval`, which
  // holds a paused run — approve or reject it first, or `doctor` starts warning
  // about an orphan.
  mark_done: { from: ['draft', 'queued', 'blocked'], to: 'done', label: 'Mark done' },
  retry: { from: ['blocked'], to: 'queued', label: 'Retry' },
  cancel: {
    from: ['draft', 'queued', 'running', 'awaiting_approval', 'blocked'],
    to: 'cancelled',
    label: 'Cancel',
  },
  archive: { from: ['draft', 'blocked', 'done', 'cancelled'], to: 'archived', label: 'Archive' },
  restore: { from: ['archived'], to: 'draft', label: 'Restore' },
}

/**
 * The actions a client may ask for at all.
 *
 * Derived from the table, never written out again. "A published list of what is
 * currently allowed so no client has to re-derive any of it" is what this
 * module already promised, and it was two thirds true: a *task* publishes the
 * actions it offers right now, but which actions exist to ask for was not
 * published — so the CLI kept its own copy of the eight a person can type, with
 * a comment saying the daemon had the final say. That comment is how a list
 * drifts: it is correct right up until somebody adds a ninth move.
 *
 * The engine's own moves are absent, which is the point. `start`, `idle`,
 * `await_approval`, `block` and `complete` belong to the scheduler and the
 * engine; a client asking for one would put a task past the concurrency cap or
 * mark a run done while its agent was still writing.
 */
export const REQUESTABLE_ACTIONS: readonly TaskAction[] = TASK_ACTIONS.filter(
  (action) => MOVES[action].internal !== true,
)

export interface AvailableAction {
  readonly action: TaskAction
  readonly label: string
  readonly to: TaskState
}

/**
 * What can be done to this task right now.
 *
 * The API returns this and the builder renders buttons from it. That is the
 * whole point: a client that re-derives the rules will drift from them, and the
 * drift shows up as a button that does nothing or an action nobody expected.
 */
export function availableActions(
  task: Pick<Task, 'state' | 'workflows'>,
  options: { includeInternal?: boolean } = {},
): AvailableAction[] {
  return (Object.entries(MOVES) as [TaskAction, Move][])
    .filter(([, move]) => move.from.includes(task.state))
    .filter(([, move]) => options.includeInternal === true || move.internal !== true)
    // Nothing ticked is nothing to run. Subsumes "no workflows at all", which
    // used to be a separate check — an empty list has nothing enabled either.
    // A finished task therefore offers archive and cancel but not queue: one
    // click should never set five agents on a repository because everything
    // happened to be done.
    .filter(([action]) => !(action === 'queue' && !task.workflows.some((w) => w.enabled)))
    .map(([action, move]) => ({ action, label: move.label, to: move.to }))
}

export class TransitionError extends Error {
  override readonly name = 'TransitionError'
  constructor(
    readonly task: string,
    readonly from: TaskState,
    readonly action: TaskAction,
    message: string,
  ) {
    super(message)
  }
}

export interface TransitionResult {
  readonly task: Task
  readonly from: TaskState
  readonly action: TaskAction
}

/**
 * Apply an action.
 *
 * Every path goes through here — the API, the CLI, the scheduler and the
 * engine alike. There is no second way to change a task's state, which is the
 * only reliable way to keep one set of rules.
 */
export function applyAction(
  task: Task,
  action: TaskAction,
  context: { now: string; reason?: string; until?: string },
): TransitionResult {
  const move = MOVES[action]
  if (move === undefined) {
    throw new TransitionError(task.id, task.state, action, `Unknown action "${action}".`)
  }

  if (!move.from.includes(task.state)) {
    const offered = availableActions(task, { includeInternal: true })
      .map((entry) => entry.action)
      .sort()
    throw new TransitionError(
      task.id,
      task.state,
      action,
      `Cannot ${action} a task that is ${task.state}. ` +
        (offered.length > 0 ? `Available: ${offered.join(', ')}.` : `Nothing is available.`),
    )
  }

  // Built by deleting rather than spreading `undefined`: under
  // exactOptionalPropertyTypes an explicitly-undefined key is not the same as
  // an absent one, and the difference shows up when the row is written.
  const next = { ...task, state: move.to, updatedAt: context.now } as Record<string, unknown>

  if (move.to === 'done') next.completedAt = context.now
  // Queueing something that already finished is how a task is re-run, so the
  // old completion has to go or it would claim to be done and queued at once.
  else if (move.to === 'queued' || move.to === 'running') delete next.completedAt

  if (move.to === 'blocked') next.blockedReason = context.reason ?? 'No reason given.'
  else delete next.blockedReason

  // A task that is not queued has no place in the queue.
  if (move.to !== 'queued') delete next.queuePosition


  // Only meaningful while queued, and only until it starts.
  if (move.to === 'queued' && context.until !== undefined) next.runnableAt = context.until
  else delete next.runnableAt

  return { from: task.state, action, task: next as unknown as Task }
}

/**
 * Work is happening on this task right now.
 *
 * `awaiting_approval` counts: the run is parked mid-plan holding uncommitted
 * changes in a working copy, and the phases after the gate are still to come.
 * Anything that would change what a run is doing or where it happens — the
 * plan, the project — is refused while a task is in one of these.
 *
 * Here rather than in the route that first needed it, because the store makes
 * the same refusal and two lists could disagree about which states mean
 * "busy".
 */
export const IN_FLIGHT: readonly TaskState[] = ['running', 'awaiting_approval']

/** Terminal for the board's purposes: nothing further happens on its own. */
export const isSettled = (state: TaskState): boolean =>
  state === 'done' || state === 'cancelled' || state === 'archived'

/** Whether the scheduler should consider this task. */
export const isSchedulable = (state: TaskState): boolean => state === 'queued'

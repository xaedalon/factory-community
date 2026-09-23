import { dependencyStatus, nextEntry, type Scheduling, type Task } from '@factory/core'
import type { Blocker, RunRepository, TaskRepository } from '@factory/store'
import type { EventBus } from '@factory/events'

/**
 * Deciding what runs next.
 *
 * The engine runs one task. The scheduler decides which tasks reach it, and the
 * whole of that decision is here: queue order, how many things may run at once,
 * and the one rule about lanes.
 *
 * Lanes come from the workflow, not the task. A workflow marked `sequential`
 * says "do not run this alongside other work" — it touches the same branch, the
 * same database, the same port — so at most one sequential workflow runs at a
 * time. Parallel workflows fill the rest of the capacity. The prototype encoded
 * this as two task states (`active_parallel`, `active_sequential`), which meant
 * every rule about running had to be written twice and a task could end up in
 * the wrong half of the machine.
 *
 * Three decisions worth stating, because all of them are visible behaviour:
 *
 * A task waiting for approval does **not** hold a slot. It is waiting for a
 * person who may be asleep, and a queue that stalls behind an unattended gate
 * is a queue that stops.
 *
 * It does, however, hold its project's *working copy* when that project works in
 * place rather than in a worktree per task. The two are not in tension: a slot
 * is global and must never be held by an absent person, while a working copy is
 * one repository's and is genuinely occupied — the parked task's uncommitted
 * changes are sitting in the tree, and a second task would edit them underneath
 * whoever is reviewing. The blast radius of that stall is one project.
 *
 * Queue position is a priority, not a barrier. If the task at the head is
 * sequential and a sequential workflow is already running, the scheduler looks
 * past it rather than idling — otherwise one long sequential task holds up
 * everything behind it, including work that could safely run now.
 *
 * Conditions are the third question. A workflow can declare that it requires a
 * flag — `hasWorktree`, `hasEnvironment` — and the scheduler passes over a task
 * that does not hold it yet. The task stays queued rather than failing: the
 * workflow that provides the flag may be running right now, and the next tick
 * will pick this one up. What it must never do is run anyway: the prototype's
 * gate existed precisely because a phase that assumes a worktree does damage
 * without one.
 *
 * Dependencies are the fourth, and the newest. A task can be made to wait for
 * another, and a queued task whose blockers are not done yet is passed over
 * with the blocker named. Queueing always works and the holding happens here —
 * that is what lets a person queue ten tasks in dependency order and walk
 * away. A blocker that can never finish is different in kind: the dependent is
 * moved to `blocked` with the reason, because leaving it in the queue would
 * park it for ever looking like it was about to run, which is the one thing the
 * board exists to make obvious.
 */

/** How many tasks may be running at once when nothing says otherwise. */
export const DEFAULT_MAX_PARALLEL = 3

export interface SchedulerOptions {
  readonly tasks: TaskRepository
  readonly runs: RunRepository
  /**
   * Hands a task to the engine. Injected so the scheduler can be specified
   * without running processes, and so a future distributed runner can replace
   * it without touching this decision logic.
   */
  readonly start: (taskId: string) => Promise<unknown>
  /**
   * What the scheduler needs to know about a workflow. Looked up rather than
   * passed in, because the answer lives in the definition and can change
   * between ticks — and looked up once, so the two questions cannot disagree.
   *
   * Asked per project, because a name does not mean one thing installation-wide:
   * a repository can define its own `deploy`, and that is the one its tasks run.
   * A lookup that ignored the project would read the wrong file's `sequential:`
   * and let two tasks into a lane meant for one.
   */
  readonly workflow: (name: string, projectId?: string) => WorkflowFacts | undefined
  /**
   * What a project says about itself. Optional, and absence means no project
   * ever serialises anything — the same degrade-by-absence as everything else
   * here, and what lets a scheduler be built without a project store at all.
   */
  readonly project?: (id: string) => ProjectFacts | undefined
  readonly maxParallel?: number
  readonly events?: EventBus
  /** Injected so a waiting task's deadline is testable. */
  readonly now?: () => Date
  /**
   * Where a failure goes when there is no task left to record it against.
   *
   * There has to be somewhere. A task that settles while the engine is working
   * on it leaves the engine's next transition throwing, and for sixteen
   * increments that error was dropped on the floor — which is precisely how
   * "cancel does not cancel" stayed invisible. Optional, because the default of
   * doing nothing is what a scenario wants; the daemon supplies one.
   */
  readonly onError?: (error: Error) => void
}

/** What a workflow definition says about how it may be scheduled. */
export interface WorkflowFacts {
  readonly scheduling: Scheduling
  /** Flags the task must hold before this workflow may run. */
  readonly requires?: readonly string[]
  /** Flags it sets when it completes. Used to tell a wait apart from a dead end. */
  readonly provides?: readonly string[]
  /**
   * Workflows that must come before this one.
   *
   * The scheduler does not gate on these — assembling the list is the builder's
   * job, and a task's list is a plan somebody wrote. Doctor reports a list that
   * got assembled another way, and reads it from this lookup so it cannot
   * disagree with the scheduler about what a name means.
   */
  readonly needs?: readonly string[]
  /**
   * Which scope this name resolved from, for this task's project.
   *
   * The scheduler does not care; doctor does. Carried on the same lookup rather
   * than a second one so the two can never disagree about which file a name
   * means — which, once definitions resolve per project, is a real possibility.
   */
  readonly scope?: string
  /** Set when the definition says a project must supply its own copy. */
  readonly override?: string
  /** Where that copy would go, so a warning can name the file. */
  readonly overridePath?: string
}

/** What a project says about how much of its work can happen at once. */
export interface ProjectFacts {
  readonly name: string
  /**
   * False when work happens in the project's own checkout.
   *
   * Everything in one directory means one task at a time; there is no way to
   * share a working copy safely between two agents.
   */
  readonly usesWorktrees: boolean
}

/** Why a queued task was passed over. Reported, never silent. */
export type SkipReason =
  | 'at capacity'
  | 'the project runs one task at a time'
  | 'a sequential workflow is already running'
  | 'a required flag is not set'
  | 'waiting for its next iteration'
  | 'a task it depends on is not done'

export interface SkippedTask {
  readonly task: Task
  readonly reason: SkipReason
  /** What exactly is missing, when the reason alone does not say. */
  readonly detail?: string
}

export interface TickReport {
  readonly started: readonly Task[]
  readonly skipped: readonly SkippedTask[]
  /**
   * Tasks this tick took out of the queue, because what they were waiting for
   * can never finish. Separate from `skipped`, which is about tasks left
   * exactly as they were found.
   */
  readonly blocked: readonly Task[]
  readonly running: number
  readonly capacity: number
}

export class Scheduler {
  readonly #tasks: TaskRepository
  readonly #runs: RunRepository
  readonly #start: (taskId: string) => Promise<unknown>
  readonly #workflow: (name: string, projectId?: string) => WorkflowFacts | undefined
  readonly #project: (id: string) => ProjectFacts | undefined
  readonly #maxParallel: number
  readonly #events: EventBus | undefined
  readonly #now: () => Date
  readonly #onError: ((error: Error) => void) | undefined
  readonly #inFlight = new Set<Promise<unknown>>()
  /** Tasks handed over and not yet finished, so a second tick cannot repeat one. */
  readonly #active = new Set<string>()
  #ticking = false
  #again = false

  constructor(options: SchedulerOptions) {
    this.#tasks = options.tasks
    this.#runs = options.runs
    this.#start = options.start
    this.#workflow = options.workflow
    this.#project = options.project ?? (() => undefined)
    this.#maxParallel = options.maxParallel ?? DEFAULT_MAX_PARALLEL
    this.#events = options.events
    this.#now = options.now ?? (() => new Date())
    this.#onError = options.onError
  }

  /**
   * Start everything that can start right now.
   *
   * Synchronous on purpose: it admits tasks and hands them over, and the work
   * itself happens on its own. A tick that awaited each run would admit one task
   * per tick and call it a scheduler.
   */
  tick(): TickReport {
    if (this.#ticking) {
      // Something inside a tick asked for another one. Do it after, not during:
      // admitting the same task twice is exactly what the running-count guard
      // exists to prevent.
      this.#again = true
      return { started: [], skipped: [], blocked: [], running: 0, capacity: 0 }
    }

    this.#ticking = true
    try {
      return this.#tick()
    } finally {
      this.#ticking = false
      if (this.#again) {
        this.#again = false
        this.tick()
      }
    }
  }

  #tick(): TickReport {
    const running = this.#tasks.list({ state: 'running' })
    let capacity = this.#maxParallel - running.length
    let sequentialBusy = running.some(
      (task) => this.#executing(task) && this.#factsFor(task).scheduling === 'sequential',
    )

    // Who is holding a shared working copy: everything running, plus everything
    // parked at a gate with uncommitted changes still in the tree. Keyed by
    // project and holding the task, because "busy" is not a useful thing to be
    // told without being told by whom.
    const busyProjects = new Map<string, Task>()
    for (const task of [...running, ...this.#tasks.list({ state: 'awaiting_approval' })]) {
      const held = this.#sharedCheckoutOf(task)
      if (held !== undefined && !busyProjects.has(held)) busyProjects.set(held, task)
    }

    const started: Task[] = []
    const skipped: SkippedTask[] = []
    const blocked: Task[] = []

    // The dependency graph, read once. Every queued task is gated against it,
    // and asking per task would read the whole table over and over to answer
    // one question. Blockers are cached for the same reason — several
    // dependents usually wait for the same task.
    const edges = this.#tasks.dependencies()
    const blockers = new Map<string, Blocker | undefined>()
    const blockerOf = (id: string): Blocker | undefined => {
      if (!blockers.has(id)) blockers.set(id, this.#tasks.blocker(id))
      return blockers.get(id)
    }
    const nameOf = (id: string): string => blockerOf(id)?.name ?? id

    // Resumed first. A task someone approved is already running and is holding
    // a paused run: it occupies its slot either way, and nothing else would
    // ever pick it up — the approval would sit there forever, which is exactly
    // what it did the first time this was tried without this loop.
    for (const task of running) {
      if (this.#active.has(task.id)) continue
      if (this.#runs.pausedFor(task.id) === undefined) continue
      // The lane, which this loop used to skip entirely. The queued path below
      // checks it, and a workflow that is unsafe to run twice at once does not
      // become safe because a person approved it: two `merge` workflows
      // approved in the same second overlapped and left a staged deletion of a
      // file that had just merged cleanly.
      //
      // Capacity is deliberately not checked, as before: the task is already
      // running and occupies its slot either way.
      if (this.#factsFor(task).scheduling === 'sequential') {
        if (sequentialBusy) {
          skipped.push({ task, reason: 'a sequential workflow is already running' })
          continue
        }
        sequentialBusy = true
      }
      this.#hand(task)
      started.push(task)
    }

    for (const task of this.#tasks.list({ state: 'queued' })) {
      if (capacity <= 0) {
        skipped.push({ task, reason: 'at capacity' })
        continue
      }

      // A loop workflow between iterations. Skipped rather than started, and
      // left in the queue, because the wait is the point.
      if (task.runnableAt !== undefined && task.runnableAt > this.#now().toISOString()) {
        skipped.push({
          task,
          reason: 'waiting for its next iteration',
          detail: `not before ${task.runnableAt}`,
        })
        continue
      }

      // Before the shared-checkout and lane checks, by the same doctrine: the
      // most useful reason is the one naming something the person can act on,
      // and a blocker is a task of theirs in the same project.
      const dependencies = dependencyStatus(task.id, edges, blockerOf)
      if (dependencies.state === 'dead') {
        const because = dependencies.dead
          .map((entry) => `"${nameOf(entry.id)}" ${entry.because}`)
          .join(' and ')
        blocked.push(this.#tasks.act(task.id, 'block', { reason: `${because}, so this cannot start.` }))
        continue
      }
      if (dependencies.state === 'waiting') {
        skipped.push({
          task,
          reason: 'a task it depends on is not done',
          detail: dependencies.waitingFor.map((id) => `"${nameOf(id)}"`).join(' and '),
        })
        continue
      }

      // Before the lane check on purpose. When both apply, "a sequential
      // workflow is already running" points at a task in some other project,
      // which nobody can act on; this names the sibling in the way.
      const shared = this.#sharedCheckoutOf(task)
      const holder = shared === undefined ? undefined : busyProjects.get(shared)
      if (shared !== undefined && holder !== undefined) {
        // Which task has it, and — when it is a person the project is waiting
        // on rather than work — that too. "One task at a time" reads as a
        // throughput limit, and it is also what happens while an approval goes
        // unanswered: three tasks waited behind one that was waiting for
        // somebody, and nothing said the queue was stalled on a human.
        const held =
          holder.state === 'awaiting_approval'
            ? `"${holder.name}" has it, waiting for approval`
            : `"${holder.name}" has it`
        skipped.push({
          task,
          reason: 'the project runs one task at a time',
          detail: `${this.#project(shared)?.name ?? shared} — ${held}`,
        })
        continue
      }

      const facts = this.#factsFor(task)
      const unmet = (facts.requires ?? []).filter((flag) => !task.flags.includes(flag))
      if (unmet.length > 0) {
        skipped.push({
          task,
          reason: 'a required flag is not set',
          detail: unmet.join(', '),
        })
        continue
      }

      const lane = facts.scheduling
      if (lane === 'sequential' && sequentialBusy) {
        skipped.push({ task, reason: 'a sequential workflow is already running' })
        continue
      }

      // Marked running here, before the engine is called: the engine's own
      // `start` happens inside an async call, and a second tick in between would
      // see the task still queued and hand it over twice.
      const admitted = this.#tasks.act(task.id, 'start')
      capacity -= 1
      if (lane === 'sequential') sequentialBusy = true
      if (shared !== undefined) busyProjects.set(shared, admitted)
      started.push(admitted)
      this.#hand(admitted)
    }

    return {
      started,
      skipped,
      blocked,
      running: running.length,
      capacity: Math.max(capacity, 0),
    }
  }

  /** Hand a task to the engine, and make sure nothing is left looking busy. */
  #hand(task: Task): void {
    this.#active.add(task.id)
    const work = this.#start(task.id)
      .catch((error: unknown) => {
        // A task that cannot even be handed over must not take the scheduler
        // down with it, and must not be left looking busy forever.
        const reason = error instanceof Error ? error.message : String(error)
        const state = this.#tasks.get(task.id)?.state
        if (state === 'running') {
          this.#tasks.act(task.id, 'block', { reason })
          return
        }
        // Not running any more, so there is nowhere to record it — and until
        // now that meant the error vanished. That is how "cancel does not
        // cancel" hid for sixteen increments: the engine's next transition
        // threw `TransitionError` because `complete` has no edge from
        // `cancelled`, this branch found the task settled, and nothing was
        // written down anywhere.
        //
        // A task that settled while the engine was working on it is ordinary —
        // somebody cancelled or deleted it — so that is not worth a noise. Any
        // other reason is a bug, and a bug with no trace is the expensive kind.
        if (state === 'cancelled' || state === undefined) return
        this.#onError?.(
          new Error(
            `Working on "${task.name}" failed after it had already become ${state}: ${reason}`,
          ),
        )
      })
      .finally(() => {
        this.#active.delete(task.id)
        this.#inFlight.delete(work)
      })
    this.#inFlight.add(work)
  }

  /**
   * Tick whenever something changes that could free or fill a slot.
   *
   * Deferred to a microtask rather than run inside the handler: the events that
   * matter are emitted from inside the store's transaction, and ticking there
   * would try to open a transaction inside one — which the store refuses, in
   * the middle of someone else's write.
   */
  watch(): () => void {
    if (this.#events === undefined) return () => {}
    const wake = (): void => {
      queueMicrotask(() => {
        this.tick()
      })
    }
    const offs = [
      this.#events.on('task.transitioned', wake),
      this.#events.on('run.completed', wake),
    ]
    return () => {
      for (const off of offs) off()
    }
  }

  /** Wait for everything this scheduler handed over. For shutdown, and for tests. */
  async settle(): Promise<void> {
    while (this.#inFlight.size > 0) {
      await Promise.all([...this.#inFlight])
    }
  }

  /**
   * Whether this task is actually running something right now.
   *
   * Not the same as `state === 'running'`. A task whose run paused at an
   * approval gate and was then approved is `running` and executing nothing,
   * and counting it as the sequential lane's occupant made each of two
   * simultaneous approvals see the other as busy while neither was doing any
   * work — so both resumed together.
   *
   * Two sources because neither is enough on its own. `#active` covers the
   * moment between handing a task over and the engine writing its run row.
   * The run's own state survives a restart, where nothing was handed over in
   * this process, and it is what tells a paused run from a going one.
   */
  #executing(task: Task): boolean {
    if (this.#active.has(task.id)) return true
    return this.#runs.forTask(task.id)[0]?.state === 'running'
  }

  /**
   * The project whose single working copy this task would occupy, if any.
   *
   * Undefined for a project that gives each task a worktree — nothing to
   * serialise against, and defaulting to "exclusive" would stall work for no
   * reason — and for one nobody can look up, which now means either a
   * scheduler built without a project store or a row edited away by hand.
   */
  #sharedCheckoutOf(task: Task): string | undefined {
    const project = this.#project(task.projectId)
    if (project === undefined || project.usesWorktrees) return undefined
    return task.projectId
  }

  /**
   * What the workflow this task is on says about itself.
   *
   * An unknown workflow is treated as sequential with no requirements: the
   * engine will record why it could not be planned — that is its job, and it
   * writes a run explaining it — while in the meantime it does not get to run
   * alongside anything.
   */
  #factsFor(task: Task): WorkflowFacts {
    const current = this.#workflowOf(task)
    if (current === undefined) return { scheduling: 'sequential' }
    return this.#workflow(current, task.projectId) ?? { scheduling: 'sequential' }
  }

  /**
   * The workflow the gates are about.
   *
   * This read the newest run's workflow for every task, falling back to
   * `workflows[0]`, and both are the wrong question for a task that has not
   * started: a task whose first workflow has finished was admitted on the lane
   * and the requirements of work that was already over. It cost real work —
   * agents ran in a project's own checkout because the flag gate was asked
   * about a workflow needing no worktree, and two `merge` workflows overlapped
   * because the lane gate was asked about the parallel one before them. No
   * scenario caught it because every one of them gave its task a single
   * workflow, so the two answers coincided.
   *
   * The distinction is the task's state, and it is the engine's own:
   *
   * - **Running** — the workflow in flight, which is the newest run's. After an
   *   `on_fail` that is the recovery workflow, which is not in the list at all,
   *   and it is the one holding the lane.
   * - **Anything else** — what `start` would pick: a paused run resumes at its
   *   own entry whatever is ticked before it, otherwise the first ticked entry.
   *   Mirrored from `Engine.start`, which is the only other place that decides.
   */
  #workflowOf(task: Task): string | undefined {
    if (task.state === 'running') return this.#runs.forTask(task.id)[0]?.workflow

    const paused = this.#runs.pausedFor(task.id)
    if (paused !== undefined) {
      const resuming = task.workflows.find((entry) => entry.id === paused.entryId)
      // The run's own workflow when the entry has gone — an `on_fail` recovery
      // that paused for approval has no entry of its own.
      return resuming?.workflow ?? paused.workflow
    }
    return nextEntry(task)?.workflow
  }
}

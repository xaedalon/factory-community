import {
  denialMessage,
  isRunFinished,
  ProcessRegistry,
  runPlan,
  type Problem,
  type ResolvedPlan,
  type PlanResult,
  type Run,
  type RunOptions,
  type RunResult,
  type StepState,
  type StopReport,
  type Task,
  type TaskWorkflowEntry,
  IGNORE_WHAT_RUNS_PRODUCE,
  PRODUCT_FAMILY_DIR,
  fileStamp,
  toShellString,
} from '@factory/core'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import type { EventBus } from '@factory/events'
import type { RunRepository, TaskRepository } from '@factory/store'

/**
 * The engine: a task, its workflows, and what actually happened.
 *
 * Increment 1's runner takes a plan and runs it in one process, reporting
 * through callbacks. That is still the thing that runs steps — this does not
 * reimplement it. What the engine adds is everything around a run that has to
 * outlive the process: which workflow of the task we are on, a row per step, the
 * output filed against it, and the task's state kept in step with all of it.
 *
 * Two rules shape it.
 *
 * The task's state only ever changes through `TaskRepository.act`, so the rules
 * in core apply to the engine exactly as they apply to a person clicking a
 * button. The prototype's scheduler wrote states directly and that is how a
 * blocked task ended up started.
 *
 * And an approval gate parks rather than asks. The engine may be running with
 * nobody watching, so a gate stops the run, remembers the phase to continue
 * from, and puts the task in `awaiting_approval` where a person can find it.
 * `runPlan` reports that as "declined" because its own caller answered no; here
 * that answer always means "not yet".
 */

/**
 * The one sequential lane, held while a workflow that asked for it executes.
 *
 * `scheduling: sequential` was checked only where the scheduler admits a task.
 * After that the task stays `running` from its first workflow to its last and
 * nothing looked at the field again, so a sequential workflow anywhere but
 * first was never serialised against anything — two tasks whose fourth
 * workflow was `merge` ran their merges 20ms apart, twice.
 *
 * In this process, which is the scope that matters: the daemon holds one
 * engine and it is what runs a board's work. `factory run` is a foreground
 * process of its own and is not serialised against the daemon, the same way it
 * is not scheduled by it.
 *
 * A plain FIFO queue rather than a library: waiters are resumed in the order
 * they arrived, so a task cannot be starved by later ones.
 */
class Lane {
  #held = false
  readonly #waiting: (() => void)[] = []

  get busy(): boolean {
    return this.#held
  }

  async take(): Promise<() => void> {
    if (this.#held) await new Promise<void>((resume) => this.#waiting.push(resume))
    this.#held = true
    let released = false
    return () => {
      // Idempotent. There is one caller and it releases in a `finally`, so
      // nothing reaches this twice today and no scenario can make it — it is
      // here because the failure it prevents is handing one lane to two
      // waiters, which would look exactly like the defect this class exists
      // to fix and would be found by the same expensive route.
      if (released) return
      released = true
      const next = this.#waiting.shift()
      if (next === undefined) this.#held = false
      else next()
    }
  }
}

export interface EngineOptions {
  readonly tasks: TaskRepository
  readonly runs: RunRepository
  /**
   * Turns a workflow name into a plan for this task.
   *
   * Injected rather than imported so the engine depends on neither the scope
   * chain nor the filesystem: the daemon passes `planWorkflow` bound to its
   * runtime, and a test passes a plan it built in memory.
   *
   * `failure` is set only when planning a recovery workflow, so the caller can
   * put the phase and reason in front of the agent that has to diagnose it.
   */
  readonly plan: (input: {
    workflow: string
    task: Task
    failure?: FailureContext
    /**
     * The agent session this run's steps should share.
     *
     * Decided here rather than by the planner, because only the engine can see
     * both the task's recorded session and the run about to happen. `started`
     * false means the first agent step will create it.
     */
    session?: { id: string; started: boolean }
  }) => PlanResult
  /** Executes a plan. Defaults to the real runner. */
  readonly execute?: (options: RunOptions) => Promise<RunResult>
  /**
   * The environment a step's process is built from.
   *
   * Passed through to the runner, which filters it according to the plan's
   * profile. Required for the same reason it is required there: the daemon is
   * the entry point that has one, and a default would be the old behaviour
   * waiting for somebody to forget.
   */
  readonly env: Readonly<Record<string, string | undefined>>
  /**
   * Where each step's process is registered so it can be stopped.
   *
   * The engine owns one by default. Injectable because a scenario needs to
   * drive the grace period without waiting for it, and because the daemon's
   * shutdown needs the same registry the runs were registered in.
   */
  readonly processes?: ProcessRegistry
  readonly events?: EventBus
  /** Seconds a single step may take. Passed through to the runner. */
  readonly timeoutSeconds?: number
  /** Injected so a loop's next-iteration time is testable. */
  readonly now?: () => Date
  /**
   * Mints the id for a task's agent session. Injected so it is testable.
   *
   * Factory chooses the id rather than reading one back, which is what makes a
   * session resumable exactly — by the next phase, by a re-run, and by a
   * person opening a terminal — instead of by "the most recent conversation in
   * this directory", which is the wrong one the moment two tasks share it.
   */
  readonly newSessionId?: () => string
}

/** How long a loop waits between iterations when the workflow does not say. */
export const DEFAULT_LOOP_INTERVAL_SECONDS = 60

export interface EngineOutcome {
  readonly task: Task
  /** The runs this call produced or continued, in order. */
  readonly runs: readonly Run[]
  readonly problems: readonly Problem[]
}

/** What went wrong, for the workflow asked to look into it. */
export interface FailureContext {
  /** The workflow that failed. */
  readonly workflow: string
  /** The phase its last step was in. */
  readonly phase?: string
  readonly reason: string
}

/** Why the engine stopped working on a task. */
type Stop = 'finished' | 'blocked' | 'paused' | 'idle' | 'cancelled'

export class Engine {
  readonly #tasks: TaskRepository
  readonly #runs: RunRepository
  readonly #plan: EngineOptions['plan']
  readonly #execute: (options: RunOptions) => Promise<RunResult>
  readonly #env: Readonly<Record<string, string | undefined>>
  readonly #processes: ProcessRegistry
  /**
   * Runs this engine is executing right now, by task.
   *
   * The missing link in the old cancel path: a person cancels a *task*, the
   * processes are keyed by *run*, and nothing joined the two — so cancelling
   * flipped a row and left the agent working.
   */
  readonly #inFlight = new Map<string, string>()
  /**
   * Runs a person stopped while they were running.
   *
   * Consulted once the runner returns, because by then the step has exited with
   * whatever a SIGKILL looks like and the honest reading of that is "cancelled",
   * not "failed". It also stops the engine attempting `complete` or `block` on a
   * task that is already `cancelled` — which threw `TransitionError`, and the
   * scheduler swallowed it because the task was no longer running.
   */
  readonly #cancelled = new Set<string>()
  readonly #lane = new Lane()
  readonly #events: EventBus | undefined
  readonly #timeoutSeconds: number | undefined
  readonly #now: () => Date
  readonly #newSessionId: () => string

  constructor(options: EngineOptions) {
    this.#tasks = options.tasks
    this.#runs = options.runs
    this.#plan = options.plan
    this.#execute = options.execute ?? runPlan
    this.#env = options.env
    this.#processes = options.processes ?? new ProcessRegistry()
    this.#events = options.events
    this.#timeoutSeconds = options.timeoutSeconds
    this.#now = options.now ?? (() => new Date())
    this.#newSessionId = options.newSessionId ?? (() => randomUUID())
  }

  /**
   * Work a task through its workflows until it finishes, fails or reaches a gate.
   *
   * Called with a queued task to start it, and with a running one to continue
   * after an approval. Anything else is refused loudly: a task in the wrong
   * state means something else already owns it, and two owners is worse than
   * one error.
   */
  async run(taskId: string): Promise<EngineOutcome> {
    let task = this.#require(taskId)
    const produced: Run[] = []
    const problems: Problem[] = []

    const paused = this.#runs.pausedFor(taskId)

    if (task.state === 'queued') {
      task = this.#tasks.act(taskId, 'start')
    } else if (task.state === 'running') {
      // Already ours: either the scheduler admitted it — it marks a task
      // running before handing it over, so two ticks cannot admit the same task
      // twice — or a person approved it and it is holding a paused run.
    } else {
      throw new Error(
        `Cannot run "${task.name}": it is ${task.state}. ` +
          `The engine starts a queued task, or continues one that is already running.`,
      )
    }

    if (task.workflows.length === 0) {
      // Nothing to do is not a failure, but it is not success either — silently
      // completing would tell the board the work is done.
      this.#tasks.act(taskId, 'block', { reason: 'No workflows are assigned.' })
      return { task: this.#require(taskId), runs: produced, problems }
    }

    if (!task.workflows.some((entry) => entry.enabled)) {
      // Ticked nothing is the same shape of nothing-to-do as assigned nothing.
      // Reachable: untick the blocked entry of a blocked task, then retry.
      this.#tasks.act(taskId, 'block', { reason: 'No workflows are ticked to run.' })
      return { task: this.#require(taskId), runs: produced, problems }
    }

    // Which entry is next is the first one still ticked — with one deliberate
    // tie-break: a paused run holds phases that have already executed, so it
    // resumes at its own entry even when something earlier is ticked.
    let resuming = paused
    let forced = paused === undefined
      ? undefined
      : task.workflows.find((entry) => entry.id === paused.entryId)
    /** Entries this call has finished, so a mismatch cannot spin for ever. */
    const settled = new Set<string>()

    for (;;) {
      const entry = forced ?? task.workflows.find((candidate) => candidate.enabled)
      if (entry === undefined) break
      if (settled.has(entry.id)) {
        // `finished` matched nothing — a wrong id, or a concurrent edit. The
        // old loop counted an index up and could not spin; this one can, and
        // spinning here means launching an agent every time round.
        throw new Error(
          `"${entry.workflow}" finished but is still ticked. Refusing to run it again.`,
        )
      }
      const result = await this.#runOne({ task, entry, resuming })
      // Cleared here rather than in a `finally` inside `#runOne`: this is the
      // one place every path out of it passes through. A stale entry would have
      // `stop` signalling a run that has already ended — harmless, but a map
      // that only grows is a leak nobody notices.
      this.#inFlight.delete(taskId)
      resuming = undefined
      forced = undefined
      produced.push(result.run)
      problems.push(...result.problems)
      if (result.stop !== 'finished') {
        return { task: this.#require(taskId), runs: produced, problems }
      }
      // Where `advance` was, under the same condition. A loop mid-repeat stops
      // at `idle` rather than `finished`, so it never reaches here and keeps
      // its tick — no special case needed.
      this.#tasks.finished(taskId, entry.id)
      settled.add(entry.id)
      // Re-read: the entries have changed, and a workflow that just earned a
      // flag should be visible to the next one's plan.
      task = this.#require(taskId)
    }

    this.#tasks.act(taskId, 'complete')
    return { task: this.#require(taskId), runs: produced, problems }
  }

  /**
   * Stop what a task is doing, for real.
   *
   * Kills the process group of whatever step is running — SIGTERM, a grace
   * period, then SIGKILL — and marks the run so that when the runner returns,
   * the outcome is recorded as cancelled rather than read as a failure.
   *
   * Idempotent and safe on a task that is doing nothing: there is then no run
   * in flight and the report says nothing was signalled, which is the truthful
   * answer rather than an error.
   */
  async cancel(taskId: string): Promise<StopReport> {
    const runId = this.#inFlight.get(taskId)
    if (runId === undefined) return { signalled: 0, killed: 0 }
    this.#cancelled.add(runId)
    return this.#processes.stop(runId)
  }

  /**
   * Stop every agent this engine started, and cancel the tasks they belonged to.
   *
   * The kill switch. It terminates process trees rather than asking an agent
   * nicely, because an agent that is mid-loop is exactly the agent somebody is
   * trying to stop.
   *
   * The task transitions happen here rather than in whatever route called it,
   * so that the CLI, the API and a desktop menu item cannot differ about what
   * "stop all" leaves behind.
   */
  async stopAll(reason = 'Stopped by request.'): Promise<StopReport> {
    for (const [taskId, runId] of this.#inFlight) {
      this.#cancelled.add(runId)
      const task = this.#tasks.get(taskId)
      // Only if it is still somewhere `cancel` can reach from. A task that has
      // moved on in the meantime is not this call's business.
      if (task !== undefined && this.#tasks.actions(taskId).some((a) => a.action === 'cancel')) {
        this.#tasks.act(taskId, 'cancel', { reason })
      }
    }
    return this.#processes.stopAll()
  }

  /** Whether anything is running that could be stopped. */
  running(): readonly string[] {
    return [...this.#inFlight.keys()]
  }

  /**
   * React to the two transitions that mean something to a run in flight.
   *
   * Subscribed rather than called by each route, so that every way of
   * cancelling or rejecting — the API, the CLI, a future desktop menu — goes
   * through one implementation. A route only has to change the state; this
   * notices.
   *
   * Deferred to a microtask for the reason the scheduler gives: the transition
   * is emitted from inside the store's transaction, and doing work there would
   * open a transaction inside one.
   */
  watch(): () => void {
    if (this.#events === undefined) return () => {}
    return this.#events.on('task.transitioned', (event) => {
      const { taskId, action, to } = event.payload
      if (to === 'cancelled') {
        queueMicrotask(() => {
          void this.cancel(taskId)
        })
        return
      }
      // A rejected approval ends the run it was asked about. It used to leave
      // it paused for ever: the board drew a run nobody would pick up, doctor
      // asked somebody to approve or reject a task that had been rejected —
      // and a retry *resumed* it, continuing at the phase after the gate, so
      // the work the person declined to authorise ran anyway with nobody asked
      // a second time.
      //
      // `declined` is the state for exactly this, and nothing in the product
      // wrote it until now. What the run produced is kept: rejecting is a
      // verdict on what happened, not a reason to discard the evidence.
      if (action === 'reject') {
        queueMicrotask(() => {
          const paused = this.#runs.pausedFor(taskId)
          if (paused === undefined) return
          this.#runs.finish(paused.id, 'declined', { detail: 'Approval was refused.' })
        })
      }
    })
  }

  /**
   * Wait for the sequential lane, if this plan asked for one.
   *
   * The wait is written into the run's own log rather than left invisible.
   * A run that is `running` and has not started a step yet looks stuck, and
   * "waiting for something else to finish" is the difference between a
   * scheduler working and a scheduler hung.
   */
  async #takeLane(plan: ResolvedPlan, run: Run): Promise<() => void> {
    if (plan.scheduling !== 'sequential') return () => {}
    if (this.#lane.busy) {
      this.#runs.append({
        runId: run.id,
        stream: 'stderr',
        text: 'waiting: another sequential workflow is running\n',
      })
    }
    return this.#lane.take()
  }

  async #runOne(input: {
    task: Task
    /** The entry being run. A recovery reuses the entry of the one that failed. */
    entry: TaskWorkflowEntry
    /** Overrides the entry's own name, for a recovery workflow. */
    workflow?: string
    resuming: Run | undefined
    /**
     * A recovery run, started because another workflow failed. It never moves
     * the task itself — the workflow that failed does that once, when the
     * recovery is over — and its own `on_fail` is ignored, so a recovery that
     * fails cannot start another one.
     */
    recovery?: FailureContext
  }): Promise<{ run: Run; stop: Stop; problems: readonly Problem[] }> {
    const { task, entry } = input
    const workflow = input.workflow ?? entry.workflow
    // The position, for `runs.workflow_index`. The entry's id is the handle
    // everything else uses; the index is kept because old rows have one and
    // the wire still carries it.
    const index = task.workflows.findIndex((candidate) => candidate.id === entry.id)
    const isRecovery = input.recovery !== undefined
    const move = (
      action: 'block' | 'await_approval' | 'complete' | 'idle',
      options: { reason?: string; until?: string } = {},
    ): void => {
      if (!isRecovery) this.#tasks.act(task.id, action, options)
    }
    // One session per task, minted the first time and reused for ever after.
    //
    // Read from the store rather than from the task this call was handed. A
    // recovery run is started with the task as it was *before* its workflow
    // ran, and that workflow may have recorded the session on its way to
    // failing — so trusting the argument would mint a second id and hand the
    // agent asked to diagnose the failure a blank conversation.
    const recorded = this.#tasks.get(task.id)?.session
    const session = {
      id: recorded?.id ?? this.#newSessionId(),
      started: recorded !== undefined,
    }
    const planned = this.#plan({
      workflow,
      task,
      session,
      ...(input.recovery === undefined ? {} : { failure: input.recovery }),
    })

    if (planned.plan === undefined) {
      // A plan that will not resolve is recorded as a run that never started,
      // rather than left as an error in a log nobody keeps: "why did nothing
      // happen?" is the question the prototype could never answer.
      const run = this.#runs.start({
        workflow,
        taskId: task.id,
        workflowIndex: index,
        entryId: entry.id,
        attempt: this.#runs.attempts(task.id, workflow) + 1,
      })
      const detail = summarise(planned.problems, `"${workflow}" could not be planned.`)
      this.#runs.finish(run.id, 'refused', { detail })
      move('block', { reason: detail })
      return { run: this.#runs.get(run.id) as Run, stop: 'blocked', problems: planned.problems }
    }

    const plan = planned.plan
    const run =
      input.resuming !== undefined
        ? this.#runs.resume(input.resuming.id)
        : this.#runs.start({
            workflow,
            taskId: task.id,
            workflowIndex: index,
            entryId: entry.id,
            attempt: this.#runs.attempts(task.id, workflow) + 1,
            // Off the plan, which is the one place the profile is decided.
            // Recorded here rather than derived later, because "what authority
            // did this run have?" has to be answerable after the project
            // setting has moved on.
            //
            // The refused-plan branch above records none, deliberately: nothing
            // ran, so no authority was granted, and inventing one would be the
            // only false entry in the table.
            profile: plan.profile,
          })

    // Keyed by where the step is in the plan rather than by "the step running
    // now": output arrives asynchronously, and a single mutable cursor is wrong
    // the moment anything overlaps.
    const stepIds = new Map<string, number>()
    const key = (phase: string, stepIndex: number) => `${phase}#${stepIndex}`

    // The agent is told to write to a path, so the path has to exist before it
    // is told. Done here rather than at plan time: `resolvePlan` is pure, and
    // that is what makes `doctor` and `--dry-run` safe to run.
    this.#prepareArtifacts(plan)

    this.#inFlight.set(task.id, run.id)

    // The lane, taken around this one workflow's execution — which is the unit
    // `scheduling:` is about — and released the moment it ends, including when
    // the run parks at an approval gate. Holding it across a wait for a person
    // is how one forgotten approval would freeze every sequential workflow in
    // the installation.
    const release = await this.#takeLane(plan, run)
    let result: RunResult
    try {
      // Cancelled while queued behind another sequential workflow: nothing has
      // been spawned, so there is nothing for `cancel` to stop and the run
      // would otherwise execute after somebody decided it should not.
      if (this.#cancelled.delete(run.id)) {
        this.#runs.finish(run.id, 'cancelled', { detail: 'Stopped on request.' })
        return { run: this.#runs.get(run.id) as Run, stop: 'cancelled', problems: [] }
      }
      result = await this.#execute({
        plan,
        env: this.#env,
        processes: this.#processes,
        ...(this.#timeoutSeconds === undefined ? {} : { timeoutSeconds: this.#timeoutSeconds }),
        ...(this.#events === undefined ? {} : { events: this.#events }),
        runId: run.id,
        ...(input.resuming?.resumePhase === undefined
          ? {}
          : { startPhase: input.resuming.resumePhase, approved: true }),
          onStep: (step, phase) => {
          const stored = this.#runs.startStep(run.id, {
            phase: phase.name,
            index: step.index,
            describe: step.planned.describe,
            uses: step.uses,
            // What actually ran, not what the phase said it would: "what did
            // this agent run, and with what authority?" is the first question
            // any audit asks, and reading the phase file back later answers a
            // different one as soon as somebody has edited it. Rendered the
            // way `--dry-run` prints it, so the two cannot disagree.
            command: toShellString(step.planned),
          })
          stepIds.set(key(phase.name, step.index), stored.id)
        },
        onOutput: (chunk, stream, step, phase) => {
          const stepId = stepIds.get(key(phase.name, step.index))
          this.#runs.append({
            runId: run.id,
            ...(stepId === undefined ? {} : { stepId }),
            stream,
            text: chunk,
          })
        },
        onStepDone: (outcome, step, phase) => {
          // Written down only once the process actually started. `error` is set
          // exactly when it could not be — no CLI on PATH, a directory that has
          // gone — and in that case no session was created, so recording the id
          // would leave every later run asking to resume a conversation that was
          // never had. Nothing recorded means the next run starts one.
          if (step.planned.session?.creates === true && outcome.error === undefined) {
            this.#tasks.rememberSession(task.id, {
              id: step.planned.session.id,
              provider: step.planned.session.provider,
            })
          }
          const stepId = stepIds.get(key(phase.name, step.index))
          if (stepId === undefined) return
          this.#runs.finishStep(stepId, {
            state: stepStateOf(outcome.exitCode, outcome.timedOut),
            attempts: outcome.attempts,
            ...(outcome.exitCode === null ? {} : { exitCode: outcome.exitCode }),
            ...(outcome.error === undefined ? {} : { detail: outcome.error }),
          })
        },
        // Always "not yet". The engine has no person to ask, so a gate parks the
        // run instead of guessing an answer.
          onApproval: () => Promise.resolve(false),
      })
    } finally {
      release()
    }

    // Checked before anything else is recorded. A cancelled run's steps exited
    // because they were killed, and reading that as a failure would block a task
    // somebody had already decided to stop — and then attempt a transition
    // `cancelled` has no edge for.
    if (this.#cancelled.delete(run.id)) {
      this.#runs.finish(run.id, 'cancelled', { detail: 'Stopped on request.' })
      return { run: this.#runs.get(run.id) as Run, stop: 'cancelled', problems: [] }
    }

    // Collected before the verdict is recorded, so evidence is already there
    // when the task lands in front of a person — which for an approval gate is
    // the entire point of having it.
    const evidenceProblems = this.#collectEvidence(run.id, plan, result)

    // Every refusal gets said, whatever the run did. This is the only notice
    // anybody gets for the ordinary case: a confined agent that is refused
    // something exits 0 and reports it in prose, so there is no failure to
    // read afterwards.
    const denialProblems: Problem[] = result.denials.map((denial) => ({
      severity: 'warning',
      message: denialMessage(denial),
      rule: 'run.permissionRefused',
    }))
    for (const denial of result.denials) {
      // Written into the run's log as well as reported, because a warning in
      // an outcome reaches nothing that persists: the board reads the database.
      // Against the run rather than a step — `run_logs.step_id` is nullable for
      // exactly this, "output the run produced outside any step".
      this.#runs.append({
        runId: run.id,
        stream: 'stderr',
        text: `${denialMessage(denial)}\n`,
      })
      this.#events?.emit('permission.requested', {
        runId: run.id,
        taskId: task.id,
        id: denial.id,
        describe: denial.describe,
        ...(denial.path === undefined ? {} : { path: denial.path }),
      })
    }

    const problems = [...result.problems, ...evidenceProblems, ...denialProblems]
    const detail = summarise(result.problems, '')

    switch (result.status) {
      case 'completed': {
        this.#runs.finish(run.id, 'completed')
        // Only a completed workflow earns its flags. A run that failed halfway
        // may well have created the worktree it promised, but nothing here knows
        // that, and claiming a flag that is not true is worse than re-running.
        if (plan.provides.length > 0 || plan.clears.length > 0) {
          this.#tasks.changeFlags(task.id, { set: plan.provides, clear: plan.clears })
        }

        // A loop repeats the workflow it is on rather than moving to the next
        // one, so the task goes back to the queue with its place kept and a
        // time before which the scheduler leaves it alone.
        //
        // Unless it has done its repeats. The count is *derived* — completed
        // runs of this workflow position — rather than kept in a column: a
        // counter would be a second copy of something the runs already say, and
        // the two would disagree the first time a run was deleted or replayed.
        if (plan.mode === 'loop' && !isRecovery && !this.#loopIsDone(task, plan, run)) {
          const seconds = plan.interval ?? DEFAULT_LOOP_INTERVAL_SECONDS
          move('idle', {
            until: new Date(this.#now().getTime() + seconds * 1000).toISOString(),
          })
          return { run: this.#runs.get(run.id) as Run, stop: 'idle', problems }
        }

        return { run: this.#runs.get(run.id) as Run, stop: 'finished', problems }
      }

      case 'declined': {
        // Everything before the gate has run; continue after it when approved.
        const resumeFrom = plan.phases.length - result.skipped.length
        this.#runs.pause(run.id, resumeFrom, detail === '' ? undefined : detail)
        move('await_approval')
        return { run: this.#runs.get(run.id) as Run, stop: 'paused', problems }
      }

      default: {
        const state = result.status === 'timed-out' ? 'timed-out' : 'failed'
        const reason = detail === '' ? `"${workflow}" ${state}.` : detail
        this.#recordSkipped(run.id, plan, result)

        // A run that failed *and* was refused something gets parked rather than
        // blocked. It was going to stop either way; pausing it is strictly
        // better — the run keeps its place, the person is told what was
        // refused, and approving continues from the failing phase rather than
        // from the beginning.
        //
        // Only when it failed. A run that was refused something and still
        // exited 0 is left alone: interrupting it would be wrong, because the
        // work that mattered may well be done, and not interrupting is the
        // entire point of the Default profile. It is reported either way.
        if (result.denials.length > 0) {
          const resumeFrom = Math.max(plan.phases.length - result.skipped.length - 1, 0)
          this.#runs.pause(run.id, resumeFrom, reason)
          move('await_approval')
          return { run: this.#runs.get(run.id) as Run, stop: 'paused', problems }
        }

        this.#runs.finish(run.id, result.status === 'refused' ? 'refused' : state, {
          detail: reason,
        })

        // Recovery runs before the task is blocked, so whoever opens the task
        // finds the diagnosis already written rather than a failure and a
        // suggestion to go and look.
        if (!isRecovery && plan.onFail !== undefined) {
          const failure: FailureContext = {
            workflow,
            ...(result.steps.at(-1)?.phase === undefined
              ? {}
              : { phase: result.steps.at(-1)?.phase as string }),
            reason,
          }
          await this.#runOne({
            task,
            entry,
            workflow: plan.onFail,
            resuming: undefined,
            recovery: failure,
          })
        }

        move('block', { reason })
        return { run: this.#runs.get(run.id) as Run, stop: 'blocked', problems }
      }
    }
  }

  /**
   * Make the directories the agents were told to write into.
   *
   * Including `versions/`, so the copy taken afterwards has somewhere to land
   * without a second mkdir at the moment it matters. Failing here is reported
   * by the missing-artifact warning later rather than stopping the run: a
   * read-only checkout should not make a workflow un-runnable.
   */
  #prepareArtifacts(plan: ResolvedPlan): void {
    for (const step of plan.phases.flatMap((phase) => phase.steps)) {
      if (step.artifact === undefined) continue
      try {
        mkdirSync(join(dirname(step.artifact.path), 'versions'), { recursive: true })
        this.#ignoreProductOutput(step.artifact.path)
      } catch {
        // Said later, by the warning that names the file that is not there.
      }
    }
  }

  /**
   * Keep a run's output out of `git status`.
   *
   * A repository that grows a diff every time an agent thinks is a repository
   * nobody wants. Written once, next to the directory it is about, and never
   * touched again if it is already there — it is the user's file the moment it
   * exists.
   *
   * The **narrow** body, not the one `createScope` writes. This fires for a
   * directory Factory did not create: one from before it wrote an ignore file
   * at all, or one somebody has already shared. Hiding the whole directory
   * there would hide a team's next workflow from `git status` while leaving
   * the ones already committed in plain sight — the half-state
   * `doctor.definitionsIgnored` exists to catch.
   */
  #ignoreProductOutput(artifactPath: string): void {
    const family = artifactPath.indexOf(`${sep}${PRODUCT_FAMILY_DIR}${sep}`)
    if (family === -1) return
    const file = join(artifactPath.slice(0, family), PRODUCT_FAMILY_DIR, '.gitignore')
    if (existsSync(file)) return
    writeFileSync(file, IGNORE_WHAT_RUNS_PRODUCE)
  }

  /**
   * Copy what each step promised into the run, and keep a dated copy of it.
   *
   * Two copies, for two different reasons. `versions/` is the history — every
   * run's output, so a rerun can be compared with what it replaced — and the
   * row in the database is what the board reads, kept because the file is
   * gitignored and deletable while the record of a decision should not be.
   *
   * A step that declared an artifact and produced nothing gets a row saying so
   * and a warning. Not a failure — plenty of artifacts are legitimately
   * optional — but never silence, which is what the prototype had.
   */
  /**
   * Whether a bounded loop has run as many times as it was asked to.
   *
   * Counts completed runs at this workflow position, which includes the one
   * that has just finished — so `repeat: 1` runs once, not twice. A loop with
   * no `repeat` is never done: it goes round until a person stops it, which is
   * what a loop meant before this existed.
   */
  #loopIsDone(task: Task, plan: ResolvedPlan, run: Run): boolean {
    if (plan.repeat === undefined) return false
    const done = this.#runs
      .forTask(task.id)
      .filter(
        (candidate) =>
          candidate.entryId === run.entryId &&
          // A recovery run is stamped with the entry of the workflow that
          // failed, so without this its completion counts as an iteration of
          // a loop it was never part of.
          candidate.workflow === run.workflow &&
          candidate.state === 'completed',
      ).length
    return done >= plan.repeat
  }

  #collectEvidence(runId: string, plan: ResolvedPlan, result: RunResult): Problem[] {
    // What actually ran. `result.skipped` is phase-granular, and a step can be
    // the one a phase stopped at, so the outcomes are the honest source.
    const ran = new Set(result.steps.map((outcome) => `${outcome.phase}#${outcome.index}`))
    const stamp = fileStamp(this.#now())
    const problems: Problem[] = []

    for (const phase of plan.phases) {
      for (const step of phase.steps) {
        const artifact = step.artifact
        if (artifact === undefined) continue
        if (!ran.has(`${phase.name}#${step.index}`)) continue

        try {
          const size = statSync(artifact.path).size
          const raw = readFileSync(artifact.path)
          // A NUL byte means this is not text. The row still records that the
          // file exists and how big it is; storing mojibake would help nobody.
          const binary = raw.includes(0)

          // The dated copy first: if writing it fails, the evidence row should
          // still be recorded rather than the whole artifact going unnoticed.
          try {
            writeFileSync(
              join(dirname(artifact.path), 'versions', `${artifact.name}-${stamp}.md`),
              raw,
            )
          } catch {
            // The history is a convenience; the evidence is the record.
          }

          this.#runs.attachEvidence({
            runId,
            phase: phase.name,
            name: artifact.name,
            path: artifact.path,
            bytes: size,
            ...(binary ? {} : { content: raw.toString('utf8') }),
          })
        } catch {
          this.#runs.attachEvidence({
            runId,
            phase: phase.name,
            name: artifact.name,
            path: artifact.path,
            missing: true,
          })
          problems.push({
            severity: 'warning',
            message:
              `A step in "${phase.name}" promised the artifact "${artifact.name}", but there is ` +
              `nothing at ${artifact.path}.`,
            rule: 'run.artifactMissing',
          })
        }
      }
    }
    return problems
  }

  /** Phases the run never reached, so the timeline shows what did not happen. */
  #recordSkipped(runId: string, plan: ResolvedPlan, result: RunResult): void {
    const skipped = new Set(result.skipped)
    for (const phase of plan.phases) {
      if (!skipped.has(phase.name)) continue
      for (const step of phase.steps) {
        this.#runs.skipStep(
          runId,
          {
            phase: phase.name,
            index: step.index,
            describe: step.planned.describe,
            uses: step.uses,
          },
          'An earlier step stopped the run.',
        )
      }
    }
  }

  #require(id: string): Task {
    const task = this.#tasks.get(id)
    if (task === undefined) throw new Error(`No task ${id}.`)
    return task
  }
}

const stepStateOf = (exitCode: number | null, timedOut: boolean): StepState => {
  if (timedOut) return 'timed-out'
  return exitCode === 0 ? 'completed' : 'failed'
}

/** The first error, or the first problem of any kind, in a sentence. */
function summarise(problems: readonly Problem[], fallback: string): string {
  const error = problems.find((problem) => problem.severity === 'error') ?? problems[0]
  return error?.message ?? fallback
}

export { isRunFinished }

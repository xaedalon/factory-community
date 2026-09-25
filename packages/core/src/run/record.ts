import type { ExecutionProfile } from '../security/profile.js'

/**
 * What a run is, once it is something that outlives the process that ran it.
 *
 * `runner.ts` runs a plan in the foreground and returns a result; this is the
 * shape that result takes when it is written down, read by the board, served by
 * the API and looked at three days later. The vocabulary lives in core so the
 * store, the daemon and the web app all spell the same states the same way —
 * the prototype had `failed`, `error` and `ko` in different layers for the same
 * thing, and every query had to know about all three.
 */

/** Where a run got to. */
export const RUN_STATES = [
  /** In progress. The only state a crash can leave behind, which is what boot reconciliation looks for. */
  'running',
  /** Stopped at an approval gate, waiting for a person. Resumable. */
  'paused',
  'completed',
  'failed',
  /** A step hit its deadline and was killed. */
  'timed-out',
  /** Someone said no at an approval gate. */
  'declined',
  /** Stopped deliberately. */
  'cancelled',
  /** Never started: the plan asked for something this build cannot do. */
  'refused',
] as const

export type RunState = (typeof RUN_STATES)[number]

/** Where a single step got to. */
export const STEP_STATES = ['running', 'completed', 'failed', 'timed-out', 'skipped'] as const

export type StepState = (typeof STEP_STATES)[number]

/**
 * Nothing further will happen to this run on its own.
 *
 * A paused run counts as unfinished: it is waiting for a person, and finishing
 * it behind their back would throw away the work it is holding.
 */
export const isRunFinished = (state: RunState): boolean =>
  state !== 'running' && state !== 'paused'

/** A run finished the way its author hoped. */
export const isRunSuccessful = (state: RunState): boolean => state === 'completed'

export interface Run {
  readonly id: string
  /** The task this run is for. Absent for `factory run`, which needs no task. */
  readonly taskId?: string
  readonly workflow: string
  readonly state: RunState
  /** Which pass this is, for a workflow that loops. First is 1. */
  readonly attempt: number
  /** Which of the task's workflows this run is, so a resume knows what follows. */
  readonly workflowIndex: number
  /**
   * Which entry of the task's list this run was for.
   *
   * Absent on runs recorded before entries existed, and on a `factory run`
   * that has no task at all. Position moves when a list is reordered; this
   * does not, which is what a resumed run and a loop's own count depend on.
   */
  readonly entryId?: string
  /** Phase to continue from when a paused run is resumed. */
  readonly resumePhase?: number
  /**
   * How much authority this run was given.
   *
   * Recorded rather than derived. Deriving it later would read today's project
   * setting and describe a run that happened under a different one — the same
   * trap `session_provider` was added to avoid. Absent for a run from before
   * profiles existed, because nothing knew.
   */
  readonly profile?: ExecutionProfile
  /**
   * The run whose agent asked for this work, when an agent did.
   *
   * Absent for anything a person started, which is every run recorded before
   * Factory served MCP. No foreign key behind it, deliberately: a lineage
   * pointer that could cascade would let a tidy-up of one finished run delete
   * the record of everything it started.
   */
  readonly originRunId?: string
  /** How far from the person who started all this. 0 when they started it. */
  readonly depth: number
  readonly startedAt: string
  readonly finishedAt?: string
  /** Why it ended the way it did, when that needs saying. */
  readonly detail?: string
}

export interface RunStep {
  readonly id: number
  readonly runId: string
  readonly phase: string
  /** Position within the phase, as the plan numbered it. */
  readonly index: number
  /** What the step said it would do, in a person's words. */
  readonly describe: string
  /** The registered step kind that ran it. */
  readonly uses: string
  /**
   * What it actually ran, as a line somebody could paste.
   *
   * Recorded rather than derived: "what did this agent run?" has to be
   * answerable after the phase file has been edited, which is the same trap
   * `runs.profile` and `session_provider` were recorded to avoid. The
   * environment is deliberately not here — it is where the secrets are, and
   * the profile already records how much of it the step could see.
   *
   * Absent for a step that ran no process, and for every step recorded before
   * this existed.
   */
  readonly command?: string
  readonly state: StepState
  /** Times it ran. More than one means it was retried. */
  readonly attempts: number
  readonly exitCode?: number
  readonly startedAt: string
  readonly finishedAt?: string
  readonly detail?: string
}

export type LogStream = 'stdout' | 'stderr'

export interface LogLine {
  readonly at: string
  readonly stream: LogStream
  readonly text: string
}

export interface LogView {
  readonly lines: readonly LogLine[]
  /** Bytes kept out to stay inside the budget. Zero when nothing was dropped. */
  readonly dropped: number
}

/**
 * Something a phase produced, kept so a decision can be justified later.
 *
 * An agent step declares `artifact: analysis`; whatever is at the path Factory
 * told it to write is copied here when the run ends. A copy rather than a
 * reference because the file is gitignored and deletable, while the record of
 * a decision should outlive it.
 */
export interface Evidence {
  readonly id: number
  readonly runId: string
  /** The phase the step was in. For display; the name is the identity. */
  readonly phase: string
  /** What the step called it — `analysis` for `analysis.md`. */
  readonly name: string
  /** Where the file was, so a person can open the original if it is still there. */
  readonly path: string
  /** Absent when the file was missing, or when it did not look like text. */
  readonly content?: string
  /** Size on disk. */
  readonly bytes: number
  readonly truncated: boolean
  /** The step promised an artifact and did not produce one. */
  readonly missing: boolean
  readonly collectedAt: string
}

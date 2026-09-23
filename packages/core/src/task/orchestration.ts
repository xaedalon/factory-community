import type { TaskAction } from './state.js'

/**
 * Who asked for a piece of work, and what that is allowed to mean.
 *
 * Until Factory served MCP, everything that could start work was a person: one
 * at the board, one at a terminal. An agent Factory launched can reach the
 * daemon too — it is on 127.0.0.1, there is no authentication, and `FACTORY_URL`
 * is not credential-shaped so it survives the environment filter. Serving MCP
 * does not create that reach; it makes it ergonomic, and an ergonomic way to
 * start work from inside work is a way to start work from inside *that*.
 *
 * So: bounded, and bounded here rather than in whichever client is asking. The
 * disclaimer gate settled that argument once — "a disclaimer only the web app
 * enforces is advice rather than a gate" — and a recursion limit only the MCP
 * server enforced would be advice too, with `curl` as the exception.
 *
 * These are pure rules over facts somebody else looks up, for the reason
 * `dependencyStatus` takes a lookup: the interesting cases are a tree six deep
 * and a cycle in a corrupted database, and neither is a thing to build out of
 * real runs to find out what happens.
 */

/**
 * Where a request came from.
 *
 * `label` is self-reported — it is what an MCP client called itself, and it is
 * used for a line in a history and nothing else. `runId` and `taskId` are not:
 * they come from the environment Factory stamped into the agent process it
 * launched, so a client cannot claim a position in the tree it does not have.
 * It can *omit* them, which makes it look like a person, and that is the
 * direction that loses authority rather than gains it.
 */
export interface Initiator {
  readonly label?: string
  readonly runId?: string
  readonly taskId?: string
}

export interface OrchestrationLimits {
  /** How far work may be started from inside work. 0 means only people may start it. */
  readonly maxDepth: number
  /** How many tasks one run's agent may ask for. */
  readonly maxTasksPerRun: number
}

/**
 * Three deep and ten wide.
 *
 * Deep enough for the shape this is for — somebody delegates, that work
 * delegates its verification, and that stops — and shallow enough that a
 * runaway is over in seconds rather than after an afternoon of agents.
 */
export const DEFAULT_ORCHESTRATION_LIMITS: OrchestrationLimits = {
  maxDepth: 3,
  maxTasksPerRun: 10,
}

/** What the rules need to know, asked rather than reached for. */
export interface OrchestrationFacts {
  /** How deep a run is, or nothing when there is no such run. */
  depthOf(runId: string): number | undefined
  /** How many tasks that run's agent has already asked for. */
  tasksCreatedBy(runId: string): number
  /** Which run asked for this task, when it was not a person. */
  creatorOf(taskId: string): string | undefined
  /** The run a run came from, for walking upwards. */
  originOf(runId: string): string | undefined
}

export const ORCHESTRATION_REFUSALS = [
  'RECURSION_LIMIT',
  'FAN_OUT_LIMIT',
  'SELF_ORCHESTRATION_BLOCKED',
  'APPROVAL_SEPARATION',
] as const

export type OrchestrationRefusalCode = (typeof ORCHESTRATION_REFUSALS)[number]

export interface OrchestrationRefusal {
  readonly code: OrchestrationRefusalCode
  /** A sentence for whoever reads it, which is usually a program. */
  readonly message: string
}

export const isRefusal = (
  outcome: OrchestrationRefusal | { depth: number } | undefined,
): outcome is OrchestrationRefusal => outcome !== undefined && 'code' in outcome

/**
 * May this initiator ask for another task, and how deep would its run be?
 *
 * A request with no run behind it is a person, and a person is depth 0 with no
 * limit to reach. Everything else is one deeper than the run it came from.
 *
 * Refusing changes nothing that is already running, deliberately: the work in
 * flight is somebody's, and stopping it because its agent asked for one task
 * too many would punish the wrong thing.
 */
export function admitTask(options: {
  readonly initiator?: Initiator | undefined
  readonly limits: OrchestrationLimits
  readonly facts: OrchestrationFacts
}): { readonly depth: number } | OrchestrationRefusal {
  const from = options.initiator?.runId
  if (from === undefined) return { depth: 0 }

  const depth = (options.facts.depthOf(from) ?? 0) + 1
  if (depth > options.limits.maxDepth) {
    return {
      code: 'RECURSION_LIMIT',
      message:
        `This would be ${depth} levels of work starting work, and Factory allows ` +
        `${options.limits.maxDepth}. Do this one yourself, or ask a person to start it.`,
    }
  }

  const already = options.facts.tasksCreatedBy(from)
  if (already >= options.limits.maxTasksPerRun) {
    return {
      code: 'FAN_OUT_LIMIT',
      message:
        `This run has already asked for ${already} tasks, which is the limit. ` +
        `Finish or cancel some before asking for more.`,
    }
  }
  return { depth }
}

/**
 * How far this run is from the person who started the whole thing.
 *
 * Walked rather than stored on the task, because a run is where depth belongs:
 * a task can be retried, moved and re-queued, and the answer has to be about
 * this attempt.
 */
export function depthFor(createdByRunId: string | undefined, facts: OrchestrationFacts): number {
  if (createdByRunId === undefined) return 0
  return (facts.depthOf(createdByRunId) ?? 0) + 1
}

/** Every run this one descends from, nearest first. */
export function ancestry(runId: string, facts: OrchestrationFacts): string[] {
  const chain: string[] = []
  const seen = new Set<string>()
  let current: string | undefined = runId
  // A cycle here means a hand-edited database, and the alternative to guarding
  // it is a daemon that hangs on one request for ever.
  while (current !== undefined && !seen.has(current)) {
    seen.add(current)
    chain.push(current)
    current = facts.originOf(current)
  }
  return chain
}

/**
 * May this initiator ask for this action on this task?
 *
 * Two rules, and both are about an agent and its own work.
 *
 * An agent may not act on the task it is running inside. Queueing it again,
 * cancelling it or approving it are all ways of reaching around the run it is
 * in, and the mildest outcome is a deadlock nobody can see. Deterministic, not
 * a heuristic: the task id came from the environment Factory stamped.
 *
 * And an agent may not approve work its own branch of the tree asked for. That
 * is the one rule this whole model exists for — an agent that could approve the
 * escalation it requested has no gate at all, only a delay.
 */
export function admitAction(options: {
  readonly initiator?: Initiator | undefined
  readonly action: TaskAction
  readonly taskId: string
  readonly facts: OrchestrationFacts
}): OrchestrationRefusal | undefined {
  const { initiator, action, taskId, facts } = options
  if (initiator === undefined) return undefined

  if (initiator.taskId === taskId) {
    return {
      code: 'SELF_ORCHESTRATION_BLOCKED',
      message:
        `This is the task you are running inside. You cannot ${action} it from within it. ` +
        `Finish the work, or create a separate task for what you want done.`,
    }
  }

  if (action !== 'approve') return undefined
  if (initiator.runId === undefined) return undefined

  const creator = facts.creatorOf(taskId)
  if (creator === undefined) return undefined
  if (!ancestry(initiator.runId, facts).includes(creator)) return undefined

  return {
    code: 'APPROVAL_SEPARATION',
    message:
      'This work was asked for by the run you are part of, so you cannot approve it. ' +
      'An approval an agent can give itself is not a gate. A person has to decide this one.',
  }
}

/**
 * An initiator as a client sent it.
 *
 * Deliberately forgiving about absence and strict about shape. A client that
 * sends nothing is a person, which is the reading that grants the least; a
 * client that sends rubbish is refused rather than half-read, because a
 * half-read initiator is one whose `taskId` went missing and whose
 * self-orchestration guard therefore did nothing.
 *
 * The label is capped. It is written into a row and shown to people, and
 * nothing that arrives over a socket gets to decide how long a column is.
 */
export const MAX_INITIATOR_LABEL = 120

export function parseInitiator(value: unknown): Initiator | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('`initiator` is an object with an optional label, runId and taskId.')
  }
  const given = value as Record<string, unknown>
  const text = (name: string): string | undefined => {
    const found = given[name]
    if (found === undefined || found === null) return undefined
    if (typeof found !== 'string' || found.trim() === '') {
      throw new Error(`\`initiator.${name}\` is a non-empty string when it is there at all.`)
    }
    return found.trim()
  }
  const label = text('label')
  const runId = text('runId')
  const taskId = text('taskId')
  if (label === undefined && runId === undefined && taskId === undefined) return undefined
  return {
    ...(label === undefined ? {} : { label: label.slice(0, MAX_INITIATOR_LABEL) }),
    ...(runId === undefined ? {} : { runId }),
    ...(taskId === undefined ? {} : { taskId }),
  }
}

import {
  ACTIVE_DRIVER_STATUSES,
  DRIVER_OWNERS,
  type AttentionSummary,
  type DriverOwner,
  type DriverSeverity,
  type DriverStatus,
  type ReliabilityCap,
  type ReliabilityDriver,
} from './model.js'
import { applyCaps, clampScore, roundScore } from './score.js'

/**
 * What happens to a driver, and who is allowed to make it happen.
 *
 * Drivers are the part of Reliability that is actually worth having. The score
 * is a summary; a driver is a thing somebody can do something about, with a
 * name, a size and an owner. So the lifecycle is a table — one place that says
 * which move is legal from where — for the reason `task/state.ts` has one: a
 * transition allowed in two places is a transition that disagrees with itself.
 */

/** What can be done to a driver. */
export const DRIVER_ACTIONS = [
  'investigate',
  'resolve',
  'accept',
  'invalidate',
  'supersede',
  'reopen',
] as const
export type DriverAction = (typeof DRIVER_ACTIONS)[number]

interface Move {
  readonly from: readonly DriverStatus[]
  readonly to: DriverStatus
  readonly label: string
  /**
   * True when a person must be the one asking.
   *
   * Only acceptance, and only for the severities that matter — see
   * `requiresHumanAcceptance`. An agent accepting its own critical finding is
   * the same hole as an agent approving its own work, and it is closed the same
   * way.
   */
  readonly humanOnly?: boolean
}

/**
 * The one transition table.
 *
 * `resolved` means the thing is no longer true. `accepted` means it is still
 * true and somebody decided to live with it — a different fact, recorded
 * differently. `invalidated` means it was never true. `superseded` means a
 * later driver replaced it, which is how a correction happens without
 * rewriting anything.
 */
export const DRIVER_MOVES: Record<DriverAction, Move> = {
  investigate: {
    from: ['open'],
    to: 'investigating',
    label: 'Investigate',
  },
  resolve: {
    from: ['open', 'investigating'],
    to: 'resolved',
    label: 'Resolve',
  },
  accept: {
    from: ['open', 'investigating'],
    to: 'accepted',
    label: 'Accept the risk',
    humanOnly: true,
  },
  invalidate: {
    from: ['open', 'investigating'],
    to: 'invalidated',
    label: 'Not actually true',
  },
  supersede: {
    from: ['open', 'investigating', 'resolved', 'accepted'],
    to: 'superseded',
    label: 'Replaced by a later finding',
  },
  // A resolution that turns out not to have held. Deliberately possible from
  // `resolved` and not from `accepted`: reopening an accepted risk means
  // overriding somebody's decision, which is a new finding rather than a state
  // change on the old one.
  reopen: {
    from: ['resolved', 'invalidated'],
    to: 'open',
    label: 'Reopen',
  },
}

/** Which moves a driver in this state will accept. */
export function driverActions(status: DriverStatus): readonly DriverAction[] {
  return DRIVER_ACTIONS.filter((action) => DRIVER_MOVES[action].from.includes(status))
}

/**
 * Whether accepting this risk needs a person.
 *
 * `critical` and `high` do. An acceptance an agent can grant itself is not a
 * gate, and these are exactly the two severities where that matters —
 * accepting a `low` finding is housekeeping, accepting a `critical` one is a
 * decision somebody should be able to point at afterwards.
 */
export function requiresHumanAcceptance(severity: DriverSeverity): boolean {
  return severity === 'critical' || severity === 'high'
}

export interface DriverTransitionRefusal {
  readonly code: 'NOT_AVAILABLE' | 'HUMAN_REQUIRED'
  readonly message: string
  /** What it would accept instead, so a caller need not guess. */
  readonly actions: readonly DriverAction[]
}

export interface DriverTransition {
  readonly status: DriverStatus
  readonly label: string
}

/**
 * Whether a move is legal, and why not when it is not.
 *
 * Takes `byAgent` rather than reading an environment, because the rule is about
 * authority and authority is established by the caller. The daemon knows
 * whether the request carried a run Factory stamped; this only knows what it
 * means.
 */
export function moveDriver(
  driver: Pick<ReliabilityDriver, 'status' | 'severity'>,
  action: DriverAction,
  options: { byAgent?: boolean } = {},
): DriverTransition | DriverTransitionRefusal {
  const move = DRIVER_MOVES[action]
  const available = driverActions(driver.status)
  if (!move.from.includes(driver.status)) {
    return {
      code: 'NOT_AVAILABLE',
      message: `Cannot ${action} a driver that is ${driver.status}.`,
      actions: available,
    }
  }
  if (move.humanOnly === true && options.byAgent === true && requiresHumanAcceptance(driver.severity)) {
    return {
      code: 'HUMAN_REQUIRED',
      message:
        `Accepting a ${driver.severity} risk is a person's decision. ` +
        'An acceptance an agent can grant itself is not a gate.',
      actions: available.filter((candidate) => candidate !== 'accept'),
    }
  }
  return { status: move.to, label: move.label }
}

// ---------------------------------------------------------------- ordering

const SEVERITY_RANK: Record<DriverSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
}

/**
 * The order a person should read them in.
 *
 * Severity first, then how much it costs, then oldest first. **Not
 * chronological**, which is the order a list naturally arrives in and the order
 * that buries the critical finding under four notes about naming.
 */
export function bySeverityThenImpact(
  a: ReliabilityDriver,
  b: ReliabilityDriver,
): number {
  const rank = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
  if (rank !== 0) return rank
  const impact = Math.abs(b.scoreImpact) - Math.abs(a.scoreImpact)
  if (impact !== 0) return impact
  return a.createdAt.localeCompare(b.createdAt)
}

/** The ones still weighing on the score and still wanting somebody. */
export function activeDrivers(
  drivers: readonly ReliabilityDriver[],
): readonly ReliabilityDriver[] {
  return drivers.filter((driver) => ACTIVE_DRIVER_STATUSES.includes(driver.status))
}

// ---------------------------------------------------------------- attention

/**
 * What the score could reach if these drivers stopped applying.
 *
 * An estimate and said to be one. Resolving a driver gives back its impact and
 * may lift a cap, and neither is a promise — the work of resolving it usually
 * produces new evidence, which moves the dimensions too.
 */
export function potentialScore(
  current: number,
  resolving: readonly ReliabilityDriver[],
  remaining: readonly ReliabilityDriver[],
  policyCaps: readonly ReliabilityCap[],
  capsFor: (drivers: readonly ReliabilityDriver[]) => readonly ReliabilityCap[],
): number {
  const given = resolving.reduce((sum, driver) => sum - driver.scoreImpact, 0)
  const capsAfter = capsFor(remaining)
  void policyCaps
  return roundScore(applyCaps(clampScore(current + given), capsAfter))
}

/**
 * Unresolved uncertainty, counted by who can do something about it.
 *
 * The number that matters is `developer`: it is the only one Factory cannot
 * work through on its own, and the product question this feature answers is
 * *what can Factory keep going on without me?*
 */
export function attentionSummary(
  drivers: readonly ReliabilityDriver[],
  current: number,
  capsFor: (drivers: readonly ReliabilityDriver[]) => readonly ReliabilityCap[],
): AttentionSummary {
  const active = activeDrivers(drivers)
  const counts = Object.fromEntries(
    DRIVER_OWNERS.map((owner) => [owner, active.filter((d) => d.owner === owner).length]),
  ) as Record<DriverOwner, number>

  const potential = Object.fromEntries(
    DRIVER_OWNERS.map((owner) => {
      const theirs = active.filter((driver) => driver.owner === owner)
      const rest = drivers.filter((driver) => !theirs.includes(driver))
      return [owner, potentialScore(current, theirs, rest, [], capsFor)]
    }),
  ) as Record<DriverOwner, number>

  return { ...counts, potential }
}

// ---------------------------------------------------------------- next actions

export interface NextAction {
  readonly driverId: string
  readonly title: string
  readonly owner: DriverOwner
  readonly severity: DriverSeverity
  /** How far the score could move if this one resolved. An estimate. */
  readonly impact: number
  readonly actionType: string
  readonly label: string
  /** Present only when the recommendation is a workflow this project has. */
  readonly workflow?: string
}

/**
 * What to do next, highest value first.
 *
 * A recommendation to run a workflow the project does not have is worse than no
 * recommendation, so `availableWorkflows` is consulted and a driver whose named
 * workflow is missing is offered as an investigation instead. Drivers with no
 * recommended action at all still appear — knowing that the highest-impact
 * uncertainty has no obvious next step is itself worth knowing.
 */
export function nextActions(
  drivers: readonly ReliabilityDriver[],
  current: number,
  capsFor: (drivers: readonly ReliabilityDriver[]) => readonly ReliabilityCap[],
  availableWorkflows: readonly string[] = [],
  limit = 5,
): readonly NextAction[] {
  const available = new Set(availableWorkflows)
  return activeDrivers(drivers)
    .slice()
    .sort(bySeverityThenImpact)
    .map((driver) => {
      const rest = drivers.filter((candidate) => candidate.id !== driver.id)
      const gain = roundScore(potentialScore(current, [driver], rest, [], capsFor) - current)
      const recommended = driver.recommendedAction
      const runnable =
        recommended?.type === 'workflow' &&
        recommended.workflow !== undefined &&
        available.has(recommended.workflow)

      // A recommendation Factory cannot act on is not a recommendation. A
      // workflow type whose workflow the project does not have falls all the
      // way back rather than keeping the type and losing the name — otherwise
      // the board draws a Run button with nothing behind it.
      const usable =
        recommended !== undefined && (recommended.type !== 'workflow' || runnable)

      return {
        driverId: driver.id,
        title: driver.title,
        owner: driver.owner,
        severity: driver.severity,
        impact: gain,
        actionType: usable ? recommended.type : fallbackAction(driver.owner),
        label: usable ? recommended.label : fallbackLabel(driver),
        ...(runnable && recommended?.workflow !== undefined
          ? { workflow: recommended.workflow }
          : {}),
      }
    })
    .sort((a, b) => b.impact - a.impact)
    .slice(0, limit)
}

/** What to suggest when the driver itself suggested nothing usable. */
function fallbackAction(owner: DriverOwner): string {
  if (owner === 'developer') return 'developer_decision'
  if (owner === 'external') return 'external_research'
  return 'agent_investigation'
}

function fallbackLabel(driver: ReliabilityDriver): string {
  if (driver.owner === 'developer') return `Decide: ${driver.title}`
  if (driver.owner === 'external') return `Find out: ${driver.title}`
  return `Investigate: ${driver.title}`
}

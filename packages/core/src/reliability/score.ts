import {
  ACTIVE_DRIVER_STATUSES,
  RELIABILITY_DIMENSIONS,
  type DeltaCause,
  type DimensionContribution,
  type DimensionScores,
  type Observation,
  type ReliabilityCap,
  type ReliabilityDriver,
  type ReliabilityExplanation,
} from './model.js'
import { capForSeverity, type ReliabilityPolicy } from './policy.js'

/**
 * The arithmetic, and only the arithmetic.
 *
 * Pure functions over values somebody else looked up. Nothing here reads a
 * database, asks a provider or knows what time it is, which is what lets the
 * hard cases be written down rather than reproduced: a critical driver capping
 * a 96, a validation that lowers the score while raising coverage, a delta
 * explained by two causes pulling opposite ways.
 *
 * The rule this file exists to enforce is that **no evaluator ever sets a
 * score**. An evaluator proposes dimension assessments and drivers; everything
 * below turns those into a number, the same way every time.
 */

/** Keeps a number inside 0–100 and free of surprises. */
export function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, value))
}

/** Rounded the way every score here is rounded, so two paths cannot disagree. */
export function roundScore(value: number): number {
  return round1(clampScore(value))
}

/**
 * One decimal place, without the clamp.
 *
 * A delta is signed and can exceed 100 in either direction, so it cannot go
 * through `roundScore` — but it is read by the same people and has to be as
 * tidy.
 */
export const round1 = (value: number): number => Math.round(value * 10) / 10

/**
 * The weighted average, and the line-by-line sum behind it.
 *
 * Returned together on purpose. "Why 95?" has to be answerable, and an answer
 * assembled later from the same inputs is a second implementation of this
 * function — the kind where the wrong one is the one nobody reads.
 */
export function rawScore(
  dimensions: DimensionScores,
  policy: ReliabilityPolicy,
): { score: number; contributions: readonly DimensionContribution[] } {
  const contributions = RELIABILITY_DIMENSIONS.map((dimension) => {
    const score = clampScore(dimensions[dimension])
    const weight = policy.weights[dimension]
    return {
      dimension,
      score,
      weight,
      contribution: Math.round(((score * weight) / 100) * 100) / 100,
    }
  })
  const total = contributions.reduce((sum, entry) => sum + (entry.score * entry.weight) / 100, 0)
  // Divided by the weights actually declared rather than by 100, so a policy
  // whose weights do not total 100 produces a proportional score instead of a
  // silently deflated one. `weightsTotal` is what refuses such a policy; this
  // is what stops it being wrong in the meantime.
  const declared = contributions.reduce((sum, entry) => sum + entry.weight, 0)
  const score = declared === 0 ? 0 : roundScore((total * 100) / declared)
  return { score, contributions }
}

/**
 * Which ceilings apply, given what is still unresolved.
 *
 * Driven by the drivers rather than by a caller's opinion: a caller that could
 * choose its own caps could choose none. The only input that is not a driver is
 * `missingEvidence`, which is how "nobody verified this" becomes a cap without
 * needing somebody to have written a driver saying so.
 */
export function capsFor(
  drivers: readonly ReliabilityDriver[],
  policy: ReliabilityPolicy,
  missingEvidence: readonly string[] = [],
  observations: readonly Observation[] = [],
): readonly ReliabilityCap[] {
  const applied = new Map<string, ReliabilityCap>()
  const rule = (type: string): void => {
    if (applied.has(type)) return
    const found = policy.caps.find((candidate) => candidate.type === type)
    if (found !== undefined) applied.set(type, { ...found })
  }

  const active = drivers.filter((driver) => ACTIVE_DRIVER_STATUSES.includes(driver.status))
  for (const driver of active) {
    const bySeverity = capForSeverity(driver.severity)
    if (bySeverity !== undefined) rule(bySeverity)
    // An unresolved ambiguity about what was asked for is the one non-critical
    // finding that caps, because everything downstream of it may be solving
    // the wrong problem — a well-built answer to the wrong question does not
    // deserve a high number however well it is built.
    if (driver.type === 'requirement' && driver.severity !== 'info') {
      rule('blockingRequirementAmbiguity')
    }
  }

  // A gate that ran and failed, which is unambiguous in a way a finding is not.
  // Deliberately **not** "a regression driver exists": discovering a regression
  // and characterising it is the system working, and it already costs the score
  // through the driver's own impact. Being red right now is a different fact.
  if (observations.some((o) => o.kind === 'gate_result' && o.status === 'failed')) {
    rule('failedRequiredValidation')
  }

  const missing = new Set(missingEvidence)
  if (missing.has('implementation_exists')) rule('implementationNotExecuted')

  // A ceiling on a *finished* solution, which is the only thing it can honestly
  // mean. Applied while anything else was still outstanding it binds from the
  // moment implementation lands until somebody reviews — and through that whole
  // stretch the score stops moving, so the dimensions and the drivers become
  // invisible exactly where the work is happening. A number that does not move
  // stops being read.
  //
  // So it waits until everything outside the verification dimension is in
  // place: the solution claims to be done, and nothing independent has agreed.
  const elsewhereOutstanding = policy.expectedEvidence.some(
    (expected) => expected.dimension !== 'verification' && missing.has(expected.key),
  )
  if (missing.has('independent_review') && !elsewhereOutstanding) {
    rule('verificationNotPerformed')
  }

  return [...applied.values()]
}

/**
 * The lowest ceiling wins.
 *
 * Caps do not compound — two caps of 80 and 70 mean 70, not 56. A score that
 * fell further than any single stated reason explains would be exactly the
 * unexplained movement this subsystem exists to end.
 */
export function applyCaps(raw: number, caps: readonly ReliabilityCap[]): number {
  return caps.reduce((score, cap) => Math.min(score, clampScore(cap.value)), roundScore(raw))
}

/**
 * How much of the expected evidence is actually there.
 *
 * Weighted by what each piece is worth, not counted — otherwise an agent raises
 * coverage by writing three documents about the same thing. An observation
 * satisfies an expectation only by naming it, and only when it did not fail:
 * a test suite that ran and failed is evidence *about* the code and is not
 * evidence that the code is tested.
 */
export function coverage(
  observations: readonly Observation[],
  policy: ReliabilityPolicy,
): { percent: number; satisfied: readonly string[]; missing: readonly string[] } {
  const satisfied = new Set<string>()
  for (const observation of observations) {
    if (observation.satisfies === undefined) continue
    if (observation.status === 'failed' || observation.status === 'missing') continue
    satisfied.add(observation.satisfies)
  }

  let have = 0
  let want = 0
  const missing: string[] = []
  for (const expected of policy.expectedEvidence) {
    want += expected.weight
    if (satisfied.has(expected.key)) have += expected.weight
    else missing.push(expected.key)
  }

  return {
    percent: want === 0 ? 0 : Math.round((have / want) * 100),
    satisfied: [...satisfied],
    missing,
  }
}

/**
 * Why the score moved.
 *
 * Built from what changed between two sets of drivers rather than from the
 * difference between two numbers, because "it went down 3" is not an
 * explanation. A driver that appeared, a driver that resolved, and a cap that
 * started or stopped applying are the three things that can move it.
 */
export function deltaCauses(
  before: readonly ReliabilityDriver[],
  after: readonly ReliabilityDriver[],
  capsBefore: readonly ReliabilityCap[],
  capsAfter: readonly ReliabilityCap[],
): readonly DeltaCause[] {
  const causes: DeltaCause[] = []
  const wasActive = new Map(
    before.filter((d) => ACTIVE_DRIVER_STATUSES.includes(d.status)).map((d) => [d.id, d]),
  )
  const isActive = new Map(
    after.filter((d) => ACTIVE_DRIVER_STATUSES.includes(d.status)).map((d) => [d.id, d]),
  )

  for (const [id, driver] of isActive) {
    if (wasActive.has(id)) continue
    causes.push({ summary: driver.title, amount: driver.scoreImpact, driverId: id })
  }
  for (const [id, driver] of wasActive) {
    if (isActive.has(id)) continue
    // Resolving a risk gives its impact back, which is why a resolution shows
    // as a positive cause even though the driver's own impact is negative.
    causes.push({
      summary: `Resolved: ${driver.title}`,
      amount: -driver.scoreImpact,
      driverId: id,
    })
  }

  // A cap's cause carries what the cap actually cost — the distance from where
  // the score would otherwise have landed down to the ceiling. A cause of `0`
  // beside a twelve-point drop is the unexplained movement this exists to end,
  // and it is what the first version of this function produced.
  const had = new Set(capsBefore.map((cap) => cap.type))
  const has = new Set(capsAfter.map((cap) => cap.type))
  const ceiling = (caps: readonly ReliabilityCap[]): number =>
    caps.reduce((lowest, cap) => Math.min(lowest, cap.value), 100)
  const floorBefore = ceiling(capsBefore)
  const floorAfter = ceiling(capsAfter)

  for (const cap of capsAfter) {
    if (had.has(cap.type)) continue
    // Only the cap that is actually binding cost anything; a ceiling above the
    // binding one changed nothing and says so.
    const cost = cap.value === floorAfter ? roundScore(floorAfter) - roundScore(floorBefore) : 0
    causes.push({ summary: cap.reason, amount: Math.min(0, cost) })
  }
  for (const cap of capsBefore) {
    if (has.has(cap.type)) continue
    const gain = cap.value === floorBefore ? roundScore(floorAfter) - roundScore(floorBefore) : 0
    causes.push({ summary: `No longer capped: ${cap.reason}`, amount: Math.max(0, gain) })
  }

  return causes
}

/**
 * What the active findings do to the dimensions they name.
 *
 * Without this a driver's `scoreImpact` is decoration: the first version of
 * this file computed caps from drivers and the average from evidence, and the
 * impact reached nothing but the delta explanation — a field declared and
 * inert, which is the shape this codebase keeps paying for.
 *
 * It belongs on the dimension rather than on the total because that is what a
 * driver *is*: a named reason one dimension is worse than its evidence
 * suggests. Applying it to the total would make two findings in different
 * dimensions indistinguishable, and the breakdown would stop explaining the
 * number it sits under.
 *
 * Resolving a driver gives the score back, which only works because the driver
 * is what took it.
 */
export function withDriverImpacts(
  dimensions: DimensionScores,
  drivers: readonly ReliabilityDriver[],
): DimensionScores {
  const adjusted = { ...dimensions }
  for (const driver of drivers) {
    if (!ACTIVE_DRIVER_STATUSES.includes(driver.status)) continue
    adjusted[driver.dimension] = clampScore(adjusted[driver.dimension] + driver.scoreImpact)
  }
  return adjusted
}

export interface ScoreInput {
  readonly dimensions: DimensionScores
  readonly drivers: readonly ReliabilityDriver[]
  readonly observations: readonly Observation[]
  readonly policy: ReliabilityPolicy
  /** The previous assessment's state, for the delta. Absent on the first one. */
  readonly previous?: {
    readonly score: number
    readonly drivers: readonly ReliabilityDriver[]
    readonly caps: readonly ReliabilityCap[]
  }
}

export interface ScoreResult {
  readonly score: number
  readonly rawScore: number
  readonly coverage: number
  readonly delta: number
  readonly caps: readonly ReliabilityCap[]
  readonly missingEvidence: readonly string[]
  readonly explanation: ReliabilityExplanation
}

/**
 * Everything, in the one order it is ever done.
 *
 * Weights, then caps, then the delta — and the whole arithmetic carried out in
 * the result rather than recoverable from it. There is exactly one path from
 * evidence to a number, and this is it.
 */
export function score(input: ScoreInput): ScoreResult {
  // Findings first: the dimensions arrive as evidence supports them, and the
  // active drivers are the named reasons to think worse of one.
  const adjusted = withDriverImpacts(input.dimensions, input.drivers)
  const { score: raw, contributions } = rawScore(adjusted, input.policy)
  const measured = coverage(input.observations, input.policy)
  const caps = capsFor(input.drivers, input.policy, measured.missing, input.observations)
  const effective = applyCaps(raw, caps)
  const causes =
    input.previous === undefined
      ? []
      : deltaCauses(input.previous.drivers, input.drivers, input.previous.caps, caps)

  return {
    score: effective,
    rawScore: raw,
    coverage: measured.percent,
    // Rounded again after the subtraction, not only before it. Two scores each
    // rounded to one decimal, subtracted, is not a number rounded to one
    // decimal: 95 − 89.8 is 5.200000000000003, and the CLI printed exactly that
    // beside a tidy 95.
    delta: round1(roundScore(effective) - roundScore(input.previous?.score ?? 0)),
    caps,
    missingEvidence: measured.missing,
    explanation: {
      contributions,
      rawScore: raw,
      caps,
      effectiveScore: effective,
      causes,
    },
  }
}

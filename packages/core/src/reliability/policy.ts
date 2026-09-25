import {
  RELIABILITY_DIMENSIONS,
  type DriverSeverity,
  type ReliabilityDimension,
} from './model.js'

/**
 * What Factory believes about reliability before anybody configures anything.
 *
 * Zero configuration is a requirement, not a convenience: a feature that needs
 * a weights table filled in before it says anything is a feature nobody turns
 * on. So the values live here, beside the rules that read them, and the
 * settings schema references this constant rather than restating the numbers —
 * the same arrangement `DEFAULT_ORCHESTRATION_LIMITS` has, for the same reason.
 *
 * These are heuristics. They are not calibrated against outcomes and nothing
 * here should be presented as a probability. What they have to be is
 * *explainable*: every number below is one a person can disagree with, which is
 * the property a hidden model would not have.
 */

/** How much each dimension is worth. Must total 100. */
export type DimensionWeights = Record<ReliabilityDimension, number>

export interface CapRule {
  /** Names the rule, and the cap it produces. Stable — it is stored on assessments. */
  readonly type: string
  /** The highest score this cap permits. */
  readonly value: number
  readonly reason: string
}

/**
 * One thing a sufficiently verified solution would have evidence of.
 *
 * Coverage is the fraction of these that have been satisfied, weighted — not a
 * count of evidence objects, which would let an agent raise coverage by writing
 * more documents about the same thing.
 */
export interface ExpectedEvidence {
  /** Matched against `Observation.satisfies`. */
  readonly key: string
  readonly dimension: ReliabilityDimension
  readonly weight: number
  /** Shown when it is missing, so the gap is legible rather than a percentage. */
  readonly describe: string
}

export interface ReliabilityPolicy {
  readonly weights: DimensionWeights
  readonly caps: readonly CapRule[]
  readonly expectedEvidence: readonly ExpectedEvidence[]
  /**
   * How far one driver may move the score.
   *
   * The ceiling on what an evaluator can do in a single finding. Without it an
   * evaluator that returns `-80` has effectively set the score, which is the
   * one thing the architecture exists to prevent.
   */
  readonly maxDriverImpact: number
  /** The dimension score a task starts from before any evidence supports it. */
  readonly baseline: number
  /** Optional, and informational: a target is not a gate in Community. */
  readonly target?: number
}

/**
 * The weights, and the argument for them.
 *
 * Design, Implementation and Regression Safety carry the most because they are
 * where solutions actually fail — a well-understood problem solved with an
 * incompatible approach is still broken. Precedent carries the least because it
 * is the weakest form of evidence: somebody else solved something similar is
 * encouraging and proves nothing about this case.
 *
 * Verification is 15 rather than higher because it is capped separately. A
 * solution nobody verified does not need its average dragged down; it needs a
 * ceiling, which is a different and more honest instrument.
 */
export const DEFAULT_DIMENSION_WEIGHTS: DimensionWeights = {
  understanding: 15,
  precedent: 10,
  design: 20,
  implementation: 20,
  regressionSafety: 20,
  verification: 15,
}

/**
 * The ceilings, in the order they bite.
 *
 * Each says "however good the average is, not above this". They stack by taking
 * the lowest, and every one that applied is recorded on the assessment with its
 * reason — a score that dropped 26 points with no explanation would be worse
 * than no score.
 *
 * `criticalOpenDriver` is the severe one and it is meant to be: an unresolved
 * critical finding means the honest answer is "do not trust this yet",
 * whatever else went well.
 */
export const DEFAULT_CAPS: readonly CapRule[] = [
  {
    type: 'criticalOpenDriver',
    value: 70,
    reason: 'A critical risk is still open.',
  },
  {
    type: 'failedRequiredValidation',
    value: 80,
    reason: 'A validation that was expected to pass did not.',
  },
  {
    type: 'implementationNotExecuted',
    value: 85,
    reason: 'Nothing has run the implementation.',
  },
  {
    type: 'blockingRequirementAmbiguity',
    value: 85,
    reason: 'A requirement is ambiguous and nobody has resolved it.',
  },
  {
    type: 'verificationNotPerformed',
    value: 92,
    reason: 'Independent verification has not been performed.',
  },
]

/**
 * What a fully evidenced task would have.
 *
 * Deliberately modest. Every key here is something Factory can actually observe
 * — a document that exists, a command that exited zero, a gate that ran — and
 * nothing here depends on an agent's opinion of its own work. An expectation
 * Factory cannot check is an expectation that is never satisfied, which would
 * make 100% coverage unreachable and the number meaningless.
 */
export const DEFAULT_EXPECTED_EVIDENCE: readonly ExpectedEvidence[] = [
  {
    key: 'requirements_understood',
    dimension: 'understanding',
    weight: 10,
    describe: 'the problem written down',
  },
  {
    key: 'constraints_identified',
    dimension: 'understanding',
    weight: 5,
    describe: 'the constraints named',
  },
  {
    key: 'precedent_examined',
    dimension: 'precedent',
    weight: 10,
    describe: 'existing work looked at',
  },
  {
    key: 'technical_approach',
    dimension: 'design',
    weight: 12,
    describe: 'an approach written down',
  },
  {
    key: 'compatibility_considered',
    dimension: 'design',
    weight: 8,
    describe: 'compatibility considered',
  },
  {
    key: 'implementation_exists',
    dimension: 'implementation',
    weight: 12,
    describe: 'the work carried out',
  },
  {
    key: 'build_success',
    dimension: 'implementation',
    weight: 8,
    describe: 'it builds',
  },
  {
    key: 'targeted_tests',
    dimension: 'implementation',
    weight: 5,
    describe: 'tests for the change itself',
  },
  {
    key: 'regression_checks',
    dimension: 'regressionSafety',
    weight: 15,
    describe: "the project's own checks",
  },
  {
    key: 'integration_checks',
    dimension: 'regressionSafety',
    weight: 5,
    describe: 'integration checked',
  },
  {
    key: 'acceptance_criteria',
    dimension: 'verification',
    weight: 5,
    describe: 'acceptance criteria checked',
  },
  {
    key: 'independent_review',
    dimension: 'verification',
    weight: 5,
    describe: 'somebody or something else looked',
  },
]

/**
 * The starting point, and why it is not zero.
 *
 * A task nobody has assessed is `unassessed`, which is a state rather than a
 * score. But a task whose first workflow has just run has *some* evidence and
 * no evidence at all about most dimensions, and scoring those zero would say
 * "this is certainly wrong" when the truth is "nobody has looked". 60 is a
 * deliberately unremarkable number: enough that a first assessment lands in the
 * low nineties when nothing is wrong, low enough that the dimensions nobody has
 * evidenced hold the score below the range a verified solution reaches.
 */
export const DEFAULT_BASELINE = 60

/** Nothing an evaluator says may move the score more than this in one finding. */
export const DEFAULT_MAX_DRIVER_IMPACT = 15

export const DEFAULT_RELIABILITY_POLICY: ReliabilityPolicy = {
  weights: DEFAULT_DIMENSION_WEIGHTS,
  caps: DEFAULT_CAPS,
  expectedEvidence: DEFAULT_EXPECTED_EVIDENCE,
  maxDriverImpact: DEFAULT_MAX_DRIVER_IMPACT,
  baseline: DEFAULT_BASELINE,
}

/**
 * The version stamped on every assessment.
 *
 * Bumped when the weights, caps or the arithmetic change. History is never
 * recalculated under new rules — an old assessment stays interpretable because
 * it says which rules produced it.
 */
export const SCORING_MODEL_VERSION = '1.0'

/**
 * Whether the weights add up.
 *
 * Exported because both the policy loader and a scenario need it, and a second
 * implementation of "does this total 100" is exactly the kind of duplication
 * that ends with the two disagreeing.
 */
export function weightsTotal(weights: DimensionWeights): number {
  return RELIABILITY_DIMENSIONS.reduce((sum, dimension) => sum + weights[dimension], 0)
}

/**
 * Which cap a severity triggers on its own, if any.
 *
 * Only `critical` does. `high` is expensive through its score impact rather
 * than through a ceiling, because a cap that fires on every `high` finding
 * would make the number stop moving — and a number that does not move stops
 * being read.
 */
export function capForSeverity(severity: DriverSeverity): string | undefined {
  return severity === 'critical' ? 'criticalOpenDriver' : undefined
}

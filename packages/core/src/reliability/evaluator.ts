import type { Capability } from '../capabilities.js'
import {
  DRIVER_OWNERS,
  DRIVER_SEVERITIES,
  RELIABILITY_DIMENSIONS,
  type DimensionScores,
  type DriverOwner,
  type DriverSeverity,
  type Observation,
  type ReliabilityDimension,
  type ReliabilityDriver,
  type RecommendedAction,
} from './model.js'
import type { ReliabilityPolicy } from './policy.js'
import { clampScore } from './score.js'

/**
 * Where judgement is allowed to enter, and how far.
 *
 * An evaluator classifies evidence and proposes findings. It does **not**
 * return a score, and there is no field it could return one in. That is the
 * architectural rule the whole subsystem turns on: an agent asked how good its
 * own work is answers 98, every time, and a system that stores that answer has
 * built a flattery machine with a database behind it.
 *
 * So the contract is deliberately narrow — dimensions and drivers — and
 * everything that comes back through it goes through `normalize()` before
 * anything else sees it. Nothing downstream trusts an evaluator twice.
 */

export const RELIABILITY_EVALUATOR_KIND = 'reliability-evaluator'

/** What an evaluator is given. Facts, and the policy it is being judged against. */
export interface EvaluatorInput {
  readonly taskId: string
  /** The task's name and description, so judgement has something to judge against. */
  readonly task: { readonly name: string; readonly description: string }
  /** Everything seen so far, oldest first — not only this run's. */
  readonly observations: readonly Observation[]
  /** What this run added, so an evaluator can be incremental if it wants to be. */
  readonly latest: readonly Observation[]
  /** Findings that already exist, so an evaluator can resolve rather than duplicate. */
  readonly drivers: readonly ReliabilityDriver[]
  readonly policy: ReliabilityPolicy
  /** Workflows this project actually has, so a recommendation can name a real one. */
  readonly workflows: readonly string[]
}

/** One dimension, judged, with the reason attached. */
export interface DimensionAssessment {
  readonly score: number
  readonly rationale: string
}

/** A finding, as an evaluator proposes it — no id, no status, no history. */
export interface ProposedFinding {
  readonly title: string
  readonly description?: string
  readonly type: string
  readonly severity: DriverSeverity
  readonly owner: DriverOwner
  readonly dimension: ReliabilityDimension
  readonly scoreImpact: number
  readonly recommendedAction?: RecommendedAction
  readonly evidenceRefs?: readonly string[]
}

/** What an evaluator hands back. Note the absence of a score. */
export interface EvaluatorOutput {
  readonly dimensions: Partial<Record<ReliabilityDimension, DimensionAssessment>>
  readonly drivers: readonly ProposedFinding[]
  /** Ids of existing drivers this evaluator believes are no longer true. */
  readonly resolves?: readonly string[]
  /** One line for the assessment's summary. */
  readonly summary?: string
}

export interface ReliabilityEvaluatorCapability extends Capability {
  readonly summary: string
  /**
   * Whether this evaluator wants to run at all for this input.
   *
   * The agent evaluator costs tokens and says no for a run that produced
   * nothing new. Absent means always.
   */
  readonly wants?: (input: EvaluatorInput) => boolean
  evaluate(input: EvaluatorInput): EvaluatorOutput | Promise<EvaluatorOutput>
}

/** What `normalize` had to change, so a rejected claim is visible rather than silent. */
export interface NormalizationNote {
  readonly what: string
  readonly reason: string
}

export interface NormalizedEvaluation {
  readonly dimensions: Partial<Record<ReliabilityDimension, DimensionAssessment>>
  readonly drivers: readonly ProposedFinding[]
  readonly resolves: readonly string[]
  readonly summary: string
  readonly notes: readonly NormalizationNote[]
}

/**
 * The authority boundary.
 *
 * Everything an evaluator returns passes through here, and what comes out is
 * the only thing anything downstream sees. It is written to be boring on
 * purpose: clamp what is out of range, drop what is not in the vocabulary,
 * bound what would otherwise amount to setting the score, and write down every
 * change so a rejected claim is visible rather than silent.
 *
 * The bound on impact is the important one. An evaluator returning `-80` on a
 * single finding has set the score by another name, and `maxDriverImpact` is
 * what stops it — the difference between "this evaluator thinks this is very
 * bad" and "this evaluator decides".
 */
export function normalize(
  output: EvaluatorOutput,
  policy: ReliabilityPolicy,
  options: { known?: ReadonlySet<string>; workflows?: readonly string[] } = {},
): NormalizedEvaluation {
  const notes: NormalizationNote[] = []
  const known = options.known ?? new Set<string>()
  const workflows = new Set(options.workflows ?? [])

  const dimensions: Partial<Record<ReliabilityDimension, DimensionAssessment>> = {}
  for (const [name, assessment] of Object.entries(output.dimensions ?? {})) {
    if (!(RELIABILITY_DIMENSIONS as readonly string[]).includes(name)) {
      notes.push({ what: name, reason: 'not a dimension Factory has' })
      continue
    }
    if (assessment === undefined) continue
    const raw = assessment.score
    const score = clampScore(typeof raw === 'number' ? raw : 0)
    if (score !== raw) {
      notes.push({ what: name, reason: `score ${String(raw)} brought into range` })
    }
    dimensions[name as ReliabilityDimension] = {
      score,
      rationale: typeof assessment.rationale === 'string' ? assessment.rationale : '',
    }
  }

  const drivers: ProposedFinding[] = []
  for (const finding of output.drivers ?? []) {
    if (typeof finding.title !== 'string' || finding.title.trim() === '') {
      notes.push({ what: 'a finding', reason: 'no title, so nobody could act on it' })
      continue
    }
    if (!(DRIVER_SEVERITIES as readonly string[]).includes(finding.severity)) {
      notes.push({ what: finding.title, reason: `severity "${String(finding.severity)}" is not one` })
      continue
    }
    if (!(DRIVER_OWNERS as readonly string[]).includes(finding.owner)) {
      notes.push({ what: finding.title, reason: `owner "${String(finding.owner)}" is not one` })
      continue
    }
    // A dimension Factory does not have is corrected rather than dropped: the
    // finding is still worth having, and `unknown` is the honest home for it.
    const dimension = (RELIABILITY_DIMENSIONS as readonly string[]).includes(finding.dimension)
      ? finding.dimension
      : 'understanding'
    if (dimension !== finding.dimension) {
      notes.push({
        what: finding.title,
        reason: `dimension "${String(finding.dimension)}" is not one, filed under understanding`,
      })
    }

    const wanted = typeof finding.scoreImpact === 'number' ? finding.scoreImpact : 0
    const bounded = Math.max(-policy.maxDriverImpact, Math.min(policy.maxDriverImpact, wanted))
    if (bounded !== wanted) {
      notes.push({
        what: finding.title,
        reason: `impact ${String(wanted)} bounded to ${String(bounded)}`,
      })
    }

    // A recommendation naming a workflow the project does not have is dropped
    // rather than carried: the board would draw a button with nothing behind it.
    let action = finding.recommendedAction
    if (
      action?.type === 'workflow' &&
      (action.workflow === undefined || !workflows.has(action.workflow))
    ) {
      notes.push({
        what: finding.title,
        reason: `recommends a workflow this project does not have`,
      })
      action = undefined
    }

    drivers.push({
      title: finding.title.trim(),
      description: typeof finding.description === 'string' ? finding.description : '',
      type: typeof finding.type === 'string' && finding.type !== '' ? finding.type : 'unknown',
      severity: finding.severity,
      owner: finding.owner,
      dimension,
      scoreImpact: bounded,
      ...(action === undefined ? {} : { recommendedAction: action }),
      evidenceRefs: Array.isArray(finding.evidenceRefs) ? finding.evidenceRefs : [],
    })
  }

  // An evaluator may only resolve a driver that exists. Inventing an id would
  // otherwise silently resolve nothing, which reads as "it was dealt with".
  const resolves: string[] = []
  for (const id of output.resolves ?? []) {
    if (known.has(id)) resolves.push(id)
    else notes.push({ what: id, reason: 'no such driver' })
  }

  return {
    dimensions,
    drivers,
    resolves,
    summary: typeof output.summary === 'string' ? output.summary : '',
    notes,
  }
}

/**
 * The dimension scores a set of observations supports, on their own.
 *
 * Evidence-driven rather than opinion-driven: a dimension rises as the evidence
 * expected for it arrives, and the ceiling is deliberately below 100 because
 * collected evidence alone is not the same as somebody having judged it. That
 * last few points is what an agent evaluator is for.
 *
 * Failures subtract from the dimension they were seen in, which is what makes
 * the number fall when a validation finds something.
 */
export function dimensionsFromEvidence(
  observations: readonly Observation[],
  policy: ReliabilityPolicy,
  ceiling = 95,
): DimensionScores {
  const satisfied = new Set(
    observations
      .filter((o) => o.satisfies !== undefined && o.status !== 'failed' && o.status !== 'missing')
      .map((o) => o.satisfies as string),
  )

  return Object.fromEntries(
    RELIABILITY_DIMENSIONS.map((dimension) => {
      const expected = policy.expectedEvidence.filter((e) => e.dimension === dimension)
      const want = expected.reduce((sum, e) => sum + e.weight, 0)
      const have = expected
        .filter((e) => satisfied.has(e.key))
        .reduce((sum, e) => sum + e.weight, 0)
      const earned = want === 0 ? 0 : (have / want) * (ceiling - policy.baseline)

      const failures = observations.filter(
        (o) => o.dimension === dimension && (o.status === 'failed' || o.status === 'missing'),
      ).length
      // Four points a failure, and never more than twenty: a dimension that has
      // gone to zero stops distinguishing "one problem" from "nothing works".
      const penalty = Math.min(20, failures * 4)

      return [dimension, clampScore(policy.baseline + earned - penalty)]
    }),
  ) as DimensionScores
}

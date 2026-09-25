/**
 * What Reliability is made of.
 *
 * Factory can say a task is `done`. It cannot say how much to trust that, and
 * the material for the answer is already produced and then thrown away: a run
 * knows its exit codes, which commands it was refused, which artifacts it
 * promised and whether they arrived. Reliability is that record kept, judged
 * and directed at whoever can act on it.
 *
 * Every type here is data. The rules live in `score.ts` and `drivers.ts` as
 * pure functions over injected facts, for the reason `dependencyStatus` and
 * `admitTask` take lookups: the interesting cases are a critical driver capping
 * a near-perfect average and a validation that lowers the score while raising
 * coverage, and neither is a thing to build out of real runs to find out what
 * happens.
 *
 * `Reliability-System-Plan-CLAUDE.md` is the adapted plan, and it records where
 * this departs from the product specification and why.
 */

/**
 * The six things a score is made of.
 *
 * Ordered as the work happens, which is also the order they are shown. They are
 * not equally weighted — see `policy.ts` — and they are deliberately not
 * exhaustive: this is the initial set, and adding a seventh is a scoring-model
 * version bump rather than a schema change.
 */
export const RELIABILITY_DIMENSIONS = [
  'understanding',
  'precedent',
  'design',
  'implementation',
  'regressionSafety',
  'verification',
] as const

export type ReliabilityDimension = (typeof RELIABILITY_DIMENSIONS)[number]

/** A score per dimension, every key present. Absent would be indistinguishable from zero. */
export type DimensionScores = Record<ReliabilityDimension, number>

/**
 * What a task's reliability is, as a state rather than a number.
 *
 * `unassessed` is not `0`. A task nobody has looked at is not a task that
 * failed, and showing it as zero would be the same lie the empty workflow told.
 */
export const RELIABILITY_STATES = ['unassessed', 'assessed', 'stale'] as const
export type ReliabilityState = (typeof RELIABILITY_STATES)[number]

// ---------------------------------------------------------------- drivers

/**
 * What kind of thing a driver is.
 *
 * Open rather than closed at the schema edge — a third-party evaluator may have
 * a vocabulary Factory has not thought of — but this list is what the built-in
 * evaluators produce and what the UI groups by. An unrecognised type is kept
 * and shown; it is not a reason to drop a finding.
 */
export const DRIVER_TYPES = [
  'requirement',
  'understanding',
  'precedent',
  'architecture',
  'compatibility',
  'implementation',
  'regression',
  'testing',
  'verification',
  'security',
  'performance',
  'migration',
  'dependency',
  'environment',
  'product_decision',
  'unknown',
] as const

export type DriverType = (typeof DRIVER_TYPES)[number] | (string & {})

/**
 * How much it matters.
 *
 * Related to score impact and not identical to it: severity says how bad the
 * thing is, impact says how far it moves the number. A `critical` driver that
 * is still open applies a cap, which is the one place severity acts directly.
 */
export const DRIVER_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const
export type DriverSeverity = (typeof DRIVER_SEVERITIES)[number]

/**
 * Where a driver is in its life.
 *
 * `resolved` means the thing is no longer true. `accepted` means it is still
 * true and a person decided to live with it — a different fact, recorded
 * differently, and never erased. `invalidated` means it was never true.
 * `superseded` means a later driver replaced it, which is how a correction is
 * made without rewriting history.
 */
export const DRIVER_STATUSES = [
  'open',
  'investigating',
  'resolved',
  'accepted',
  'invalidated',
  'superseded',
] as const
export type DriverStatus = (typeof DRIVER_STATUSES)[number]

/** Statuses that still weigh on the score and still want somebody's attention. */
export const ACTIVE_DRIVER_STATUSES: readonly DriverStatus[] = ['open', 'investigating']

/**
 * Who should resolve it.
 *
 * This is the routing, and it is the part of the feature that answers *what can
 * Factory keep working on without me?* — which is worth more than the score.
 */
export const DRIVER_OWNERS = ['agent', 'developer', 'either', 'external'] as const
export type DriverOwner = (typeof DRIVER_OWNERS)[number]

/** What kind of thing would resolve a driver. */
export const ACTION_TYPES = [
  'workflow',
  'agent_investigation',
  'developer_decision',
  'manual_review',
  'external_research',
] as const
export type ActionType = (typeof ACTION_TYPES)[number]

/**
 * The next thing that would help, when Factory can name one.
 *
 * `workflow` is the only type Factory can act on by itself, and it carries the
 * name of a workflow the project actually has — a recommendation to run
 * something that does not exist is worse than none.
 */
export interface RecommendedAction {
  readonly type: ActionType
  readonly label: string
  /** Set when `type` is `workflow`. The workflow's name, as the project spells it. */
  readonly workflow?: string
}

/** Where a driver came from, so it can be traced back to the run that found it. */
export interface DriverOrigin {
  readonly runId?: string
  readonly workflow?: string
  readonly assessmentId?: string
}

/** A thing that materially changes how much the current solution can be trusted. */
export interface ReliabilityDriver {
  readonly id: string
  readonly taskId: string
  readonly title: string
  readonly description: string
  readonly type: DriverType
  readonly severity: DriverSeverity
  readonly status: DriverStatus
  readonly owner: DriverOwner
  readonly dimension: ReliabilityDimension
  /**
   * How far it moves the score, negative for a risk and positive for support.
   *
   * A number rather than a function of severity, because two `high` drivers are
   * rarely equally expensive and the evaluator that found them is better placed
   * to say. Bounded by `normalize()`; an evaluator cannot move a score by 90.
   */
  readonly scoreImpact: number
  readonly recommendedAction?: RecommendedAction
  /** Artifact names, step ids or observation ids. References, never copies. */
  readonly evidenceRefs: readonly string[]
  readonly introducedBy: DriverOrigin
  readonly createdAt: string
  readonly updatedAt: string
  readonly resolvedAt?: string
  readonly acceptedAt?: string
  /** Who accepted the risk. Never an agent for a high-severity driver. */
  readonly acceptedBy?: string
  readonly acceptanceReason?: string
  /** The driver this one replaces, when it is a correction. */
  readonly supersedes?: string
}

// ---------------------------------------------------------------- caps

/**
 * A ceiling a known risk puts on the score.
 *
 * A weighted average cannot express "there is an unresolved critical security
 * finding". It can only dilute it, and dilution is how a 96 gets shipped with a
 * hole in it. A cap is the model's way of saying some facts do not average.
 */
export interface ReliabilityCap {
  readonly type: string
  /** The highest score this cap permits. */
  readonly value: number
  readonly reason: string
}

// ---------------------------------------------------------------- evidence

/**
 * One thing an assessment saw.
 *
 * Deliberately small, and a *reference* to whatever it is about — an artifact
 * has a path and a version history already, and duplicating a 200 KB document
 * into the reliability record would be a second copy that goes stale. What is
 * kept is the note: this ran, this was refused, this was promised and did not
 * arrive. Without it the explanation of a score cannot be reconstructed once
 * the run logs have been trimmed.
 */
export const OBSERVATION_KINDS = [
  'test_result',
  'build_result',
  'gate_result',
  'runtime_observation',
  'artifact',
  'artifact_missing',
  'command_refused',
  'path_refused',
  'approval',
  'clarification',
  'review_result',
  'external_reference',
] as const

export type ObservationKind = (typeof OBSERVATION_KINDS)[number] | (string & {})

/** Whether what was seen was good news, bad news, or merely a fact. */
export const OBSERVATION_STATUSES = ['passed', 'failed', 'missing', 'noted'] as const
export type ObservationStatus = (typeof OBSERVATION_STATUSES)[number]

export interface Observation {
  readonly kind: ObservationKind
  readonly status: ObservationStatus
  /** One line, for a person. Never the whole log. */
  readonly summary: string
  readonly dimension?: ReliabilityDimension
  /** Where it came from: a workflow name, a step, a provider. */
  readonly source?: string
  readonly runId?: string
  readonly stepId?: string
  /** A path, an artifact name, a command — whatever makes it findable again. */
  readonly reference?: string
  /** Which expected-evidence key this satisfies, when it satisfies one. */
  readonly satisfies?: string
}

// ---------------------------------------------------------------- assessment

/**
 * Why an assessment happened.
 *
 * Kept because "the score moved and nobody knows what touched it" is the
 * failure this whole subsystem exists to prevent, and that applies to the
 * subsystem itself.
 */
export const ASSESSMENT_TRIGGERS = [
  'run',
  'driver_resolved',
  'driver_accepted',
  'clarification',
  'manual',
] as const
export type AssessmentTrigger = (typeof ASSESSMENT_TRIGGERS)[number]

/** One line of the arithmetic, so "why 95?" has an answer that is not a shrug. */
export interface DimensionContribution {
  readonly dimension: ReliabilityDimension
  readonly score: number
  readonly weight: number
  /** `score × weight / 100`, carried rather than recomputed so a reader can check the sum. */
  readonly contribution: number
}

/** Why the score moved, in the terms a person would use. */
export interface DeltaCause {
  readonly summary: string
  readonly amount: number
  readonly driverId?: string
}

/** The whole arithmetic of one assessment, kept so it can be shown. */
export interface ReliabilityExplanation {
  readonly contributions: readonly DimensionContribution[]
  readonly rawScore: number
  readonly caps: readonly ReliabilityCap[]
  readonly effectiveScore: number
  /** Empty for the first assessment, which has nothing to have moved from. */
  readonly causes: readonly DeltaCause[]
}

/**
 * One judgement, at one moment, for one task.
 *
 * Append-only from the product's point of view: an assessment is never edited
 * because interpretation changed. A correction is a new assessment that
 * supersedes, which is the same rule the drivers follow and for the same
 * reason — a history that can be rewritten is not evidence of anything.
 */
export interface ReliabilityAssessment {
  readonly id: string
  readonly taskId: string
  /** 1-based, and the ordering. Timestamps collide; a sequence does not. */
  readonly sequence: number
  readonly trigger: AssessmentTrigger
  readonly workflow?: string
  readonly runId?: string
  readonly score: number
  readonly rawScore: number
  /** 0–100. How much of the expected evidence has actually been collected. */
  readonly coverage: number
  /** Movement from the previous assessment. The first one's delta is its score. */
  readonly delta: number
  readonly summary: string
  readonly dimensions: DimensionScores
  readonly caps: readonly ReliabilityCap[]
  readonly explanation: ReliabilityExplanation
  /**
   * The newest run this assessment took into account.
   *
   * What makes staleness derivable rather than stored: a run for this task that
   * finished after this one means the judgement is behind the work, and nothing
   * had to be written down to know it.
   */
  readonly consideredRunId?: string
  readonly scoringModelVersion: string
  readonly createdAt: string
}

/**
 * The two numbers a list draws, and nothing else.
 *
 * A row wants the score and the evidence coverage. It does not want the
 * dimensions, the caps, the explanation or who should deal with what — three
 * JSON columns to parse and two more queries to run, per row.
 *
 * Both fields are required, which makes `state` derivable from presence: a task
 * nobody has judged has no brief at all. That is deliberate. `unassessed` is a
 * state and the honest shape for it in a list is nothing, because a `score: 0`
 * on a row reads as a verdict.
 */
export interface ReliabilityBrief {
  readonly score: number
  readonly coverage: number
}

/**
 * What a task's reliability is right now.
 *
 * Assembled from the newest assessment and the drivers that are still active —
 * two indexed queries. It is deliberately not a stored row: a stored current
 * score is a second copy of something the history already says, and the two
 * disagree the first time an assessment is deleted or replayed.
 *
 * A list reads `ReliabilityBrief` from the same newest row through a narrower
 * projection, so the number on a row and the number on the card cannot disagree.
 */
export interface ReliabilitySummary {
  readonly taskId: string
  readonly state: ReliabilityState
  /** Absent when `state` is `unassessed`. Never `0` in that case. */
  readonly score?: number
  readonly rawScore?: number
  readonly coverage?: number
  readonly delta?: number
  readonly dimensions?: DimensionScores
  readonly caps?: readonly ReliabilityCap[]
  readonly assessedAt?: string
  readonly assessmentId?: string
  /** Why the assessment is behind the work, when it is. */
  readonly staleReason?: string
  readonly attention: AttentionSummary
}

/**
 * Unresolved uncertainty, counted by who can do something about it.
 *
 * The number that matters most is `developer` — it is the only one Factory
 * cannot work through on its own.
 */
export interface AttentionSummary {
  readonly agent: number
  readonly developer: number
  readonly either: number
  readonly external: number
  /** What the score could reach if every active driver of that owner resolved. */
  readonly potential: Record<DriverOwner, number>
}

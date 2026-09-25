import { randomUUID } from 'node:crypto'
import type { EventBus } from '@factory/events'
import {
  ACTIVE_DRIVER_STATUSES,
  RELIABILITY_DIMENSIONS,
  type DimensionScores,
  type DriverOwner,
  type DriverSeverity,
  type DriverStatus,
  type DriverType,
  type Observation,
  type ReliabilityAssessment,
  type ReliabilityBrief,
  type ReliabilityCap,
  type ReliabilityDimension,
  type ReliabilityDriver,
  type ReliabilityExplanation,
  type RecommendedAction,
} from '@factory/core'
import type { Database } from './sqlite.js'

/**
 * Where a task's judgement lives.
 *
 * Three tables and no fourth for "the current state", which is the decision
 * worth defending: the current score is the newest assessment and the drivers
 * that are still active, and a stored copy of that would be a second source of
 * truth for something the history already says. `progress` on a task is derived
 * for the same reason, and the two disagree the first time an assessment is
 * replayed.
 *
 * History is append-only. There is no `update` for an assessment and there is
 * not going to be one: a judgement is never edited because interpretation
 * changed, and a correction is a later assessment that supersedes. A history
 * that can be rewritten is not evidence of anything.
 */

interface AssessmentRow {
  id: string
  task_id: string
  sequence: number
  trigger: string
  workflow: string | null
  run_id: string | null
  score: number
  raw_score: number
  coverage: number
  delta: number
  summary: string
  dimensions: string
  caps: string
  explanation: string
  considered_run_id: string | null
  scoring_model_version: string
  created_at: string
}

interface DriverRow {
  id: string
  task_id: string
  title: string
  description: string
  type: string
  severity: string
  status: string
  owner: string
  dimension: string
  score_impact: number
  recommended_action: string | null
  evidence_refs: string
  introduced_run_id: string | null
  introduced_workflow: string | null
  introduced_assessment_id: string | null
  supersedes: string | null
  resolved_at: string | null
  accepted_at: string | null
  accepted_by: string | null
  acceptance_reason: string | null
  created_at: string
  updated_at: string
}

interface ObservationRow {
  id: string
  task_id: string
  assessment_id: string | null
  kind: string
  status: string
  summary: string
  dimension: string | null
  source: string | null
  run_id: string | null
  step_id: string | null
  reference: string | null
  satisfies: string | null
  created_at: string
}

export interface ReliabilityRepositoryOptions {
  readonly db: Database
  readonly events?: EventBus
  readonly now?: () => string
  readonly newId?: () => string
}

/** What an assessment needs to be written down. The scoring already happened. */
export interface RecordAssessment {
  readonly taskId: string
  readonly trigger: ReliabilityAssessment['trigger']
  readonly workflow?: string
  readonly runId?: string
  readonly score: number
  readonly rawScore: number
  readonly coverage: number
  readonly delta: number
  readonly summary: string
  readonly dimensions: DimensionScores
  readonly caps: readonly ReliabilityCap[]
  readonly explanation: ReliabilityExplanation
  readonly consideredRunId?: string
  readonly scoringModelVersion: string
  /** Recorded against the assessment, so the explanation survives log trimming. */
  readonly observations?: readonly Observation[]
}

/** A driver as an evaluator proposes it, before it has an id or a history. */
export interface ProposedDriver {
  readonly taskId: string
  readonly title: string
  readonly description?: string
  readonly type: DriverType
  readonly severity: DriverSeverity
  readonly owner: DriverOwner
  readonly dimension: ReliabilityDimension
  readonly scoreImpact: number
  readonly recommendedAction?: RecommendedAction
  readonly evidenceRefs?: readonly string[]
  readonly introducedBy?: { runId?: string; workflow?: string; assessmentId?: string }
}

export class ReliabilityRepository {
  readonly #db: Database
  readonly #events: EventBus | undefined
  readonly #now: () => string
  readonly #newId: () => string

  constructor(options: ReliabilityRepositoryOptions) {
    this.#db = options.db
    this.#events = options.events
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#newId = options.newId ?? (() => randomUUID())
  }

  // ------------------------------------------------------------ assessments

  /**
   * Write one judgement down.
   *
   * The sequence is taken inside the transaction that inserts, which is what
   * makes two runs finishing at once produce two assessments in a defined order
   * rather than one overwriting the other's number. SQLite serialises writers,
   * so the read and the insert cannot interleave.
   */
  record(input: RecordAssessment): ReliabilityAssessment {
    const id = this.#newId()
    const createdAt = this.#now()

    const stored = this.#db.transaction(() => {
      const last = this.#db.get<{ sequence: number }>(
        'SELECT sequence FROM reliability_assessments WHERE task_id = ? ORDER BY sequence DESC LIMIT 1',
        input.taskId,
      )
      const sequence = (last?.sequence ?? 0) + 1

      this.#db.run(
        `INSERT INTO reliability_assessments (
           id, task_id, sequence, trigger, workflow, run_id, score, raw_score, coverage,
           delta, summary, dimensions, caps, explanation, considered_run_id,
           scoring_model_version, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.taskId,
        sequence,
        input.trigger,
        input.workflow ?? null,
        input.runId ?? null,
        input.score,
        input.rawScore,
        input.coverage,
        input.delta,
        input.summary,
        JSON.stringify(input.dimensions),
        JSON.stringify(input.caps),
        JSON.stringify(input.explanation),
        input.consideredRunId ?? null,
        input.scoringModelVersion,
        createdAt,
      )

      for (const observation of input.observations ?? []) {
        this.#db.run(
          `INSERT INTO reliability_observations (
             id, task_id, assessment_id, kind, status, summary, dimension, source,
             run_id, step_id, reference, satisfies, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          this.#newId(),
          input.taskId,
          id,
          observation.kind,
          observation.status,
          observation.summary,
          observation.dimension ?? null,
          observation.source ?? null,
          observation.runId ?? null,
          observation.stepId ?? null,
          observation.reference ?? null,
          observation.satisfies ?? null,
          createdAt,
        )
      }

      return sequence
    })

    this.#events?.emit('reliability.assessed', {
      taskId: input.taskId,
      assessmentId: id,
      score: input.score,
      delta: input.delta,
      coverage: input.coverage,
    })

    return this.#assessment(id) ?? this.#hydrateAssessment({
      id,
      task_id: input.taskId,
      sequence: stored,
      trigger: input.trigger,
      workflow: input.workflow ?? null,
      run_id: input.runId ?? null,
      score: input.score,
      raw_score: input.rawScore,
      coverage: input.coverage,
      delta: input.delta,
      summary: input.summary,
      dimensions: JSON.stringify(input.dimensions),
      caps: JSON.stringify(input.caps),
      explanation: JSON.stringify(input.explanation),
      considered_run_id: input.consideredRunId ?? null,
      scoring_model_version: input.scoringModelVersion,
      created_at: createdAt,
    })
  }

  /** The newest judgement, or nothing when the task has never been assessed. */
  newest(taskId: string): ReliabilityAssessment | undefined {
    const row = this.#db.get<AssessmentRow>(
      'SELECT * FROM reliability_assessments WHERE task_id = ? ORDER BY sequence DESC LIMIT 1',
      taskId,
    )
    return row === undefined ? undefined : this.#hydrateAssessment(row)
  }

  /**
   * The newest score and coverage of every task that has one, in one statement.
   *
   * The whole table once, the way the task list reads its dependency graph once
   * for the whole page rather than once per row. Forty tasks asking `newest`,
   * `drivers` and `forTask` each would be a hundred and twenty statements for
   * one answer, and none of the JSON columns a row never draws are parsed here.
   *
   * A task with no assessment is **absent from the map**, never present with a
   * zero: `unassessed` is a state, and a missing key is what it looks like.
   */
  newestScores(): Map<string, ReliabilityBrief> {
    const rows = this.#db.all<{ task_id: string; score: number; coverage: number }>(
      `SELECT a.task_id, a.score, a.coverage
         FROM reliability_assessments a
         JOIN (
           SELECT task_id, MAX(sequence) AS sequence
             FROM reliability_assessments
            GROUP BY task_id
         ) newest ON newest.task_id = a.task_id AND a.sequence = newest.sequence`,
    )
    return new Map(rows.map((row) => [row.task_id, { score: row.score, coverage: row.coverage }]))
  }

  /** Every judgement, oldest first — which is the order a graph wants. */
  history(taskId: string): readonly ReliabilityAssessment[] {
    return this.#db
      .all<AssessmentRow>(
        'SELECT * FROM reliability_assessments WHERE task_id = ? ORDER BY sequence',
        taskId,
      )
      .map((row) => this.#hydrateAssessment(row))
  }

  #assessment(id: string): ReliabilityAssessment | undefined {
    const row = this.#db.get<AssessmentRow>(
      'SELECT * FROM reliability_assessments WHERE id = ?',
      id,
    )
    return row === undefined ? undefined : this.#hydrateAssessment(row)
  }

  // ---------------------------------------------------------------- drivers

  /** Everything ever found for this task, whatever became of it. */
  drivers(taskId: string): readonly ReliabilityDriver[] {
    return this.#db
      .all<DriverRow>(
        'SELECT * FROM reliability_drivers WHERE task_id = ? ORDER BY created_at, id',
        taskId,
      )
      .map((row) => this.#hydrateDriver(row))
  }

  /** The ones still weighing on the score. */
  active(taskId: string): readonly ReliabilityDriver[] {
    return this.drivers(taskId).filter((driver) => ACTIVE_DRIVER_STATUSES.includes(driver.status))
  }

  driver(id: string): ReliabilityDriver | undefined {
    const row = this.#db.get<DriverRow>('SELECT * FROM reliability_drivers WHERE id = ?', id)
    return row === undefined ? undefined : this.#hydrateDriver(row)
  }

  /**
   * Write a finding down.
   *
   * No de-duplication here, deliberately. Whether two findings are the same
   * finding is a judgement about their meaning, and the evaluator that produced
   * them is the only thing placed to make it — see `reconcile` in the engine,
   * which is where that decision lives and where it can be specified.
   */
  addDriver(input: ProposedDriver): ReliabilityDriver {
    const id = this.#newId()
    const at = this.#now()
    this.#db.run(
      `INSERT INTO reliability_drivers (
         id, task_id, title, description, type, severity, status, owner, dimension,
         score_impact, recommended_action, evidence_refs, introduced_run_id,
         introduced_workflow, introduced_assessment_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.taskId,
      input.title,
      input.description ?? '',
      String(input.type),
      input.severity,
      input.owner,
      input.dimension,
      input.scoreImpact,
      input.recommendedAction === undefined ? null : JSON.stringify(input.recommendedAction),
      JSON.stringify(input.evidenceRefs ?? []),
      input.introducedBy?.runId ?? null,
      input.introducedBy?.workflow ?? null,
      input.introducedBy?.assessmentId ?? null,
      at,
      at,
    )
    this.#events?.emit('reliability.driver.created', {
      taskId: input.taskId,
      driverId: id,
      severity: input.severity,
      owner: input.owner,
    })
    return this.driver(id) as ReliabilityDriver
  }

  /**
   * Move a driver to a new status.
   *
   * The legality of the move is `moveDriver`'s business in core, and the
   * authority is the caller's. This writes down a decision somebody else made,
   * which is why it takes `status` rather than an action.
   */
  setDriverStatus(
    id: string,
    status: DriverStatus,
    detail: { acceptedBy?: string; reason?: string; supersedes?: string } = {},
  ): ReliabilityDriver {
    const existing = this.driver(id)
    if (existing === undefined) throw new Error(`No reliability driver ${id}.`)
    const at = this.#now()

    this.#db.run(
      `UPDATE reliability_drivers
         SET status = ?, updated_at = ?,
             resolved_at = CASE WHEN ? IN ('resolved', 'invalidated') THEN ? ELSE resolved_at END,
             accepted_at = CASE WHEN ? = 'accepted' THEN ? ELSE accepted_at END,
             accepted_by = COALESCE(?, accepted_by),
             acceptance_reason = COALESCE(?, acceptance_reason),
             supersedes = COALESCE(?, supersedes)
       WHERE id = ?`,
      status,
      at,
      status,
      at,
      status,
      at,
      detail.acceptedBy ?? null,
      detail.reason ?? null,
      detail.supersedes ?? null,
      id,
    )

    this.#events?.emit('reliability.driver.changed', {
      taskId: existing.taskId,
      driverId: id,
      status,
      ...(detail.acceptedBy === undefined ? {} : { by: detail.acceptedBy }),
    })
    return this.driver(id) as ReliabilityDriver
  }

  // ----------------------------------------------------------- observations

  /** What every assessment of this task has seen, oldest first. */
  observations(taskId: string): readonly Observation[] {
    return this.#db
      .all<ObservationRow>(
        'SELECT * FROM reliability_observations WHERE task_id = ? ORDER BY created_at, id',
        taskId,
      )
      .map((row) => hydrateObservation(row))
  }

  // ---------------------------------------------------------------- hydrate

  #hydrateAssessment(row: AssessmentRow): ReliabilityAssessment {
    const assessment: Record<string, unknown> = {
      id: row.id,
      taskId: row.task_id,
      sequence: row.sequence,
      trigger: row.trigger,
      score: row.score,
      rawScore: row.raw_score,
      coverage: row.coverage,
      delta: row.delta,
      summary: row.summary,
      dimensions: readDimensions(row.dimensions),
      caps: readJsonArray<ReliabilityCap>(row.caps),
      explanation: readExplanation(row.explanation),
      scoringModelVersion: row.scoring_model_version,
      createdAt: row.created_at,
    }
    if (row.workflow !== null) assessment['workflow'] = row.workflow
    if (row.run_id !== null) assessment['runId'] = row.run_id
    if (row.considered_run_id !== null) assessment['consideredRunId'] = row.considered_run_id
    return assessment as unknown as ReliabilityAssessment
  }

  #hydrateDriver(row: DriverRow): ReliabilityDriver {
    const introducedBy: Record<string, unknown> = {}
    if (row.introduced_run_id !== null) introducedBy['runId'] = row.introduced_run_id
    if (row.introduced_workflow !== null) introducedBy['workflow'] = row.introduced_workflow
    if (row.introduced_assessment_id !== null) {
      introducedBy['assessmentId'] = row.introduced_assessment_id
    }

    const driver: Record<string, unknown> = {
      id: row.id,
      taskId: row.task_id,
      title: row.title,
      description: row.description,
      type: row.type,
      severity: row.severity,
      status: row.status,
      owner: row.owner,
      dimension: row.dimension,
      scoreImpact: row.score_impact,
      evidenceRefs: readJsonArray<string>(row.evidence_refs),
      introducedBy,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
    const action = readJsonObject<RecommendedAction>(row.recommended_action)
    if (action !== undefined) driver['recommendedAction'] = action
    if (row.resolved_at !== null) driver['resolvedAt'] = row.resolved_at
    if (row.accepted_at !== null) driver['acceptedAt'] = row.accepted_at
    if (row.accepted_by !== null) driver['acceptedBy'] = row.accepted_by
    if (row.acceptance_reason !== null) driver['acceptanceReason'] = row.acceptance_reason
    if (row.supersedes !== null) driver['supersedes'] = row.supersedes
    return driver as unknown as ReliabilityDriver
  }
}

function hydrateObservation(row: ObservationRow): Observation {
  const observation: Record<string, unknown> = {
    kind: row.kind,
    status: row.status,
    summary: row.summary,
  }
  if (row.dimension !== null) observation['dimension'] = row.dimension
  if (row.source !== null) observation['source'] = row.source
  if (row.run_id !== null) observation['runId'] = row.run_id
  if (row.step_id !== null) observation['stepId'] = row.step_id
  if (row.reference !== null) observation['reference'] = row.reference
  if (row.satisfies !== null) observation['satisfies'] = row.satisfies
  return observation as unknown as Observation
}

/**
 * JSON that will not parse reads as absent, never as a throw.
 *
 * The rule `projects.granted_directories` established: a row somebody edited by
 * hand must not make a task unloadable. A score that reads zero is a bug worth
 * seeing; a board that will not open is a bug that hides every other one.
 */
function readJsonArray<T>(raw: string | null): readonly T[] {
  if (raw === null || raw.trim() === '') return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

function readJsonObject<T>(raw: string | null): T | undefined {
  if (raw === null || raw.trim() === '') return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? (parsed as T) : undefined
  } catch {
    return undefined
  }
}

/** Every dimension present, because a missing one is indistinguishable from zero. */
function readDimensions(raw: string): DimensionScores {
  const parsed = readJsonObject<Record<string, unknown>>(raw) ?? {}
  return Object.fromEntries(
    RELIABILITY_DIMENSIONS.map((dimension) => {
      const value = parsed[dimension]
      return [dimension, typeof value === 'number' && Number.isFinite(value) ? value : 0]
    }),
  ) as DimensionScores
}

function readExplanation(raw: string): ReliabilityExplanation {
  const parsed = readJsonObject<Partial<ReliabilityExplanation>>(raw)
  return {
    contributions: parsed?.contributions ?? [],
    rawScore: parsed?.rawScore ?? 0,
    caps: parsed?.caps ?? [],
    effectiveScore: parsed?.effectiveScore ?? 0,
    causes: parsed?.causes ?? [],
  }
}

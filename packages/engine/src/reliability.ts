import {
  SCORING_MODEL_VERSION,
  dimensionsFromEvidence,
  normalize,
  observationsFrom,
  score,
  type AssessmentTrigger,
  type DimensionScores,
  type EvaluatorAgent,
  type EvaluatorInput,
  type ProposedFinding,
  type ReliabilityAssessment,
  type ReliabilityEvaluatorCapability,
  type ReliabilityPolicy,
  type RunFacts,
} from '@factory/core'
import type { Problem } from '@factory/core'
import type { ReliabilityRepository } from '@factory/store'

/**
 * Judging a task, after something happened to it.
 *
 * The order is fixed and it is the whole of the architecture: observations from
 * what Factory saw, evaluators proposing, `normalize` refusing, the score
 * engine deciding, the history appending. An evaluator never touches the number
 * and never touches the database.
 *
 * **A failed assessment never fails the run.** The workflow completed; a
 * judgement of it could not be made. That is a warning against the run and a
 * retry offer, not a failure — turning "the evaluator crashed" into "your work
 * failed" would make the feature something people switch off.
 */

export interface AssessInput {
  readonly taskId: string
  readonly task: { readonly name: string; readonly description: string }
  readonly reliability: ReliabilityRepository
  readonly evaluators: readonly ReliabilityEvaluatorCapability[]
  readonly policy: ReliabilityPolicy
  readonly trigger: AssessmentTrigger
  /** What this run did. Absent for a trigger that is not a run. */
  readonly facts?: RunFacts
  /** Workflows the project has, so a recommendation can name a real one. */
  readonly workflows?: readonly string[]
  /**
   * How to ask an agent, when this project has one to ask.
   *
   * Absent is the ordinary case and costs nothing: the deterministic evaluator
   * still runs and the task is still judged. What is absent is somebody having
   * read the work.
   */
  readonly agent?: EvaluatorAgent
}

export interface AssessOutcome {
  /** Absent when nothing could be judged. The run is unaffected either way. */
  readonly assessment?: ReliabilityAssessment
  readonly problems: readonly Problem[]
}

export async function assessReliability(input: AssessInput): Promise<AssessOutcome> {
  const problems: Problem[] = []

  try {
    const previous = input.reliability.newest(input.taskId)
    const before = input.reliability.drivers(input.taskId)
    const earlier = input.reliability.observations(input.taskId)
    const latest = input.facts === undefined ? [] : observationsFrom(input.facts)
    const observations = [...earlier, ...latest]

    const evaluatorInput: EvaluatorInput = {
      taskId: input.taskId,
      task: input.task,
      observations,
      latest,
      drivers: before,
      policy: input.policy,
      workflows: input.workflows ?? [],
      ...(input.agent === undefined ? {} : { agent: input.agent }),
    }

    // Every evaluator's opinion, and a note when one of them could not give it.
    // One failing evaluator must not take the assessment with it: the
    // deterministic one alone is still a judgement worth having.
    const dimensions: DimensionScores = dimensionsFromEvidence(observations, input.policy)
    const proposed: ProposedFinding[] = []
    const resolving = new Set<string>()
    const summaries: string[] = []
    const known = new Set(before.map((driver) => driver.id))

    for (const evaluator of input.evaluators) {
      if (evaluator.wants?.(evaluatorInput) === false) continue
      try {
        const raw = await evaluator.evaluate(evaluatorInput)
        const clean = normalize(raw, input.policy, {
          known,
          workflows: input.workflows ?? [],
        })
        for (const [dimension, assessment] of Object.entries(clean.dimensions)) {
          if (assessment === undefined) continue
          dimensions[dimension as keyof DimensionScores] = assessment.score
        }
        proposed.push(...clean.drivers)
        for (const id of clean.resolves) resolving.add(id)
        if (clean.summary !== '') summaries.push(clean.summary)
        for (const note of clean.notes) {
          problems.push({
            severity: 'warning',
            message: `Reliability evaluator "${evaluator.id}": ${note.what} — ${note.reason}.`,
            rule: 'reliability.evaluatorCorrected',
          })
        }
      } catch (error) {
        problems.push({
          severity: 'warning',
          message:
            `Reliability evaluator "${evaluator.id}" failed: ` +
            `${error instanceof Error ? error.message : String(error)}. ` +
            'The run is unaffected; the assessment used what the others reported.',
          rule: 'reliability.evaluatorFailed',
        })
      }
    }

    // Findings first, then resolutions, so an evaluator that proposes and
    // resolves in the same breath gets both and in the order it meant them.
    for (const finding of proposed) {
      input.reliability.addDriver({
        taskId: input.taskId,
        title: finding.title,
        ...(finding.description === undefined ? {} : { description: finding.description }),
        type: finding.type,
        severity: finding.severity,
        owner: finding.owner,
        dimension: finding.dimension,
        scoreImpact: finding.scoreImpact,
        ...(finding.recommendedAction === undefined
          ? {}
          : { recommendedAction: finding.recommendedAction }),
        evidenceRefs: finding.evidenceRefs ?? [],
        introducedBy: {
          ...(input.facts?.runId === undefined ? {} : { runId: input.facts.runId }),
          ...(input.facts?.workflow === undefined ? {} : { workflow: input.facts.workflow }),
        },
      })
    }
    for (const id of resolving) input.reliability.setDriverStatus(id, 'resolved')

    const after = input.reliability.drivers(input.taskId)
    const result = score({
      dimensions,
      drivers: after,
      observations,
      policy: input.policy,
      ...(previous === undefined
        ? {}
        : {
            previous: {
              score: previous.score,
              drivers: before,
              caps: previous.caps,
            },
          }),
    })

    const assessment = input.reliability.record({
      taskId: input.taskId,
      trigger: input.trigger,
      ...(input.facts?.workflow === undefined ? {} : { workflow: input.facts.workflow }),
      ...(input.facts?.runId === undefined ? {} : { runId: input.facts.runId }),
      score: result.score,
      rawScore: result.rawScore,
      coverage: result.coverage,
      delta: result.delta,
      summary: summaries.join(' ') || describe(result.score, result.delta),
      // What the score was computed from, not what went in: the drivers moved
      // the dimensions they name, and a card showing the un-moved ones is a
      // breakdown that cannot add up to the number above it.
      dimensions: result.dimensions,
      caps: result.caps,
      explanation: result.explanation,
      ...(input.facts?.runId === undefined ? {} : { consideredRunId: input.facts.runId }),
      scoringModelVersion: SCORING_MODEL_VERSION,
      observations: latest,
    })

    return { assessment, problems }
  } catch (error) {
    // The one outcome this function guarantees: whatever went wrong, the run
    // that triggered it is not affected by it.
    problems.push({
      severity: 'warning',
      message:
        'Reliability could not be recalculated: ' +
        `${error instanceof Error ? error.message : String(error)}. ` +
        'The workflow itself is unaffected.',
      rule: 'reliability.assessmentFailed',
    })
    return { problems }
  }
}

/** A sentence for an assessment nobody wrote one for. */
function describe(current: number, delta: number): string {
  if (delta === 0) return `Reliability is unchanged at ${String(current)}.`
  const direction = delta > 0 ? 'up' : 'down'
  return `Reliability ${direction} ${String(Math.abs(delta))} to ${String(current)}.`
}

/**
 * Whether an assessment is behind the work it judges.
 *
 * Derived rather than stored: an assessment records the newest run it took into
 * account, so a run that finished after that one means the judgement is stale.
 * Nothing has to be written down, and nothing can be written down wrongly.
 */
export function stalenessOf(
  assessment: ReliabilityAssessment | undefined,
  finishedRunIds: readonly string[],
): string | undefined {
  if (assessment === undefined) return undefined
  const considered = assessment.consideredRunId
  if (considered === undefined) return undefined
  const index = finishedRunIds.indexOf(considered)
  if (index === -1) return undefined
  const since = finishedRunIds.length - index - 1
  if (since <= 0) return undefined
  return since === 1
    ? 'One run has finished since this was assessed.'
    : `${String(since)} runs have finished since this was assessed.`
}

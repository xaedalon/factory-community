import type { Denial } from '../security/denials.js'
import type { Observation, ReliabilityDimension } from './model.js'

/**
 * What Factory saw, turned into something a judgement can be built on.
 *
 * All of this already exists and is then thrown away: a run knows its exit
 * codes, which commands it was refused, which artifacts it promised and whether
 * they arrived. This is the one place that converts it, so an evaluator reads
 * facts rather than a `RunResult` — which matters because an evaluator may come
 * from a plugin and `RunResult` is not its business.
 *
 * Nothing here interprets. A failed step is recorded as a failed step; whether
 * that means the design is wrong or the environment is broken is the
 * evaluator's judgement, and keeping the two apart is what lets the same
 * observations be re-judged by a better evaluator later.
 */

/** A step, as much of it as a judgement needs. */
export interface StepFacts {
  readonly phase: string
  readonly index: number
  readonly uses: string
  /** Null when the step could not be started at all. */
  readonly exitCode?: number | null
  readonly timedOut?: boolean
  readonly stepId?: string
  /** The rendered command, for a shell step. */
  readonly command?: string
}

/** An artifact a step promised, and what became of it. */
export interface ArtifactFacts {
  readonly name: string
  readonly bytes: number
  readonly missing: boolean
}

/** What a workflow said about its own contribution, when it said anything. */
export interface ReliabilityDeclaration {
  readonly contributes?: readonly ReliabilityDimension[]
  readonly expectedEvidence?: readonly string[]
  readonly evaluateAfterRun?: boolean
}

/** One run, as a judgement needs to see it. */
export interface RunFacts {
  readonly runId: string
  readonly workflow: string
  /** `completed`, `failed`, `refused`, `timed-out`, `declined`. */
  readonly status: string
  readonly steps: readonly StepFacts[]
  readonly denials: readonly Denial[]
  readonly artifacts: readonly ArtifactFacts[]
  readonly declaration?: ReliabilityDeclaration
  /**
   * The command this project checks itself with, when it has one.
   *
   * The one expectation Factory can satisfy without being told: a shell step
   * running exactly this command and exiting zero *is* the project's own
   * checks passing. Nothing else can be inferred that confidently, which is why
   * everything else waits for a declaration.
   */
  readonly checkCommand?: string
}

/**
 * The facts of one run, as observations.
 *
 * Coverage credit is deliberately hard to earn. A `satisfies` key is set only
 * when the workflow declared what it was collecting, or when the project's own
 * check command ran green — and never by guessing from an artifact's name.
 * Guessed coverage is worse than none: it reads as "this has been verified"
 * when what happened is that somebody wrote a document.
 */
export function observationsFrom(facts: RunFacts): readonly Observation[] {
  const observations: Observation[] = []
  const declared = facts.declaration?.expectedEvidence ?? []
  const dimensions = facts.declaration?.contributes ?? []
  const first = dimensions[0]

  for (const step of facts.steps) {
    const failed = step.timedOut === true || (step.exitCode ?? 1) !== 0
    const isCheck =
      facts.checkCommand !== undefined &&
      step.command !== undefined &&
      step.command.includes(facts.checkCommand)

    if (step.uses === 'shell' || isCheck) {
      observations.push({
        kind: 'gate_result',
        status: failed ? 'failed' : 'passed',
        summary: step.timedOut === true
          ? `${step.phase} step ${step.index} was killed after its deadline`
          : `${step.phase} step ${step.index} exited ${String(step.exitCode ?? 'without starting')}`,
        source: facts.workflow,
        runId: facts.runId,
        ...(step.stepId === undefined ? {} : { stepId: step.stepId }),
        ...(step.command === undefined ? {} : { reference: step.command }),
        ...(isCheck && !failed ? { satisfies: 'regression_checks' } : {}),
        ...(first === undefined ? {} : { dimension: first }),
      })
      continue
    }

    if (failed) {
      observations.push({
        kind: 'runtime_observation',
        status: 'failed',
        summary: `${step.phase} step ${step.index} did not succeed`,
        source: facts.workflow,
        runId: facts.runId,
        ...(step.stepId === undefined ? {} : { stepId: step.stepId }),
        ...(first === undefined ? {} : { dimension: first }),
      })
    }
  }

  // A refusal is the strongest evidence Factory has that something did not
  // happen, and the CLI's own words come with it.
  for (const denial of facts.denials) {
    observations.push({
      kind: denial.command === undefined ? 'path_refused' : 'command_refused',
      status: 'failed',
      summary:
        denial.command === undefined
          ? `The agent was refused ${denial.describe}`
          : `The agent could not run \`${denial.command}\``,
      source: facts.workflow,
      runId: facts.runId,
      ...(denial.command === undefined
        ? denial.path === undefined
          ? {}
          : { reference: denial.path }
        : { reference: denial.command }),
    })
  }

  for (const artifact of facts.artifacts) {
    observations.push({
      kind: artifact.missing ? 'artifact_missing' : 'artifact',
      status: artifact.missing ? 'missing' : 'passed',
      summary: artifact.missing
        ? `${artifact.name} was promised and is not there`
        : `${artifact.name} (${String(artifact.bytes)} bytes)`,
      source: facts.workflow,
      runId: facts.runId,
      reference: artifact.name,
      ...(first === undefined ? {} : { dimension: first }),
      // Only a declaration earns coverage, and only for a workflow that
      // actually produced what it promised.
      ...(artifact.missing || declared.length === 0 ? {} : { satisfies: declared[0] as string }),
    })
  }

  // The rest of a declaration is credited once the run got through, because a
  // workflow that declared it would collect three things and then failed has
  // not collected them.
  if (facts.status === 'completed' && declared.length > 1) {
    for (const key of declared.slice(1)) {
      observations.push({
        kind: 'review_result',
        status: 'passed',
        summary: `${facts.workflow} reported ${key}`,
        source: facts.workflow,
        runId: facts.runId,
        satisfies: key,
        ...(first === undefined ? {} : { dimension: first }),
      })
    }
  }

  return observations
}

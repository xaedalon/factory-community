import type { FactoryPlugin } from '../host.js'
import {
  RELIABILITY_EVALUATOR_KIND,
  dimensionsFromEvidence,
  type EvaluatorInput,
  type EvaluatorOutput,
  type ProposedFinding,
  type ReliabilityEvaluatorCapability,
} from '../reliability/evaluator.js'
import type { DriverOwner, Observation, ReliabilityDimension } from '../reliability/model.js'

/**
 * The evaluator that costs nothing and is always right about what it saw.
 *
 * It has no opinions. Everything it produces is a restatement of something
 * Factory observed: a command was refused, a gate failed, an artifact was
 * promised and did not arrive. That makes it reproducible, free, and impossible
 * to flatter — and it is why it always runs, whatever else is configured.
 *
 * What it cannot do is notice that the requirements are ambiguous or that the
 * approach will not survive contact with the existing architecture. That is
 * what an agent evaluator is for, and the two are deliberately the same
 * capability kind so the second is an addition rather than a replacement.
 *
 * Registered through the capability seam rather than called directly, because a
 * built-in that cannot be expressed through the extension API means the API is
 * wrong — and a third party shipping an evaluator for their own provider should
 * find the door already open.
 */

/** What a refused command means, and who can do something about it. */
function fromDenial(observation: Observation): ProposedFinding | undefined {
  if (observation.kind === 'command_refused') {
    return {
      title: `Could not run ${observation.reference ?? 'a command it needed'}`,
      description:
        'The agent was refused this command, so whatever it was for did not happen. ' +
        'Everything reported afterwards was reported without it.',
      type: 'environment',
      severity: 'high',
      // A person's decision: the remedy is the provider's allow-list or the
      // project's profile, and neither is the agent's to change.
      owner: 'developer',
      dimension: 'implementation',
      scoreImpact: -6,
      recommendedAction: {
        type: 'developer_decision',
        label: `Allow \`${observation.reference ?? 'the command'}\`, or run this project under Full Access`,
      },
      evidenceRefs: observation.reference === undefined ? [] : [observation.reference],
    }
  }
  if (observation.kind === 'path_refused') {
    return {
      title: `Refused a path outside the workspace`,
      description: observation.summary,
      type: 'environment',
      severity: 'medium',
      owner: 'developer',
      dimension: 'implementation',
      scoreImpact: -2,
      recommendedAction: {
        type: 'developer_decision',
        label: 'Grant the directory for this project, or leave it refused',
      },
      evidenceRefs: observation.reference === undefined ? [] : [observation.reference],
    }
  }
  return undefined
}

/** A gate that failed is the least ambiguous bad news there is. */
function fromFailedGate(observation: Observation): ProposedFinding {
  return {
    title: `A check failed: ${observation.reference ?? observation.summary}`,
    description: observation.summary,
    type: 'regression',
    severity: 'high',
    // Agent-addressable: a red check is something Factory can be sent at.
    owner: 'agent',
    dimension: 'regressionSafety',
    scoreImpact: -5,
    evidenceRefs: observation.reference === undefined ? [] : [observation.reference],
  }
}

/** A promise a run made and did not keep. */
function fromMissingArtifact(observation: Observation): ProposedFinding {
  return {
    title: `${observation.reference ?? 'A document'} was promised and is not there`,
    description:
      'A step declared it would write this and the file is missing, so whatever it ' +
      'was meant to record is not recorded.',
    type: 'testing',
    severity: 'medium',
    owner: 'agent',
    dimension: 'understanding',
    scoreImpact: -3,
    evidenceRefs: observation.reference === undefined ? [] : [observation.reference],
  }
}

/**
 * One finding per distinct thing, however many times it was seen.
 *
 * A run refused the same command eleven times has one problem, not eleven —
 * the same rule `DenialScanner` follows, for the same reason.
 */
function deduplicate(findings: readonly ProposedFinding[]): readonly ProposedFinding[] {
  const seen = new Map<string, ProposedFinding>()
  for (const finding of findings) {
    const key = `${finding.type}:${finding.title}`
    if (!seen.has(key)) seen.set(key, finding)
  }
  return [...seen.values()]
}

function evaluate(input: EvaluatorInput): EvaluatorOutput {
  const findings: ProposedFinding[] = []

  for (const observation of input.latest) {
    const denial = fromDenial(observation)
    if (denial !== undefined) {
      findings.push(denial)
      continue
    }
    if (observation.kind === 'gate_result' && observation.status === 'failed') {
      findings.push(fromFailedGate(observation))
      continue
    }
    if (observation.kind === 'artifact_missing') {
      findings.push(fromMissingArtifact(observation))
    }
  }

  // A finding already on the task is not a new finding. Whether the existing
  // one should be resolved is a question about the world rather than about this
  // run, so it is left alone — an evaluator that resolved its own findings
  // whenever they stopped appearing would clear a regression by not looking.
  const existing = new Set(input.drivers.map((driver) => driver.title))
  const fresh = deduplicate(findings).filter((finding) => !existing.has(finding.title))

  const dimensions = dimensionsFromEvidence(input.observations, input.policy)
  const assessed = Object.fromEntries(
    Object.entries(dimensions).map(([dimension, score]) => [
      dimension,
      { score, rationale: rationaleFor(dimension as ReliabilityDimension, input) },
    ]),
  )

  return {
    dimensions: assessed,
    drivers: fresh,
    summary: summarise(fresh.length, input.latest.length),
  }
}

/** Why a dimension reads what it reads, in terms of what was collected. */
function rationaleFor(dimension: ReliabilityDimension, input: EvaluatorInput): string {
  const expected = input.policy.expectedEvidence.filter((e) => e.dimension === dimension)
  const satisfied = new Set(
    input.observations
      .filter((o) => o.satisfies !== undefined && o.status !== 'failed' && o.status !== 'missing')
      .map((o) => o.satisfies as string),
  )
  const missing = expected.filter((e) => !satisfied.has(e.key))
  if (expected.length === 0) return 'Nothing is expected here.'
  if (missing.length === 0) return 'Everything expected here has been collected.'
  return `Still missing: ${missing.map((e) => e.describe).join(', ')}.`
}

function summarise(found: number, seen: number): string {
  if (seen === 0) return 'Nothing new was observed.'
  if (found === 0) return `${String(seen)} observation(s), nothing new to worry about.`
  return `${String(seen)} observation(s), ${String(found)} new to worry about.`
}

export const deterministicEvaluator: ReliabilityEvaluatorCapability = {
  id: 'deterministic',
  displayName: 'What Factory saw',
  summary:
    'Turns exit codes, refused commands and missing artifacts into findings. ' +
    'Always runs, costs nothing, and has no opinions.',
  evaluate,
}

/** Everything a driver this evaluator produced can be owned by. Exported for the docs. */
export const DETERMINISTIC_OWNERS: readonly DriverOwner[] = ['agent', 'developer']

export const reliabilityEvaluatorPlugin: FactoryPlugin = {
  name: '@factory/core/reliability-evaluator',
  version: '0.1.0',
  register(context) {
    context.provide(RELIABILITY_EVALUATOR_KIND, deterministicEvaluator)
  },
}

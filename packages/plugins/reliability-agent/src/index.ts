import {
  RELIABILITY_DIMENSIONS,
  RELIABILITY_EVALUATOR_KIND,
  type EvaluatorInput,
  type EvaluatorOutput,
  type FactoryPlugin,
  type Observation,
  type ProposedFinding,
  type ReliabilityDimension,
  type ReliabilityEvaluatorCapability,
} from '@factory/plugin-sdk'

/**
 * The evaluator that can read.
 *
 * The deterministic evaluator is always right about what it saw and blind to
 * everything it did not. It cannot notice that the requirements were ambiguous,
 * that the approach fights the architecture it landed in, or that the new tests
 * assert the bug. Somebody has to read the work, and on most days nobody will.
 *
 * So this one asks an agent — and is given no more authority for it. It returns
 * dimensions and findings through the same contract the free evaluator uses,
 * and everything it says goes through `normalize` before anything downstream
 * sees it. An agent asked how good its own work is answers 98; this is built on
 * the assumption that it will.
 *
 * It costs money on every run it agrees to, so most of the care here is about
 * declining: no agent to ask, nothing new to look at, or nothing that happened
 * that a reader could have an opinion about.
 */

export const RELIABILITY_AGENT_ID = 'reliability-agent'

/** What is worth paying an agent to look at. */
const INTERESTING_KINDS = new Set([
  'artifact',
  'artifact_missing',
  'command_refused',
  'path_refused',
  'review_result',
])

/**
 * Whether this run changed anything a reader could have an opinion about.
 *
 * An artifact arrived, something was refused, or something went red. A run that
 * only noted an approval has not changed the project, and paying for a re-read
 * of the same evidence is how a per-run cost becomes a per-run waste.
 */
export function worthReading(latest: readonly Observation[]): boolean {
  return latest.some(
    (observation) =>
      INTERESTING_KINDS.has(observation.kind) ||
      observation.status === 'failed' ||
      observation.status === 'missing',
  )
}

/** One observation, as a line an agent can read. */
const line = (observation: Observation): string => {
  const where = observation.source === undefined ? '' : ` [${observation.source}]`
  const what = observation.reference === undefined ? '' : ` (${observation.reference})`
  return `- ${observation.kind}/${observation.status}${where}: ${observation.summary}${what}`
}

/**
 * What the agent is asked.
 *
 * Built from observations Factory recorded, never from the agent's own account
 * of its work: asking an agent to summarise itself and then judging the summary
 * is a machine for laundering a claim into a fact.
 *
 * It asks for dimensions and findings and it does not ask for a score, because
 * there is nowhere to put one — `EvaluatorOutput` has no such field, and asking
 * for something that would be thrown away only teaches the model that its
 * judgement of the total is wanted.
 */
export function promptFor(input: EvaluatorInput): string {
  const evidence =
    input.observations.length === 0
      ? '- (nothing recorded yet)'
      : input.observations.map(line).join('\n')
  const findings =
    input.drivers.length === 0
      ? '- (none)'
      : input.drivers
          .map(
            (driver) =>
              `- ${driver.id} — ${driver.title} [${driver.severity}, ${driver.status}, ` +
              `owner: ${driver.owner}, dimension: ${driver.dimension}]`,
          )
          .join('\n')
  const expected = input.policy.expectedEvidence
    .map((item) => `- ${item.key} (${item.dimension})`)
    .join('\n')

  return [
    'You are reviewing a software task for a system that decides, on its own, how',
    'much to trust the work. You do not decide that. You report what you find.',
    '',
    `## The task`,
    `Name: ${input.task.name}`,
    `Description: ${input.task.description === '' ? '(none given)' : input.task.description}`,
    '',
    '## What Factory observed',
    'These are recorded facts, not claims. Judge the work against them.',
    evidence,
    '',
    '## Findings already on this task',
    findings,
    '',
    '## The evidence this policy expects',
    expected,
    '',
    '## The dimensions',
    RELIABILITY_DIMENSIONS.map((dimension) => `- ${dimension}`).join('\n'),
    '',
    '## Answer with JSON and nothing else',
    'Shape:',
    '{',
    '  "dimensions": { "<dimension>": { "score": 0-100, "rationale": "one sentence" } },',
    '  "drivers": [{',
    '    "title": "short", "description": "what and why", "type": "regression|ambiguity|design|environment|coverage",',
    '    "severity": "critical|high|medium|low", "owner": "agent|developer",',
    '    "dimension": "<dimension>", "scoreImpact": -15..0',
    '  }],',
    '  "resolves": ["<id of a finding above that is no longer true>"],',
    '  "summary": "one sentence a person would read first"',
    '}',
    '',
    'Only dimensions from the list. Only findings you can point at evidence for.',
    'Omit a dimension you have nothing to say about rather than guessing at it.',
  ].join('\n')
}

/** Anything that is not a number is not a score. */
const numberOr = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/**
 * Find the object in whatever came back.
 *
 * Every CLI wraps JSON differently and some of them apologise first. Reading
 * only a bare object fails on the common case; reading anything at all fails
 * silently on the dangerous one — an evaluator that returns an empty judgement
 * for an unreadable answer has reported "nothing was wrong".
 */
export function extractJson(raw: string): unknown {
  const attempts: string[] = []
  const trimmed = raw.trim()
  attempts.push(trimmed)

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)
  if (fenced?.[1] !== undefined) attempts.push(fenced[1].trim())

  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  if (first !== -1 && last > first) attempts.push(trimmed.slice(first, last + 1))

  for (const attempt of attempts) {
    if (attempt === '') continue
    try {
      const parsed: unknown = JSON.parse(attempt)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed
    } catch {
      // The next shape, or none.
    }
  }
  return undefined
}

/**
 * Read an answer into the contract.
 *
 * Deliberately narrow: a key this does not read is a key that cannot reach the
 * score engine, and `score` is the one it must never read. Dropping it here as
 * well as in `normalize` is not redundant — this is the first of two, and the
 * only one a plugin author writing their own evaluator would see.
 */
export function readEvaluation(raw: string): EvaluatorOutput {
  const parsed = extractJson(raw)
  if (parsed === undefined) {
    throw new Error(
      'The evaluator could not be read: the answer was not JSON. ' +
        `It began: ${raw.trim().slice(0, 120)}`,
    )
  }
  const body = parsed as Record<string, unknown>

  const dimensions: EvaluatorOutput['dimensions'] = {}
  const given = body['dimensions']
  if (typeof given === 'object' && given !== null) {
    for (const [name, value] of Object.entries(given as Record<string, unknown>)) {
      if (!(RELIABILITY_DIMENSIONS as readonly string[]).includes(name)) continue
      if (typeof value !== 'object' || value === null) continue
      const entry = value as Record<string, unknown>
      dimensions[name as ReliabilityDimension] = {
        score: numberOr(entry['score'], 0),
        rationale: text(entry['rationale']),
      }
    }
  }

  const drivers: ProposedFinding[] = []
  const proposed = body['drivers']
  if (Array.isArray(proposed)) {
    for (const value of proposed) {
      if (typeof value !== 'object' || value === null) continue
      const entry = value as Record<string, unknown>
      drivers.push({
        title: text(entry['title']),
        description: text(entry['description']),
        type: text(entry['type']) || 'unknown',
        // Left as the agent said them: `normalize` owns the vocabulary, and a
        // second opinion about what a severity is would be a second place to
        // keep the list.
        severity: entry['severity'] as ProposedFinding['severity'],
        owner: entry['owner'] as ProposedFinding['owner'],
        dimension: entry['dimension'] as ReliabilityDimension,
        scoreImpact: numberOr(entry['scoreImpact'], 0),
        evidenceRefs: Array.isArray(entry['evidenceRefs'])
          ? (entry['evidenceRefs'] as unknown[]).filter(
              (reference): reference is string => typeof reference === 'string',
            )
          : [],
      })
    }
  }

  const resolves = Array.isArray(body['resolves'])
    ? (body['resolves'] as unknown[]).filter((id): id is string => typeof id === 'string')
    : []

  return { dimensions, drivers, resolves, summary: text(body['summary']) }
}

export const reliabilityAgentEvaluator: ReliabilityEvaluatorCapability = {
  id: RELIABILITY_AGENT_ID,
  summary: 'Asks an agent to read the work and say what is still uncertain.',
  wants: (input) => input.agent !== undefined && worthReading(input.latest),
  async evaluate(input) {
    const agent = input.agent
    // Reachable: `wants` is advice the host may ignore, and an evaluator that
    // assumed otherwise would throw a TypeError instead of a sentence.
    if (agent === undefined) {
      throw new Error(
        'There is no agent to ask. Choose a model for this project, or leave judging to ' +
          'the free evaluator.',
      )
    }
    let answer: string
    try {
      answer = await agent.ask(promptFor(input))
    } catch (error) {
      throw new Error(
        `The evaluator could not be reached: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      )
    }
    return readEvaluation(answer)
  },
}

const plugin: FactoryPlugin = {
  name: '@factory/reliability-agent',
  version: '0.1.0',
  register(context) {
    context.provide(RELIABILITY_EVALUATOR_KIND, reliabilityAgentEvaluator)
  },
}

export default plugin

import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import fc from 'fast-check'
import {
  RELIABILITY_DIMENSIONS,
  type ReliabilityDimension,
} from '../src/reliability/model.js'
import { EventBus } from '@factory/events'
import { CapabilityHost } from '../src/host.js'
import { builtinStepsPlugin } from '../src/builtins/steps.js'
import { parsePhaseFile, parseWorkflowFile } from '../src/yaml/parse.js'
import {
  updateExistingWorkflow,
  writeNewPhase,
  writeNewWorkflow,
} from '../src/yaml/serialize.js'
import type { Workflow } from '../src/schema/workflow.js'
import type { Phase } from '../src/schema/phase.js'

const feature = await loadFeature(
  fileURLToPath(new URL('./round-trip-properties.feature', import.meta.url)),
)

const host = new CapabilityHost({ events: new EventBus({ onSubscriberError: () => {} }) })
await host.load(builtinStepsPlugin)

/**
 * Arbitraries are hand-written rather than derived from the zod schema, so the
 * string alphabet can be seeded with the values that actually break YAML
 * round-trips. A generic generator would emit tidy identifiers and prove very
 * little.
 */
const NASTY = [
  '[ ! -d dist ] && npm run build',
  'yes',
  'no',
  'on',
  'off',
  'null',
  '~',
  '0755',
  '1.0',
  '#hash',
  'a: b',
  '- dash',
  '*anchor',
  '&ref',
  '%directive',
  '@at',
  '`backtick`',
  "'single'",
  '"double"',
  '  padded  ',
  'trailing ',
  'line\nbreak',
  '',
]

const text = fc.oneof(
  fc.constantFrom(...NASTY),
  fc.string(),
  fc.string({ unit: fc.constantFrom('a', ' ', ':', '-', '#', '\n', '"', "'", '{', '[') }),
)
const nonEmptyText = text.filter((value) => value.length > 0)
const slugArb = fc
  .stringMatching(/^[a-z][a-z0-9-]{0,12}$/)
  .filter((value) => /^[a-z][a-z0-9-]*$/.test(value))
const varsArb = fc.dictionary(slugArb, text, { maxKeys: 3 })

const workflowArb: fc.Arbitrary<Workflow> = fc
  .record({
    name: slugArb,
    description: text,
    mode: fc.constantFrom('once' as const, 'loop' as const),
    interval: fc.option(fc.integer({ min: 1, max: 3600 }), { nil: undefined }),
    scheduling: fc.constantFrom('sequential' as const, 'parallel' as const),
    variables: varsArb,
    conditions: fc.option(
      fc.record({
        requires: fc.array(slugArb, { maxLength: 3 }),
        // Optional in the schema, so the generator must produce both shapes:
        // a `provides` that is absent must stay absent through a save.
        provides: fc.option(fc.array(slugArb, { maxLength: 3 }), { nil: undefined }),
        clears: fc.option(fc.array(slugArb, { maxLength: 3 }), { nil: undefined }),
      }),
      { nil: undefined },
    ),
    repeat: fc.option(fc.integer({ min: 1, max: 100 }), { nil: undefined }),
    needs: fc.array(slugArb, { maxLength: 3 }),
    onFail: fc.option(slugArb, { nil: undefined }),
    override: fc.option(fc.constant('required' as const), { nil: undefined }),
    // Optional in the schema, so both shapes are generated: an absent block
    // must stay absent through a save, the same property `conditions` has.
    reliability: fc.option(
      fc.record({
        contributes: fc.array(
          fc.constantFrom(...(RELIABILITY_DIMENSIONS as readonly ReliabilityDimension[])),
          { maxLength: 3 },
        ),
        expected_evidence: fc.array(slugArb, { maxLength: 3 }),
        evaluate_after_run: fc.option(fc.boolean(), { nil: undefined }),
      }),
      { nil: undefined },
    ),
    phases: fc.array(slugArb, { maxLength: 4 }),
  })
  .map((value) => {
    // interval and repeat are only valid on a loop, and the schema enforces it.
    const interval = value.mode === 'loop' ? value.interval : undefined
    const repeat = value.mode === 'loop' ? value.repeat : undefined
    // A workflow that needs itself is a named error, so generating one would
    // fail the round-trip for a reason that has nothing to do with writing.
    const needs = value.needs.filter((name) => name !== value.name)
    return {
      ...value,
      ...(interval === undefined ? { interval: undefined } : { interval }),
      ...(repeat === undefined ? { repeat: undefined } : { repeat }),
      needs,
      extensions: {},
    } as Workflow
  })

const shellStepArb = fc.record({ uses: fc.constant('shell' as const), run: nonEmptyText })
const agentStepArb = fc.record({
  uses: fc.constant('agent' as const),
  prompt: nonEmptyText,
  model: fc.option(fc.constantFrom('strong', 'balanced', 'fast'), { nil: undefined }),
  session: fc.option(fc.constantFrom('task' as const, 'workflow' as const), { nil: undefined }),
})

const phaseArb: fc.Arbitrary<Phase> = fc
  .record({
    name: slugArb,
    description: text,
    approval: fc.constantFrom('none' as const, 'before' as const, 'after' as const),
    workingDir: fc.option(nonEmptyText, { nil: undefined }),
    variables: varsArb,
    steps: fc.array(fc.oneof(shellStepArb, agentStepArb), { maxLength: 4 }),
  })
  .map((value) => ({ ...value, extensions: {} }) as Phase)

/** Strip undefined-valued keys so comparison is about content, not absence style. */
const compact = (value: unknown): unknown => JSON.parse(JSON.stringify(value))

describeFeature(feature, ({ Scenario, ScenarioOutline }) => {
  Scenario('A workflow survives being written and read back', ({ When, Then }) => {
    let ok = false
    When('500 arbitrary workflows are written and parsed again', () => {
      fc.assert(
        fc.property(workflowArb, (workflow) => {
          const text = writeNewWorkflow(workflow)
          const back = parseWorkflowFile(text, 'generated.yaml')
          expect(back.problems.filter((p) => p.severity === 'error')).toEqual([])
          expect(compact(back.value)).toEqual(compact(workflow))
        }),
        { numRuns: 500 },
      )
      ok = true
    })
    Then('every one is identical to what was written', () => expect(ok).toBe(true))
  })

  Scenario('A phase survives being written and read back', ({ When, Then }) => {
    let ok = false
    When('500 arbitrary phases are written and parsed again', () => {
      fc.assert(
        fc.property(phaseArb, (phase) => {
          const text = writeNewPhase(phase, host)
          const back = parsePhaseFile(text, host, 'generated.yaml')
          expect(back.problems.filter((p) => p.severity === 'error')).toEqual([])
          expect(compact(back.value)).toEqual(compact(phase))
        }),
        { numRuns: 500 },
      )
      ok = true
    })
    Then('every one is identical to what was written', () => expect(ok).toBe(true))
  })

  Scenario('Writing is idempotent', ({ When, Then }) => {
    let ok = false
    When('200 arbitrary workflows are written twice', () => {
      fc.assert(
        fc.property(workflowArb, (workflow) => {
          const once = writeNewWorkflow(workflow)
          const twice = writeNewWorkflow(parseWorkflowFile(once, 'g.yaml').value as Workflow)
          expect(twice).toBe(once)
        }),
        { numRuns: 200 },
      )
      ok = true
    })
    Then('the second output equals the first', () => expect(ok).toBe(true))
  })

  Scenario('Updating a canonical file changes nothing', ({ When, Then }) => {
    let ok = false
    When('200 arbitrary workflows are written and then updated with no changes', () => {
      fc.assert(
        fc.property(workflowArb, (workflow) => {
          const text = writeNewWorkflow(workflow)
          const parsed = parseWorkflowFile(text, 'g.yaml').value as Workflow
          expect(updateExistingWorkflow(text, parsed)).toBe(text)
        }),
        { numRuns: 200 },
      )
      ok = true
    })
    Then('the file is unchanged every time', () => expect(ok).toBe(true))
  })

  ScenarioOutline('Awkward command strings survive a round trip', ({ Given, When, Then }, vars) => {
    let command = ''
    let roundTripped: string | undefined
    Given('a phase whose only step runs <command>', () => {
      command = String(vars.command).replace(/\\n/g, '\n')
    })
    When('the phase is written and parsed again', () => {
      const phase = {
        name: 'build',
        description: '',
        approval: 'none',
        variables: {},
        steps: [{ uses: 'shell', run: command }],
        extensions: {},
      } as unknown as Phase
      const text = writeNewPhase(phase, host)
      const back = parsePhaseFile(text, host, 'generated.yaml')
      expect(back.problems.filter((p) => p.severity === 'error')).toEqual([])
      roundTripped = back.value?.steps[0]?.run as string | undefined
    })
    Then('the step still runs exactly <command>', () => {
      expect(roundTripped).toBe(command)
    })
  })
})

import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import {
  RELIABILITY_DIMENSIONS,
  type Observation,
  type ReliabilityDimension,
  type ReliabilityDriver,
} from '../src/reliability/model.js'
import { DEFAULT_RELIABILITY_POLICY as policy } from '../src/reliability/policy.js'
import {
  dimensionsFromEvidence,
  normalize,
  type EvaluatorInput,
  type EvaluatorOutput,
  type NormalizedEvaluation,
  type ProposedFinding,
} from '../src/reliability/evaluator.js'
import { deterministicEvaluator } from '../src/builtins/reliability.js'
import { observationsFrom, type RunFacts } from '../src/reliability/observations.js'

const feature = await loadFeature(
  fileURLToPath(new URL('./reliability-evaluator.feature', import.meta.url)),
)

describeFeature(feature, ({ Rule, BeforeEachScenario }) => {
  let output: EvaluatorOutput
  let result: NormalizedEvaluation
  let workflows: string[]
  let known: Set<string>
  let dimensions: Record<string, number>
  let observations: Observation[]
  let judged: EvaluatorOutput

  BeforeEachScenario(() => {
    workflows = []
    known = new Set()
    observations = []
  })

  /** A finding with everything the contract needs and nothing a scenario is about. */
  const finding = (over: Partial<ProposedFinding> = {}): ProposedFinding =>
    ({
      title: 'a finding',
      type: 'testing',
      severity: 'medium',
      owner: 'agent',
      dimension: 'regressionSafety',
      scoreImpact: -3,
      ...over,
    }) as ProposedFinding

  const run = (): void => {
    result = normalize(output, policy, { known, workflows })
  }
  const noted = (fragment: string) => (): void => {
    const all = result.notes.map((note) => note.reason).join(' | ')
    expect(all).toContain(fragment)
  }
  const survives = (): void => expect(result.drivers).toHaveLength(1)
  const noneSurvive = (): void => expect(result.drivers).toEqual([])

  Rule('an evaluator cannot set the score by another name', ({ RuleScenario }) => {
    RuleScenario('A finding cannot move the score further than the policy allows', ({
      When,
      Then,
      And,
    }) => {
      When('an evaluator proposes a finding costing 80', () => {
        output = { dimensions: {}, drivers: [finding({ scoreImpact: -80 })] }
        run()
      })
      Then('the finding survives', survives)
      And('its impact is bounded by the policy', () =>
        expect(result.drivers[0]?.scoreImpact).toBe(-policy.maxDriverImpact),
      )
      And('a note says the impact was bounded', noted('bounded'))
    })

    RuleScenario('A positive impact is bounded too', ({ When, Then }) => {
      When('an evaluator proposes a finding worth 80', () => {
        output = { dimensions: {}, drivers: [finding({ scoreImpact: 80 })] }
        run()
      })
      Then('its impact is bounded by the policy', () =>
        expect(result.drivers[0]?.scoreImpact).toBe(policy.maxDriverImpact),
      )
    })

    RuleScenario('A dimension score above one hundred is brought into range', ({
      When,
      Then,
      And,
    }) => {
      When('an evaluator scores "design" at 150', () => {
        output = { dimensions: { design: { score: 150, rationale: '' } }, drivers: [] }
        run()
      })
      Then('"design" is 100', () => expect(result.dimensions.design?.score).toBe(100))
      And('a note says the score was brought into range', noted('brought into range'))
    })

    RuleScenario('A dimension score below zero is brought into range', ({ When, Then }) => {
      When('an evaluator scores "design" at -20', () => {
        output = { dimensions: { design: { score: -20, rationale: '' } }, drivers: [] }
        run()
      })
      Then('"design" is 0', () => expect(result.dimensions.design?.score).toBe(0))
    })
  })

  Rule('what is not in the vocabulary does not enter it', ({ RuleScenario }) => {
    RuleScenario('A dimension Factory does not have is dropped', ({ When, Then, And }) => {
      When('an evaluator scores "vibes" at 99', () => {
        output = {
          dimensions: { vibes: { score: 99, rationale: '' } } as EvaluatorOutput['dimensions'],
          drivers: [],
        }
        run()
      })
      Then('no dimension called "vibes" survives', () =>
        expect(Object.keys(result.dimensions)).not.toContain('vibes'),
      )
      And('a note says it is not a dimension', noted('not a dimension'))
    })

    RuleScenario('A severity Factory does not have loses the finding', ({ When, Then, And }) => {
      When('an evaluator proposes a finding of "catastrophic" severity', () => {
        output = {
          dimensions: {},
          drivers: [finding({ severity: 'catastrophic' as ProposedFinding['severity'] })],
        }
        run()
      })
      Then('no finding survives', noneSurvive)
      And('a note says the severity is not one', noted('severity'))
    })

    RuleScenario('An owner Factory does not have loses the finding', ({ When, Then, And }) => {
      When('an evaluator proposes a finding owned by "the universe"', () => {
        output = {
          dimensions: {},
          drivers: [finding({ owner: 'the universe' as ProposedFinding['owner'] })],
        }
        run()
      })
      Then('no finding survives', noneSurvive)
      And('a note says the owner is not one', noted('owner'))
    })

    RuleScenario('A finding with no title is dropped', ({ When, Then }) => {
      When('an evaluator proposes a finding with no title', () => {
        output = { dimensions: {}, drivers: [finding({ title: '   ' })] }
        run()
      })
      Then('no finding survives', noneSurvive)
    })

    RuleScenario('A dimension Factory does not have is corrected, not dropped', ({
      When,
      Then,
      And,
    }) => {
      When('an evaluator proposes a finding about "vibes"', () => {
        output = {
          dimensions: {},
          drivers: [finding({ dimension: 'vibes' as ReliabilityDimension })],
        }
        run()
      })
      Then('the finding survives', survives)
      And('it is filed under "understanding"', () =>
        expect(result.drivers[0]?.dimension).toBe('understanding'),
      )
      And('a note says where it was filed', noted('filed under understanding'))
    })
  })

  Rule('a recommendation has to be one somebody can take', ({ RuleScenario }) => {
    const recommending = (): void => {
      output = {
        dimensions: {},
        drivers: [
          finding({
            recommendedAction: {
              type: 'workflow',
              workflow: 'checkout-regression',
              label: 'Run it',
            },
          }),
        ],
      }
      run()
    }

    RuleScenario('A workflow the project has is kept', ({ Given, When, Then }) => {
      Given('the project has a "checkout-regression" workflow', () => {
        workflows = ['checkout-regression']
      })
      When('an evaluator recommends running "checkout-regression"', recommending)
      Then('the recommendation survives', () =>
        expect(result.drivers[0]?.recommendedAction?.workflow).toBe('checkout-regression'),
      )
    })

    RuleScenario('A workflow the project does not have is dropped', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given('the project has no workflows', () => {
        workflows = []
      })
      When('an evaluator recommends running "checkout-regression"', recommending)
      Then('the finding survives', survives)
      And('it carries no recommendation', () =>
        expect(result.drivers[0]?.recommendedAction).toBeUndefined(),
      )
      And('a note says the workflow is not there', noted('does not have'))
    })
  })

  Rule('an evaluator may only resolve something that exists', ({ RuleScenario }) => {
    RuleScenario('Resolving a real driver is allowed', ({ Given, When, Then }) => {
      Given('the task has a driver', () => {
        known = new Set(['driver-1'])
      })
      When('an evaluator resolves that driver', () => {
        output = { dimensions: {}, drivers: [], resolves: ['driver-1'] }
        run()
      })
      Then('the resolution survives', () => expect(result.resolves).toEqual(['driver-1']))
    })

    RuleScenario('Resolving an invented driver is refused', ({ Given, When, Then, And }) => {
      Given('the task has a driver', () => {
        known = new Set(['driver-1'])
      })
      When('an evaluator resolves "driver-that-never-was"', () => {
        output = { dimensions: {}, drivers: [], resolves: ['driver-that-never-was'] }
        run()
      })
      Then('no resolution survives', () => expect(result.resolves).toEqual([]))
      And('a note says there is no such driver', noted('no such driver'))
    })
  })

  Rule('dimensions follow the evidence rather than an opinion', ({ RuleScenario }) => {
    const read = (): void => {
      dimensions = dimensionsFromEvidence(observations, policy)
    }
    const satisfying = (key: string): Observation => ({
      kind: 'artifact',
      status: 'passed',
      summary: key,
      satisfies: key,
    })
    const designEvidence = (): void => {
      observations = policy.expectedEvidence
        .filter((expected) => expected.dimension === 'design')
        .map((expected) => satisfying(expected.key))
    }

    RuleScenario('No evidence sits at the baseline', ({ Given, When, Then }) => {
      Given('nothing has been observed', () => {
        observations = []
      })
      When('dimensions are read from the evidence', read)
      Then('every dimension is the policy baseline', () => {
        for (const dimension of RELIABILITY_DIMENSIONS) {
          expect(dimensions[dimension], dimension).toBe(policy.baseline)
        }
      })
    })

    RuleScenario('Evidence raises the dimension it belongs to', ({ Given, When, Then, And }) => {
      Given('everything expected of "design" has been observed', designEvidence)
      When('dimensions are read from the evidence', read)
      Then('"design" is above the baseline', () =>
        expect(dimensions['design']).toBeGreaterThan(policy.baseline),
      )
      And('"verification" is still the baseline', () =>
        expect(dimensions['verification']).toBe(policy.baseline),
      )
    })

    RuleScenario('Collected evidence alone does not reach one hundred', ({
      Given,
      When,
      Then,
    }) => {
      Given('everything expected has been observed', () => {
        observations = policy.expectedEvidence.map((expected) => satisfying(expected.key))
      })
      When('dimensions are read from the evidence', read)
      Then('no dimension reaches 100', () => {
        for (const dimension of RELIABILITY_DIMENSIONS) {
          expect(dimensions[dimension], dimension).toBeLessThan(100)
        }
      })
    })

    RuleScenario('A failure on its own does not lower the dimension', ({
      Given,
      And,
      When,
      Then,
    }) => {
      let without = 0
      Given('everything expected of "design" has been observed', () => {
        designEvidence()
        without = dimensionsFromEvidence(observations, policy)['design'] as number
      })
      And('a failure was seen in "design"', () => {
        observations = [
          ...observations,
          { kind: 'runtime_observation', status: 'failed', summary: 'it broke', dimension: 'design' },
        ]
      })
      When('dimensions are read from the evidence', read)
      Then('"design" is what the evidence alone supports', () =>
        expect(dimensions['design']).toBe(without),
      )
    })
  })

  Rule('what Factory saw becomes findings without interpretation', ({ RuleScenario }) => {
    let drivers: ReliabilityDriver[] = []

    const facts = (over: Partial<RunFacts> = {}): RunFacts => ({
      runId: 'run-1',
      workflow: 'validate',
      status: 'completed',
      steps: [],
      denials: [],
      artifacts: [],
      ...over,
    })

    const judge = (given: RunFacts): void => {
      const latest = observationsFrom(given)
      const input: EvaluatorInput = {
        taskId: 'task-1',
        task: { name: 'a task', description: '' },
        observations: latest,
        latest,
        drivers,
        policy,
        workflows: [],
      }
      judged = deterministicEvaluator.evaluate(input) as EvaluatorOutput
    }

    const refusedCommand = (times = 1): RunFacts =>
      facts({
        denials: Array.from({ length: times }, (_, index) => ({
          id: `command-refused:pnpm-${String(index)}`,
          describe: 'permission to run `pnpm install`',
          command: 'pnpm install',
          evidence: 'Permission for this tool use was denied.',
        })),
      })

    RuleScenario('A refused command becomes a finding a person owns', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given('a run where a command was refused', () => {
        drivers = []
      })
      When('the deterministic evaluator judges it', () => judge(refusedCommand()))
      Then('it proposes a finding', () => expect(judged.drivers).toHaveLength(1))
      And('the finding is owned by the developer', () =>
        expect(judged.drivers[0]?.owner).toBe('developer'),
      )
      And('the finding names the command', () =>
        expect(judged.drivers[0]?.title).toContain('pnpm install'),
      )
    })

    RuleScenario('A failed check becomes a finding an agent owns', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given("a run where the project's checks failed", () => {
        drivers = []
      })
      When('the deterministic evaluator judges it', () =>
        judge(
          facts({
            status: 'failed',
            checkCommand: 'pnpm test',
            steps: [
              { phase: 'project-check', index: 0, uses: 'shell', exitCode: 1, command: 'pnpm test' },
            ],
          }),
        ),
      )
      Then('it proposes a finding', () => expect(judged.drivers).toHaveLength(1))
      And('the finding is owned by the agent', () => expect(judged.drivers[0]?.owner).toBe('agent'))
    })

    RuleScenario('A promised document that never arrived becomes a finding', ({
      Given,
      When,
      Then,
    }) => {
      Given('a run that promised a document and did not write it', () => {
        drivers = []
      })
      When('the deterministic evaluator judges it', () =>
        judge(facts({ artifacts: [{ name: 'analysis', bytes: 0, missing: true }] })),
      )
      Then('it proposes a finding', () => expect(judged.drivers).toHaveLength(1))
    })

    RuleScenario('The same refusal eleven times is one finding', ({ Given, When, Then }) => {
      Given('a run where the same command was refused eleven times', () => {
        drivers = []
      })
      When('the deterministic evaluator judges it', () => judge(refusedCommand(11)))
      Then('it proposes 1 finding', () => expect(judged.drivers).toHaveLength(1))
    })

    RuleScenario('A finding the task already has is not proposed again', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('a run where a command was refused', () => {
        drivers = []
      })
      And('the task already has that finding', () => {
        drivers = [
          {
            id: 'existing',
            taskId: 'task-1',
            title: 'Could not run pnpm install',
            description: '',
            type: 'environment',
            severity: 'high',
            status: 'open',
            owner: 'developer',
            dimension: 'implementation',
            scoreImpact: -6,
            evidenceRefs: [],
            introducedBy: {},
            createdAt: '',
            updatedAt: '',
          },
        ]
      })
      When('the deterministic evaluator judges it', () => judge(refusedCommand()))
      Then('it proposes no findings', () => expect(judged.drivers).toEqual([]))
    })

    RuleScenario('A clean run proposes nothing', ({ Given, When, Then }) => {
      Given('a run where everything succeeded', () => {
        drivers = []
      })
      When('the deterministic evaluator judges it', () =>
        judge(
          facts({
            steps: [{ phase: 'work', index: 0, uses: 'agent', exitCode: 0 }],
            artifacts: [{ name: 'analysis', bytes: 400, missing: false }],
          }),
        ),
      )
      Then('it proposes no findings', () => expect(judged.drivers).toEqual([]))
    })

    RuleScenario('It never returns a score', ({ Given, When, Then }) => {
      Given('a run where everything succeeded', () => {
        drivers = []
      })
      When('the deterministic evaluator judges it', () =>
        judge(facts({ steps: [{ phase: 'work', index: 0, uses: 'agent', exitCode: 0 }] })),
      )
      // Not "the score is right" — there is no field it could be in, and a
      // scenario that checked a value would pass the day somebody added one.
      Then('what it returns has no score in it', () => {
        expect(judged).not.toHaveProperty('score')
        expect(judged).not.toHaveProperty('reliability')
        expect(Object.keys(judged).sort()).toEqual(['dimensions', 'drivers', 'summary'])
      })
    })
  })
})

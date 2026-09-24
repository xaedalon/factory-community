import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_RELIABILITY_POLICY,
  RELIABILITY_DIMENSIONS,
  type EvaluatorAgent,
  type EvaluatorInput,
  type EvaluatorOutput,
  type Observation,
  type ReliabilityDriver,
} from '@factory/plugin-sdk'
import { promptFor, reliabilityAgentEvaluator } from '../src/index.js'

const feature = await loadFeature(
  fileURLToPath(new URL('./reliability-agent.feature', import.meta.url)),
)

/** A finding an agent could resolve, in the shape the store hands back. */
const FINDING: ReliabilityDriver = {
  id: 'drv-1',
  taskId: 'task-1',
  title: 'the checkout total is wrong for one currency',
  description: '',
  type: 'regression',
  severity: 'high',
  status: 'open',
  owner: 'agent',
  dimension: 'regressionSafety',
  scoreImpact: -6,
  evidenceRefs: [],
  introducedBy: {},
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const BODY = {
  dimensions: { design: { score: 72, rationale: 'the approach fights the existing router' } },
  drivers: [],
  summary: 'The design is the weak part.',
}

describeFeature(feature, ({ Rule }) => {
  let latest: Observation[] = []
  let drivers: ReliabilityDriver[] = []
  let agent: EvaluatorAgent | undefined
  let asked = ''
  let askedModel: string | undefined
  let result: EvaluatorOutput | undefined
  let failure: unknown

  const reset = (): void => {
    latest = []
    drivers = []
    agent = undefined
    asked = ''
    askedModel = undefined
    result = undefined
    failure = undefined
  }

  const input = (): EvaluatorInput => ({
    taskId: 'task-1',
    task: { name: 'Add due dates', description: 'Tasks need a date they are wanted by.' },
    observations: latest,
    latest,
    drivers,
    policy: DEFAULT_RELIABILITY_POLICY,
    workflows: ['validate'],
    ...(agent === undefined ? {} : { agent }),
  })

  /** An agent that answers with whatever text a scenario hands it. */
  const answering = (text: string, model?: string): EvaluatorAgent => ({
    ...(model === undefined ? {} : { model }),
    ask: (prompt: string) => {
      asked = prompt
      askedModel = model
      return Promise.resolve(text)
    },
  })

  const evaluate = async (): Promise<void> => {
    try {
      result = await reliabilityAgentEvaluator.evaluate(input())
    } catch (error) {
      failure = error
    }
  }

  const failsSaying = (fragment: string) => (): void => {
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain(fragment)
  }

  const failedGate: Observation = {
    kind: 'gate_result',
    status: 'failed',
    summary: 'pnpm test exited 1',
    source: 'validate',
    reference: 'pnpm test',
  }
  const wroteArtifact: Observation = {
    kind: 'artifact',
    status: 'passed',
    summary: 'technical-approach.md',
    source: 'design',
    satisfies: 'technical_approach',
  }
  const refused: Observation = {
    kind: 'command_refused',
    status: 'failed',
    summary: 'the agent was refused a command',
    reference: 'docker compose up',
  }
  const approval: Observation = {
    kind: 'approval',
    status: 'noted',
    summary: 'a person approved the plan',
  }

  Rule('it declines rather than costing anything it cannot spend well', ({ RuleScenario }) => {
    const wants = (expected: boolean) => (): void => {
      expect(reliabilityAgentEvaluator.wants?.(input())).toBe(expected)
    }

    RuleScenario('With nothing to ask, it does not run', ({ Given, But, Then }) => {
      Given('a run that failed a gate', () => {
        reset()
        latest = [failedGate]
      })
      But('no agent to ask', () => {
        agent = undefined
      })
      Then('the evaluator does not want to run', wants(false))
    })

    RuleScenario('With nothing new, it does not run', ({ Given, But, Then }) => {
      Given('an agent to ask', () => {
        reset()
        agent = answering('{}')
      })
      But('a run that produced nothing', () => {
        latest = []
      })
      Then('the evaluator does not want to run', wants(false))
    })

    RuleScenario('A run that only noted things does not earn a judgement', ({
      Given,
      And,
      Then,
    }) => {
      Given('an agent to ask', () => {
        reset()
        agent = answering('{}')
      })
      And('a run whose only observation is an approval', () => {
        latest = [approval]
      })
      Then('the evaluator does not want to run', wants(false))
    })

    RuleScenario('New work is worth looking at', ({ Given, And, Then }) => {
      Given('an agent to ask', () => {
        reset()
        agent = answering('{}')
      })
      And('a run that wrote an artifact', () => {
        latest = [wroteArtifact]
      })
      Then('the evaluator wants to run', wants(true))
    })

    RuleScenario('A run that went badly is worth looking at', ({ Given, And, Then }) => {
      Given('an agent to ask', () => {
        reset()
        agent = answering('{}')
      })
      And('a run that failed a gate', () => {
        latest = [failedGate]
      })
      Then('the evaluator wants to run', wants(true))
    })

    RuleScenario('A refused command is worth looking at', ({ Given, And, Then }) => {
      Given('an agent to ask', () => {
        reset()
        agent = answering('{}')
      })
      And('a run whose command was refused', () => {
        latest = [refused]
      })
      Then('the evaluator wants to run', wants(true))
    })
  })

  Rule('what it is asked is the evidence, and the shape of an answer', ({ RuleScenario }) => {
    RuleScenario('The prompt carries what Factory saw', ({ Given, And, When, Then }) => {
      Given('an agent to ask', () => {
        reset()
        agent = answering(JSON.stringify(BODY))
      })
      And('a run that failed a gate', () => {
        latest = [failedGate]
      })
      When('it is evaluated', evaluate)
      Then('the prompt names the failed gate', () => {
        expect(asked).toContain('pnpm test exited 1')
      })
      And('the prompt names the task', () => {
        expect(asked).toContain('Add due dates')
      })
    })

    RuleScenario('The prompt says which dimensions exist', ({ Given, And, When, Then }) => {
      Given('an agent to ask', () => {
        reset()
        agent = answering(JSON.stringify(BODY))
      })
      And('a run that wrote an artifact', () => {
        latest = [wroteArtifact]
      })
      When('it is evaluated', evaluate)
      Then('the prompt lists every dimension', () => {
        for (const dimension of RELIABILITY_DIMENSIONS) expect(asked).toContain(dimension)
      })
    })

    RuleScenario('The prompt offers the findings that already exist', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('an agent to ask', () => {
        reset()
        agent = answering(JSON.stringify(BODY))
      })
      And('a run that failed a gate', () => {
        latest = [failedGate]
      })
      And('a finding already on the task', () => {
        drivers = [FINDING]
      })
      When('it is evaluated', evaluate)
      Then('the prompt names that finding', () => {
        expect(asked).toContain('the checkout total is wrong for one currency')
        expect(asked).toContain('drv-1')
      })
    })

    RuleScenario('The prompt never asks for a score', ({ Given, And, When, Then }) => {
      Given('an agent to ask', () => {
        reset()
        agent = answering(JSON.stringify(BODY))
      })
      And('a run that wrote an artifact', () => {
        latest = [wroteArtifact]
      })
      When('it is evaluated', evaluate)
      Then('the prompt does not ask for a score', () => {
        // The word appears inside `scoreImpact`, which is a finding's weight
        // and not the total. What must not appear is a field asking for the
        // number itself.
        expect(asked).not.toMatch(/"score"\s*:\s*0-100\s*,?\s*\n?\s*"(?!rationale)/)
        expect(asked.toLowerCase()).not.toContain('overall score')
        expect(asked).not.toContain('"reliabilityScore"')
      })
    })

    RuleScenario('The model the project chose is the model that is asked', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('an agent to ask using "claude-opus-5-5"', () => {
        reset()
        agent = answering(JSON.stringify(BODY), 'claude-opus-5-5')
      })
      And('a run that wrote an artifact', () => {
        latest = [wroteArtifact]
      })
      When('it is evaluated', evaluate)
      Then('it was asked through "claude-opus-5-5"', () => {
        expect(askedModel).toBe('claude-opus-5-5')
      })
    })
  })

  Rule('an answer is read forgivingly and trusted narrowly', ({ RuleScenario }) => {
    const designIs72 = (): void => {
      expect(result?.dimensions.design?.score).toBe(72)
    }

    RuleScenario('A bare object is read', ({ Given, When, Then }) => {
      Given('an agent that answers with a bare object', () => {
        reset()
        latest = [wroteArtifact]
        agent = answering(JSON.stringify(BODY))
      })
      When('it is evaluated', evaluate)
      Then('the design dimension is 72', designIs72)
    })

    RuleScenario('A fenced block is read', ({ Given, When, Then }) => {
      Given('an agent that answers inside a code fence', () => {
        reset()
        latest = [wroteArtifact]
        agent = answering('```json\n' + JSON.stringify(BODY) + '\n```')
      })
      When('it is evaluated', evaluate)
      Then('the design dimension is 72', designIs72)
    })

    RuleScenario('An object with prose around it is read', ({ Given, When, Then }) => {
      Given('an agent that answers with prose around the object', () => {
        reset()
        latest = [wroteArtifact]
        agent = answering(
          `Here is my assessment.\n\n${JSON.stringify(BODY)}\n\nLet me know if you need more.`,
        )
      })
      When('it is evaluated', evaluate)
      Then('the design dimension is 72', designIs72)
    })

    RuleScenario('An answer that is not JSON at all is refused', ({ Given, When, Then }) => {
      Given('an agent that answers with an apology', () => {
        reset()
        latest = [wroteArtifact]
        agent = answering("I'm sorry, I can't help with that.")
      })
      When('it is evaluated', evaluate)
      Then('evaluating fails saying it could not be read', failsSaying('could not be read'))
    })

    RuleScenario('An answer that is JSON but not an object is refused', ({ Given, When, Then }) => {
      Given('an agent that answers with a list', () => {
        reset()
        latest = [wroteArtifact]
        agent = answering('[1, 2, 3]')
      })
      When('it is evaluated', evaluate)
      Then('evaluating fails saying it could not be read', failsSaying('could not be read'))
    })

    RuleScenario('An agent that cannot be reached fails loudly', ({ Given, When, Then }) => {
      Given('an agent that cannot be reached', () => {
        reset()
        latest = [wroteArtifact]
        agent = {
          ask: () => Promise.reject(new Error('spawn claude ENOENT')),
        }
      })
      When('it is evaluated', evaluate)
      Then('evaluating fails saying it could not be reached', failsSaying('could not be reached'))
    })
  })

  Rule('a score cannot be smuggled through it', ({ RuleScenario }) => {
    RuleScenario('A score in the answer is dropped', ({ Given, When, Then }) => {
      Given('an agent that answers with a score of 98', () => {
        reset()
        latest = [wroteArtifact]
        agent = answering(JSON.stringify({ ...BODY, score: 98, reliabilityScore: 98 }))
      })
      When('it is evaluated', evaluate)
      Then('what comes back carries no score', () => {
        expect(JSON.stringify(result)).not.toContain('98')
      })
    })

    RuleScenario('Findings come through, with their own dimensions', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given('an agent that answers with a finding', () => {
        reset()
        latest = [wroteArtifact]
        agent = answering(
          JSON.stringify({
            dimensions: {},
            drivers: [
              {
                title: 'the router rewrite is untested',
                description: 'Nothing exercises the new branch.',
                type: 'coverage',
                severity: 'medium',
                owner: 'agent',
                dimension: 'verification',
                scoreImpact: -4,
              },
            ],
          }),
        )
      })
      When('it is evaluated', evaluate)
      Then('the finding comes through', () => {
        expect(result?.drivers).toHaveLength(1)
        expect(result?.drivers[0]?.title).toBe('the router rewrite is untested')
      })
      And('it is filed under the dimension the agent named', () => {
        expect(result?.drivers[0]?.dimension).toBe('verification')
      })
    })

    RuleScenario('Resolutions come through', ({ Given, When, Then }) => {
      Given('an agent that answers resolving a finding', () => {
        reset()
        latest = [wroteArtifact]
        drivers = [FINDING]
        agent = answering(JSON.stringify({ dimensions: {}, drivers: [], resolves: ['drv-1'] }))
      })
      When('it is evaluated', evaluate)
      Then('it says that finding is resolved', () => {
        expect(result?.resolves).toEqual(['drv-1'])
      })
    })

    RuleScenario('A dimension the agent invented is dropped before it is returned', ({
      Given,
      When,
      Then,
    }) => {
      Given('an agent that answers with a dimension Factory does not have', () => {
        reset()
        latest = [wroteArtifact]
        agent = answering(
          JSON.stringify({
            dimensions: {
              design: { score: 72, rationale: '' },
              vibes: { score: 100, rationale: 'it feels good' },
            },
            drivers: [],
          }),
        )
      })
      When('it is evaluated', evaluate)
      Then('only dimensions Factory has come back', () => {
        for (const name of Object.keys(result?.dimensions ?? {})) {
          expect(RELIABILITY_DIMENSIONS as readonly string[]).toContain(name)
        }
      })
    })
  })

  // Referenced so the helper is not dead weight when a scenario stops using it.
  void promptFor
})

import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import {
  RELIABILITY_DIMENSIONS,
  type DimensionScores,
  type DriverSeverity,
  type DriverStatus,
  type DriverType,
  type Observation,
  type ReliabilityDimension,
  type ReliabilityDriver,
} from '../src/reliability/model.js'
import {
  DEFAULT_RELIABILITY_POLICY,
  weightsTotal,
  type ReliabilityPolicy,
} from '../src/reliability/policy.js'
import { score, type ScoreResult } from '../src/reliability/score.js'

const feature = await loadFeature(
  fileURLToPath(new URL('./reliability-scoring.feature', import.meta.url)),
)

describeFeature(feature, ({ Rule, BeforeEachScenario }) => {
  const policy: ReliabilityPolicy = DEFAULT_RELIABILITY_POLICY

  let dimensions: DimensionScores
  let drivers: ReliabilityDriver[]
  let observations: Observation[]
  let previous: { score: number; drivers: readonly ReliabilityDriver[]; caps: [] } | undefined
  let result: ScoreResult
  /** A second calculation, for the scenarios that compare two. */
  let other: ScoreResult

  const flat = (value: number): DimensionScores =>
    Object.fromEntries(
      RELIABILITY_DIMENSIONS.map((dimension) => [dimension, value]),
    ) as DimensionScores

  BeforeEachScenario(() => {
    dimensions = flat(0)
    drivers = []
    observations = []
    previous = undefined
  })

  /** A driver with everything the model requires and nothing a scenario is about. */
  let nextDriver = 0
  const driver = (
    fields: Partial<ReliabilityDriver> & { severity: DriverSeverity; type: DriverType },
  ): ReliabilityDriver => ({
    id: `driver-${++nextDriver}`,
    taskId: 'task-1',
    title: `a ${fields.severity} ${String(fields.type)} finding`,
    description: '',
    status: 'open' as DriverStatus,
    owner: 'agent',
    dimension: 'regressionSafety',
    scoreImpact: -3,
    evidenceRefs: [],
    introducedBy: {},
    createdAt: '2026-09-24T00:00:00.000Z',
    updatedAt: '2026-09-24T00:00:00.000Z',
    ...fields,
  })

  /** An observation that satisfies one expected key, the ordinary shape. */
  const satisfying = (key: string): Observation => ({
    kind: 'artifact',
    status: 'passed',
    summary: key,
    satisfies: key,
  })

  const calculate = (): void => {
    result = score({
      dimensions,
      drivers,
      observations,
      policy,
      ...(previous === undefined ? {} : { previous }),
    })
  }

  const allAt = (value: number) => (): void => {
    dimensions = flat(value)
  }
  const allExcept = (value: number, dimension: ReliabilityDimension, low: number) => (): void => {
    dimensions = { ...flat(value), [dimension]: low }
  }
  const rawIs = (expected: number) => (): void => expect(result.rawScore).toBe(expected)
  const effectiveIs = (expected: number) => (): void => expect(result.score).toBe(expected)
  const noCaps = (): void => expect(result.caps).toEqual([])

  Rule('the policy has to add up before anything uses it', ({ RuleScenario }) => {
    RuleScenario('The shipped weights total one hundred', ({ Given, Then }) => {
      Given('the policy Factory ships', () => {})
      Then('the dimension weights total 100', () => expect(weightsTotal(policy.weights)).toBe(100))
    })

    RuleScenario('Every dimension has a weight', ({ Given, Then }) => {
      Given('the policy Factory ships', () => {})
      Then('every dimension the model lists has a weight', () => {
        for (const dimension of RELIABILITY_DIMENSIONS) {
          expect(policy.weights[dimension], dimension).toBeGreaterThan(0)
        }
      })
    })

    RuleScenario('Every expected piece of evidence is worth something', ({ Given, Then }) => {
      Given('the policy Factory ships', () => {})
      Then('every expected piece of evidence has a weight above zero', () => {
        for (const expected of policy.expectedEvidence) {
          expect(expected.weight, expected.key).toBeGreaterThan(0)
        }
      })
    })
  })

  Rule('the score is a weighted average, and it shows its working', ({ RuleScenario }) => {
    RuleScenario('A perfect assessment scores one hundred', ({ Given, When, Then }) => {
      Given('every dimension scores 100', allAt(100))
      When('the score is calculated', calculate)
      Then('the raw score is 100', rawIs(100))
    })

    RuleScenario('The weights actually weight', ({ Given, When, And, Then }) => {
      Given('every dimension scores 100 except "design" which scores 50', allExcept(100, 'design', 50))
      When('the score is calculated', calculate)
      And('the same assessment is calculated with "precedent" at 50 instead', () => {
        dimensions = { ...flat(100), precedent: 50 }
        other = score({ dimensions, drivers, observations, policy })
      })
      // design is 20, precedent is 10 — exactly twice, which a plain mean
      // would fail and an equal-weights table would fail too.
      Then('the design shortfall costs twice what the precedent shortfall costs', () => {
        expect(100 - result.rawScore).toBeCloseTo((100 - other.rawScore) * 2, 5)
      })
    })

    RuleScenario('The working is carried, not recoverable', ({ Given, When, Then, And }) => {
      Given('every dimension scores 90', allAt(90))
      When('the score is calculated', calculate)
      Then('there is one contribution line per dimension', () =>
        expect(result.explanation.contributions).toHaveLength(RELIABILITY_DIMENSIONS.length),
      )
      And("each line carries the dimension's score and its weight", () => {
        for (const line of result.explanation.contributions) {
          expect(line.score).toBe(90)
          expect(line.weight).toBe(policy.weights[line.dimension])
        }
      })
      And('the contributions sum to the raw score', () => {
        const total = result.explanation.contributions.reduce((sum, l) => sum + l.contribution, 0)
        expect(total).toBeCloseTo(result.rawScore, 1)
      })
    })

    RuleScenario('A dimension score outside the range is brought back into it', ({
      Given,
      When,
      Then,
    }) => {
      Given('every dimension scores 100 except "design" which scores 150', allExcept(100, 'design', 150))
      When('the score is calculated', calculate)
      Then('the raw score is 100', rawIs(100))
    })
  })

  Rule('a known serious risk caps the score, however good the average is', ({ RuleScenario }) => {
    /** Full coverage, so a missing-evidence cap cannot be what a scenario measures. */
    const fullyObserved = (): void => {
      observations = policy.expectedEvidence.map((expected) => satisfying(expected.key))
    }

    RuleScenario('A critical open driver caps the score', ({ Given, And, When, Then }) => {
      Given('every dimension scores 96', () => {
        dimensions = flat(96)
        fullyObserved()
      })
      And('a "critical" open driver', () => {
        drivers = [driver({ severity: 'critical', type: 'security' })]
      })
      When('the score is calculated', calculate)
      Then('the raw score is still above 90', () => expect(result.rawScore).toBeGreaterThan(90))
      And('the effective score is 70', effectiveIs(70))
      And('the assessment records why it was capped', () => {
        expect(result.caps.map((cap) => cap.type)).toContain('criticalOpenDriver')
        expect(result.caps[0]?.reason).not.toBe('')
      })
    })

    RuleScenario('A resolved critical driver caps nothing', ({ Given, And, When, Then }) => {
      Given('every dimension scores 96', () => {
        dimensions = flat(96)
        fullyObserved()
      })
      And('a "critical" driver that has been resolved', () => {
        drivers = [driver({ severity: 'critical', type: 'security', status: 'resolved' })]
      })
      When('the score is calculated', calculate)
      Then('the effective score is the raw score', () => expect(result.score).toBe(result.rawScore))
    })

    RuleScenario('An accepted critical driver caps nothing', ({ Given, And, When, Then }) => {
      Given('every dimension scores 96', () => {
        dimensions = flat(96)
        fullyObserved()
      })
      And('a "critical" driver that has been accepted', () => {
        drivers = [driver({ severity: 'critical', type: 'security', status: 'accepted' })]
      })
      When('the score is calculated', calculate)
      Then('the effective score is the raw score', () => expect(result.score).toBe(result.rawScore))
    })

    RuleScenario('Caps do not compound', ({ Given, And, When, Then }) => {
      Given('every dimension scores 96', () => {
        dimensions = flat(96)
        fullyObserved()
      })
      And('a "critical" open driver', () => {
        drivers = [driver({ severity: 'critical', type: 'security' })]
      })
      And('an open "regression" driver of "high" severity', () => {
        drivers = [...drivers, driver({ severity: 'high', type: 'regression' })]
      })
      When('the score is calculated', calculate)
      Then('the effective score is 70', effectiveIs(70))
    })

    RuleScenario('Resolving a finding gives its cost back', ({ Given, And, When, Then }) => {
      let clean = 0
      Given('every dimension scores 96', () => {
        dimensions = flat(96)
        fullyObserved()
        clean = score({ dimensions, drivers: [], observations, policy }).score
      })
      And('an open "testing" driver of "medium" severity costing 6', () => {
        drivers = [driver({ severity: 'medium', type: 'testing', scoreImpact: -6 })]
      })
      When('the score is calculated', calculate)
      And('that driver is resolved and the score recalculated', () => {
        other = result
        drivers = drivers.map((d) => ({ ...d, status: 'resolved' as DriverStatus }))
        calculate()
      })
      Then('the score went up', () => expect(result.score).toBeGreaterThan(other.score))
      And('it is back to what it was before the finding', () => expect(result.score).toBe(clean))
    })

    RuleScenario('A high-severity driver costs its impact rather than a ceiling', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('every dimension scores 96', () => {
        dimensions = flat(96)
        fullyObserved()
      })
      And('an open "testing" driver of "high" severity', () => {
        drivers = [driver({ severity: 'high', type: 'testing' })]
      })
      When('the score is calculated', calculate)
      Then('no cap was applied', noCaps)
    })

    RuleScenario('Evidence nobody collected caps the score too', ({ Given, And, When, Then }) => {
      Given('every dimension scores 99', allAt(99))
      And('nothing has been observed at all', () => {
        observations = []
      })
      When('the score is calculated', calculate)
      Then('the effective score is at most 85', () => expect(result.score).toBeLessThanOrEqual(85))
      And('the assessment records why it was capped', () =>
        expect(result.caps.length).toBeGreaterThan(0),
      )
    })
  })

  Rule('coverage is how much of the expected evidence exists, weighted', ({ RuleScenario }) => {
    RuleScenario('No evidence is no coverage', ({ Given, When, Then }) => {
      Given('nothing has been observed at all', () => {
        observations = []
      })
      When('the score is calculated', calculate)
      Then('the coverage is 0', () => expect(result.coverage).toBe(0))
    })

    RuleScenario('Everything expected is full coverage', ({ Given, When, Then }) => {
      Given('every expected piece of evidence has been observed', () => {
        observations = policy.expectedEvidence.map((expected) => satisfying(expected.key))
      })
      When('the score is calculated', calculate)
      Then('the coverage is 100', () => expect(result.coverage).toBe(100))
    })

    RuleScenario('Coverage counts weight, not observations', ({ Given, When, Then }) => {
      Given('the cheapest expected evidence has been observed ten times', () => {
        const cheapest = [...policy.expectedEvidence].sort((a, b) => a.weight - b.weight)[0]
        expect(cheapest).toBeDefined()
        observations = Array.from({ length: 10 }, () => satisfying((cheapest as { key: string }).key))
      })
      When('the score is calculated', calculate)
      Then('the coverage is below 20', () => expect(result.coverage).toBeLessThan(20))
    })

    RuleScenario('A check that ran and failed does not satisfy the expectation', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given("the project's own checks ran and failed", () => {
        observations = [
          {
            kind: 'gate_result',
            status: 'failed',
            summary: 'pnpm test exited 1',
            satisfies: 'regression_checks',
          },
        ]
      })
      When('the score is calculated', calculate)
      Then('the coverage is 0', () => expect(result.coverage).toBe(0))
      And('the missing evidence still names "regression_checks"', () =>
        expect(result.missingEvidence).toContain('regression_checks'),
      )
    })
  })

  Rule('more evidence can arrive with less reliability', ({ RuleScenario }) => {
    RuleScenario('A failed validation lowers the score and raises coverage', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given('a task assessed at 97 with 68% coverage', givenAssessedAt97)
      When('validation runs, satisfies its expected evidence, and finds a regression', validationFindsRegression)
      Then('the score is lower than it was', () => expect(result.score).toBeLessThan(before.score))
      And('the coverage is higher than it was', () =>
        expect(result.coverage).toBeGreaterThan(before.coverage),
      )
    })
  })

  Rule('no score moves without a reason attached', ({ RuleScenario }) => {
    RuleScenario('A new driver is named as the cause', ({ Given, When, Then }) => {
      Given('a task assessed at 97 with 68% coverage', givenAssessedAt97)
      When('validation runs, satisfies its expected evidence, and finds a regression', validationFindsRegression)
      Then('a cause names the regression that was found', () => {
        const named = result.explanation.causes.map((cause) => cause.summary).join(' | ')
        expect(named).toContain('checkout regression')
      })
    })

    RuleScenario('Resolving a driver is named as the cause, and gives back its impact', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('a task assessed at 97 with 68% coverage', givenAssessedAt97)
      And('validation found a regression', validationFindsRegression)
      When('that regression is resolved', () => {
        const found = drivers.map((d) => ({ ...d, status: 'resolved' as DriverStatus }))
        previous = { score: result.score, drivers, caps: [] }
        drivers = found
        calculate()
      })
      Then('a cause says the regression was resolved', () => {
        const named = result.explanation.causes.map((cause) => cause.summary).join(' | ')
        expect(named).toContain('Resolved:')
      })
      And('that cause is positive', () => {
        const resolved = result.explanation.causes.find((c) => c.summary.startsWith('Resolved:'))
        expect(resolved?.amount).toBeGreaterThan(0)
      })
    })

    RuleScenario('The first assessment has nothing to have moved from', ({ Given, When, Then }) => {
      Given('every dimension scores 90', allAt(90))
      When('the score is calculated', calculate)
      Then('no causes are given', () => expect(result.explanation.causes).toEqual([]))
    })

    RuleScenario('A fall is a negative delta', ({ Given, When, Then }) => {
      Given('a task assessed at 97 with 68% coverage', givenAssessedAt97)
      When(
        'validation runs, satisfies its expected evidence, and finds a regression',
        validationFindsRegression,
      )
      Then('the delta is negative', () => expect(result.delta).toBeLessThan(0))
    })

    RuleScenario('A delta is a number a person can read', ({ Given, When, Then }) => {
      // Reached through the dimensions rather than set directly, because the
      // delta is the difference of two *rounded* scores and that is where the
      // remainder comes from. Every dimension at 89.8 scores 89.8; at 95, 95.
      Given('a task assessed at 89.8', () => {
        // Everything observed, so no ceiling is in play: the two scores have to
        // be free to be 89.8 and 95, or there is no remainder to expose.
        observations = policy.expectedEvidence.map((expected) => satisfying(expected.key))
        dimensions = flat(89.8)
        calculate()
        previous = { score: result.score, drivers: [], caps: [] }
      })
      When('it is assessed again at 95', () => {
        dimensions = flat(95)
        calculate()
      })
      Then('the delta reads as 5.2', () => expect(result.delta).toBe(5.2))
    })
  })

  Rule('one hundred is rare', ({ RuleScenario }) => {
    RuleScenario('Good work with an ordinary gap does not reach one hundred', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('every dimension scores 97', allAt(97))
      And('every expected piece of evidence has been observed', () => {
        observations = policy.expectedEvidence.map((expected) => satisfying(expected.key))
      })
      When('the score is calculated', calculate)
      Then('the effective score is below 100', () => expect(result.score).toBeLessThan(100))
    })

    RuleScenario('One hundred needs everything', ({ Given, And, When, Then }) => {
      Given('every dimension scores 100', allAt(100))
      And('every expected piece of evidence has been observed', () => {
        observations = policy.expectedEvidence.map((expected) => satisfying(expected.key))
      })
      When('the score is calculated', calculate)
      Then('the effective score is 100', effectiveIs(100))
      And('no cap was applied', noCaps)
    })
  })

  /**
   * The state a validation arrives into: implementation done, tests passing,
   * verification not yet attempted. Shared because three scenarios build on it
   * and a fourth copy would be the one that drifts.
   */
  let before: ScoreResult
  function givenAssessedAt97(): void {
    dimensions = {
      understanding: 98,
      precedent: 94,
      design: 97,
      implementation: 98,
      regressionSafety: 97,
      verification: 97,
    }
    observations = [
      'requirements_understood',
      'constraints_identified',
      'precedent_examined',
      'technical_approach',
      'compatibility_considered',
      'implementation_exists',
      'build_success',
      'targeted_tests',
    ].map(satisfying)
    drivers = []
    calculate()
    before = result
  }

  function validationFindsRegression(): void {
    previous = { score: before.score, drivers: [], caps: [] }
    observations = [
      ...observations,
      satisfying('regression_checks'),
      satisfying('integration_checks'),
    ]
    dimensions = { ...dimensions, regressionSafety: 88 }
    drivers = [
      driver({
        severity: 'high',
        type: 'regression',
        title: 'checkout regression still unverified',
        scoreImpact: -3,
      }),
    ]
    calculate()
  }
})

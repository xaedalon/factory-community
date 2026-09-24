import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import type {
  DriverOwner,
  DriverSeverity,
  DriverStatus,
  ReliabilityCap,
  ReliabilityDriver,
} from '../src/reliability/model.js'
import {
  attentionSummary,
  bySeverityThenImpact,
  driverActions,
  moveDriver,
  nextActions,
  type DriverAction,
  type DriverTransition,
  type DriverTransitionRefusal,
  type NextAction,
} from '../src/reliability/drivers.js'
import { DEFAULT_RELIABILITY_POLICY as policy } from '../src/reliability/policy.js'
import { capsFor } from '../src/reliability/score.js'

const feature = await loadFeature(
  fileURLToPath(new URL('./reliability-drivers.feature', import.meta.url)),
)

describeFeature(feature, ({ Rule, BeforeEachScenario }) => {
  let drivers: ReliabilityDriver[]
  let subject: ReliabilityDriver
  let outcome: DriverTransition | DriverTransitionRefusal
  let ordered: readonly ReliabilityDriver[]
  let summary: ReturnType<typeof attentionSummary>
  let actions: readonly NextAction[]
  let workflows: string[]

  let nextId = 0
  const make = (over: Partial<ReliabilityDriver> = {}): ReliabilityDriver => ({
    id: `driver-${++nextId}`,
    taskId: 'task-1',
    title: over.title ?? `finding ${nextId}`,
    description: '',
    type: 'testing',
    severity: 'medium',
    status: 'open',
    owner: 'agent',
    dimension: 'regressionSafety',
    scoreImpact: -3,
    evidenceRefs: [],
    introducedBy: {},
    createdAt: `2026-09-24T00:00:${String(nextId).padStart(2, '0')}.000Z`,
    updatedAt: '2026-09-24T00:00:00.000Z',
    ...over,
  })

  /** The real cap rules, so a scenario about lifting one is about the real thing. */
  const caps = (list: readonly ReliabilityDriver[]): readonly ReliabilityCap[] =>
    capsFor(list, policy, [], [])

  BeforeEachScenario(() => {
    drivers = []
    workflows = []
    ordered = []
    actions = []
  })

  const given = (status: DriverStatus, severity: DriverSeverity = 'medium') => (): void => {
    subject = make({ status, severity })
  }
  const attempt = (action: DriverAction, byAgent?: boolean) => (): void => {
    outcome = moveDriver(subject, action, byAgent === undefined ? {} : { byAgent })
  }
  const offers = (action: DriverAction) => (): void =>
    expect(driverActions(subject.status)).toContain(action)
  const doesNotOffer = (action: DriverAction) => (): void =>
    expect(driverActions(subject.status)).not.toContain(action)
  const becomes = (status: DriverStatus) => (): void =>
    expect((outcome as DriverTransition).status).toBe(status)

  Rule('a driver moves through one table and nowhere else', ({ RuleScenario }) => {
    RuleScenario('An open driver offers the moves that make sense', ({ Given, Then, And }) => {
      Given('an open driver', given('open'))
      Then('it offers "investigate"', offers('investigate'))
      And('it offers "resolve"', offers('resolve'))
      And('it offers "accept"', offers('accept'))
      And('it does not offer "reopen"', doesNotOffer('reopen'))
    })

    RuleScenario('A resolved driver cannot be resolved again', ({ Given, When, Then, And }) => {
      Given('a resolved driver', given('resolved'))
      When('"resolve" is attempted', attempt('resolve'))
      Then('it is refused', () =>
        expect((outcome as DriverTransitionRefusal).code).toBe('NOT_AVAILABLE'),
      )
      And('the refusal lists what it would accept instead', () =>
        expect((outcome as DriverTransitionRefusal).actions).toContain('reopen'),
      )
    })

    RuleScenario('A resolution that did not hold can be reopened', ({ Given, When, Then }) => {
      Given('a resolved driver', given('resolved'))
      When('"reopen" is attempted', attempt('reopen'))
      Then('it becomes "open"', becomes('open'))
    })

    RuleScenario('An accepted risk is not reopened, it is superseded', ({ Given, Then, And }) => {
      Given('an accepted driver', given('accepted'))
      Then('it does not offer "reopen"', doesNotOffer('reopen'))
      And('it offers "supersede"', offers('supersede'))
    })
  })

  Rule('an agent cannot accept its own serious risk', ({ RuleScenario }) => {
    RuleScenario('An agent may not accept a critical risk', ({ Given, When, Then, And }) => {
      Given('an open driver of "critical" severity', given('open', 'critical'))
      When('an agent attempts to accept it', attempt('accept', true))
      Then('it is refused because a person is required', () =>
        expect((outcome as DriverTransitionRefusal).code).toBe('HUMAN_REQUIRED'),
      )
      And('the refusal does not offer "accept"', () =>
        expect((outcome as DriverTransitionRefusal).actions).not.toContain('accept'),
      )
    })

    RuleScenario('An agent may not accept a high risk either', ({ Given, When, Then }) => {
      Given('an open driver of "high" severity', given('open', 'high'))
      When('an agent attempts to accept it', attempt('accept', true))
      Then('it is refused because a person is required', () =>
        expect((outcome as DriverTransitionRefusal).code).toBe('HUMAN_REQUIRED'),
      )
    })

    RuleScenario('An agent may accept a low risk', ({ Given, When, Then }) => {
      Given('an open driver of "low" severity', given('open', 'low'))
      When('an agent attempts to accept it', attempt('accept', true))
      Then('it becomes "accepted"', becomes('accepted'))
    })

    RuleScenario('A person may accept a critical risk', ({ Given, When, Then }) => {
      Given('an open driver of "critical" severity', given('open', 'critical'))
      When('a person accepts it', attempt('accept', false))
      Then('it becomes "accepted"', becomes('accepted'))
    })

    RuleScenario('An agent may still resolve a critical risk', ({ Given, When, Then }) => {
      Given('an open driver of "critical" severity', given('open', 'critical'))
      When('an agent attempts to resolve it', attempt('resolve', true))
      Then('it becomes "resolved"', becomes('resolved'))
    })
  })

  Rule('the worst thing is read first', ({ RuleScenario }) => {
    const order = (): void => {
      ordered = [...drivers].sort(bySeverityThenImpact)
    }

    RuleScenario('Severity orders before impact', ({ Given, When, Then }) => {
      Given('a "critical" driver costing 1 and a "low" driver costing 9', () => {
        drivers = [
          make({ severity: 'low', scoreImpact: -9, title: 'cheap but loud' }),
          make({ severity: 'critical', scoreImpact: -1, title: 'the critical one' }),
        ]
      })
      When('the drivers are ordered', order)
      Then('the "critical" one is first', () => expect(ordered[0]?.severity).toBe('critical'))
    })

    RuleScenario('Within a severity, the expensive one is first', ({ Given, When, Then }) => {
      Given('two "medium" drivers costing 2 and 7', () => {
        drivers = [make({ scoreImpact: -2 }), make({ scoreImpact: -7 })]
      })
      When('the drivers are ordered', order)
      Then('the one costing 7 is first', () => expect(ordered[0]?.scoreImpact).toBe(-7))
    })

    RuleScenario('Chronology is the tie-breaker, not the rule', ({ Given, When, Then }) => {
      Given('two "medium" drivers costing 3, the older added second', () => {
        const newer = make({ scoreImpact: -3, createdAt: '2026-09-24T12:00:00.000Z' })
        const older = make({ scoreImpact: -3, createdAt: '2026-09-24T09:00:00.000Z' })
        drivers = [newer, older]
      })
      When('the drivers are ordered', order)
      Then('the older one is first', () =>
        expect(ordered[0]?.createdAt).toBe('2026-09-24T09:00:00.000Z'),
      )
    })
  })

  Rule('attention is counted by who can act, not by how many there are', ({ RuleScenario }) => {
    const mixed = (): void => {
      const of = (owner: DriverOwner, count: number): ReliabilityDriver[] =>
        Array.from({ length: count }, () => make({ owner }))
      drivers = [...of('agent', 4), ...of('developer', 2), ...of('external', 1)]
    }
    const summarise = (): void => {
      summary = attentionSummary(drivers, 90, caps)
    }

    RuleScenario('Drivers are counted by owner', ({ Given, When, Then, And }) => {
      Given('four agent drivers, two developer drivers and one external driver', mixed)
      When('attention is summarised', summarise)
      Then('it says 4 for the agent', () => expect(summary.agent).toBe(4))
      And('it says 2 for the developer', () => expect(summary.developer).toBe(2))
      And('it says 1 for external', () => expect(summary.external).toBe(1))
    })

    RuleScenario("Resolved drivers want nobody's attention", ({ Given, And, When, Then }) => {
      Given('four agent drivers, two developer drivers and one external driver', mixed)
      And('the external driver has been resolved', () => {
        drivers = drivers.map((d) =>
          d.owner === 'external' ? { ...d, status: 'resolved' as DriverStatus } : d,
        )
      })
      When('attention is summarised', summarise)
      Then('it says 0 for external', () => expect(summary.external).toBe(0))
    })

    RuleScenario('The summary says what each owner could unlock', ({ Given, When, Then, And }) => {
      Given('four agent drivers, two developer drivers and one external driver', mixed)
      When('attention is summarised', summarise)
      Then("resolving the agent's drivers would raise the score", () =>
        expect(summary.potential.agent).toBeGreaterThan(90),
      )
      And("resolving the developer's drivers would raise the score", () =>
        expect(summary.potential.developer).toBeGreaterThan(90),
      )
    })

    RuleScenario('Lifting a cap is worth more than the driver\'s own impact', ({
      Given,
      When,
      Then,
    }) => {
      Given('a "critical" driver costing 2 and a "medium" driver costing 6', () => {
        drivers = [
          make({ severity: 'critical', type: 'security', scoreImpact: -2, title: 'the capped one' }),
          make({ severity: 'medium', scoreImpact: -6, title: 'the expensive one' }),
        ]
      })
      When('the next actions are worked out', () => {
        // A score above the cap, so lifting the ceiling is what the estimate
        // is about rather than the impact alone.
        actions = nextActions(drivers, 90, caps, workflows)
      })
      Then('the critical one is offered first', () =>
        expect(actions[0]?.title).toBe('the capped one'),
      )
    })
  })

  Rule('a recommendation names something that exists', ({ RuleScenario }) => {
    const work = (): void => {
      actions = nextActions(drivers, 90, caps, workflows)
    }

    RuleScenario('A recommended workflow the project has is offered as a workflow', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('a driver recommending the "checkout-regression" workflow', () => {
        drivers = [
          make({
            recommendedAction: {
              type: 'workflow',
              workflow: 'checkout-regression',
              label: 'Run checkout regression verification',
            },
          }),
        ]
      })
      And('the project has a "checkout-regression" workflow', () => {
        workflows = ['checkout-regression']
      })
      When('the next actions are worked out', work)
      Then('the action is a "workflow"', () => expect(actions[0]?.actionType).toBe('workflow'))
      And('it names "checkout-regression"', () =>
        expect(actions[0]?.workflow).toBe('checkout-regression'),
      )
    })

    RuleScenario('A recommended workflow the project does not have becomes an investigation', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('a driver recommending the "checkout-regression" workflow', () => {
        drivers = [
          make({
            recommendedAction: {
              type: 'workflow',
              workflow: 'checkout-regression',
              label: 'Run checkout regression verification',
            },
          }),
        ]
      })
      And('the project has no workflows', () => {
        workflows = []
      })
      When('the next actions are worked out', work)
      Then('the action is an "agent_investigation"', () =>
        expect(actions[0]?.actionType).toBe('agent_investigation'),
      )
      And('it names no workflow', () => expect(actions[0]?.workflow).toBeUndefined())
    })

    RuleScenario('A driver with no recommendation still appears', ({ Given, And, When, Then }) => {
      Given('an open driver of "high" severity with no recommended action', () => {
        drivers = [make({ severity: 'high' })]
      })
      And('the project has no workflows', () => {
        workflows = []
      })
      When('the next actions are worked out', work)
      Then('one action is offered', () => expect(actions).toHaveLength(1))
    })

    RuleScenario('A developer-owned driver is offered as a decision', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('a developer-owned driver with no recommended action', () => {
        drivers = [make({ owner: 'developer' })]
      })
      And('the project has no workflows', () => {
        workflows = []
      })
      When('the next actions are worked out', work)
      Then('the action is a "developer_decision"', () =>
        expect(actions[0]?.actionType).toBe('developer_decision'),
      )
    })
  })
})

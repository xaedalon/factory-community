import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { EventBus, type FactoryEvent } from '@factory/events'
import {
  RELIABILITY_DIMENSIONS,
  SCORING_MODEL_VERSION,
  type DimensionScores,
  type Observation,
  type ReliabilityAssessment,
  type ReliabilityDriver,
} from '@factory/core'
import {
  MIGRATIONS,
  ProjectRepository,
  ReliabilityRepository,
  TaskRepository,
  openStore,
  type Store,
} from '../src/index.js'

const feature = await loadFeature(fileURLToPath(new URL('./reliability.feature', import.meta.url)))

describeFeature(feature, ({ Background, Rule, AfterEachScenario }) => {
  let store: Store
  let reliability: ReliabilityRepository
  let tasks: TaskRepository
  let taskId: string
  let events: FactoryEvent[]
  /** Moved by default so ordering by time is possible; frozen by one scenario. */
  let tick: number
  let frozen: boolean

  AfterEachScenario(() => store?.close())

  Background(({ Given }) => {
    Given('an empty store with a project and a task', () => {
      tick = 0
      frozen = false
      events = []
      store = openStore({ file: ':memory:', migrations: MIGRATIONS })
      const bus = new EventBus({ onSubscriberError: () => {} })
      bus.onAny((event) => events.push(event))
      const now = (): string =>
        new Date(Date.UTC(2026, 8, 24, 0, 0, frozen ? 0 : tick++)).toISOString()
      let ids = 0
      const newId = (): string => `rel-${++ids}`

      const projects = new ProjectRepository({ db: store.db, now })
      const project = projects.add({ name: 'probe', path: process.env['PWD'] ?? '.' })
      tasks = new TaskRepository({ db: store.db, events: bus, now })
      taskId = tasks.create({ name: 'a task', projectId: project.id }).id
      reliability = new ReliabilityRepository({ db: store.db, events: bus, now, newId })
    })
  })

  const flat = (value: number): DimensionScores =>
    Object.fromEntries(
      RELIABILITY_DIMENSIONS.map((dimension) => [dimension, value]),
    ) as DimensionScores

  const record = (
    score: number,
    over: Partial<Parameters<ReliabilityRepository['record']>[0]> = {},
  ): ReliabilityAssessment =>
    reliability.record({
      taskId,
      trigger: 'run',
      score,
      rawScore: score,
      coverage: 50,
      delta: score,
      summary: `scored ${score}`,
      dimensions: flat(score),
      caps: [],
      explanation: { contributions: [], rawScore: score, caps: [], effectiveScore: score, causes: [] },
      scoringModelVersion: SCORING_MODEL_VERSION,
      ...over,
    })

  const addDriver = (): ReliabilityDriver =>
    reliability.addDriver({
      taskId,
      title: 'checkout regression',
      type: 'regression',
      severity: 'high',
      owner: 'agent',
      dimension: 'regressionSafety',
      scoreImpact: -3,
    })

  const named = (name: string): FactoryEvent[] => events.filter((event) => event.name === name)
  const columnTo = (column: string, value: string) => (): void => {
    store.db.run(
      `UPDATE reliability_assessments SET ${column} = ? WHERE task_id = ?`,
      value,
      taskId,
    )
  }

  Rule('a task that has never been judged says so rather than scoring zero', ({ RuleScenario }) => {
    RuleScenario('A new task has no assessment', ({ Then, And }) => {
      Then('the task has no newest assessment', () =>
        expect(reliability.newest(taskId)).toBeUndefined(),
      )
      And('the task has no history', () => expect(reliability.history(taskId)).toEqual([]))
    })

    RuleScenario('A new task has no drivers', ({ Then }) => {
      Then('the task has no drivers', () => expect(reliability.drivers(taskId)).toEqual([]))
    })
  })

  Rule('assessments accumulate, in an order that cannot tie', ({ RuleScenario }) => {
    RuleScenario('The first assessment is sequence one', ({ When, Then, And }) => {
      When('an assessment scoring 93 is recorded', () => {
        record(93)
      })
      Then('the newest assessment scores 93', () => expect(reliability.newest(taskId)?.score).toBe(93))
      And('its sequence is 1', () => expect(reliability.newest(taskId)?.sequence).toBe(1))
    })

    RuleScenario('The next assessment is sequence two', ({ Given, When, Then, And }) => {
      Given('an assessment scoring 93 was recorded', () => {
        record(93)
      })
      When('an assessment scoring 95 is recorded', () => {
        record(95)
      })
      Then('the newest assessment scores 95', () => expect(reliability.newest(taskId)?.score).toBe(95))
      And('its sequence is 2', () => expect(reliability.newest(taskId)?.sequence).toBe(2))
      And('the history holds 2 assessments', () =>
        expect(reliability.history(taskId)).toHaveLength(2),
      )
    })

    RuleScenario('History is oldest first, which is the order a graph wants', ({
      Given,
      And,
      Then,
    }) => {
      Given('an assessment scoring 93 was recorded', () => {
        record(93)
      })
      And('an assessment scoring 95 was recorded', () => {
        record(95)
      })
      Then('the history reads 93 then 95', () =>
        expect(reliability.history(taskId).map((a) => a.score)).toEqual([93, 95]),
      )
    })

    RuleScenario('Two assessments written in the same instant still order', ({
      Given,
      When,
      And,
      Then,
    }) => {
      Given('the clock does not move', () => {
        frozen = true
      })
      When('an assessment scoring 93 is recorded', () => {
        record(93)
      })
      And('an assessment scoring 95 is recorded', () => {
        record(95)
      })
      Then('their sequences are 1 and 2', () => {
        const history = reliability.history(taskId)
        expect(history.map((a) => a.sequence)).toEqual([1, 2])
        // The point of the scenario: the timestamps really are identical, so
        // ordering by time would be a coin toss.
        expect(history[0]?.createdAt).toBe(history[1]?.createdAt)
      })
    })

    RuleScenario('Recording an assessment is announced', ({ When, Then, And }) => {
      When('an assessment scoring 93 is recorded', () => {
        record(93, { delta: 4 })
      })
      Then('a "reliability.assessed" event says so', () =>
        expect(named('reliability.assessed')).toHaveLength(1),
      )
      And('the event carries the delta', () =>
        expect((named('reliability.assessed')[0]?.payload as { delta: number }).delta).toBe(4),
      )
    })
  })

  Rule('the whole arithmetic survives, because the logs will not', ({ RuleScenario }) => {
    RuleScenario('The dimensions come back as they went in', ({ When, Then }) => {
      When('an assessment with a dimension breakdown is recorded', () => {
        record(90, { dimensions: { ...flat(90), design: 71, verification: 55 } })
      })
      Then('every dimension comes back with its score', () => {
        const back = reliability.newest(taskId)?.dimensions
        expect(back?.design).toBe(71)
        expect(back?.verification).toBe(55)
        expect(back?.understanding).toBe(90)
      })
    })

    RuleScenario('The caps and their reasons come back', ({ When, Then }) => {
      When('an assessment capped at 70 is recorded', () => {
        record(70, {
          caps: [{ type: 'criticalOpenDriver', value: 70, reason: 'A critical risk is still open.' }],
        })
      })
      Then('the cap comes back with its reason', () => {
        const caps = reliability.newest(taskId)?.caps ?? []
        expect(caps[0]?.type).toBe('criticalOpenDriver')
        expect(caps[0]?.reason).toBe('A critical risk is still open.')
      })
    })

    RuleScenario('The working comes back', ({ When, Then, And }) => {
      When('an assessment with a full explanation is recorded', () => {
        record(90, {
          explanation: {
            contributions: [
              { dimension: 'design', score: 90, weight: 20, contribution: 18 },
            ],
            rawScore: 90,
            caps: [],
            effectiveScore: 90,
            causes: [{ summary: 'checkout regression', amount: -3 }],
          },
        })
      })
      Then('the contributions come back', () =>
        expect(reliability.newest(taskId)?.explanation.contributions).toHaveLength(1),
      )
      And('the causes come back', () =>
        expect(reliability.newest(taskId)?.explanation.causes[0]?.summary).toBe(
          'checkout regression',
        ),
      )
    })

    RuleScenario('What it saw comes back', ({ When, Then, And }) => {
      When('an assessment that observed a failed gate is recorded', () => {
        const observations: Observation[] = [
          {
            kind: 'gate_result',
            status: 'failed',
            summary: 'pnpm test exited 1',
            satisfies: 'regression_checks',
            reference: 'pnpm test',
          },
        ]
        record(80, { observations })
      })
      Then('the observation comes back', () =>
        expect(reliability.observations(taskId)).toHaveLength(1),
      )
      And('it still names what failed', () => {
        const seen = reliability.observations(taskId)[0]
        expect(seen?.status).toBe('failed')
        expect(seen?.reference).toBe('pnpm test')
      })
    })
  })

  Rule('a row edited by hand does not take the task with it', ({ RuleScenario }) => {
    RuleScenario('Unparseable dimensions read as zeroes, not as a throw', ({
      Given,
      And,
      Then,
    }) => {
      Given('an assessment scoring 93 was recorded', () => {
        record(93)
      })
      And('its dimensions column is edited by hand to nonsense', columnTo('dimensions', '{ oh dear'))
      Then('the assessment still loads', () => expect(reliability.newest(taskId)).toBeDefined())
      And('every dimension reads 0', () => {
        const back = reliability.newest(taskId)?.dimensions
        for (const dimension of RELIABILITY_DIMENSIONS) expect(back?.[dimension]).toBe(0)
      })
    })

    RuleScenario('An unparseable explanation reads as empty', ({ Given, And, Then }) => {
      Given('an assessment scoring 93 was recorded', () => {
        record(93)
      })
      And('its explanation column is edited by hand to nonsense', columnTo('explanation', 'nope'))
      Then('the assessment still loads', () => expect(reliability.newest(taskId)).toBeDefined())
      And('it has no contributions', () =>
        expect(reliability.newest(taskId)?.explanation.contributions).toEqual([]),
      )
    })

    RuleScenario('An unparseable list of caps reads as no caps', ({ Given, And, Then }) => {
      Given('an assessment capped at 70 was recorded', () => {
        record(70, {
          caps: [{ type: 'criticalOpenDriver', value: 70, reason: 'A critical risk is still open.' }],
        })
      })
      And('its caps column is edited by hand to nonsense', columnTo('caps', '[oh dear'))
      Then('the assessment still loads', () => expect(reliability.newest(taskId)).toBeDefined())
      And('it has no caps', () => expect(reliability.newest(taskId)?.caps).toEqual([]))
    })

    RuleScenario('A dimension the column omits still comes back', ({ Given, And, Then }) => {
      Given('an assessment scoring 93 was recorded', () => {
        record(93)
      })
      And('its dimensions column holds only "design"', columnTo('dimensions', '{"design":88}'))
      Then('every dimension the model lists is present', () => {
        const back = reliability.newest(taskId)?.dimensions
        for (const dimension of RELIABILITY_DIMENSIONS) {
          expect(back, dimension).toHaveProperty(dimension)
        }
        expect(back?.design).toBe(88)
      })
    })
  })

  Rule('what a board draws is one read, not one per task', ({ RuleScenario }) => {
    let second = ''
    const judgeOne = (task: string, score: number, coverage: number) => (): void => {
      reliability.record({
        taskId: task,
        trigger: 'run',
        score,
        rawScore: score,
        coverage,
        delta: score,
        summary: `scored ${score}`,
        dimensions: flat(score),
        caps: [],
        explanation: {
          contributions: [],
          rawScore: score,
          caps: [],
          effectiveScore: score,
          causes: [],
        },
        scoringModelVersion: '1.0',
      })
    }
    const read = () => reliability.newestScores()
    /** Read when the step runs, not when the Rule is built. */
    const projectId = (): string => {
      const task = tasks.get(taskId)
      if (task === undefined) throw new Error('The background task is missing.')
      return task.projectId
    }

    RuleScenario("Every task's newest score comes back in one answer", ({
      Given,
      And,
      Then,
    }) => {
      Given('a second task in the same project', () => {
        second = tasks.create({ name: 'another task', projectId: projectId() }).id
      })
      And('the first task was judged at 88 with 70% coverage', () => judgeOne(taskId, 88, 70)())
      And('the second task was judged at 61 with 40% coverage', () => judgeOne(second, 61, 40)())
      Then('the board read says the first task is 88 with 70% coverage', () =>
        expect(read().get(taskId)).toEqual({ score: 88, coverage: 70 }),
      )
      And('the board read says the second task is 61 with 40% coverage', () =>
        expect(read().get(second)).toEqual({ score: 61, coverage: 40 }),
      )
    })

    RuleScenario('The newest of several judgements is the one that comes back', ({
      Given,
      And,
      Then,
    }) => {
      Given('the task was judged at 40 with 10% coverage', () => judgeOne(taskId, 40, 10)())
      And('the task was judged at 91 with 95% coverage', () => judgeOne(taskId, 91, 95)())
      Then('the board read says the task is 91 with 95% coverage', () =>
        expect(read().get(taskId)).toEqual({ score: 91, coverage: 95 }),
      )
    })

    RuleScenario('A task nobody has judged is absent rather than scoring zero', ({
      Given,
      And,
      Then,
    }) => {
      Given('a second task in the same project', () => {
        second = tasks.create({ name: 'another task', projectId: projectId() }).id
      })
      And('the first task was judged at 88 with 70% coverage', () => judgeOne(taskId, 88, 70)())
      Then('the board read does not mention the second task', () => {
        expect(read().has(second)).toBe(false)
        expect(read().size).toBe(1)
      })
    })
  })

  Rule('drivers are found, moved, and never quietly dropped', ({ RuleScenario }) => {
    RuleScenario('A driver is stored with everything it was given', ({ When, Then, And }) => {
      When('a "high" driver owned by the agent is added', () => {
        addDriver()
      })
      Then('the task has 1 driver', () => expect(reliability.drivers(taskId)).toHaveLength(1))
      And('it is "open"', () => expect(reliability.drivers(taskId)[0]?.status).toBe('open'))
      And('it carries its owner and severity', () => {
        const driver = reliability.drivers(taskId)[0]
        expect(driver?.owner).toBe('agent')
        expect(driver?.severity).toBe('high')
      })
      And('a "reliability.driver.created" event says so', () =>
        expect(named('reliability.driver.created')).toHaveLength(1),
      )
    })

    RuleScenario('Resolving a driver records when', ({ Given, When, Then, And }) => {
      let id = ''
      Given('a "high" driver owned by the agent was added', () => {
        id = addDriver().id
      })
      When('it is resolved', () => {
        reliability.setDriverStatus(id, 'resolved')
      })
      Then('it is "resolved"', () => expect(reliability.driver(id)?.status).toBe('resolved'))
      And('it records when it was resolved', () =>
        expect(reliability.driver(id)?.resolvedAt).toBeDefined(),
      )
      And('a "reliability.driver.changed" event says so', () =>
        expect(named('reliability.driver.changed')).toHaveLength(1),
      )
    })

    RuleScenario('Accepting a driver records who and why', ({ Given, When, Then, And }) => {
      let id = ''
      Given('a "high" driver owned by the agent was added', () => {
        id = addDriver().id
      })
      When('it is accepted by "alex" because "the browser is out of support"', () => {
        reliability.setDriverStatus(id, 'accepted', {
          acceptedBy: 'alex',
          reason: 'the browser is out of support',
        })
      })
      Then('it is "accepted"', () => expect(reliability.driver(id)?.status).toBe('accepted'))
      And('it records who accepted it', () => expect(reliability.driver(id)?.acceptedBy).toBe('alex'))
      And('it records why', () =>
        expect(reliability.driver(id)?.acceptanceReason).toBe('the browser is out of support'),
      )
    })

    RuleScenario('A resolved driver is no longer active', ({ Given, When, Then, And }) => {
      let id = ''
      Given('a "high" driver owned by the agent was added', () => {
        id = addDriver().id
      })
      When('it is resolved', () => {
        reliability.setDriverStatus(id, 'resolved')
      })
      Then('the task has no active drivers', () => expect(reliability.active(taskId)).toEqual([]))
      And('the task still has 1 driver in all', () =>
        expect(reliability.drivers(taskId)).toHaveLength(1),
      )
    })

    RuleScenario('An accepted risk stays in the record', ({ Given, When, Then }) => {
      let id = ''
      Given('a "high" driver owned by the agent was added', () => {
        id = addDriver().id
      })
      When('it is accepted by "alex" because "the browser is out of support"', () => {
        reliability.setDriverStatus(id, 'accepted', {
          acceptedBy: 'alex',
          reason: 'the browser is out of support',
        })
      })
      Then('the task still has 1 driver in all', () =>
        expect(reliability.drivers(taskId)).toHaveLength(1),
      )
    })
  })

  Rule('deleting a task takes its judgement with it', ({ RuleScenario }) => {
    RuleScenario('Nothing is left behind', ({ Given, And, When, Then }) => {
      Given('an assessment scoring 93 was recorded', () => {
        record(93, {
          observations: [{ kind: 'artifact', status: 'passed', summary: 'analysis.md' }],
        })
      })
      And('a "high" driver owned by the agent was added', () => {
        addDriver()
      })
      When('the task is deleted', () => {
        tasks.delete(taskId)
      })
      Then('no assessments remain', () => expect(reliability.history(taskId)).toEqual([]))
      And('no drivers remain', () => expect(reliability.drivers(taskId)).toEqual([]))
      And('no observations remain', () => expect(reliability.observations(taskId)).toEqual([]))
    })
  })
})

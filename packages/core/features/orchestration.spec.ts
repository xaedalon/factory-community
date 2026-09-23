import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_ORCHESTRATION_LIMITS,
  admitAction,
  admitTask,
  isRefusal,
  type Initiator,
  type OrchestrationFacts,
  type OrchestrationLimits,
  type OrchestrationRefusal,
  type TaskAction,
} from '../src/index.js'

const feature = await loadFeature(
  fileURLToPath(new URL('./orchestration.feature', import.meta.url)),
)

describeFeature(feature, ({ Background, Rule }) => {
  /** The whole world these rules can see, built per scenario. */
  let depths: Map<string, number>
  let created: Map<string, number>
  let creators: Map<string, string>
  let origins: Map<string, string>
  let limits: OrchestrationLimits
  let facts: OrchestrationFacts
  let outcome: OrchestrationRefusal | { depth: number } | undefined

  Background(({ Given }) => {
    Given('nothing has run yet', () => {
      depths = new Map()
      created = new Map()
      creators = new Map()
      origins = new Map()
      limits = DEFAULT_ORCHESTRATION_LIMITS
      outcome = undefined
      facts = {
        depthOf: (runId) => depths.get(runId),
        tasksCreatedBy: (runId) => created.get(runId) ?? 0,
        creatorOf: (taskId) => creators.get(taskId),
        originOf: (runId) => origins.get(runId),
      }
    })
  })

  const asksForATask = (initiator?: Initiator) => () => {
    outcome = admitTask({ initiator, limits, facts })
  }
  const tries = (action: TaskAction, taskId: string, initiator: Initiator) => () => {
    outcome = admitAction({ initiator, action, taskId, facts })
  }
  const allowed = () => expect(isRefusal(outcome)).toBe(false)
  const refusedAs = (code: string) => () => {
    expect(isRefusal(outcome)).toBe(true)
    expect((outcome as OrchestrationRefusal).code).toBe(code)
  }
  const says = (text: string) => () =>
    expect((outcome as OrchestrationRefusal).message).toContain(text)
  const wouldBeAtDepth = (depth: number) => () =>
    expect((outcome as { depth: number }).depth).toBe(depth)
  const runAt = (id: string, depth: number) => () => void depths.set(id, depth)

  Rule('work started by a person is at the top of the tree', ({ RuleScenario }) => {
    RuleScenario('A request with no run behind it is depth zero', ({ When, Then, And }) => {
      When('somebody with no run asks for a task', asksForATask())
      Then('it is allowed', allowed)
      And('its run would be at depth 0', wouldBeAtDepth(0))
    })

    RuleScenario('A request from inside a run is one deeper', ({ Given, When, Then, And }) => {
      Given('a run "run-1" at depth 0', runAt('run-1', 0))
      When('the agent in "run-1" asks for a task', asksForATask({ runId: 'run-1' }))
      Then('it is allowed', allowed)
      And('its run would be at depth 1', wouldBeAtDepth(1))
    })

    RuleScenario('A run whose parent Factory has never heard of is treated as the top', ({
      When,
      Then,
      And,
    }) => {
      When('the agent in a run nobody has heard of asks for a task', asksForATask({ runId: 'ghost' }))
      Then('it is allowed', allowed)
      And('its run would be at depth 1', wouldBeAtDepth(1))
    })
  })

  Rule('the tree has a bottom', ({ RuleScenario }) => {
    RuleScenario('Three deep is allowed', ({ Given, When, Then, And }) => {
      Given('a run "run-3" at depth 2', runAt('run-3', 2))
      When('the agent in "run-3" asks for a task', asksForATask({ runId: 'run-3' }))
      Then('it is allowed', allowed)
      And('its run would be at depth 3', wouldBeAtDepth(3))
    })

    RuleScenario('Four deep is refused', ({ Given, When, Then, And }) => {
      Given('a run "run-4" at depth 3', runAt('run-4', 3))
      When('the agent in "run-4" asks for a task', asksForATask({ runId: 'run-4' }))
      Then('it is refused as RECURSION_LIMIT', refusedAs('RECURSION_LIMIT'))
      And('the refusal says to do it itself or ask a person', says('yourself'))
    })

    RuleScenario("The limit is the installation's to set", ({ Given, And, When, Then }) => {
      Given('the installation allows only one level', () => {
        limits = { ...DEFAULT_ORCHESTRATION_LIMITS, maxDepth: 1 }
      })
      And('a run "run-1" at depth 1', runAt('run-1', 1))
      When('the agent in "run-1" asks for a task', asksForATask({ runId: 'run-1' }))
      Then('it is refused as RECURSION_LIMIT', refusedAs('RECURSION_LIMIT'))
    })
  })

  Rule('one run may only ask for so much', ({ RuleScenario }) => {
    const asked = (count: number) => () => {
      depths.set('run-1', 0)
      created.set('run-1', count)
    }

    RuleScenario('The tenth task is allowed', ({ Given, When, Then }) => {
      Given('a run "run-1" at depth 0 that has asked for 9 tasks', asked(9))
      When('the agent in "run-1" asks for a task', asksForATask({ runId: 'run-1' }))
      Then('it is allowed', allowed)
    })

    RuleScenario('The eleventh is refused', ({ Given, When, Then, And }) => {
      Given('a run "run-1" at depth 0 that has asked for 10 tasks', asked(10))
      When('the agent in "run-1" asks for a task', asksForATask({ runId: 'run-1' }))
      Then('it is refused as FAN_OUT_LIMIT', refusedAs('FAN_OUT_LIMIT'))
      And('the refusal says to finish or cancel some first', says('Finish or cancel'))
    })
  })

  Rule('an agent may not reach around the run it is in', ({ RuleScenario }) => {
    const inTask = { runId: 'run-1', taskId: 'task-1' }
    const givenAgent = () => void depths.set('run-1', 0)

    RuleScenario('It cannot queue its own task', ({ Given, When, Then, And }) => {
      Given('an agent running task "task-1" in run "run-1"', givenAgent)
      When('it tries to queue "task-1"', tries('queue', 'task-1', inTask))
      Then('it is refused as SELF_ORCHESTRATION_BLOCKED', refusedAs('SELF_ORCHESTRATION_BLOCKED'))
      And('the refusal tells it to create a separate task', says('separate task'))
    })

    RuleScenario('It cannot cancel its own task', ({ Given, When, Then }) => {
      Given('an agent running task "task-1" in run "run-1"', givenAgent)
      When('it tries to cancel "task-1"', tries('cancel', 'task-1', inTask))
      Then('it is refused as SELF_ORCHESTRATION_BLOCKED', refusedAs('SELF_ORCHESTRATION_BLOCKED'))
    })

    RuleScenario('It may act on another task', ({ Given, When, Then }) => {
      Given('an agent running task "task-1" in run "run-1"', givenAgent)
      When('it tries to queue "task-2"', tries('queue', 'task-2', inTask))
      Then('it is allowed', allowed)
    })

    RuleScenario('A person is not running inside anything', ({ When, Then }) => {
      When('somebody with no run tries to queue "task-1"', () => {
        outcome = admitAction({ action: 'queue', taskId: 'task-1', facts })
      })
      Then('it is allowed', allowed)
    })
  })

  Rule('an agent may not approve what its own branch asked for', ({ RuleScenario }) => {
    const agentIn = (runId: string) => () => void depths.set(runId, 0)
    const askedForBy = (taskId: string, runId: string) => () => void creators.set(taskId, runId)
    const cameFrom = (runId: string, origin: string) => () => void origins.set(runId, origin)

    RuleScenario('It cannot approve a task it asked for itself', ({ Given, And, When, Then }) => {
      Given('an agent in run "run-1"', agentIn('run-1'))
      And('the task "task-2" was asked for by "run-1"', askedForBy('task-2', 'run-1'))
      When('it tries to approve "task-2"', tries('approve', 'task-2', { runId: 'run-1' }))
      Then('it is refused as APPROVAL_SEPARATION', refusedAs('APPROVAL_SEPARATION'))
      And('the refusal says an approval an agent can give itself is not a gate', () =>
        expect((outcome as OrchestrationRefusal).message).toContain('is not a gate'),
      )
    })

    RuleScenario("It cannot approve a task its parent asked for", ({ Given, And, When, Then }) => {
      Given('a run "run-2" that came from "run-1"', cameFrom('run-2', 'run-1'))
      And('an agent in run "run-2"', agentIn('run-2'))
      And('the task "task-3" was asked for by "run-1"', askedForBy('task-3', 'run-1'))
      When('it tries to approve "task-3"', tries('approve', 'task-3', { runId: 'run-2' }))
      Then('it is refused as APPROVAL_SEPARATION', refusedAs('APPROVAL_SEPARATION'))
    })

    RuleScenario('It may approve work from outside its own branch', ({ Given, And, When, Then }) => {
      Given('an agent in run "run-1"', agentIn('run-1'))
      And('the task "task-9" was asked for by a run in another tree', askedForBy('task-9', 'elsewhere'))
      When('it tries to approve "task-9"', tries('approve', 'task-9', { runId: 'run-1' }))
      Then('it is allowed', allowed)
    })

    RuleScenario('It may approve work a person asked for', ({ Given, And, When, Then }) => {
      Given('an agent in run "run-1"', agentIn('run-1'))
      And('the task "task-9" was asked for by a person', () => undefined)
      When('it tries to approve "task-9"', tries('approve', 'task-9', { runId: 'run-1' }))
      Then('it is allowed', allowed)
    })

    RuleScenario('A ring in the ancestry is walked once, not for ever', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('a run "run-1" that came from "run-2"', cameFrom('run-1', 'run-2'))
      And('a run "run-2" that came from "run-1"', cameFrom('run-2', 'run-1'))
      And('an agent in run "run-1"', agentIn('run-1'))
      And('the task "task-9" was asked for by a person', () => undefined)
      When('it tries to approve "task-9"', tries('approve', 'task-9', { runId: 'run-1' }))
      Then('it is allowed', allowed)
    })
  })
})

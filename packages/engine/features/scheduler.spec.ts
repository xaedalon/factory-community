import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { EventBus } from '@factory/events'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Scheduling } from '@factory/core'
import {
  MIGRATIONS,
  ProjectRepository,
  RunRepository,
  TaskRepository,
  openStore,
  type Store,
} from '@factory/store'
import { Scheduler, type TickReport } from '@factory/engine'

const feature = await loadFeature(fileURLToPath(new URL('./scheduler.feature', import.meta.url)))

describeFeature(feature, ({ Background, Scenario, Rule, AfterEachScenario }) => {
  let store: Store
  let tasks: TaskRepository
  let runs: RunRepository
  let events: EventBus
  let scheduler: Scheduler
  let report: TickReport
  let handovers: string[]
  let probes: boolean[]
  let failures: Map<string, string>
  let requirements: Map<string, string[]>
  /** Lanes a specific project gives a workflow, keyed `projectId/name`. */
  let lanes: Map<string, 'sequential' | 'parallel'>
  let projects: ProjectRepository
  let projectIds: Map<string, string>
  /** Ids the lookup pretends not to know, for the defensive branch. */
  let hidden: Set<string>
  let root = ''
  let byName: Map<string, string>
  let unwatch: (() => void) | undefined
  let cap: number
  let clock: Date
  let tick = 0

  const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString()

  AfterEachScenario(() => {
    unwatch?.()
    unwatch = undefined
    store?.close()
    rmSync(root, { recursive: true, force: true })
  })

  // Built in Background: the runner executes Background steps before anything
  // in BeforeEachScenario exists.
  Background(({ Given, And }) => {
    Given('an empty store', () => {
      tick = 0
      cap = 3
      clock = new Date(Date.UTC(2026, 0, 1, 0, 0, 0))
      handovers = []
      probes = []
      failures = new Map()
      requirements = new Map()
      lanes = new Map()
      projectIds = new Map()
      homeId = ''
      hidden = new Set()
      root = mkdtempSync(join(tmpdir(), 'factory-scheduler-'))
      byName = new Map()
      events = new EventBus({ onSubscriberError: () => {} })
      store = openStore({ file: ':memory:', migrations: MIGRATIONS })
      let ids = 0
      tasks = new TaskRepository({ db: store.db, events, now, newId: () => `task-${++ids}` })
      runs = new RunRepository({ db: store.db, events, now, newId: () => `run-${++ids}` })
      projects = new ProjectRepository({ db: store.db, events, now, newId: () => `pr-${++ids}` })
      build()
    })
    And('nothing is running', () => expect(tasks.list({ state: 'running' })).toHaveLength(0))
  })

  // The store refuses a transaction inside a transaction, so trying to open one
  // is a reliable way to ask "am I inside somebody else's write right now?".
  const transactionOpen = (): boolean => {
    try {
      store.db.transaction(() => undefined)
      return false
    } catch {
      return true
    }
  }

  const build = (): void => {
    scheduler = new Scheduler({
      tasks,
      runs,
      events,
      maxParallel: cap,
      // Read through a variable so a scenario can move time without rebuilding.
      now: () => clock,
      workflow: (name, projectId) => ({
        scheduling:
          lanes.get(`${projectId ?? ''}/${name}`) ??
          (name.startsWith('sequential') ? 'sequential' : 'parallel'),
        requires: requirements.get(name) ?? [],
      }),
      // Real projects, read the way the daemon reads them.
      project: (id) => {
        if (hidden.has(id)) return undefined
        const found = projects.get(id)
        return found === undefined
          ? undefined
          : { name: found.name, usesWorktrees: found.usesWorktrees }
      },
      // Stands in for the engine, and does what the engine does that the
      // scheduler depends on: nothing. The scheduler has already marked the task
      // running, so a handover that never returns leaves a task running — which
      // is exactly the state a long job is in.
      start: (taskId) => {
        handovers.push(taskId)
        probes.push(transactionOpen())
        const message = failures.get(taskId)
        return message === undefined ? new Promise(() => {}) : Promise.reject(new Error(message))
      },
    })
  }

  /**
   * The project the scenarios that are not about projects put their tasks in.
   *
   * It gives each task a worktree, so it serialises nothing — these scenarios
   * are about lanes and capacity, and a shared checkout would hold tasks back
   * for a reason they are not testing.
   */
  let homeId = ''
  const home = (): string => {
    if (homeId === '') {
      const path = join(root, 'home')
      mkdirSync(join(path, '.git'), { recursive: true })
      homeId = projects.add({ name: 'home', path, usesWorktrees: true }).id
    }
    return homeId
  }

  const queued = (name: string, lane: Scheduling): void => {
    const task = tasks.create({ name, workflows: [`${lane}-work`], projectId: home() })
    byName.set(name, task.id)
    tasks.act(task.id, 'queue')
  }
  const idOf = (name: string) => byName.get(name) as string
  const stateOf = (name: string) => tasks.get(idOf(name))?.state
  const startedNames = () => report.started.map((task) => task.name)
  const skippedFor = (name: string) =>
    report.skipped.find((entry) => entry.task.name === name)?.reason

  Scenario('A queued task is started', ({ Given, When, Then, And }) => {
    Given('a queued task "Add due dates" on a parallel workflow', () =>
      queued('Add due dates', 'parallel'),
    )
    When('the scheduler ticks', () => {
      report = scheduler.tick()
    })
    Then('"Add due dates" is started', () => expect(startedNames()).toEqual(['Add due dates']))
    And('it is "running"', () => expect(stateOf('Add due dates')).toBe('running'))
  })

  Scenario('Nothing queued, nothing started', ({ When, Then }) => {
    When('the scheduler ticks', () => {
      report = scheduler.tick()
    })
    Then('nothing is started', () => expect(report.started).toHaveLength(0))
  })

  Scenario('Tasks start in queue order', ({ Given, And, When, Then }) => {
    Given('a queued task "First" on a parallel workflow', () => queued('First', 'parallel'))
    And('a queued task "Second" on a parallel workflow', () => queued('Second', 'parallel'))
    When('the scheduler ticks', () => {
      report = scheduler.tick()
    })
    Then('the started tasks are "First, Second" in that order', () =>
      expect(startedNames()).toEqual(['First', 'Second']),
    )
  })

  Scenario('The concurrency cap holds', ({ Given, And, When, Then }) => {
    Given('the cap is 2', () => {
      cap = 2
      build()
    })
    And('a queued task "First" on a parallel workflow', () => queued('First', 'parallel'))
    And('a queued task "Second" on a parallel workflow', () => queued('Second', 'parallel'))
    And('a queued task "Third" on a parallel workflow', () => queued('Third', 'parallel'))
    When('the scheduler ticks', () => {
      report = scheduler.tick()
    })
    Then('2 tasks are started', () => expect(report.started).toHaveLength(2))
    And('"Third" was skipped because "at capacity"', () =>
      expect(skippedFor('Third')).toBe('at capacity'),
    )
  })

  Scenario('Only one sequential workflow runs at a time', ({ Given, And, When, Then }) => {
    Given('a queued task "First" on a sequential workflow', () => queued('First', 'sequential'))
    And('a queued task "Second" on a sequential workflow', () => queued('Second', 'sequential'))
    When('the scheduler ticks', () => {
      report = scheduler.tick()
    })
    Then('1 task is started', () => expect(report.started).toHaveLength(1))
    And('"Second" was skipped because "a sequential workflow is already running"', () =>
      expect(skippedFor('Second')).toBe('a sequential workflow is already running'),
    )
  })

  Scenario('A blocked lane does not hold up the queue behind it', ({ Given, And, When, Then }) => {
    Given('a queued task "First" on a sequential workflow', () => queued('First', 'sequential'))
    And('a queued task "Second" on a sequential workflow', () => queued('Second', 'sequential'))
    And('a queued task "Third" on a parallel workflow', () => queued('Third', 'parallel'))
    When('the scheduler ticks', () => {
      report = scheduler.tick()
    })
    Then('the started tasks are "First, Third" in that order', () =>
      expect(startedNames()).toEqual(['First', 'Third']),
    )
  })

  Scenario('A sequential workflow may run alongside parallel ones', ({
    Given,
    And,
    When,
    Then,
  }) => {
    Given('a queued task "First" on a sequential workflow', () => queued('First', 'sequential'))
    And('a queued task "Second" on a parallel workflow', () => queued('Second', 'parallel'))
    When('the scheduler ticks', () => {
      report = scheduler.tick()
    })
    Then('2 tasks are started', () => expect(report.started).toHaveLength(2))
  })

  Scenario('A task waiting for a person does not hold a slot', ({ Given, And, When, Then }) => {
    Given('the cap is 1', () => {
      cap = 1
      build()
    })
    And('a task "Waiting" is awaiting approval', () => {
      queued('Waiting', 'parallel')
      tasks.act(idOf('Waiting'), 'start')
      tasks.act(idOf('Waiting'), 'await_approval')
    })
    And('a queued task "Next" on a parallel workflow', () => queued('Next', 'parallel'))
    When('the scheduler ticks', () => {
      report = scheduler.tick()
    })
    Then('"Next" is started', () => expect(startedNames()).toEqual(['Next']))
  })

  Scenario('A freed slot is filled on the next tick', ({ Given, And, When, Then }) => {
    Given('the cap is 1', () => {
      cap = 1
      build()
    })
    And('a queued task "First" on a parallel workflow', () => queued('First', 'parallel'))
    And('a queued task "Second" on a parallel workflow', () => queued('Second', 'parallel'))
    And('the scheduler ticks', () => {
      report = scheduler.tick()
    })
    When('"First" finishes', () => {
      tasks.act(idOf('First'), 'complete')
    })
    And('the scheduler ticks again', () => {
      report = scheduler.tick()
    })
    Then('"Second" is started', () => expect(startedNames()).toEqual(['Second']))
  })

  Scenario('A task is never handed over twice', ({ Given, And, When, Then }) => {
    Given('the cap is 3', () => {
      cap = 3
      build()
    })
    And('a queued task "First" on a parallel workflow', () => queued('First', 'parallel'))
    When('the scheduler ticks twice', () => {
      scheduler.tick()
      report = scheduler.tick()
    })
    Then('"First" was handed over once', () =>
      expect(handovers.filter((id) => id === idOf('First'))).toHaveLength(1),
    )
  })

  Scenario('A tick asked for during a tick happens after it', ({ Given, And, When, Then }) => {
    Given('the cap is 3', () => {
      cap = 3
      build()
    })
    And('a queued task "First" on a parallel workflow', () => queued('First', 'parallel'))
    And('a queued task "Second" on a parallel workflow', () => queued('Second', 'parallel'))
    And('the scheduler ticks whenever a task changes state', () => {
      unwatch = scheduler.watch()
    })
    When('a task is queued', async () => {
      queued('Third', 'parallel')
      // Let the deferred ticks run.
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    Then('all the queued tasks are started', () =>
      expect(tasks.list({ state: 'queued' })).toHaveLength(0),
    )
    And('no transaction was still open when a tick ran', () => {
      expect(probes.length).toBeGreaterThan(0)
      expect(probes.every((open) => open === false)).toBe(true)
    })
  })

  const needsWorktree = (): void => {
    requirements.set('parallel-work', ['hasWorktree'])
    queued('Build', 'parallel')
  }

  Scenario('A task waits until the flag its workflow requires is set', ({ Given, When, Then, And }) => {
    Given('a queued task "Build" whose workflow requires "hasWorktree"', needsWorktree)
    When('the scheduler ticks', () => {
      report = scheduler.tick()
    })
    Then('nothing is started', () => expect(report.started).toHaveLength(0))
    And('"Build" was skipped because "a required flag is not set"', () =>
      expect(skippedFor('Build')).toBe('a required flag is not set'),
    )
    And('the report names "hasWorktree"', () =>
      expect(report.skipped[0]?.detail).toBe('hasWorktree'),
    )
    And('"Build" is still "queued"', () => expect(stateOf('Build')).toBe('queued'))
  })

  Scenario('The task runs once the flag is set', ({ Given, And, When, Then }) => {
    Given('a queued task "Build" whose workflow requires "hasWorktree"', needsWorktree)
    And('the scheduler ticks', () => {
      report = scheduler.tick()
    })
    When('"Build" earns "hasWorktree"', () => {
      tasks.changeFlags(idOf('Build'), { set: ['hasWorktree'] })
    })
    And('the scheduler ticks again', () => {
      report = scheduler.tick()
    })
    Then('"Build" is started', () => expect(startedNames()).toEqual(['Build']))
  })

  const waiting = (): void => {
    const created = tasks.create({ name: 'Watch', workflows: ['parallel-work'], projectId: home() })
    byName.set('Watch', created.id)
    tasks.act(created.id, 'queue', { until: new Date(clock.getTime() + 60_000).toISOString() })
  }

  Scenario('A loop waiting for its next iteration is left alone', ({ Given, When, Then, And }) => {
    Given('a queued task "Watch" that may not run for another minute', waiting)
    When('the scheduler ticks', () => {
      report = scheduler.tick()
    })
    Then('nothing is started', () => expect(report.started).toHaveLength(0))
    And('"Watch" was skipped because "waiting for its next iteration"', () =>
      expect(skippedFor('Watch')).toBe('waiting for its next iteration'),
    )
  })

  Scenario('The iteration starts once its time has come', ({ Given, And, When, Then }) => {
    Given('a queued task "Watch" that may not run for another minute', waiting)
    And('the scheduler ticks', () => {
      report = scheduler.tick()
    })
    When('a minute passes', () => {
      clock = new Date(clock.getTime() + 61_000)
    })
    And('the scheduler ticks again', () => {
      report = scheduler.tick()
    })
    Then('"Watch" is started', () => expect(startedNames()).toEqual(['Watch']))
  })

  /**
   * The state an approval leaves behind: the task is running again because a
   * person approved it, and its run is paused holding everything that already
   * happened. Nothing but the scheduler will pick it up.
   */
  const approvedAndWaiting = (): void => {
    queued('Waiting', 'parallel')
    const id = idOf('Waiting')
    tasks.act(id, 'start')
    const run = runs.start({ workflow: 'parallel-work', taskId: id })
    runs.pause(run.id, 1)
    tasks.act(id, 'await_approval')
    tasks.act(id, 'approve')
  }

  Scenario('An approved task is picked back up', ({ Given, When, Then }) => {
    Given('a task "Waiting" that was approved and is holding a paused run', approvedAndWaiting)
    When('the scheduler ticks', () => {
      report = scheduler.tick()
    })
    Then('"Waiting" was handed over once', () =>
      expect(handovers.filter((id) => id === idOf('Waiting'))).toHaveLength(1),
    )
  })

  Scenario('A task already being worked on is not handed over again', ({
    Given,
    And,
    When,
    Then,
  }) => {
    Given('a task "Waiting" that was approved and is holding a paused run', approvedAndWaiting)
    And('the scheduler ticks', () => {
      report = scheduler.tick()
    })
    When('the scheduler ticks again', () => {
      report = scheduler.tick()
    })
    // The fake handover never resolves, so the task is still in flight — and a
    // second hand-over would run the same work twice.
    Then('"Waiting" was handed over once', () =>
      expect(handovers.filter((id) => id === idOf('Waiting'))).toHaveLength(1),
    )
  })

  Scenario('A task the engine refuses is blocked, and the scheduler carries on', ({
    Given,
    And,
    When,
    Then,
  }) => {
    Given('a queued task "Broken" on a parallel workflow', () => queued('Broken', 'parallel'))
    And('handing a task over fails with "the worktree is missing"', () => {
      failures.set(idOf('Broken'), 'the worktree is missing')
    })
    And('a queued task "Fine" on a parallel workflow', () => queued('Fine', 'parallel'))
    When('the scheduler ticks', () => {
      report = scheduler.tick()
    })
    And('the work settles', async () => {
      // "Fine" never returns, so waiting for everything would wait forever —
      // the rejected handover is the one being observed.
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    Then('"Broken" is "blocked"', () => expect(stateOf('Broken')).toBe('blocked'))
    And('"Broken" says why it is blocked', () =>
      expect(tasks.get(idOf('Broken'))?.blockedReason).toContain('worktree'),
    )
    And('"Fine" is "running"', () => expect(stateOf('Fine')).toBe('running'))
  })

  /**
   * A real project, with a real directory — `tasks.project_id` is a foreign key,
   * so there is no such thing as a task in a project that does not exist.
   */
  const givenProject = (name: string, usesWorktrees: boolean): void => {
    const path = join(root, name)
    mkdirSync(usesWorktrees ? join(path, '.git') : path, { recursive: true })
    projectIds.set(name, projects.add({ name, path, usesWorktrees }).id)
  }
  const queuedIn = (name: string, project: string): void => {
    const created = tasks.create({
      name,
      workflows: ['parallel-work'],
      projectId: projectIds.get(project) as string,
    })
    byName.set(name, created.id)
    tasks.act(created.id, 'queue')
  }
  const reasonFor = (name: string): string =>
    report.skipped.find((entry) => entry.task.name === name)?.detail ?? ''

  /** The scenario paired with "does not hold a slot", above. */
  Scenario('A task waiting for a person keeps the checkout it is working in', ({
    Given,
    And,
    When,
    Then,
  }) => {
    Given('a project "api" that works in its own checkout', () => givenProject('api', false))
    And('a task "Waiting" in "api" is awaiting approval', () => {
      queuedIn('Waiting', 'api')
      tasks.act(idOf('Waiting'), 'start')
      tasks.act(idOf('Waiting'), 'await_approval')
    })
    And('a queued task "Next" in "api"', () => queuedIn('Next', 'api'))
    When('the scheduler ticks', () => {
      report = scheduler.tick()
    })
    // It released its slot — the scenario above proves that — and kept the
    // working copy, because its uncommitted changes are still in the tree.
    Then('nothing is started', () => expect(report.started).toHaveLength(0))
    And('"Next" was skipped because "the project runs one task at a time"', () =>
      expect(skippedFor('Next')).toBe('the project runs one task at a time'),
    )
  })

  Rule('a project that shares one checkout runs one task at a time', ({ RuleScenario }) => {
      RuleScenario('A project that works in its own checkout starts one task and no more', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('a project "api" that works in its own checkout', () => givenProject('api', false))
      And('a queued task "First" in "api"', () => queuedIn('First', 'api'))
      And('a queued task "Second" in "api"', () => queuedIn('Second', 'api'))
      When('the scheduler ticks', () => {
        report = scheduler.tick()
      })
      Then('1 task is started', () => expect(report.started).toHaveLength(1))
      And('"Second" was skipped because "the project runs one task at a time"', () =>
        expect(skippedFor('Second')).toBe('the project runs one task at a time'),
      )
    })

      RuleScenario('The task left waiting is told which project, and which task has it', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('a project "api" that works in its own checkout', () => givenProject('api', false))
      And('a queued task "First" in "api"', () => queuedIn('First', 'api'))
      And('a queued task "Second" in "api"', () => queuedIn('Second', 'api'))
      When('the scheduler ticks', () => {
        report = scheduler.tick()
      })
      // "Busy" is not a useful thing to be told without being told by whom.
      Then('the reason given to "Second" names "api"', () =>
        expect(reasonFor('Second')).toContain('api'),
      )
      And('the reason given to "Second" names "First"', () =>
        expect(reasonFor('Second')).toContain('First'),
      )
    })

      RuleScenario('Work in other projects carries on regardless', ({ Given, And, When, Then }) => {
      Given('a project "api" that works in its own checkout', () => givenProject('api', false))
      And('a project "web" that gives each task a worktree', () => givenProject('web', true))
      And('a queued task "First" in "api"', () => queuedIn('First', 'api'))
      And('a queued task "Second" in "api"', () => queuedIn('Second', 'api'))
      And('a queued task "Third" in "web"', () => queuedIn('Third', 'web'))
      When('the scheduler ticks', () => {
        report = scheduler.tick()
      })
      Then('the started tasks are "First, Third" in that order', () =>
        expect(startedNames()).toEqual(['First', 'Third']),
      )
    })

      RuleScenario('A project no lookup can answer for holds nothing', ({ Given, And, When, Then }) => {
      // `hidden` is the lookup refusing to answer, which is what a scheduler
      // built without a project store does for every project — and what a
      // hand-edited database does for one.
      Given('a queued task "First" in a project the lookup cannot see', () => {
        givenProject('gone', false)
        queuedIn('First', 'gone')
        hidden.add(projectIds.get('gone') as string)
      })
      And('a queued task "Second" in the same project', () => queuedIn('Second', 'gone'))
      When('the scheduler ticks', () => {
        report = scheduler.tick()
      })
      Then('2 tasks are started', () => expect(report.started).toHaveLength(2))
    })

      RuleScenario('A project that gives each task a worktree runs as many as capacity allows', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('a project "web" that gives each task a worktree', () => givenProject('web', true))
      And('a queued task "First" in "web"', () => queuedIn('First', 'web'))
      And('a queued task "Second" in "web"', () => queuedIn('Second', 'web'))
      When('the scheduler ticks', () => {
        report = scheduler.tick()
      })
      Then('2 tasks are started', () => expect(report.started).toHaveLength(2))
    })

      RuleScenario('The project is free again once the task that had it finishes', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('a project "api" that works in its own checkout', () => givenProject('api', false))
      And('a queued task "First" in "api"', () => queuedIn('First', 'api'))
      And('a queued task "Second" in "api"', () => queuedIn('Second', 'api'))
      And('the scheduler ticks', () => {
        report = scheduler.tick()
      })
      When('"First" finishes', () => {
        tasks.act(idOf('First'), 'complete')
      })
      And('the scheduler ticks again', () => {
        report = scheduler.tick()
      })
      Then('"Second" is started', () => expect(startedNames()).toEqual(['Second']))
    })

      RuleScenario('A blocked task lets the project go', ({ Given, And, When, Then }) => {
      Given('a project "api" that works in its own checkout', () => givenProject('api', false))
      // One forgotten failure must not freeze a repository. Its changes are still
      // in the tree, which doctor says out loud.
      And('a task "Stopped" in "api" is blocked', () => {
        queuedIn('Stopped', 'api')
        tasks.act(idOf('Stopped'), 'start')
        tasks.act(idOf('Stopped'), 'block', { reason: 'the tests failed' })
      })
      And('a queued task "Next" in "api"', () => queuedIn('Next', 'api'))
      When('the scheduler ticks', () => {
        report = scheduler.tick()
      })
      Then('"Next" is started', () => expect(startedNames()).toEqual(['Next']))
    })

      RuleScenario('A busy project does not hold up the queue behind it', ({ Given, And, When, Then }) => {
      Given('a project "api" that works in its own checkout', () => givenProject('api', false))
      And('a project "web" that gives each task a worktree', () => givenProject('web', true))
      And('a queued task "First" in "api"', () => queuedIn('First', 'api'))
      And('a queued task "Second" in "api"', () => queuedIn('Second', 'api'))
      And('a queued task "Loose" in "web"', () => queuedIn('Loose', 'web'))
      When('the scheduler ticks', () => {
        report = scheduler.tick()
      })
      Then('the started tasks are "First, Loose" in that order', () =>
        expect(startedNames()).toEqual(['First', 'Loose']),
      )
    })

      RuleScenario('An approved task is picked back up even though its project is busy with it', ({
      Given,
      And,
      When,
      Then,
    }) => {
      // The resume loop seeds the busy map and never consults it. A resumed task
      // is continuing work whose files are already in that checkout, so making it
      // wait protects nothing — and there is no way back to the queue from here.
      Given('a project "api" that works in its own checkout', () => givenProject('api', false))
      And('a task "Waiting" in "api" that was approved and is holding a paused run', () => {
        queuedIn('Waiting', 'api')
        const id = idOf('Waiting')
        tasks.act(id, 'start')
        const run = runs.start({ workflow: 'parallel-work', taskId: id })
        runs.pause(run.id, 1)
        tasks.act(id, 'await_approval')
        tasks.act(id, 'approve')
      })
      When('the scheduler ticks', () => {
        report = scheduler.tick()
      })
      Then('"Waiting" was handed over once', () =>
        expect(handovers.filter((id) => id === idOf('Waiting'))).toHaveLength(1),
      )
    })
  })

  Rule("a workflow means whatever the task's own project says it means", ({ RuleScenario }) => {
    const laneIn = (project: string, workflow: string, lane: 'sequential' | 'parallel'): void => {
      givenProject(project, true)
      lanes.set(`${projectIds.get(project) as string}/${workflow}`, lane)
    }
    const queuedOn = (name: string, workflow: string, project: string): void => {
      const created = tasks.create({
        name,
        workflows: [workflow],
        projectId: projectIds.get(project) as string,
      })
      byName.set(name, created.id)
      tasks.act(created.id, 'queue')
    }

    RuleScenario("A workflow's lane is read from the task's own project", ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('a project "api" where "build" runs one task at a time', () =>
        laneIn('api', 'build', 'sequential'),
      )
      And('a project "web" where "build" runs alongside others', () =>
        laneIn('web', 'build', 'parallel'),
      )
      And('a queued task "Api one" on "build" in "api"', () => queuedOn('Api one', 'build', 'api'))
      And('a queued task "Api two" on "build" in "api"', () => queuedOn('Api two', 'build', 'api'))
      And('a queued task "Web one" on "build" in "web"', () => queuedOn('Web one', 'build', 'web'))
      When('the scheduler ticks', () => {
        report = scheduler.tick()
      })
      // Both projects give every task a worktree, so nothing here is about
      // sharing a checkout: the only thing holding "Api two" back is the lane
      // its own project's "build" declares.
      Then('the started tasks are "Api one, Web one" in that order', () =>
        expect(report.started.map((task) => task.name).join(', ')).toBe('Api one, Web one'),
      )
      And('"Api two" was skipped because "a sequential workflow is already running"', () =>
        expect(
          report.skipped.find((entry) => entry.task.name === 'Api two')?.reason,
        ).toBe('a sequential workflow is already running'),
      )
    })
  })

  Rule('a task waits for the tasks it depends on', ({ RuleScenario }) => {
    const ticks = (): void => {
      report = scheduler.tick()
    }
    const waitsFor = (name: string, blocker: string) => (): void => {
      tasks.dependOn(idOf(name), idOf(blocker))
    }
    const skippedBecause = (name: string, reason: string) => (): void => {
      expect(skippedFor(name)).toBe(reason)
    }
    const isState = (name: string, state: string) => (): void => {
      expect(stateOf(name)).toBe(state)
    }
    const started = (names: string) => (): void => {
      expect(startedNames()).toEqual(names.split(', '))
    }

    RuleScenario('A task waits for its blocker', ({ Given, And, When, Then }) => {
      Given('a queued task "Scaffold" on a parallel workflow', () =>
        queued('Scaffold', 'parallel'),
      )
      And('a queued task "The model" on a parallel workflow', () =>
        queued('The model', 'parallel'),
      )
      And('"The model" waits for "Scaffold"', waitsFor('The model', 'Scaffold'))
      When('the scheduler ticks', ticks)
      Then('the started tasks are "Scaffold" in that order', started('Scaffold'))
      And(
        '"The model" was skipped because "a task it depends on is not done"',
        skippedBecause('The model', 'a task it depends on is not done'),
      )
      And('"The model" is "queued"', isState('The model', 'queued'))
    })

    RuleScenario('The skip names the blocker', ({ Given, And, When, Then }) => {
      Given('a queued task "Scaffold" on a parallel workflow', () =>
        queued('Scaffold', 'parallel'),
      )
      And('a queued task "The model" on a parallel workflow', () =>
        queued('The model', 'parallel'),
      )
      And('"The model" waits for "Scaffold"', waitsFor('The model', 'Scaffold'))
      When('the scheduler ticks', ticks)
      Then('the skip detail for "The model" names "Scaffold"', () =>
        expect(reasonFor('The model')).toBe('"Scaffold"'),
      )
    })

    RuleScenario('It starts once the blocker is done', ({ Given, And, When, Then }) => {
      Given('a queued task "Scaffold" on a parallel workflow', () =>
        queued('Scaffold', 'parallel'),
      )
      And('a queued task "The model" on a parallel workflow', () =>
        queued('The model', 'parallel'),
      )
      And('"The model" waits for "Scaffold"', waitsFor('The model', 'Scaffold'))
      And('the scheduler ticks', ticks)
      When('"Scaffold" is done', () => {
        tasks.act(idOf('Scaffold'), 'complete')
      })
      And('the scheduler ticks again', ticks)
      Then('"The model" is started', () => expect(startedNames()).toEqual(['The model']))
    })

    RuleScenario('A task with no dependencies is unaffected', ({ Given, When, Then }) => {
      Given('a queued task "Add due dates" on a parallel workflow', () =>
        queued('Add due dates', 'parallel'),
      )
      When('the scheduler ticks', ticks)
      Then('"Add due dates" is started', () => expect(startedNames()).toEqual(['Add due dates']))
    })

    RuleScenario('Two tasks waiting for the same blocker both go when it is done', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('a queued task "Scaffold" on a parallel workflow', () =>
        queued('Scaffold', 'parallel'),
      )
      And('a queued task "The model" on a parallel workflow', () =>
        queued('The model', 'parallel'),
      )
      And('a queued task "The view" on a parallel workflow', () =>
        queued('The view', 'parallel'),
      )
      And('"The model" waits for "Scaffold"', waitsFor('The model', 'Scaffold'))
      And('"The view" waits for "Scaffold"', waitsFor('The view', 'Scaffold'))
      And('the scheduler ticks', ticks)
      When('"Scaffold" is done', () => {
        tasks.act(idOf('Scaffold'), 'complete')
      })
      And('the scheduler ticks again', ticks)
      Then('the started tasks are "The model, The view" in that order', started('The model, The view'))
    })

    RuleScenario('A chain runs one at a time in order', ({ Given, And, When, Then }) => {
      Given('a queued task "One" on a parallel workflow', () => queued('One', 'parallel'))
      And('a queued task "Two" on a parallel workflow', () => queued('Two', 'parallel'))
      And('a queued task "Three" on a parallel workflow', () => queued('Three', 'parallel'))
      And('"Two" waits for "One"', waitsFor('Two', 'One'))
      And('"Three" waits for "Two"', waitsFor('Three', 'Two'))
      When('the scheduler ticks', ticks)
      Then('the started tasks are "One" in that order', started('One'))
    })

    RuleScenario('Waiting outranks the lane', ({ Given, And, When, Then }) => {
      Given('a queued task "Scaffold" on a sequential workflow', () =>
        queued('Scaffold', 'sequential'),
      )
      And('a queued task "The model" on a sequential workflow', () =>
        queued('The model', 'sequential'),
      )
      And('"The model" waits for "Scaffold"', waitsFor('The model', 'Scaffold'))
      When('the scheduler ticks', ticks)
      Then(
        '"The model" was skipped because "a task it depends on is not done"',
        skippedBecause('The model', 'a task it depends on is not done'),
      )
    })

    RuleScenario('Waiting outranks the shared checkout', ({ Given, And, When, Then }) => {
      Given('a project "api" that works in its own checkout', () => givenProject('api', false))
      And('a queued task "Scaffold" in "api"', () => queuedIn('Scaffold', 'api'))
      And('a queued task "The model" in "api"', () => queuedIn('The model', 'api'))
      And('"The model" waits for "Scaffold"', waitsFor('The model', 'Scaffold'))
      When('the scheduler ticks', ticks)
      Then(
        '"The model" was skipped because "a task it depends on is not done"',
        skippedBecause('The model', 'a task it depends on is not done'),
      )
    })

    RuleScenario('Capacity still comes first', ({ Given, And, When, Then }) => {
      Given('the cap is 1', () => {
        cap = 1
        build()
      })
      And('a queued task "Scaffold" on a parallel workflow', () =>
        queued('Scaffold', 'parallel'),
      )
      And('a queued task "The model" on a parallel workflow', () =>
        queued('The model', 'parallel'),
      )
      And('"The model" waits for "Scaffold"', waitsFor('The model', 'Scaffold'))
      When('the scheduler ticks', ticks)
      Then('"The model" was skipped because "at capacity"', skippedBecause('The model', 'at capacity'))
    })

    RuleScenario('A cancelled blocker blocks its dependent', ({ Given, And, When, Then }) => {
      Given('a queued task "Scaffold" on a parallel workflow', () =>
        queued('Scaffold', 'parallel'),
      )
      And('a queued task "The model" on a parallel workflow', () =>
        queued('The model', 'parallel'),
      )
      And('"The model" waits for "Scaffold"', waitsFor('The model', 'Scaffold'))
      And('"Scaffold" is cancelled', () => {
        tasks.act(idOf('Scaffold'), 'cancel')
      })
      When('the scheduler ticks', ticks)
      Then('"The model" is "blocked"', isState('The model', 'blocked'))
      And('the tick reports blocking "The model"', () =>
        expect(report.blocked.map((entry) => entry.name)).toEqual(['The model']),
      )
      And('the reason for "The model" says "Scaffold" was cancelled', () =>
        expect(tasks.get(idOf('The model'))?.blockedReason).toBe(
          '"Scaffold" was cancelled, so this cannot start.',
        ),
      )
    })

    RuleScenario('A blocked blocker blocks its dependent', ({ Given, And, When, Then }) => {
      Given('a queued task "Scaffold" on a parallel workflow', () =>
        queued('Scaffold', 'parallel'),
      )
      And('a queued task "The model" on a parallel workflow', () =>
        queued('The model', 'parallel'),
      )
      And('"The model" waits for "Scaffold"', waitsFor('The model', 'Scaffold'))
      And('"Scaffold" is blocked', () => {
        tasks.act(idOf('Scaffold'), 'block', { reason: 'the tests failed' })
      })
      When('the scheduler ticks', ticks)
      Then('"The model" is "blocked"', isState('The model', 'blocked'))
      And('the reason for "The model" says "Scaffold" is blocked', () =>
        expect(tasks.get(idOf('The model'))?.blockedReason).toBe(
          '"Scaffold" is blocked, so this cannot start.',
        ),
      )
    })

    RuleScenario('A dependent taken out of the queue is not also reported as skipped', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('a queued task "Scaffold" on a parallel workflow', () =>
        queued('Scaffold', 'parallel'),
      )
      And('a queued task "The model" on a parallel workflow', () =>
        queued('The model', 'parallel'),
      )
      And('"The model" waits for "Scaffold"', waitsFor('The model', 'Scaffold'))
      And('"Scaffold" is cancelled', () => {
        tasks.act(idOf('Scaffold'), 'cancel')
      })
      When('the scheduler ticks', ticks)
      Then('nothing was skipped', () => expect(report.skipped).toEqual([]))
    })

    RuleScenario('Retrying the blocker puts the dependent back to waiting', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('a queued task "Scaffold" on a parallel workflow', () =>
        queued('Scaffold', 'parallel'),
      )
      And('a queued task "The model" on a parallel workflow', () =>
        queued('The model', 'parallel'),
      )
      And('"The model" waits for "Scaffold"', waitsFor('The model', 'Scaffold'))
      And('"Scaffold" is cancelled', () => {
        tasks.act(idOf('Scaffold'), 'cancel')
      })
      And('the scheduler ticks', ticks)
      When('"Scaffold" is queued again', () => {
        tasks.act(idOf('Scaffold'), 'queue')
      })
      And('"The model" is retried', () => {
        tasks.act(idOf('The model'), 'retry')
      })
      And('the scheduler ticks again', ticks)
      Then('the started tasks are "Scaffold" in that order', started('Scaffold'))
      And(
        '"The model" was skipped because "a task it depends on is not done"',
        skippedBecause('The model', 'a task it depends on is not done'),
      )
    })

    RuleScenario('A blocker archived after finishing is done enough', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('a queued task "Scaffold" on a parallel workflow', () =>
        queued('Scaffold', 'parallel'),
      )
      And('a queued task "The model" on a parallel workflow', () =>
        queued('The model', 'parallel'),
      )
      And('"The model" waits for "Scaffold"', waitsFor('The model', 'Scaffold'))
      And('"Scaffold" is done', () => {
        tasks.act(idOf('Scaffold'), 'mark_done')
      })
      When('"Scaffold" is archived', () => {
        tasks.act(idOf('Scaffold'), 'archive')
      })
      And('the scheduler ticks', ticks)
      Then('"The model" is started', () => expect(startedNames()).toEqual(['The model']))
    })

    RuleScenario('A blocker archived without finishing is a dead end', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('a queued task "Scaffold" on a parallel workflow', () =>
        queued('Scaffold', 'parallel'),
      )
      And('a queued task "The model" on a parallel workflow', () =>
        queued('The model', 'parallel'),
      )
      And('"The model" waits for "Scaffold"', waitsFor('The model', 'Scaffold'))
      And('"Scaffold" is cancelled', () => {
        tasks.act(idOf('Scaffold'), 'cancel')
      })
      When('"Scaffold" is archived', () => {
        tasks.act(idOf('Scaffold'), 'archive')
      })
      And('the scheduler ticks', ticks)
      Then('"The model" is "blocked"', isState('The model', 'blocked'))
    })

    RuleScenario('A dead blocker settles it even while another is still going', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('a queued task "Scaffold" on a parallel workflow', () =>
        queued('Scaffold', 'parallel'),
      )
      And('a queued task "Groundwork" on a parallel workflow', () =>
        queued('Groundwork', 'parallel'),
      )
      And('a queued task "The model" on a parallel workflow', () =>
        queued('The model', 'parallel'),
      )
      And('"The model" waits for "Scaffold"', waitsFor('The model', 'Scaffold'))
      And('"The model" waits for "Groundwork"', waitsFor('The model', 'Groundwork'))
      And('"Scaffold" is cancelled', () => {
        tasks.act(idOf('Scaffold'), 'cancel')
      })
      When('the scheduler ticks', ticks)
      Then('"The model" is "blocked"', isState('The model', 'blocked'))
      And('the reason for "The model" says "Scaffold" was cancelled', () =>
        expect(tasks.get(idOf('The model'))?.blockedReason).toBe(
          '"Scaffold" was cancelled, so this cannot start.',
        ),
      )
    })
  })
  Rule('the gates are about the workflow that is about to run', ({ RuleScenario }) => {
    /**
     * A task that has finished its first workflow and is queued for its next.
     *
     * `finished` is what the engine calls when a workflow completes: it unticks
     * the entry, so `nextEntry` moves on while `workflows[0]` and the newest
     * run both still name the one that is over.
     */
    const partlyDone = (next: string): void => {
      const created = tasks.create({
        name: 'Ship',
        workflows: ['parallel-work', next],
        projectId: home(),
      })
      byName.set('Ship', created.id)
      // Through the real transitions, so the task reaches "queued with one
      // workflow behind it" the way a task actually does.
      tasks.act(created.id, 'queue')
      tasks.act(created.id, 'start')
      runs.start({ workflow: 'parallel-work', taskId: created.id })
      tasks.finished(created.id, created.workflows[0]?.id as string)
      tasks.act(created.id, 'complete')
      tasks.act(created.id, 'queue')
    }

    RuleScenario('The lane comes from the workflow about to run, not the one that has run', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given(
        'a queued task "Ship" whose parallel workflow has run and whose next is sequential',
        () => partlyDone('sequential-work'),
      )
      And('a sequential workflow is already running', () => {
        queued('Holder', 'sequential')
        tasks.act(idOf('Holder'), 'start')
        runs.start({ workflow: 'sequential-work', taskId: idOf('Holder') })
      })
      When('the scheduler ticks', () => {
        report = scheduler.tick()
      })
      Then('"Ship" was skipped because "a sequential workflow is already running"', () =>
        expect(skippedFor('Ship')).toBe('a sequential workflow is already running'),
      )
    })

    RuleScenario('The flag gate asks about the workflow about to run', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given(
        'a queued task "Ship" whose parallel workflow has run and whose next needs "hasWorktree"',
        () => {
          requirements.set('deploy', ['hasWorktree'])
          partlyDone('deploy')
        },
      )
      When('the scheduler ticks', () => {
        report = scheduler.tick()
      })
      Then('"Ship" was skipped because "a required flag is not set"', () =>
        expect(skippedFor('Ship')).toBe('a required flag is not set'),
      )
      And('the report names "hasWorktree"', () =>
        expect(report.skipped.find((entry) => entry.task.name === 'Ship')?.detail).toBe(
          'hasWorktree',
        ),
      )
    })

    // The one case where the newest run is the right answer, and why the fix
    // is not "always ask the list": an `on_fail` workflow is not in it.
    RuleScenario('A running task holds the lane of the workflow it is actually running', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given(
        'a task "Repairing" running a sequential recovery workflow that is not in its list',
        () => {
          queued('Repairing', 'parallel')
          tasks.act(idOf('Repairing'), 'start')
          runs.start({ workflow: 'sequential-repair', taskId: idOf('Repairing') })
        },
      )
      And('a queued task "Next" on a sequential workflow', () => queued('Next', 'sequential'))
      When('the scheduler ticks', () => {
        report = scheduler.tick()
      })
      Then('"Next" was skipped because "a sequential workflow is already running"', () =>
        expect(skippedFor('Next')).toBe('a sequential workflow is already running'),
      )
    })
  })
  Rule('the lane holds across an approval gate too', ({ RuleScenario }) => {
    /** Approved, holding a paused run, waiting for the resume loop to pick it up. */
    const approvedOn = (name: string, lane: Scheduling) => (): void => {
      queued(name, lane)
      const id = idOf(name)
      tasks.act(id, 'start')
      const run = runs.start({ workflow: `${lane}-work`, taskId: id })
      runs.pause(run.id, 1)
      tasks.act(id, 'await_approval')
      tasks.act(id, 'approve')
    }
    const handedOver = (name: string) => handovers.includes(idOf(name))

    RuleScenario('Two approved tasks do not resume their sequential workflows together', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('a task "First" approved and holding a paused sequential run', approvedOn('First', 'sequential'))
      And('a task "Second" approved and holding a paused sequential run', approvedOn('Second', 'sequential'))
      When('the scheduler ticks', () => {
        report = scheduler.tick()
      })
      Then('1 task was handed over', () => expect(handovers).toHaveLength(1))
      And('"Second" was skipped because "a sequential workflow is already running"', () =>
        expect(skippedFor('Second')).toBe('a sequential workflow is already running'),
      )
    })

    RuleScenario('The one left behind resumes on the next tick', ({ Given, And, When, Then }) => {
      Given('a task "First" approved and holding a paused sequential run', approvedOn('First', 'sequential'))
      And('a task "Second" approved and holding a paused sequential run', approvedOn('Second', 'sequential'))
      And('the scheduler ticks', () => {
        report = scheduler.tick()
      })
      When('"First" finishes', () => {
        const paused = runs.pausedFor(idOf('First'))
        if (paused !== undefined) runs.resume(paused.id)
        tasks.act(idOf('First'), 'complete')
      })
      And('the scheduler ticks again', () => {
        report = scheduler.tick()
      })
      Then('"Second" was handed over', () => expect(handedOver('Second')).toBe(true))
    })

    RuleScenario('An approved parallel workflow resumes beside a sequential one', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('a task "First" approved and holding a paused sequential run', approvedOn('First', 'sequential'))
      And('a task "Second" approved and holding a paused parallel run', approvedOn('Second', 'parallel'))
      When('the scheduler ticks', () => {
        report = scheduler.tick()
      })
      Then('2 tasks were handed over', () => expect(handovers).toHaveLength(2))
    })

    // The other half: a run stopped at a gate is not executing anything, so it
    // cannot be what makes the lane busy.
    RuleScenario('A task waiting to be approved does not hold the lane', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('a task "Waiting" at an approval gate nobody has answered', () => {
        queued('Waiting', 'sequential')
        const id = idOf('Waiting')
        tasks.act(id, 'start')
        const run = runs.start({ workflow: 'sequential-work', taskId: id })
        runs.pause(run.id, 1)
        tasks.act(id, 'await_approval')
      })
      And('a queued task "Next" on a sequential workflow', () => queued('Next', 'sequential'))
      When('the scheduler ticks', () => {
        report = scheduler.tick()
      })
      Then('"Next" is started', () => expect(startedNames()).toEqual(['Next']))
    })
  })
})

import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import type { Problem, Scheduling } from '@factory/core'
import { CapabilityHost } from '@factory/core'
import {
  runDoctor,
  type DefinitionListing,
  type DoctorContext,
  type ScopeChain,
} from '@factory/config'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MIGRATIONS,
  ProjectRepository,
  RunRepository,
  TaskRepository,
  openStore,
  type Store,
} from '@factory/store'
import { reconcile, runningInstallationPlugin, type WorkflowFacts } from '@factory/engine'
import { runSetup, type SetupItem, type SetupReport } from '@factory/core'

const feature = await loadFeature(fileURLToPath(new URL('./doctor.feature', import.meta.url)))

describeFeature(feature, ({ Background, Rule, Scenario, AfterEachScenario }) => {
  let store: Store
  let tasks: TaskRepository
  let runs: RunRepository
  let projects: ProjectRepository
  let root = ''
  let facts: Map<string, WorkflowFacts>
  let problems: Problem[]
  let ruleCount = 0
  let tick = 0

  const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString()

  AfterEachScenario(() => {
    store?.close()
    rmSync(root, { recursive: true, force: true })
  })

  // Built in Background: Background steps run before BeforeEachScenario.
  Background(({ Given, And }) => {
    Given('an empty store', () => {
      tick = 0
      facts = new Map()
      problems = []
      ruleCount = 0
      // Reset with everything else. A reconciliation left over from an earlier
      // scenario reports its recovered runs against this one's clean store,
      // which looks exactly like a rule misfiring.
      report = undefined
      store = openStore({ file: ':memory:', migrations: MIGRATIONS })
      let ids = 0
      tasks = new TaskRepository({ db: store.db, now, newId: () => `task-${++ids}` })
      runs = new RunRepository({ db: store.db, now, newId: () => `run-${++ids}` })
      projects = new ProjectRepository({ db: store.db, now, newId: () => `project-${++ids}` })
      root = mkdtempSync(join(tmpdir(), 'factory-doctor-'))
      homeId = ''
    })
    And('the workflow "hello" exists', () => {
      facts.set('hello', { scheduling: 'parallel', requires: [] })
    })
  })

  const chain: ScopeChain = { scopes: [], defaultWriteScope: 'user' }
  const listing = (name: string): DefinitionListing => ({
    name,
    winner: { kind: 'workflow', name, scope: 'project', file: `${name}.workflow.yaml` },
    shadowed: [],
    valid: true,
    problems: [],
  })

  const doctor = async (withStore: boolean): Promise<void> => {
    const host = new CapabilityHost()
    if (withStore) {
      await host.load(
        runningInstallationPlugin({
          tasks,
          runs,
          projects,
          reconciliation: report ?? { closedRuns: [], blockedTasks: [] },
          workflow: (name) => facts.get(name),
        }),
      )
    }
    const context: DoctorContext = {
      chain,
      host,
      env: {},
      workflows: [...facts.keys()].map(listing),
      phases: [],
      agents: [],
    }
    const result = await runDoctor(context)
    problems = [...result.problems]
    ruleCount = result.checked.rules
  }

  let report: ReturnType<typeof reconcile> | undefined

  const says = (text: string) => problems.some((problem) => problem.message.includes(text))

  /**
   * The project the scenarios that are not about projects put their tasks in.
   *
   * Made on first use rather than in the Background: the setup-step scenarios
   * are about an installation that has none at all, and one conjured for every
   * scenario would quietly finish that step for them.
   */
  let homeId = ''
  const home = (): string => {
    if (homeId === '') homeId = projects.add({ name: 'sample', path: root }).id
    return homeId
  }

  const task = (name: string, workflow: string) => {
    const created = tasks.create({ name, workflows: [workflow], projectId: home() })
    return created.id
  }
  const workflowRequiring = (name: string, flag: string, lane: Scheduling = 'parallel') => {
    facts.set(name, { scheduling: lane, requires: [flag] })
  }

  Scenario('A healthy installation has nothing to say', ({ Given, When, Then }) => {
    Given('a task "Add due dates" on "hello"', () => {
      task('Add due dates', 'hello')
    })
    When('doctor runs', () => doctor(true))
    Then('doctor reports nothing', () => expect(problems).toEqual([]))
  })

  Scenario('A task waiting on a flag is explained', ({ Given, And, When, Then }) => {
    Given('the workflow "deploy" requires "hasWorktree"', () =>
      workflowRequiring('deploy', 'hasWorktree'),
    )
    And('a queued task "Ship it" on "deploy"', () => {
      tasks.act(task('Ship it', 'deploy'), 'queue')
    })
    When('doctor runs', () => doctor(true))
    Then('doctor says "Ship it" is waiting for "hasWorktree"', () => {
      expect(says('Ship it')).toBe(true)
      expect(says('hasWorktree')).toBe(true)
    })
  })

  Scenario('A task waiting on a flag it already has is not reported', ({
    Given,
    And,
    When,
    Then,
  }) => {
    Given('the workflow "deploy" requires "hasWorktree"', () =>
      workflowRequiring('deploy', 'hasWorktree'),
    )
    let id = ''
    And('a queued task "Ship it" on "deploy"', () => {
      id = task('Ship it', 'deploy')
      tasks.act(id, 'queue')
    })
    And('"Ship it" has the flag "hasWorktree"', () => {
      tasks.changeFlags(id, { set: ['hasWorktree'] })
    })
    When('doctor runs', () => doctor(true))
    Then('doctor reports nothing', () => expect(problems).toEqual([]))
  })

  Scenario('A task pointed at a workflow that no longer exists', ({ Given, When, Then }) => {
    Given('a task "Add due dates" on "gone"', () => {
      task('Add due dates', 'gone')
    })
    When('doctor runs', () => doctor(true))
    Then('doctor says "gone" does not exist', () => expect(says('"gone"')).toBe(true))
  })

  Scenario('A task waiting for a person is surfaced', ({ Given, When, Then }) => {
    Given('a task "Add due dates" on "hello" that is awaiting approval', () => {
      const id = task('Add due dates', 'hello')
      tasks.act(id, 'queue')
      tasks.act(id, 'start')
      tasks.act(id, 'await_approval')
    })
    When('doctor runs', () => doctor(true))
    Then('doctor says someone needs to approve "Add due dates"', () =>
      expect(says('approve or reject')).toBe(true),
    )
  })

  Scenario('A blocked task carries its reason into the report', ({ Given, When, Then }) => {
    Given('a task "Add due dates" on "hello" that is blocked because "the tests failed"', () => {
      const id = task('Add due dates', 'hello')
      tasks.act(id, 'queue')
      tasks.act(id, 'start')
      tasks.act(id, 'block', { reason: 'the tests failed' })
    })
    When('doctor runs', () => doctor(true))
    Then('doctor repeats "the tests failed"', () => expect(says('the tests failed')).toBe(true))
  })

  Scenario('What the boot had to close is reported', ({ Given, When, And, Then }) => {
    Given('the last stop left a run of "hello" marked running', () => {
      const id = task('Add due dates', 'hello')
      tasks.act(id, 'queue')
      tasks.act(id, 'start')
      runs.start({ workflow: 'hello', taskId: id })
    })
    When('Factory starts and reconciles', () => {
      report = reconcile({ tasks, runs })
    })
    And('doctor runs', () => doctor(true))
    Then('doctor says a run was closed because Factory stopped', () =>
      expect(says('still marked running when Factory started')).toBe(true),
    )
  })

  Scenario('A run and its task disagreeing is an error', ({ Given, And, When, Then }) => {
    let id = ''
    Given('a task "Add due dates" on "hello" that is blocked because "the tests failed"', () => {
      id = task('Add due dates', 'hello')
      tasks.act(id, 'queue')
      tasks.act(id, 'start')
      tasks.act(id, 'block', { reason: 'the tests failed' })
    })
    And('a run of "hello" for it is still marked running', () => {
      runs.start({ workflow: 'hello', taskId: id })
    })
    When('doctor runs', () => doctor(true))
    Then('doctor reports an error about a run whose task is not running', () => {
      const found = problems.find((problem) => problem.rule === 'doctor.runWithoutRunningTask')
      expect(found?.severity).toBe('error')
    })
  })

  Scenario('A project whose directory has gone is an error', ({ Given, And, When, Then }) => {
    let path = ''
    Given('the project "factory" exists', () => {
      path = join(root, 'factory')
      mkdirSync(path, { recursive: true })
      projects.add({ name: 'factory', path })
    })
    // The real case: someone moved or deleted the repository after adding it.
    And('its directory is deleted', () => rmSync(path, { recursive: true, force: true }))
    When('doctor runs', () => doctor(true))
    Then("doctor reports an error about the project's path", () => {
      const found = problems.find((problem) => problem.rule === 'doctor.projectPathMissing')
      expect(found?.severity).toBe('error')
    })
  })

  Scenario('A task claiming a worktree that is not there', ({ Given, And, When, Then }) => {
    let path = ''
    Given('the project "factory" exists', () => {
      path = join(root, 'factory')
      // A repository, so it gets a worktree per task — which is what makes a
      // missing one a fault rather than the configured behaviour.
      mkdirSync(join(path, '.git'), { recursive: true })
      projects.add({ name: 'factory', path })
    })
    And('a task "Add due dates" in it with the flag "hasWorktree"', () => {
      const project = projects.byName('factory')
      const created = tasks.create({
        name: 'Add due dates',
        projectId: project?.id as string,
        workflows: ['hello'],
      })
      tasks.changeFlags(created.id, { set: ['hasWorktree'] })
    })
    When('doctor runs', () => doctor(true))
    Then('doctor reports an error about the missing worktree', () => {
      const found = problems.find((problem) => problem.rule === 'doctor.worktreeMissing')
      expect(found?.severity).toBe('error')
    })
    And('the error says where the work would run instead', () =>
      expect(says(path)).toBe(true),
    )
  })

  let setupReport: SetupReport
  const setupItem = (id: string): SetupItem | undefined =>
    setupReport.items.find((entry) => entry.id === id)

  const checkSetup = async (): Promise<void> => {
    const host = new CapabilityHost()
    await host.load(
      runningInstallationPlugin({
        tasks,
        runs,
        projects,
        reconciliation: { closedRuns: [], blockedTasks: [] },
        workflow: (name) => facts.get(name),
      }),
    )
    setupReport = await runSetup({ host, env: {} })
  }

  Scenario('Somewhere to work is a setup step, not a fault', ({ Given, When, Then, And }) => {
    Given('no projects', () => {
      // The store starts empty.
    })
    When('setup is checked', checkSetup)
    Then('"a-project" is not done', () => expect(setupItem('a-project')?.done).toBe(false))
    // A task with no project runs wherever the daemon was started, which is
    // fine for a demonstration and wrong for work.
    And('it is marked essential', () => expect(setupItem('a-project')?.essential).toBe(true))
    And('it offers the projects page', () =>
      expect(setupItem('a-project')?.actions?.[0]?.url).toBe('/projects'),
    )
    And('its terminal hint is a command, not a port', () => {
      const command = setupItem('a-project')?.actions?.[1]?.command ?? ''
      expect(command).toContain('factory project add')
      // No host, no port, no curl: anything of that shape is a copy of a
      // decision the CLI already makes from FACTORY_URL or FACTORY_PORT.
      expect(command).not.toMatch(/\d{4}|curl|127\.0\.0\.1|localhost|http/)
    })
  })

  Scenario('A registered project finishes the step', ({ Given, When, Then, And }) => {
    Given('the project "factory" exists', () => {
      const path = join(root, 'factory')
      mkdirSync(path, { recursive: true })
      projects.add({ name: 'factory', path })
    })
    When('setup is checked', checkSetup)
    Then('"a-project" is done', () => expect(setupItem('a-project')?.done).toBe(true))
    And('the detail names the repository', () =>
      expect(setupItem('a-project')?.detail).toContain('factory'),
    )
  })

  Scenario('Without a store there are no running rules', ({ When, Then }) => {
    When('doctor runs with no store', () => doctor(false))
    // Degrade by absence: no database, no rules about one, and nothing to
    // configure or switch off.
    Then('doctor has only the installation rules', () => expect(ruleCount).toBe(0))
  })

  // Returns nothing: step callbacks are typed `void`, and a concise arrow that
  // returns the id fails the typecheck while the tests still pass.
  const givenInPlaceProject = (): void => {
    const path = join(root, 'in-place')
    mkdirSync(path, { recursive: true })
    projects.add({ name: 'in-place', path, usesWorktrees: false })
  }

  Scenario('A worktree that is not there is not a fault where worktrees are off', ({
    Given,
    And,
    When,
    Then,
  }) => {
    Given('the project "in-place" exists and works in its own checkout', givenInPlaceProject)
    And('a task "Add due dates" in it with the flag "hasWorktree"', () => {
      const created = tasks.create({
        name: 'Add due dates',
        projectId: projects.byName('in-place')?.id as string,
        workflows: ['hello'],
      })
      tasks.changeFlags(created.id, { set: ['hasWorktree'] })
    })
    When('doctor runs', () => doctor(true))
    // Work there is meant to happen in the repository, so "no worktree" is the
    // configured behaviour rather than something to report.
    Then('doctor reports nothing about a missing worktree', () =>
      expect(problems.some((problem) => problem.rule === 'doctor.worktreeMissing')).toBe(false),
    )
  })

  Scenario('A task waiting for a person in a shared checkout says what it holds up', ({
    Given,
    And,
    When,
    Then,
  }) => {
    Given('the project "in-place" exists and works in its own checkout', givenInPlaceProject)
    And('a task "Add due dates" in it is awaiting approval', () => {
      const created = tasks.create({
        name: 'Add due dates',
        projectId: projects.byName('in-place')?.id as string,
        workflows: ['hello'],
      })
      tasks.act(created.id, 'queue')
      tasks.act(created.id, 'start')
      tasks.act(created.id, 'await_approval')
    })
    When('doctor runs', () => doctor(true))
    Then('doctor says nothing else in "in-place" can start', () =>
      expect(says('Nothing else in "in-place" can start')).toBe(true),
    )
  })

  Scenario('A blocked task in a shared checkout says what it left behind', ({
    Given,
    And,
    When,
    Then,
  }) => {
    Given('the project "in-place" exists and works in its own checkout', givenInPlaceProject)
    And('a task "Add due dates" in it is blocked', () => {
      const created = tasks.create({
        name: 'Add due dates',
        projectId: projects.byName('in-place')?.id as string,
        workflows: ['hello'],
      })
      tasks.act(created.id, 'queue')
      tasks.act(created.id, 'start')
      tasks.act(created.id, 'block', { reason: 'the tests failed' })
    })
    When('doctor runs', () => doctor(true))
    Then('doctor says what it left behind is still there', () =>
      expect(says('is still there')).toBe(true),
    )
  })

  Scenario('A flag nothing the task is assigned provides is a dead end', ({
    Given,
    And,
    When,
    Then,
  }) => {
    Given('the workflow "deploy" requires "hasWorktree"', () =>
      workflowRequiring('deploy', 'hasWorktree'),
    )
    And('a queued task "Ship it" on "deploy"', () => {
      tasks.act(task('Ship it', 'deploy'), 'queue')
    })
    When('doctor runs', () => doctor(true))
    Then('doctor reports an error about the flag', () => {
      const found = problems.find((problem) => problem.rule === 'doctor.taskFlagUnreachable')
      expect(found?.severity).toBe('error')
    })
    And('the error says nothing it is assigned provides it', () =>
      expect(says('nothing it is assigned provides it')).toBe(true),
    )
  })

  Scenario('A flag provided by a workflow that runs later is a dead end too', ({
    Given,
    And,
    When,
    Then,
  }) => {
    Given('the workflow "deploy" requires "hasWorktree"', () =>
      workflowRequiring('deploy', 'hasWorktree'),
    )
    And('the workflow "prepare" provides "hasWorktree"', () => {
      facts.set('prepare', { scheduling: 'parallel', requires: [], provides: ['hasWorktree'] })
    })
    // The blocked workflow is always the earliest one not yet run, so anything
    // after it can never set the flag in time. Naming the misordering is the
    // whole value of the message.
    And('a queued task "Ship it" on "deploy" and then "prepare"', () => {
      const created = tasks.create({
        name: 'Ship it',
        workflows: ['deploy', 'prepare'],
        projectId: home(),
      })
      tasks.act(created.id, 'queue')
    })
    When('doctor runs', () => doctor(true))
    Then('doctor reports an error about the flag', () =>
      expect(problems.some((problem) => problem.rule === 'doctor.taskFlagUnreachable')).toBe(true),
    )
    And('the error says "prepare" comes too late', () =>
      expect(says('comes after')).toBe(true),
    )
  })

  Rule('a built-in that asks to be overridden is reported where it is used', ({ RuleScenario }) => {
    const overridable = (scope: 'builtin' | 'project'): void => {
      facts.set('worktree-create', {
        scheduling: 'parallel',
        requires: [],
        scope,
        override: 'required',
        overridePath: '/repo/.factory/workflows/worktree-create.workflow.yaml',
      })
    }
    const taskIn = (name: string, workflow: string): void => {
      tasks.create({
        name,
        projectId: projects.byName('in-place')?.id as string,
        workflows: [workflow],
      })
    }

    RuleScenario('A task about to run the built-in copy is reported', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('the project "in-place" exists and works in its own checkout', givenInPlaceProject)
      And(
        'the workflow "worktree-create" must be overridden and resolves from the builtin scope',
        () => overridable('builtin'),
      )
      And('a task "Ship it" in that project on "worktree-create"', () =>
        taskIn('Ship it', 'worktree-create'),
      )
      When('doctor runs', () => doctor(true))
      // The path, not just the complaint: "write your own" without saying where
      // is a warning someone has to go and research.
      Then('doctor reports an error naming the file to create', () => {
        expect(says('worktree-create.workflow.yaml')).toBe(true)
        expect(problems.some((problem) => problem.rule === 'doctor.overrideRequired')).toBe(true)
      })
    })

    RuleScenario('A project that has made its own copy is not reported', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('the project "in-place" exists and works in its own checkout', givenInPlaceProject)
      And(
        'the workflow "worktree-create" must be overridden and resolves from the project scope',
        () => overridable('project'),
      )
      And('a task "Ship it" in that project on "worktree-create"', () =>
        taskIn('Ship it', 'worktree-create'),
      )
      When('doctor runs', () => doctor(true))
      Then('doctor reports nothing', () => expect(problems).toEqual([]))
    })

    RuleScenario('A workflow that asks for nothing is never reported', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('the project "in-place" exists and works in its own checkout', givenInPlaceProject)
      And('a task "Ship it" in that project on "hello"', () => taskIn('Ship it', 'hello'))
      When('doctor runs', () => doctor(true))
      Then('doctor reports nothing', () => expect(problems).toEqual([]))
    })

    RuleScenario('A task nobody assigned it to is not reported', ({ Given, And, When, Then }) => {
      Given('the project "in-place" exists and works in its own checkout', givenInPlaceProject)
      And(
        'the workflow "worktree-create" must be overridden and resolves from the builtin scope',
        () => overridable('builtin'),
      )
      And('a task "Ship it" in that project on "hello"', () => taskIn('Ship it', 'hello'))
      When('doctor runs', () => doctor(true))
      Then('doctor reports nothing', () => expect(problems).toEqual([]))
    })
  })

  Rule('a task that runs a workflow before what it needs is reported', ({ RuleScenario }) => {
    const givenNeeds = (): void => {
      facts.set('validate', { scheduling: 'parallel', requires: [], needs: [] })
      facts.set('verify', { scheduling: 'parallel', requires: [], needs: ['validate'] })
    }
    const assigned = (...workflows: string[]) =>
      tasks.create({ name: 'Ship it', workflows, projectId: home() }).id
    const outOfOrder = () => problems.filter((p) => p.rule === 'doctor.needsOutOfOrder')

    RuleScenario('A predecessor that comes later in the list is an error', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('"verify" needs "validate"', givenNeeds)
      And('a task assigned "verify" then "validate"', () => {
        assigned('verify', 'validate')
      })
      When('doctor runs', () => doctor(true))
      Then('it says "verify" runs before "validate"', () => {
        expect(outOfOrder()).toHaveLength(1)
        expect(outOfOrder()[0]?.message).toContain('Put it first')
      })
    })

    RuleScenario('A predecessor missing from the list altogether is an error', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('"verify" needs "validate"', givenNeeds)
      And('a task assigned only "verify"', () => {
        assigned('verify')
      })
      When('doctor runs', () => doctor(true))
      Then('it says "validate" is not in the list', () => {
        expect(outOfOrder()).toHaveLength(1)
        expect(outOfOrder()[0]?.message).toContain('not in the list at all')
      })
    })

    RuleScenario('A correctly ordered task is not reported', ({ Given, And, When, Then }) => {
      Given('"verify" needs "validate"', givenNeeds)
      And('a task assigned "validate" then "verify"', () => {
        assigned('validate', 'verify')
      })
      When('doctor runs', () => doctor(true))
      Then('nothing is out of order', () => expect(outOfOrder()).toEqual([]))
    })

    // A list that has already been carried out is history, not a plan, and
    // telling someone to reorder something that finished is noise.
    RuleScenario('A finished task is left alone', ({ Given, And, When, Then }) => {
      Given('"verify" needs "validate"', givenNeeds)
      And('a task assigned only "verify" that is already done', () => {
        const id = assigned('verify')
        tasks.act(id, 'queue')
        tasks.act(id, 'start')
        tasks.act(id, 'complete')
      })
      When('doctor runs', () => doctor(true))
      Then('nothing is out of order', () => expect(outOfOrder()).toEqual([]))
    })
  })
  Rule('a task waiting for something that can never finish is reported', ({ RuleScenario }) => {
    const graphProblems = () => problems.filter((problem) => problem.rule === 'doctor.dependencyDead')
    const ids = new Map<string, string>()
    const waitingPair = (): void => {
      const build = tasks.create({ name: 'Build', workflows: ['hello'], projectId: home() })
      const ship = tasks.create({ name: 'Ship it', workflows: ['hello'], projectId: home() })
      tasks.dependOn(ship.id, build.id)
      ids.set('Build', build.id)
      ids.set('Ship it', ship.id)
    }
    const cancelled = (): void => {
      tasks.act(ids.get('Build') as string, 'cancel', { reason: 'Not now.' })
    }

    RuleScenario('A draft waiting on a cancelled task is reported', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('a task "Ship it" waiting for "Build" in the same project', waitingPair)
      And('"Build" was cancelled', cancelled)
      When('doctor runs', () => doctor(true))
      Then('doctor says "Ship it" is waiting for something that cannot finish', () =>
        expect(graphProblems()).toHaveLength(1),
      )
      And('it names "Build" and why', () => {
        expect(says('Build')).toBe(true)
        expect(says('was cancelled')).toBe(true)
      })
    })

    RuleScenario('Waiting for something still to run is not reported', ({ Given, When, Then }) => {
      Given('a task "Ship it" waiting for "Build" in the same project', waitingPair)
      When('doctor runs', () => doctor(true))
      Then('nothing is reported about the graph', () => expect(graphProblems()).toHaveLength(0))
    })

    RuleScenario('Waiting for something already done is not reported', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('a task "Ship it" waiting for "Build" in the same project', waitingPair)
      And('"Build" is done', () => {
        tasks.act(ids.get('Build') as string, 'mark_done')
      })
      When('doctor runs', () => doctor(true))
      Then('nothing is reported about the graph', () => expect(graphProblems()).toHaveLength(0))
    })

    RuleScenario('A task already blocked is left to the rule that covers it', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('a task "Ship it" waiting for "Build" in the same project', waitingPair)
      And('"Build" was cancelled', cancelled)
      And('"Ship it" is blocked', () => {
        // Queued first, because `block` is reachable from `queued` and from
        // `running` — which is exactly how the scheduler blocks a dependent
        // whose blocker turned out to be dead.
        tasks.act(ids.get('Ship it') as string, 'queue')
        tasks.act(ids.get('Ship it') as string, 'block', { reason: 'Waiting on Build.' })
      })
      When('doctor runs', () => doctor(true))
      Then('nothing is reported about the graph', () => expect(graphProblems()).toHaveLength(0))
    })
  })
})

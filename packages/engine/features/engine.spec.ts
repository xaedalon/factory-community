import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { EventBus, type FactoryEvent } from '@factory/events'
import type { FailureContext } from '@factory/engine'
import type {
  Approval,
  PlanResult,
  ResolvedPhase,
  Problem,
  ResolvedPlan,
  StopReport,
  Run,
  Scheduling,
  Task,
} from '@factory/core'
import {
  PRODUCT_FAMILY_DIR,
  artifactFile,
  artifactsRoot,
  joinPath,
} from '@factory/core'
import {
  MIGRATIONS,
  ProjectRepository,
  RunRepository,
  TaskRepository,
  openStore,
  type Store,
} from '@factory/store'
import { Engine, reconcile, type ReconcileReport } from '@factory/engine'

const feature = await loadFeature(fileURLToPath(new URL('./engine.feature', import.meta.url)))

describeFeature(feature, ({ Background, Rule, Scenario, AfterEachScenario }) => {
  let store: Store
  let bus: EventBus
  let tasks: TaskRepository
  let runs: RunRepository
  let engine: Engine
  let task: Task
  let plans: Map<string, PlanResult>
  let work = ''
  let report: ReconcileReport
  let failure: unknown
  let problems: Problem[] = []
  let seen: FactoryEvent[] = []
  let tick = 0
  let ids = 0
  let sessions = 0
  /** What each call to `plan` was told about the session, in order. */
  let sessionsSeen: ({ id: string; started: boolean } | undefined)[] = []

  const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString()

  AfterEachScenario(() => {
    store?.close()
    rmSync(work, { recursive: true, force: true })
  })

  // Everything per-scenario is built here, not in BeforeEachScenario: the
  // runner executes Background steps first.
  Background(({ Given, And }) => {
    Given('an empty store', () => {
      tick = 0
      ids = 0
      sessions = 0
      sessionsSeen = []
      clock = new Date(Date.UTC(2026, 0, 1, 0, 0, 0))
      plans = new Map()
      seenFailure = undefined
      work = mkdtempSync(join(tmpdir(), 'factory-engine-'))
      failure = undefined
      store = openStore({ file: ':memory:', migrations: MIGRATIONS })
      // Monotonic: entry ids are minted from here too, so a fixed value would
      // give every workflow in a task the same entry id.
      problems = []
      seen = []
      bus = new EventBus({ onSubscriberError: () => {} })
      bus.onAny((event) => seen.push(event))
      tasks = new TaskRepository({
        db: store.db,
        events: bus,
        now,
        newId: () => `task-${++ids}`,
      })
      runs = new RunRepository({ db: store.db, now, newId: () => `run-${++ids}` })
      engine = buildEngine()
    })
    And('a task "Add due dates"', () => {
      // `work` is already a directory on disk; a project needs one, and a task
      // needs a project.
      const project = new ProjectRepository({
        db: store.db,
        now,
        newId: () => `project-${++ids}`,
      }).add({ name: 'sample', path: work })
      task = tasks.create({ name: 'Add due dates', projectId: project.id })
    })
  })

  const buildEngine = (timeoutSeconds?: number): Engine =>
    new Engine({
      tasks,
      runs,
      events: bus,
      // Curated rather than `process.env`: these scenarios run real commands,
      // so they need a PATH — and a machine that exports a token should not
      // change what they observe. It was `{}` for one commit, which worked only
      // because `echo` is a shell builtin and nothing here needed anything else.
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
      // Pinned so "30 seconds from now" is a value the scenario can name.
      now: () => clock,
      // Minted here so a scenario can name the id. The engine defaults to a
      // real UUID, which nothing could assert on.
      newSessionId: () => `session-${++sessions}`,
      plan: ({ workflow, failure, session }) => {
        if (failure !== undefined) seenFailure = failure
        sessionsSeen.push(session)
        return (
          plans.get(workflow) ?? {
            problems: [
              {
                severity: 'error',
                message: `No workflow named "${workflow}" in any scope.`,
                rule: 'plan.missingWorkflow',
              },
            ],
          }
        )
      },
    })

  // Real plans running real processes. The runner is already specified in
  // packages/core; what is being tested here is what the engine writes down
  // while it runs, so faking the execution would test the wrong half.
  const shellPhase = (name: string, command: string, approval: Approval = 'none'): ResolvedPhase => ({
    name,
    approval,
    cwd: process.cwd(),
    steps: [
      {
        index: 0,
        uses: 'shell',
        planned: { describe: command, command: 'bash', args: ['-c', command] },
        raw: { uses: 'shell', run: command },
      },
    ],
  })
  /**
   * Read through a variable so a scenario can move time.
   *
   * Two runs of one artifact need two different readings, or both dated copies
   * land on the same filename and the second silently replaces the first.
   */
  let clock = new Date(Date.UTC(2026, 0, 1, 0, 0, 0))

  const planOf = (workflow: string, phases: ResolvedPhase[]): ResolvedPlan => ({
    workflow,
    profile: 'default',
    mode: 'once',
    scheduling: 'sequential',
    requires: [],
    provides: [],
    clears: [],
    phases,
  })
  const givePlan = (
    workflow: string,
    phases: ResolvedPhase[],
    scheduling: Scheduling = 'sequential',
  ): void => {
    plans.set(workflow, { plan: { ...planOf(workflow, phases), scheduling }, problems: [] })
  }

  const assign = (...workflows: string[]): void => {
    task = tasks.assign(task.id, workflows)
  }
  const queue = (): void => {
    task = tasks.act(task.id, 'queue')
  }
  const runEngine = async (): Promise<void> => {
    try {
      const outcome = await engine.run(task.id)
      task = outcome.task
      // Kept, so a scenario can assert on what the engine *said* as well as on
      // what it wrote down. Warnings never reach the database, so the outcome
      // is the only place a refusal appears.
      problems = [...outcome.problems]
    } catch (error) {
      failure = error
    }
  }
  const allRuns = (): Run[] => runs.forTask(task.id)
  const newest = (): Run => allRuns()[0] as Run
  const stepsOf = (run: Run) => runs.steps(run.id)

  Scenario('A queued task becomes a run', ({ Given, And, When, Then }) => {
    Given('the task has the workflow "development"', () => assign('development'))
    And('"development" prints "building" and succeeds', () =>
      givePlan('development', [shellPhase('build', 'echo building')]),
    )
    And('the task is queued', queue)
    When('the engine runs the task', runEngine)
    Then('the task is "done"', () => expect(task.state).toBe('done'))
    And('there is 1 run', () => expect(allRuns()).toHaveLength(1))
    And('the run is "completed"', () => expect(newest().state).toBe('completed'))
    And('the run is for "development"', () => expect(newest().workflow).toBe('development'))
  })

  Scenario('Every step is recorded with what it printed', ({ Given, And, When, Then }) => {
    Given('the task has the workflow "development"', () => assign('development'))
    And('"development" prints "building" and succeeds', () =>
      givePlan('development', [shellPhase('build', 'echo building')]),
    )
    And('the task is queued', queue)
    When('the engine runs the task', runEngine)
    Then('the run has 1 step', () => expect(stepsOf(newest())).toHaveLength(1))
    And('the step is "completed"', () => expect(stepsOf(newest())[0]?.state).toBe('completed'))
    And('the step\'s log contains "building"', () => {
      const step = stepsOf(newest())[0]
      const log = runs.logs(newest().id, { stepId: step?.id as number })
      expect(log.lines.map((line) => line.text).join('')).toContain('building')
    })
  })

  Scenario('A failing step blocks the task', ({ Given, And, When, Then }) => {
    Given('the task has the workflow "development"', () => assign('development'))
    And('"development" fails with exit code 3', () =>
      givePlan('development', [shellPhase('build', 'exit 3')]),
    )
    And('the task is queued', queue)
    When('the engine runs the task', runEngine)
    Then('the task is "blocked"', () => expect(task.state).toBe('blocked'))
    And('the task says why it is blocked', () =>
      expect(task.blockedReason ?? '').not.toBe(''),
    )
    And('the run is "failed"', () => expect(newest().state).toBe('failed'))
    And('the step exited with 3', () => expect(stepsOf(newest())[0]?.exitCode).toBe(3))
  })

  Scenario('What never ran is recorded as skipped', ({ Given, And, When, Then }) => {
    Given('the task has the workflow "development"', () => assign('development'))
    And('"development" fails in its first phase and has a second phase', () =>
      givePlan('development', [shellPhase('build', 'exit 1'), shellPhase('ship', 'echo shipping')]),
    )
    And('the task is queued', queue)
    When('the engine runs the task', runEngine)
    Then('the run has 2 steps', () => expect(stepsOf(newest())).toHaveLength(2))
    And('the step of the second phase is "skipped"', () =>
      expect(stepsOf(newest()).find((step) => step.phase === 'ship')?.state).toBe('skipped'),
    )
  })

  Scenario("A task's workflows run in order", ({ Given, And, When, Then }) => {
    Given('the task has the workflows "development, review"', () => assign('development', 'review'))
    And('every workflow succeeds', () => {
      givePlan('development', [shellPhase('build', 'echo building')])
      givePlan('review', [shellPhase('review', 'echo reviewing')])
    })
    And('the task is queued', queue)
    When('the engine runs the task', runEngine)
    Then('there are 2 runs', () => expect(allRuns()).toHaveLength(2))
    And('the runs are for "development, review" in that order', () =>
      expect(
        allRuns()
          .map((run) => run.workflow)
          .reverse(),
      ).toEqual(['development', 'review']),
    )
    And('the task is "done"', () => expect(task.state).toBe('done'))
  })

  Scenario('A workflow after a failure does not start', ({ Given, And, When, Then }) => {
    Given('the task has the workflows "development, review"', () => assign('development', 'review'))
    And('"development" fails with exit code 1', () => {
      givePlan('development', [shellPhase('build', 'exit 1')])
      givePlan('review', [shellPhase('review', 'echo reviewing')])
    })
    And('the task is queued', queue)
    When('the engine runs the task', runEngine)
    Then('there is 1 run', () => expect(allRuns()).toHaveLength(1))
    And('the task is "blocked"', () => expect(task.state).toBe('blocked'))
  })

  const gatedPlan = (): void =>
    givePlan('development', [
      shellPhase('build', 'echo building', 'after'),
      shellPhase('ship', 'echo shipping'),
    ])

  Scenario('An approval gate parks the task rather than asking', ({ Given, And, When, Then }) => {
    Given('the task has the workflow "development"', () => assign('development'))
    And('"development" needs approval after its first phase and has a second phase', gatedPlan)
    And('the task is queued', queue)
    When('the engine runs the task', runEngine)
    Then('the task is "awaiting_approval"', () => expect(task.state).toBe('awaiting_approval'))
    And('the run is "paused"', () => expect(newest().state).toBe('paused'))
    And('the run continues from phase 1', () => expect(newest().resumePhase).toBe(1))
    And('the second phase has not run', () =>
      expect(stepsOf(newest()).map((step) => step.phase)).toEqual(['build']),
    )
  })

  Scenario('Approving continues after the gate without repeating it', ({
    Given,
    And,
    When,
    Then,
  }) => {
    Given('the task has the workflow "development"', () => assign('development'))
    And('"development" needs approval after its first phase and has a second phase', gatedPlan)
    And('the task is queued', queue)
    And('the engine has run the task', runEngine)
    When('the task is approved', () => {
      task = tasks.act(task.id, 'approve')
    })
    And('the engine runs the task again', runEngine)
    Then('the task is "done"', () => expect(task.state).toBe('done'))
    And('there is 1 run', () => expect(allRuns()).toHaveLength(1))
    And('the run is "completed"', () => expect(newest().state).toBe('completed'))
    And('the first phase ran once', () =>
      expect(stepsOf(newest()).filter((step) => step.phase === 'build')).toHaveLength(1),
    )
  })

  Scenario('A workflow that cannot be planned blocks the task and says so', ({
    Given,
    And,
    When,
    Then,
  }) => {
    Given('the task has the workflow "nonsense"', () => assign('nonsense'))
    And('"nonsense" cannot be planned', () => {
      // Left out of the plan map on purpose: the engine's injected planner
      // answers exactly as the real one does for a name that resolves nowhere.
      plans.delete('nonsense')
    })
    And('the task is queued', queue)
    When('the engine runs the task', runEngine)
    Then('the task is "blocked"', () => expect(task.state).toBe('blocked'))
    And('the run is "refused"', () => expect(newest().state).toBe('refused'))
    And('the task says why it is blocked', () =>
      expect(task.blockedReason ?? '').toContain('nonsense'),
    )
  })

  Scenario('A step that runs too long is stopped and the task is blocked', ({
    Given,
    And,
    When,
    Then,
  }) => {
    Given('the task has the workflow "development"', () => assign('development'))
    And('"development" runs for longer than the deadline', () => {
      givePlan('development', [shellPhase('build', 'sleep 30')])
      engine = buildEngine(1)
    })
    And('the task is queued', queue)
    When('the engine runs the task', runEngine)
    Then('the task is "blocked"', () => expect(task.state).toBe('blocked'))
    And('the run is "timed-out"', () => expect(newest().state).toBe('timed-out'))
    And('the step is "timed-out"', () => expect(stepsOf(newest())[0]?.state).toBe('timed-out'))
  })

  Scenario('A task the engine does not own is refused', ({ Given, And, When, Then }) => {
    Given('the task has the workflow "development"', () => assign('development'))
    And('every workflow succeeds', () =>
      givePlan('development', [shellPhase('build', 'echo building')]),
    )
    When('the engine runs the task', runEngine)
    Then('it is refused', () => expect(failure).toBeDefined())
    And('the error says what state the task is in', () =>
      expect((failure as Error).message).toContain('draft'),
    )
  })

  Scenario('A task with nothing to run is blocked, not completed', ({ Given, And, When, Then }) => {
    Given('the task has the workflow "development"', () => assign('development'))
    And('every workflow succeeds', () =>
      givePlan('development', [shellPhase('build', 'echo building')]),
    )
    And('the task is queued', queue)
    And('the workflows are taken away', () => {
      task = tasks.assign(task.id, [])
    })
    When('the engine runs the task', runEngine)
    Then('the task is "blocked"', () => expect(task.state).toBe('blocked'))
  })

  Scenario('Running a task again records a second attempt', ({ Given, And, When, Then }) => {
    Given('the task has the workflow "development"', () => assign('development'))
    And('"development" fails with exit code 1', () =>
      givePlan('development', [shellPhase('build', 'exit 1')]),
    )
    And('the task is queued', queue)
    And('the engine has run the task', runEngine)
    When('the task is retried and the engine runs it again', async () => {
      task = tasks.act(task.id, 'retry')
      await runEngine()
    })
    Then('there are 2 runs', () => expect(allRuns()).toHaveLength(2))
    And('the newest run is attempt 2', () => expect(newest().attempt).toBe(2))
  })

  const flagPlan = (
    workflow: string,
    command: string,
    conditions: { provides?: string[]; clears?: string[] },
  ): void => {
    plans.set(workflow, {
      plan: {
        ...planOf(workflow, [shellPhase('work', command)]),
        provides: conditions.provides ?? [],
        clears: conditions.clears ?? [],
      },
      problems: [],
    })
  }

  Scenario('A completed workflow sets the flags it declares', ({ Given, And, When, Then }) => {
    Given('the task has the workflow "worktree-create"', () => assign('worktree-create'))
    And('"worktree-create" succeeds and provides "hasWorktree"', () =>
      flagPlan('worktree-create', 'echo made', { provides: ['hasWorktree'] }),
    )
    And('the task is queued', queue)
    When('the engine runs the task', runEngine)
    Then('the task has the flag "hasWorktree"', () => expect(task.flags).toEqual(['hasWorktree']))
  })

  Scenario('A workflow that fails earns nothing', ({ Given, And, When, Then }) => {
    Given('the task has the workflow "worktree-create"', () => assign('worktree-create'))
    And('"worktree-create" fails and would have provided "hasWorktree"', () =>
      flagPlan('worktree-create', 'exit 1', { provides: ['hasWorktree'] }),
    )
    And('the task is queued', queue)
    When('the engine runs the task', runEngine)
    Then('the task has no flags', () => expect(task.flags).toEqual([]))
  })

  Scenario('A workflow can clear a flag it invalidates', ({ Given, And, When, Then }) => {
    Given('the task has the workflow "worktree-delete"', () => assign('worktree-delete'))
    And('the task already has the flag "hasWorktree"', () => {
      task = tasks.changeFlags(task.id, { set: ['hasWorktree'] })
    })
    And('"worktree-delete" succeeds and clears "hasWorktree"', () =>
      flagPlan('worktree-delete', 'echo removed', { clears: ['hasWorktree'] }),
    )
    And('the task is queued', queue)
    When('the engine runs the task', runEngine)
    Then('the task has no flags', () => expect(task.flags).toEqual([]))
  })

  let seenFailure: FailureContext | undefined

  const recoveryPlan = (workflow: string, command: string, onFail?: string): void => {
    plans.set(workflow, {
      plan: {
        ...planOf(workflow, [shellPhase('work', command)]),
        ...(onFail === undefined ? {} : { onFail }),
      },
      problems: [],
    })
  }

  Scenario('A failure can call for help before the task is blocked', ({
    Given,
    And,
    When,
    Then,
  }) => {
    Given('the task has the workflow "development"', () => assign('development'))
    And('"development" fails and calls "development-failure" on failure', () =>
      recoveryPlan('development', 'exit 1', 'development-failure'),
    )
    And('"development-failure" writes a diagnosis', () =>
      recoveryPlan('development-failure', 'echo diagnosing'),
    )
    And('the task is queued', queue)
    When('the engine runs the task', runEngine)
    Then('there are 2 runs', () => expect(allRuns()).toHaveLength(2))
    And('the recovery run is for "development-failure"', () =>
      expect(newest().workflow).toBe('development-failure'),
    )
    And('the recovery run is "completed"', () => expect(newest().state).toBe('completed'))
    And('the recovery was told which workflow failed', () => {
      expect(seenFailure?.workflow).toBe('development')
      expect(seenFailure?.phase).toBe('work')
      expect(seenFailure?.reason ?? '').not.toBe('')
    })
    And('the task is "blocked"', () => expect(task.state).toBe('blocked'))
  })

  Scenario('A recovery that fails does not call for help itself', ({
    Given,
    And,
    When,
    Then,
  }) => {
    Given('the task has the workflow "development"', () => assign('development'))
    And('"development" fails and calls "development-failure" on failure', () =>
      recoveryPlan('development', 'exit 1', 'development-failure'),
    )
    And('"development-failure" fails and calls "development-failure" on failure', () =>
      recoveryPlan('development-failure', 'exit 1', 'development-failure'),
    )
    And('the task is queued', queue)
    When('the engine runs the task', runEngine)
    // Two: the failure and one attempt to diagnose it. A third would be the
    // recovery recovering from itself, which is a loop with no exit.
    Then('there are 2 runs', () => expect(allRuns()).toHaveLength(2))
    And('the task is "blocked"', () => expect(task.state).toBe('blocked'))
  })

  Scenario('A retry resumes at the workflow that failed', ({ Given, And, When, Then }) => {
    Given('the task has the workflows "development, review"', () => assign('development', 'review'))
    And('"development" succeeds', () =>
      givePlan('development', [shellPhase('build', 'echo building')]),
    )
    And('"review" fails with exit code 1', () =>
      givePlan('review', [shellPhase('review', 'exit 1')]),
    )
    And('the task is queued', queue)
    And('the engine has run the task', runEngine)
    When('the task is retried and the engine runs it again', async () => {
      task = tasks.act(task.id, 'retry')
      await runEngine()
    })
    Then('"development" ran once', () =>
      expect(allRuns().filter((run) => run.workflow === 'development')).toHaveLength(1),
    )
    And('there are 3 runs', () => expect(allRuns()).toHaveLength(3))
  })

  const loopPlan = (): void => {
    plans.set('watch', {
      plan: { ...planOf('watch', [shellPhase('watch', 'echo watching')]), mode: 'loop', interval: 30 },
      problems: [],
    })
  }

  Scenario('A loop workflow goes back in the queue instead of finishing', ({
    Given,
    And,
    When,
    Then,
  }) => {
    Given('the task has the workflow "watch"', () => assign('watch'))
    And('"watch" loops every 30 seconds', loopPlan)
    And('the task is queued', queue)
    When('the engine runs the task', runEngine)
    Then('the task is "queued"', () => expect(task.state).toBe('queued'))
    And('the task waits 30 seconds before running again', () =>
      expect(task.runnableAt).toBe(new Date(Date.UTC(2026, 0, 1, 0, 0, 30)).toISOString()),
    )
    And('the run is "completed"', () => expect(newest().state).toBe('completed'))
    And('the task is still on "watch"', () =>
      expect(task.workflows.find((entry) => entry.workflow === 'watch')?.enabled).toBe(true),
    )
  })

  Scenario("A loop's next iteration is a new run", ({ Given, And, When, Then }) => {
    Given('the task has the workflow "watch"', () => assign('watch'))
    And('"watch" loops every 30 seconds', loopPlan)
    And('the task is queued', queue)
    And('the engine has run the task', runEngine)
    When('the engine runs the task again', runEngine)
    Then('there are 2 runs', () => expect(allRuns()).toHaveLength(2))
    And('the newest run is attempt 2', () => expect(newest().attempt).toBe(2))
  })

  /**
   * A step that declares an artifact, in a scratch directory of its own so the
   * file it writes is real — the engine reads from disk, and a fake would test
   * the fake.
   *
   * The path is the one a plan carries: worked out where the artifacts root and
   * the step were both in scope, so the engine never derives it a second time.
   */
  const artifactsIn = (root: string) => join(root, 'artifacts')
  const artifactPathFor = (name: string) => join(artifactsIn(work), name, `${name}.md`)

  const artifactPlan = (
    command: string,
    approval: Approval = 'none',
    name = 'report',
  ): void => {
    plans.set('review', {
      plan: planOf('review', [
        {
          name: 'work',
          approval,
          cwd: work,
          steps: [
            {
              index: 0,
              uses: 'shell',
              planned: { describe: command, command: 'bash', args: ['-c', command] },
              raw: { uses: 'shell', run: command },
              artifact: { name, path: artifactPathFor(name) },
            },
          ],
        },
      ]),
      problems: [],
    })
  }

  Scenario('What a phase produced is kept with the run', ({ Given, And, When, Then }) => {
    Given('the task has the workflow "review"', () => assign('review'))
    And('"review" writes "looks good" to the artifact it declares', () =>
      artifactPlan(`echo "looks good" > ${artifactPathFor('report')}`),
    )
    And('the task is queued', queue)
    When('the engine runs the task', runEngine)
    Then('the run has evidence from the phase "work"', () =>
      expect(runs.evidence(newest().id).map((entry) => entry.phase)).toEqual(['work']),
    )
    And('the evidence reads "looks good"', () =>
      expect(runs.evidence(newest().id)[0]?.content).toContain('looks good'),
    )
  })

  Scenario('An artifact a phase promised and did not produce is recorded and warned about', ({
    Given,
    And,
    When,
    Then,
  }) => {
    let outcome: Awaited<ReturnType<Engine['run']>> | undefined
    Given('the task has the workflow "review"', () => assign('review'))
    And('"review" declares an artifact and writes nothing', () => artifactPlan('echo nothing'))
    And('the task is queued', queue)
    When('the engine runs the task', async () => {
      outcome = await engine.run(task.id)
      task = outcome.task
    })
    Then('the run has evidence from the phase "work"', () =>
      expect(runs.evidence(newest().id)).toHaveLength(1),
    )
    And('the evidence is marked missing', () =>
      expect(runs.evidence(newest().id)[0]?.missing).toBe(true),
    )
    // Warned, not failed: plenty of artifacts are legitimately optional, but
    // silence is what the prototype had.
    And('a problem says the artifact is not there', () =>
      expect(
        (outcome?.problems ?? []).some((problem) => problem.rule === 'run.artifactMissing'),
      ).toBe(true),
    )
  })

  Scenario('Evidence waits with a task that stopped for approval', ({
    Given,
    And,
    When,
    Then,
  }) => {
    Given('the task has the workflow "review"', () => assign('review'))
    And('"review" writes "looks good" to the artifact it declares and then needs approval', () =>
      artifactPlan(`echo "looks good" > ${artifactPathFor('report')}`, 'after'),
    )
    And('the task is queued', queue)
    When('the engine runs the task', runEngine)
    Then('the task is "awaiting_approval"', () => expect(task.state).toBe('awaiting_approval'))
    // The whole point: the person deciding has what they need in front of them.
    And('the evidence reads "looks good"', () =>
      expect(runs.evidence(newest().id)[0]?.content).toContain('looks good'),
    )
  })

  Scenario('A flaky step is retried, and the run records how many attempts it took', ({
    Given,
    And,
    When,
    Then,
  }) => {
    Given('the task has the workflow "flaky"', () => assign('flaky'))
    And('"flaky" fails once then succeeds, with 1 retry', () => {
      // A marker file decides the second attempt's exit code, so nothing here
      // depends on timing.
      const marker = join(work, 'tried')
      const command = `if [ -f ${marker} ]; then exit 0; else touch ${marker}; exit 7; fi`
      plans.set('flaky', {
        plan: planOf('flaky', [
          {
            name: 'work',
            approval: 'none',
            cwd: work,
            steps: [
              {
                index: 0,
                uses: 'shell',
                planned: { describe: command, command: 'bash', args: ['-c', command] },
                raw: { uses: 'shell', run: command, retries: 1 },
              },
            ],
          },
        ]),
        problems: [],
      })
    })
    And('the task is queued', queue)
    When('the engine runs the task', runEngine)
    Then('the task is "done"', () => expect(task.state).toBe('done'))
    And('the step took 2 attempts', () =>
      expect(stepsOf(newest())[0]?.attempts).toBe(2),
    )
  })

  Scenario('A run a crash left behind is closed at boot', ({ Given, And, When, Then }) => {
    Given('the task has the workflow "development"', () => assign('development'))
    And('"development" was left running when Factory stopped', () => {
      givePlan('development', [shellPhase('build', 'echo building')])
      queue()
      task = tasks.act(task.id, 'start')
      runs.start({ workflow: 'development', taskId: task.id })
    })
    When('Factory starts and reconciles', () => {
      report = reconcile({ tasks, runs })
      task = tasks.get(task.id) as Task
    })
    Then('the run is "failed"', () => expect(newest().state).toBe('failed'))
    And('the run says Factory stopped', () =>
      expect(newest().detail ?? '').toContain('Factory stopped'),
    )
    And('the task is "blocked"', () => expect(task.state).toBe('blocked'))
  })

  Scenario('Reconciling leaves an approved task waiting rather than blocking it', ({
    Given,
    And,
    When,
    Then,
  }) => {
    Given('the task has the workflow "development"', () => assign('development'))
    And('"development" needs approval after its first phase and has a second phase', gatedPlan)
    And('the task is queued', queue)
    And('the engine has run the task', runEngine)
    And('the task is approved', () => {
      task = tasks.act(task.id, 'approve')
    })
    When('Factory starts and reconciles', () => {
      report = reconcile({ tasks, runs })
      task = tasks.get(task.id) as Task
    })
    // Blocking it would throw away an approval someone already gave, and the
    // paused run still holds everything that happened before the gate.
    Then('the task is "running"', () => expect(task.state).toBe('running'))
    And('nothing was closed', () => expect(report.closedRuns).toHaveLength(0))
  })

  Scenario('Reconciling leaves a paused run alone', ({ Given, And, When, Then }) => {
    Given('the task has the workflow "development"', () => assign('development'))
    And('"development" needs approval after its first phase and has a second phase', gatedPlan)
    And('the task is queued', queue)
    And('the engine has run the task', runEngine)
    When('Factory starts and reconciles', () => {
      report = reconcile({ tasks, runs })
      task = tasks.get(task.id) as Task
    })
    Then('the run is "paused"', () => expect(newest().state).toBe('paused'))
    And('the task is "awaiting_approval"', () => expect(task.state).toBe('awaiting_approval'))
    And('nothing was closed', () => expect(report.closedRuns).toHaveLength(0))
  })

  Rule('an artifact keeps every version and the latest', ({ RuleScenario }) => {
    const versionsOf = (name: string) => {
      try {
        return readdirSync(join(artifactsIn(work), name, 'versions'))
      } catch {
        return []
      }
    }
    const latestOf = (name: string) => readFileSync(artifactPathFor(name), 'utf8')

    RuleScenario('A produced artifact is kept, and a copy of it dated', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('the task has the workflow "review"', () => assign('review'))
      And('"review" writes "looks good" to the artifact it declares', () =>
        artifactPlan(`echo "looks good" > ${artifactPathFor('report')}`),
      )
      And('the task is queued', queue)
      When('the engine runs the task', runEngine)
      Then('the run has evidence from the phase "work"', () =>
        expect(runs.evidence(newest().id)).toHaveLength(1),
      )
      And('a dated copy of the artifact was kept', () =>
        expect(versionsOf('report')).toHaveLength(1),
      )
    })

    RuleScenario('Running it again adds a version and updates the latest', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('the task has the workflow "review"', () => assign('review'))
      And('"review" writes "looks good" to the artifact it declares', () =>
        artifactPlan(`echo "first" > ${artifactPathFor('report')}`),
      )
      And('the task is queued', queue)
      And('the engine has already run the task once', async () => {
        await runEngine()
        // A different clock reading, or both copies would land on one filename.
        clock = new Date(clock.getTime() + 1000)
        artifactPlan(`echo "second" > ${artifactPathFor('report')}`)
        // It unticked itself when it finished, so running it again is a
        // deliberate gesture now rather than a side effect of re-queueing.
        task = tasks.assign(
          task.id,
          task.workflows.map((entry) => ({ ...entry, enabled: true })),
        )
        task = tasks.act(task.id, 'queue')
      })
      When('the engine runs the task again', runEngine)
      Then('there are 2 dated copies', () => expect(versionsOf('report')).toHaveLength(2))
      And('the latest reads what the second run wrote', () =>
        expect(latestOf('report')).toContain('second'),
      )
    })

    RuleScenario('Two artifacts in one run do not collide', ({ Given, And, When, Then }) => {
      // The old evidence key was (run, phase), which two artifacts in one phase
      // would have silently overwritten — keeping whichever ran last.
      Given('the task has the workflow "two-artifacts"', () => {
        plans.set('two-artifacts', {
          plan: planOf('two-artifacts', [
            {
              name: 'work',
              approval: 'none',
              cwd: work,
              steps: ['first', 'second'].map((name, index) => {
                const command = `echo "${name}" > ${artifactPathFor(name)}`
                return {
                  index,
                  uses: 'shell',
                  planned: { describe: command, command: 'bash', args: ['-c', command] },
                  raw: { uses: 'shell', run: command },
                  artifact: { name, path: artifactPathFor(name) },
                }
              }),
            },
          ]),
          problems: [],
        })
        assign('two-artifacts')
      })
      And('the task is queued', queue)
      When('the engine runs the task', runEngine)
      Then('the run has 2 pieces of evidence', () =>
        expect(runs.evidence(newest().id)).toHaveLength(2),
      )
      And('they are named "first, second"', () =>
        expect(
          runs
            .evidence(newest().id)
            .map((entry) => entry.name)
            .sort()
            .join(', '),
        ).toBe('first, second'),
      )
    })
  })

  Rule('a gate that asks first parks with its phase still to run', ({ RuleScenario }) => {
    const askFirstPlan = (): void =>
      givePlan('development', [
        shellPhase('build', 'echo building', 'before'),
        shellPhase('ship', 'echo shipping'),
      ])

    RuleScenario('Nothing of the gated phase has run when the task parks', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('the task has the workflow "development"', () => assign('development'))
      And('"development" asks before its first phase and has a second phase', askFirstPlan)
      And('the task is queued', queue)
      When('the engine runs the task', runEngine)
      Then('the task is "awaiting_approval"', () => expect(task.state).toBe('awaiting_approval'))
      And('the run is "paused"', () => expect(newest().state).toBe('paused'))
      // The complaint that started this: the phase used to have run already.
      And('no step has run at all', () => expect(stepsOf(newest())).toHaveLength(0))
      // Phase 0, not 1 — approving has to come back to the phase it authorised.
      And('the run continues from phase 0', () => expect(newest().resumePhase).toBe(0))
    })

    RuleScenario('Approving runs the phase that was asked about, exactly once', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('the task has the workflow "development"', () => assign('development'))
      And('"development" asks before its first phase and has a second phase', askFirstPlan)
      And('the task is queued', queue)
      And('the engine has run the task', runEngine)
      When('the task is approved', () => {
        task = tasks.act(task.id, 'approve')
      })
      And('the engine runs the task again', runEngine)
      Then('the task is "done"', () => expect(task.state).toBe('done'))
      And('there is 1 run', () => expect(allRuns()).toHaveLength(1))
      // Once. Not never (resumed past it) and not twice (asked, ran, asked
      // again, ran again) — both of which this resume point could have caused.
      And('the first phase ran once', () =>
        expect(stepsOf(newest()).filter((step) => step.phase === 'build')).toHaveLength(1),
      )
      And('the second phase ran once', () =>
        expect(stepsOf(newest()).filter((step) => step.phase === 'ship')).toHaveLength(1),
      )
    })
  })

  Rule('a loop with a repeat count stops when it has done them', ({ RuleScenario }) => {
    const repeatingPlan = (times: number) => (): void => {
      plans.set('watch', {
        plan: {
          ...planOf('watch', [shellPhase('watch', 'echo watching')]),
          mode: 'loop',
          interval: 30,
          repeat: times,
        },
        problems: [],
      })
    }

    RuleScenario('A loop set to repeat once runs once and is done', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('the task has the workflow "watch"', () => assign('watch'))
      And('"watch" loops every 30 seconds, repeating 1 time', repeatingPlan(1))
      And('the task is queued', queue)
      When('the engine runs the task', runEngine)
      // `repeat: 1` runs once, not twice: the count includes the pass that has
      // just finished.
      Then('the task is "done"', () => expect(task.state).toBe('done'))
      And('there is 1 run', () => expect(allRuns()).toHaveLength(1))
    })

    RuleScenario('A loop set to repeat twice goes round again first', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('the task has the workflow "watch"', () => assign('watch'))
      And('"watch" loops every 30 seconds, repeating 2 times', repeatingPlan(2))
      And('the task is queued', queue)
      When('the engine runs the task', runEngine)
      Then('the task is "queued"', () => expect(task.state).toBe('queued'))
      And('the task is still on "watch"', () =>
        expect(task.workflows.find((entry) => entry.workflow === 'watch')?.enabled).toBe(true),
      )
    })

    RuleScenario('And stops on the second pass', ({ Given, And, When, Then }) => {
      Given('the task has the workflow "watch"', () => assign('watch'))
      And('"watch" loops every 30 seconds, repeating 2 times', repeatingPlan(2))
      And('the task is queued', queue)
      And('the engine has run the task', runEngine)
      When('the engine runs the task again', runEngine)
      Then('the task is "done"', () => expect(task.state).toBe('done'))
      And('there are 2 runs', () => expect(allRuns()).toHaveLength(2))
    })

    RuleScenario('A loop with no repeat keeps going', ({ Given, And, When, Then }) => {
      Given('the task has the workflow "watch"', () => assign('watch'))
      And('"watch" loops every 30 seconds', loopPlan)
      And('the task is queued', queue)
      And('the engine has run the task', runEngine)
      When('the engine runs the task again', runEngine)
      Then('the task is "queued"', () => expect(task.state).toBe('queued'))
    })
  })

  Rule('what runs next is whatever is ticked, and only that', ({ RuleScenario }) => {
    const ticked = (name: string) =>
      task.workflows.find((entry) => entry.workflow === name)?.enabled
    const untick = (...names: string[]): void => {
      task = tasks.assign(
        task.id,
        task.workflows.map((entry) => ({
          ...entry,
          enabled: names.includes(entry.workflow) ? false : entry.enabled,
        })),
      )
    }
    const bothPlanned = (): void => {
      givePlan('development', [shellPhase('build', 'echo building')])
      givePlan('review', [shellPhase('review', 'echo reviewing')])
    }

    RuleScenario('An unticked workflow is passed over', ({ Given, And, When, Then }) => {
      Given('the task has the workflows "development, review"', () => {
        assign('development', 'review')
        bothPlanned()
      })
      And('"development" is unticked', () => untick('development'))
      And('the task is queued', queue)
      When('the engine runs the task', runEngine)
      Then('there is 1 run', () => expect(allRuns()).toHaveLength(1))
      And('the runs are for "review" in that order', () =>
        expect(allRuns().map((run) => run.workflow)).toEqual(['review']),
      )
    })

    RuleScenario('A workflow that completes unticks itself', ({ Given, And, When, Then }) => {
      Given('the task has the workflows "development, review"', () => {
        assign('development', 'review')
        bothPlanned()
      })
      And('the task is queued', queue)
      When('the engine runs the task', runEngine)
      Then('"development" is unticked', () => expect(ticked('development')).toBe(false))
      And('"review" is unticked', () => expect(ticked('review')).toBe(false))
    })

    const reviewFails = (): void => {
      givePlan('development', [shellPhase('build', 'echo building')])
      givePlan('review', [shellPhase('review', 'exit 1')])
    }

    RuleScenario('A workflow that failed stays ticked', ({ Given, And, When, Then }) => {
      Given('the task has the workflows "development, review"', () =>
        assign('development', 'review'),
      )
      And('"review" fails', reviewFails)
      And('the task is queued', queue)
      When('the engine runs the task', runEngine)
      Then('"development" is unticked', () => expect(ticked('development')).toBe(false))
      // The case the whole feature is for: a retry does exactly this one again,
      // with no re-ticking and nothing earlier repeated.
      And('"review" is still ticked', () => expect(ticked('review')).toBe(true))
    })

    RuleScenario('Fixing it and running again does only what is left', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('the task has the workflows "development, review"', () =>
        assign('development', 'review'),
      )
      And('"review" fails', reviewFails)
      And('the task is queued', queue)
      And('the engine has run the task', runEngine)
      When('"review" is fixed', () => {
        givePlan('review', [shellPhase('review', 'echo reviewing')])
      })
      And('the task is retried', () => {
        task = tasks.act(task.id, 'retry')
      })
      And('the engine runs the task again', runEngine)
      // Once, not twice: it succeeded the first time and unticked itself.
      Then('"development" ran once', () =>
        expect(allRuns().filter((run) => run.workflow === 'development')).toHaveLength(1),
      )
      And('the task is "done"', () => expect(task.state).toBe('done'))
    })

    RuleScenario('A task queued with nothing ticked is blocked, not completed', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('the task has the workflows "development, review"', () => {
        assign('development', 'review')
        bothPlanned()
      })
      // Reachable: untick the blocked entry of a blocked task, then retry.
      And('every workflow is unticked', () => untick('development', 'review'))
      And('the task is queued', () => {
        // The state machine still allows the transition; it is `actions()` that
        // withholds the button. So this is reachable — untick the blocked entry
        // of a blocked task and retry — and the engine has to cope.
        task = tasks.act(task.id, 'queue')
      })
      When('the engine runs the task', runEngine)
      Then('the task is "blocked"', () => expect(task.state).toBe('blocked'))
      And('there are 0 runs', () => expect(allRuns()).toHaveLength(0))
    })
  })

  Rule("a task's agent session is written down once it really exists", ({ RuleScenario }) => {
    /**
     * A phase whose one step claims to start a session.
     *
     * `planned.session` is what a real provider render reports; here it is
     * stated, because what is under test is what the engine does with the
     * claim rather than how a command comes to carry it.
     */
    const sessionPhase = (options: { command: string; creates?: boolean }): ResolvedPhase => ({
      name: 'work',
      approval: 'none',
      cwd: process.cwd(),
      steps: [
        {
          index: 0,
          uses: 'agent',
          planned: {
            describe: 'claude: look at it',
            command: options.command === 'missing' ? 'factory-no-such-agent-cli' : 'bash',
            args: options.command === 'missing' ? [] : ['-c', options.command],
            ...(options.creates === false
              ? {}
              : { session: { id: 'session-1', provider: 'claude', creates: true } }),
          },
          raw: { uses: 'agent', prompt: 'look at it' },
        },
      ],
    })
    const giveSessionPlan = (options: { command: string; onFail?: string }) => (): void => {
      plans.set('development', {
        plan: {
          ...planOf('development', [sessionPhase({ command: options.command })]),
          ...(options.onFail === undefined ? {} : { onFail: options.onFail }),
        },
        problems: [],
      })
    }
    const startsWith = (index: number, id: string) => () =>
      expect(sessionsSeen[index]).toEqual({ id, started: false })
    const existsAt = (index: number, id: string) => () =>
      expect(sessionsSeen[index]).toEqual({ id, started: true })

    RuleScenario('The session is written down after the step that starts it', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('the task has the workflow "development"', () => assign('development'))
      And(
        '"development" runs an agent step that starts a session',
        giveSessionPlan({ command: 'echo looking' }),
      )
      And('the task is queued', queue)
      When('the engine runs the task', runEngine)
      Then('the task carries the session "session-1"', () =>
        expect(task.session?.id).toBe('session-1'),
      )
      // The provider travels with the id: which CLI owns the session decides
      // which flag resumes it, and reading that back off the definitions later
      // would let an edit to a phase disagree with what ran.
      And('the session belongs to "claude"', () => expect(task.session?.provider).toBe('claude'))
    })

    RuleScenario('A later run is told the session already exists', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('the task has the workflow "development" twice', () =>
        assign('development', 'development'),
      )
      And(
        '"development" runs an agent step that starts a session',
        giveSessionPlan({ command: 'echo looking' }),
      )
      And('the task is queued', queue)
      When('the engine runs the task', runEngine)
      Then('the first plan was told to start "session-1"', startsWith(0, 'session-1'))
      And('the second plan was told "session-1" already exists', existsAt(1, 'session-1'))
    })

    RuleScenario('A step that could not be started records nothing', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('the task has the workflow "development"', () => assign('development'))
      And(
        '"development" runs an agent step whose command does not exist',
        giveSessionPlan({ command: 'missing' }),
      )
      And('the task is queued', queue)
      When('the engine runs the task', runEngine)
      Then('the task carries no session', () => expect(task.session).toBeUndefined())
      And('the task is "blocked"', () => expect(task.state).toBe('blocked'))
    })

    RuleScenario('And the run after it starts a fresh one', ({ Given, And, When, Then }) => {
      Given('the task has the workflow "development"', () => assign('development'))
      And(
        '"development" runs an agent step whose command does not exist',
        giveSessionPlan({ command: 'missing' }),
      )
      And('the task is queued', queue)
      When('the engine runs the task', runEngine)
      // A blocked task is retried, and because nothing was recorded the retry
      // is asked to start a session rather than to resume one that was never
      // had. A fresh id, not the one that got away: it costs nothing and it
      // cannot collide with a session the failed spawn somehow did create.
      And('the task is retried', async () => {
        task = tasks.act(task.id, 'retry')
        await runEngine()
      })
      Then('the second plan was told to start a session', () =>
        expect(sessionsSeen.at(-1)).toEqual({ id: 'session-2', started: false }),
      )
    })

    RuleScenario('A step that starts no session records nothing', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('the task has the workflow "development"', () => assign('development'))
      And('"development" prints "building" and succeeds', () =>
        givePlan('development', [shellPhase('build', 'echo building')]),
      )
      And('the task is queued', queue)
      When('the engine runs the task', runEngine)
      Then('the task carries no session', () => expect(task.session).toBeUndefined())
    })

    RuleScenario('A recovery workflow is given the same session', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('the task has the workflow "development"', () => assign('development'))
      And(
        '"development" runs an agent step that starts a session then fails',
        giveSessionPlan({ command: 'echo looking; exit 1', onFail: 'development-failure' }),
      )
      And('"development-failure" looks into it', () =>
        recoveryPlan('development-failure', 'echo diagnosing'),
      )
      And('the task is queued', queue)
      When('the engine runs the task', runEngine)
      Then('the recovery plan was told "session-1" already exists', () =>
        expect(sessionsSeen.at(-1)).toEqual({ id: 'session-1', started: true }),
      )
    })
  })

  Rule('cancelling a task stops what it is doing', ({ RuleScenario }) => {
    /** Started and deliberately not awaited, so the scenario can act mid-run. */
    let working: Promise<unknown> | undefined
    let stopped: StopReport | undefined

    const longPhase = (): void => {
      // `sleep 30 &` plus `wait` makes the work a grandchild, which is the
      // shape of every real step and the thing a single-pid kill misses.
      givePlan('long', [shellPhase('work', 'sleep 30 & wait')])
    }
    const startWorking = async (): Promise<void> => {
      failure = undefined
      working = engine.run(task.id).catch((error: unknown) => {
        failure = error
      })
      // Until the engine is actually executing: cancelling before it starts
      // would prove nothing about stopping a process.
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline && engine.running().length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(engine.running(), 'the engine never started the task').toContain(task.id)
    }
    const finishWorking = async (): Promise<void> => {
      await working
      task = tasks.get(task.id) as Task
    }

    RuleScenario('Cancelling a running task stops its process and records it', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('the workflow "long" whose phase runs for a long time', longPhase)
      And("it is the task's only workflow", () => assign('long'))
      And('the task is queued', queue)
      When('the task is cancelled while it is running', async () => {
        await startWorking()
        tasks.act(task.id, 'cancel')
        stopped = await engine.cancel(task.id)
        await finishWorking()
      })
      Then('the run is recorded as cancelled', () =>
        expect(allRuns().map((run) => run.state)).toEqual(['cancelled']),
      )
      And('the task is cancelled', () => expect(task.state).toBe('cancelled'))
      And('nothing is left running', () => expect(engine.running()).toEqual([]))
      And('no error was raised', () => expect(failure).toBeUndefined())
    })

    RuleScenario('Cancelling through the store reaches the engine', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('the workflow "long" whose phase runs for a long time', longPhase)
      And("it is the task's only workflow", () => assign('long'))
      And('the task is queued', queue)
      When('the task is cancelled through the store while it is running', async () => {
        const unwatch = engine.watch()
        await startWorking()
        // Only the state change — no direct call to the engine. This is the
        // route's whole contribution.
        tasks.act(task.id, 'cancel')
        await finishWorking()
        unwatch()
      })
      Then('the run is recorded as cancelled', () =>
        expect(allRuns().map((run) => run.state)).toEqual(['cancelled']),
      )
      And('nothing is left running', () => expect(engine.running()).toEqual([]))
    })

    RuleScenario('Cancelling a task that is doing nothing is not an error', ({
      When,
      Then,
    }) => {
      When('the task is cancelled before anything runs', async () => {
        stopped = await engine.cancel(task.id)
      })
      Then('nothing was signalled', () => expect(stopped).toEqual({ signalled: 0, killed: 0 }))
    })

    RuleScenario('Stopping everything cancels the tasks it stopped', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('the workflow "long" whose phase runs for a long time', longPhase)
      And("it is the task's only workflow", () => assign('long'))
      And('the task is queued', queue)
      When('everything is stopped while it is running', async () => {
        await startWorking()
        stopped = await engine.stopAll('Factory was shut down.')
        await finishWorking()
      })
      Then('the run is recorded as cancelled', () =>
        expect(allRuns().map((run) => run.state)).toEqual(['cancelled']),
      )
      And('the task is cancelled', () => expect(task.state).toBe('cancelled'))
      And('the reason is recorded against the task', () => {
        const history = tasks.history(task.id)
        expect(history.at(-1)?.detail).toBe('Factory was shut down.')
      })
    })
  })

  Rule('a refusal is always reported, and only parks a run that failed', ({ RuleScenario }) => {
    /** The message Claude Code actually prints, and the pattern Factory ships. */
    const REFUSAL = '/tmp/probe.txt is outside the configured working directories'
    const patterns = [
      {
        id: 'path-outside-workspace',
        contains: 'is outside the',
        match: '(\\S+) is outside the (?:configured )?working director',
        describe: "a path outside the task's workspace",
      },
    ]
    const refusedPhase = (exitCode: number): ResolvedPhase => {
      const command = `echo "${REFUSAL}"; exit ${exitCode}`
      return {
        name: 'review',
        approval: 'none',
        cwd: process.cwd(),
        steps: [
          {
            index: 0,
            uses: 'agent',
            planned: {
              describe: command,
              command: 'bash',
              args: ['-c', command],
              denialPatterns: patterns,
            },
            raw: { uses: 'shell', run: command },
          },
        ],
      }
    }
    const refusedAnd = (exitCode: number) => (): void => {
      givePlan('review', [refusedPhase(exitCode)])
    }
    const plainFailure = (): void => {
      givePlan('review', [shellPhase('review', 'exit 1')])
    }
    const refusalProblem = (): void => {
      const problem = problems.find((entry) => entry.rule === 'run.permissionRefused')
      expect(problem, JSON.stringify(problems)).toBeDefined()
      expect(problem?.severity).toBe('warning')
    }

    RuleScenario('A refusal on a run that succeeded is reported without stopping it', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('the workflow "review" whose phase is refused a path but succeeds', refusedAnd(0))
      And("it is the task's only workflow", () => assign('review'))
      And('the task is queued', queue)
      When('the engine works on it', runEngine)
      Then('the run completed', () =>
        expect(allRuns().map((run) => run.state)).toEqual(['completed']),
      )
      And('the task is done', () => expect(task.state).toBe('done'))
      And('a problem says the agent was refused something', refusalProblem)
      And('the problem names the path it was refused', () => {
        const problem = problems.find((entry) => entry.rule === 'run.permissionRefused')
        expect(problem?.message).toContain('/tmp/probe.txt')
      })
      And('a "permission.requested" event was emitted', () => {
        const emitted = seen.filter((event) => event.name === 'permission.requested')
        expect(emitted).toHaveLength(1)
        expect(emitted[0]?.payload).toMatchObject({ id: 'path-outside-workspace' })
      })
    })

    RuleScenario('A refusal on a run that failed parks it for a person', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('the workflow "review" whose phase is refused a path and fails', refusedAnd(1))
      And("it is the task's only workflow", () => assign('review'))
      And('the task is queued', queue)
      When('the engine works on it', runEngine)
      Then('the task is awaiting approval', () => expect(task.state).toBe('awaiting_approval'))
      And('the run is paused', () =>
        expect(allRuns().map((run) => run.state)).toEqual(['paused']),
      )
      And('a problem says the agent was refused something', refusalProblem)
    })

    RuleScenario('A failure with no refusal still blocks', ({ Given, And, When, Then }) => {
      Given('the workflow "review" whose phase simply fails', plainFailure)
      And("it is the task's only workflow", () => assign('review'))
      And('the task is queued', queue)
      When('the engine works on it', runEngine)
      Then('the task is blocked', () => expect(task.state).toBe('blocked'))
    })
  })
  Rule('a sequential workflow runs alone, wherever it is in the task\'s list', ({
    RuleScenario,
  }) => {
    let ledger = ''
    let second: Task

    /**
     * A step that writes when it started and when it stopped.
     *
     * Two of these overlap if and only if a `start` follows a `start`, which is
     * a question the file answers without anybody measuring a clock. The sleep
     * is what gives them time to overlap; without it, "did not overlap" would
     * pass for a scheduler that does nothing at all — which is why the parallel
     * scenario below reads the same file and expects the opposite.
     */
    const recording = (who: string): ResolvedPhase =>
      shellPhase('work', `echo "${who} start" >> ${ledger}; sleep 0.2; echo "${who} end" >> ${ledger}`)

    const lines = (): string[] =>
      readFileSync(ledger, 'utf8').trim().split('\n').filter((line) => line !== '')
    const who = (index: number): string => lines()[index]?.split(' ')[0] ?? ''

    /** A second task, in the same project as the first. */
    const another = (name: string): Task =>
      tasks.create({ name, projectId: tasks.get(task.id)?.projectId as string })

    const givenTwo = (lane: Scheduling, workflows: (name: string) => string[]) => (): void => {
      ledger = join(work, 'ledger.txt')
      second = another('Ship it')
      givePlan('first', [shellPhase('quick', 'true')], 'parallel')
      plans.set('one-work', { plan: { ...planOf('one-work', [recording('one')]), scheduling: lane }, problems: [] })
      plans.set('two-work', { plan: { ...planOf('two-work', [recording('two')]), scheduling: lane }, problems: [] })
      task = tasks.assign(task.id, workflows('one'))
      second = tasks.assign(second.id, workflows('two'))
      task = tasks.act(task.id, 'queue')
      second = tasks.act(second.id, 'queue')
    }

    const bothAtOnce = async (): Promise<void> => {
      const [one, two] = await Promise.all([engine.run(task.id), engine.run(second.id)])
      task = one.task
      second = two.task
    }

    RuleScenario('Two tasks reaching a sequential workflow do not overlap', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given(
        'two tasks whose second workflow is sequential and records when it ran',
        givenTwo('sequential', (name) => ['first', `${name}-work`]),
      )
      When('the engine works on both at once', bothAtOnce)
      Then("the second workflow's two runs did not overlap", () => {
        expect(lines()).toHaveLength(4)
        expect(who(0)).toBe(who(1))
        expect(who(2)).toBe(who(3))
      })
      And('both tasks are "done"', () => {
        expect(task.state).toBe('done')
        expect(second.state).toBe('done')
      })
    })

    RuleScenario('The one that waited says so', ({ Given, When, Then }) => {
      Given(
        'two tasks whose second workflow is sequential and records when it ran',
        givenTwo('sequential', (name) => ['first', `${name}-work`]),
      )
      When('the engine works on both at once', bothAtOnce)
      Then('one of the runs says it waited for the sequential lane', () => {
        const said = [task.id, second.id].flatMap((id) =>
          runs.forTask(id).flatMap((run) => runs.logs(run.id).lines.map((line) => line.text)),
        )
        expect(said.some((text) => text.includes('waiting: another sequential workflow'))).toBe(
          true,
        )
      })
    })

    RuleScenario('Parallel workflows are still parallel', ({ Given, When, Then }) => {
      Given(
        'two tasks whose only workflow is parallel and records when it ran',
        givenTwo('parallel', (name) => [`${name}-work`]),
      )
      When('the engine works on both at once', bothAtOnce)
      Then('the two runs overlapped', () => {
        expect(lines()).toHaveLength(4)
        expect(who(0)).not.toBe(who(1))
      })
    })
  })
  Rule('rejecting an approval ends the run it was asked about', ({ RuleScenario }) => {
    const parked = async (): Promise<void> => {
      assign('development')
      givePlan('development', [
        shellPhase('build', 'echo building'),
        shellPhase('ship', 'echo shipping', 'before'),
      ])
      queue()
      await runEngine()
    }
    /**
     * Through the watcher, which is what the route does: `reject` is a state
     * change, and noticing it is the engine's job — subscribed once so the
     * API, the CLI and a desktop menu cannot differ about what it means.
     */
    const reject = async (): Promise<void> => {
      const unwatch = engine.watch()
      task = tasks.act(task.id, 'reject', { reason: 'Not like that.' })
      // The watcher defers to a microtask, because the transition is emitted
      // from inside the store's transaction.
      await new Promise((done) => setTimeout(done, 0))
      unwatch()
    }

    RuleScenario('The run is finished as declined', ({ Given, When, Then, And }) => {
      Given('a task parked at an approval gate', parked)
      When('somebody rejects it', reject)
      Then('the run is "declined"', () => expect(newest().state).toBe('declined'))
      And("the run's output is still there", () =>
        expect(stepsOf(newest()).length).toBeGreaterThan(0),
      )
    })

    RuleScenario('A retry after a rejection starts the workflow again', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('a task parked at an approval gate', parked)
      And('somebody rejects it', reject)
      When('the task is retried', async () => {
        task = tasks.act(task.id, 'retry')
        await runEngine()
      })
      Then('the gate was reached a second time', () =>
        expect(task.state).toBe('awaiting_approval'),
      )
      And('there are 2 runs', () => expect(allRuns()).toHaveLength(2))
    })
  })
  Rule('what a run produced is kept out of git, and nothing else is', ({ RuleScenario }) => {
    /**
     * An artifact path of the shape a real project has.
     *
     * Built through core's own `artifactsRoot` rather than typed out: every
     * artifact scenario above puts its files in `<work>/artifacts`, which has
     * no `.xaedalon` segment — so `#ignoreProductOutput` took its early return
     * in every one of them and this writer had never executed in a test.
     */
    const inFamilyDirectory = (name: string) =>
      artifactFile(artifactsRoot(work, 'add-due-dates', joinPath), name, joinPath)
    const familyIgnore = () => join(work, PRODUCT_FAMILY_DIR, '.gitignore')

    const artifactAt = (path: string) => (): void => {
      plans.set('review', {
        plan: planOf('review', [
          {
            name: 'work',
            approval: 'none',
            cwd: process.cwd(),
            steps: [
              {
                index: 0,
                uses: 'shell',
                planned: {
                  describe: 'write it',
                  command: 'bash',
                  args: ['-c', `echo "looks good" > ${path}`],
                },
                raw: { uses: 'shell', run: 'write it' },
                artifact: { name: 'report', path },
              },
            ],
          },
        ]),
        problems: [],
      })
    }

    RuleScenario('A run writes an ignore file for the output it produced', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('a workflow whose step writes an artifact under a Factory directory', () =>
        artifactAt(inFamilyDirectory('report'))(),
      )
      And("it is the task's only workflow", () => assign('review'))
      And('the task is queued', queue)
      When('the engine runs the task', runEngine)
      Then('the family directory has an ignore file', () =>
        expect(existsSync(familyIgnore())).toBe(true),
      )
      // Named literally rather than looped over `PRODUCT_OUTPUT_DIRS`, which
      // is the thing under test: an assertion that iterates the constant it is
      // checking passes whatever that constant says, and dropping two of the
      // three from it went unnoticed exactly that way.
      And('it ignores the task directories, the database and the bundle backups', () => {
        const lines = readFileSync(familyIgnore(), 'utf8').split('\n')
        expect(lines).toContain('.factory/tasks/')
        expect(lines).toContain('.factory/state/')
        expect(lines).toContain('.factory/.trash/')
      })
      // The whole reason this body is narrower than the one `createScope`
      // writes: the directory may already be shared.
      And('it leaves the definitions alone', () => {
        const text = readFileSync(familyIgnore(), 'utf8')
        expect(text.split('\n')).not.toContain('*')
        expect(text).not.toContain('.factory/workflows')
      })
    })

    RuleScenario('An ignore file already there is left exactly as it is', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('a workflow whose step writes an artifact under a Factory directory', () =>
        artifactAt(inFamilyDirectory('report'))(),
      )
      And('an ignore file somebody wrote by hand', () => {
        mkdirSync(join(work, PRODUCT_FAMILY_DIR), { recursive: true })
        writeFileSync(familyIgnore(), '# mine\n')
      })
      And("it is the task's only workflow", () => assign('review'))
      And('the task is queued', queue)
      When('the engine runs the task', runEngine)
      Then('the ignore file still says what they wrote', () =>
        expect(readFileSync(familyIgnore(), 'utf8')).toBe('# mine\n'),
      )
    })

    RuleScenario('An artifact outside a Factory directory writes no ignore file', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('a workflow whose step writes an artifact somewhere of its own', () =>
        artifactAt(join(work, 'elsewhere', 'report.md'))(),
      )
      And("it is the task's only workflow", () => assign('review'))
      And('the task is queued', queue)
      When('the engine runs the task', runEngine)
      Then('no ignore file was written', () => {
        expect(existsSync(familyIgnore())).toBe(false)
        expect(existsSync(join(work, 'elsewhere', '.gitignore'))).toBe(false)
      })
    })
  })
  Rule('an agent is told where it is in the tree', ({ RuleScenario }) => {
    /**
     * Everything the newest run printed, as one string.
     *
     * Gathered per step, because a run's own log holds what the engine wrote
     * and everything a command printed is attached to the step that printed it.
     */
    const printed = (): string => {
      const run = newest()
      return runs
        .steps(run.id)
        .flatMap((step) => runs.logs(run.id, { stepId: step.id }).lines)
        .map((line) => line.text)
        .join('\n')
    }

    RuleScenario('A step can see the run and the task it belongs to', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('the task has the workflow "development"', () => assign('development'))
      And('"development" prints what it was told about itself', () =>
        givePlan('development', [
          shellPhase(
            'work',
            'echo "run=$FACTORY_RUN_ID task=$FACTORY_TASK_ID depth=$FACTORY_ORCHESTRATION_DEPTH"',
          ),
        ]),
      )
      And('the task is queued', queue)
      When('the engine runs the task', runEngine)
      Then('the output names the run it is part of', () =>
        expect(printed()).toContain(`run=${newest().id}`),
      )
      And('the output names the task it is part of', () =>
        expect(printed()).toContain(`task=${task.id}`),
      )
      And('the output says it is at depth 0', () => expect(printed()).toContain('depth=0'))
    })
  })

  Rule('a run remembers who asked for its task', ({ RuleScenario }) => {
    RuleScenario('A task a person created starts a run at the top of the tree', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('the task has the workflow "development"', () => assign('development'))
      And('"development" prints "building" and succeeds', () =>
        givePlan('development', [shellPhase('work', 'echo building')]),
      )
      And('the task is queued', queue)
      When('the engine runs the task', runEngine)
      Then('the run is at depth 0', () => expect(newest().depth).toBe(0))
      And('the run came from nowhere', () => expect(newest().originRunId).toBeUndefined())
    })

    RuleScenario('A task an agent asked for starts a run one deeper', ({
      Given,
      And,
      When,
      Then,
    }) => {
      let earlier = ''
      Given('a finished run "run-earlier" at depth 0', () => {
        earlier = runs.start({ workflow: 'development', depth: 0 }).id
        runs.finish(earlier, 'completed')
      })
      And('a task created by "run-earlier"', () => {
        task = tasks.create({
          name: 'Asked for by an agent',
          projectId: task.projectId,
          createdByRunId: earlier,
          createdBy: 'mcp:a-client/1.0',
        })
      })
      And('that task has a workflow that succeeds', () => {
        assign('development')
        givePlan('development', [shellPhase('work', 'echo building')])
      })
      And('the task is queued', queue)
      When('the engine runs the task', runEngine)
      Then('the run is at depth 1', () => expect(newest().depth).toBe(1))
      And('the run came from "run-earlier"', () => expect(newest().originRunId).toBe(earlier))
    })
  })
})

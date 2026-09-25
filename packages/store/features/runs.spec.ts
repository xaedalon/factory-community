import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExecutionProfile, LogStream, Run, RunStep, Task } from '@factory/core'
import {
  MIGRATIONS,
  ProjectRepository,
  RunRepository,
  TaskRepository,
  openStore,
  type Store,
} from '../src/index.js'

const feature = await loadFeature(fileURLToPath(new URL('./runs.feature', import.meta.url)))

describeFeature(feature, ({ Background, Rule, Scenario, AfterEachScenario }) => {
  let store: Store
  let tasks: TaskRepository
  let runs: RunRepository
  let task: Task
  let run: Run
  let second: Run
  let step: RunStep
  let byName: Map<string, RunStep>
  let printed: string[]
  let failure: unknown
  let tick = 0
  let root = ''

  const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString()
  let runNumber = 0
  const newId = () => `run-${++runNumber}`

  AfterEachScenario(() => {
    store?.close()
    rmSync(root, { recursive: true, force: true })
  })

  // In Background, not BeforeEachScenario: the runner executes Background steps
  // first, so anything built in BeforeEachScenario does not exist yet.
  Background(({ Given, And }) => {
    Given('an empty store', () => {
      tick = 0
      runNumber = 0
      byName = new Map()
      printed = []
      failure = undefined
      store = openStore({ file: ':memory:', migrations: MIGRATIONS })
      tasks = new TaskRepository({ db: store.db, now, newId: () => 'task-1' })
      runs = new RunRepository({ db: store.db, now, newId })
    })
    // The project is not in the Gherkin because these scenarios are about runs
    // and a task cannot exist without one — it is part of what "a task exists"
    // means, the way the store itself is.
    And('a task "Add due dates" with the workflow "development"', () => {
      root = mkdtempSync(join(tmpdir(), 'factory-runs-'))
      mkdirSync(join(root, '.git'), { recursive: true })
      const project = new ProjectRepository({
        db: store.db,
        now,
        newId: () => 'project-1',
      }).add({ name: 'sample', path: root })
      task = tasks.create({
        name: 'Add due dates',
        workflows: ['development'],
        projectId: project.id,
      })
    })
  })

  const budget = (bytes: number, head: number): void => {
    runs = new RunRepository({
      db: store.db,
      now,
      newId,
      logBudgetBytes: bytes,
      logHeadBytes: head,
    })
  }
  // Returns nothing: step callbacks are typed `void`, and a concise arrow that
  // returns the run fails the typecheck while the tests still pass.
  const startRun = (): void => {
    run = runs.start({ workflow: 'development', taskId: task.id })
  }
  const startStep = (describe: string, phase: string): void => {
    step = runs.startStep(run.id, { phase, index: byName.size, describe, uses: 'shell' })
    byName.set(describe, step)
  }
  const ranWith = (describe: string, phase: string, exitCode: number): void => {
    startStep(describe, phase)
    byName.set(
      describe,
      runs.finishStep(step.id, {
        state: exitCode === 0 ? 'completed' : 'failed',
        exitCode,
      }),
    )
  }
  const print = (text: string, stream: LogStream = 'stdout'): void => {
    runs.append({ runId: run.id, stepId: step.id, stream, text })
  }
  const attempt = (work: () => void): void => {
    try {
      work()
    } catch (error) {
      failure = error
    }
  }
  const logText = (): string[] => runs.logs(run.id, { stepId: step.id }).lines.map((l) => l.text)

  Scenario('A run records what it was and when it started', ({ When, Then, And }) => {
    When('I start a run of "development" for the task', startRun)
    Then('the run is "running"', () => expect(run.state).toBe('running'))
    And('the run has a start time', () => expect(run.startedAt).toBeDefined())
    And('the run belongs to the task', () => expect(run.taskId).toBe(task.id))
  })

  Scenario('A run does not need a task', ({ When, Then, And }) => {
    When('I start a detached run of "development"', () => {
      run = runs.start({ workflow: 'development' })
    })
    Then('the run is "running"', () => expect(run.state).toBe('running'))
    And('the run belongs to no task', () => expect(run.taskId).toBeUndefined())
  })

  Scenario('Steps are recorded in order', ({ Given, When, And, Then }) => {
    Given('a run of "development"', startRun)
    When('the step "install" of phase "setup" runs and succeeds', () =>
      ranWith('install', 'setup', 0),
    )
    And('the step "test" of phase "verify" runs and fails with exit code 1', () =>
      ranWith('test', 'verify', 1),
    )
    Then('the run has 2 steps', () => expect(runs.steps(run.id)).toHaveLength(2))
    And('the steps are "install, test" in that order', () =>
      expect(runs.steps(run.id).map((entry) => entry.describe)).toEqual(['install', 'test']),
    )
    And('the step "test" is "failed"', () => expect(byName.get('test')?.state).toBe('failed'))
    And('the step "test" exited with 1', () => expect(byName.get('test')?.exitCode).toBe(1))
  })

  Scenario('A finished run has an end time and a verdict', ({ Given, When, Then, And }) => {
    Given('a run of "development"', startRun)
    When('the run finishes as "failed"', () => {
      run = runs.finish(run.id, 'failed')
    })
    Then('the run is "failed"', () => expect(run.state).toBe('failed'))
    And('the run has an end time', () => expect(run.finishedAt).toBeDefined())
  })

  Scenario('A run that has already finished cannot finish again', ({ Given, And, When, Then }) => {
    Given('a run of "development"', startRun)
    And('the run finishes as "completed"', () => {
      run = runs.finish(run.id, 'completed')
    })
    When('I finish the run as "failed"', () => attempt(() => runs.finish(run.id, 'failed')))
    Then('it is refused', () => expect(failure).toBeDefined())
    And('the error mentions the status it already has', () =>
      expect((failure as Error).message).toContain('completed'),
    )
  })

  Scenario('A step that was never reached is recorded as skipped', ({ Given, When, And, Then }) => {
    Given('a run of "development"', startRun)
    When('the step "install" of phase "setup" runs and fails with exit code 2', () =>
      ranWith('install', 'setup', 2),
    )
    And('the step "deploy" of phase "release" is skipped', () => {
      byName.set(
        'deploy',
        runs.skipStep(
          run.id,
          { phase: 'release', index: byName.size, describe: 'deploy', uses: 'shell' },
          'An earlier step failed.',
        ),
      )
    })
    Then('the step "deploy" is "skipped"', () => expect(byName.get('deploy')?.state).toBe('skipped'))
    And('the step "deploy" has no exit code', () =>
      expect(byName.get('deploy')?.exitCode).toBeUndefined(),
    )
  })

  Scenario('Output is kept against the step that produced it', ({ Given, And, When, Then }) => {
    Given('a run of "development"', startRun)
    And('the step "install" of phase "setup" is running', () => startStep('install', 'setup'))
    When('the step prints "installing" on stdout', () => print('installing'))
    And('the step prints "a warning" on stderr', () => print('a warning', 'stderr'))
    Then('the step\'s log reads "installing, a warning"', () =>
      expect(logText().join(', ')).toBe('installing, a warning'),
    )
    And('the log line "a warning" came from stderr', () => {
      const line = runs.logs(run.id, { stepId: step.id }).lines.find((l) => l.text === 'a warning')
      expect(line?.stream).toBe('stderr')
    })
  })

  Scenario('Output that belongs to the run rather than a step is kept too', ({
    Given,
    When,
    Then,
    And,
  }) => {
    Given('a run of "development"', startRun)
    When('the run prints "worktree created" on stdout', () => {
      runs.append({ runId: run.id, stream: 'stdout', text: 'worktree created' })
    })
    Then('the run\'s own log reads "worktree created"', () =>
      expect(runs.logs(run.id).lines.map((l) => l.text)).toEqual(['worktree created']),
    )
    And('the log is not attached to any step', () => {
      const attached = store.db.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM run_logs WHERE step_id IS NOT NULL',
      )
      expect(attached?.n).toBe(0)
    })
  })

  Scenario('Output arrives in the order it was written', ({ Given, And, When, Then }) => {
    Given('a run of "development"', startRun)
    And('the step "install" of phase "setup" is running', () => startStep('install', 'setup'))
    When('the step prints 20 numbered lines', () => {
      printed = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`)
      for (const line of printed) print(line)
    })
    Then('the step\'s log is in the order they were printed', () =>
      expect(logText()).toEqual(printed),
    )
  })

  const printBulk = (): void => {
    printed = Array.from(
      { length: 100 },
      (_, i) => `${String(i + 1).padStart(3, '0')}${'x'.repeat(96)}\n`,
    )
    for (const line of printed) print(line)
  }

  Scenario('A step that prints more than its budget keeps the start and the end', ({
    Given,
    And,
    When,
    Then,
  }) => {
    Given('a run of "development"', startRun)
    And('a log budget of 2000 bytes with a 500 byte head', () => budget(2000, 500))
    And('the step "install" of phase "setup" is running', () => startStep('install', 'setup'))
    When('the step prints 100 lines of 100 bytes', printBulk)
    Then('the step\'s log starts with line 1', () => expect(logText()[0]).toBe(printed[0]))
    And('the step\'s log ends with line 100', () =>
      expect(logText().at(-1)).toBe(printed.at(-1)),
    )
    And('the step reports dropped output', () =>
      expect(runs.logs(run.id, { stepId: step.id }).dropped).toBeGreaterThan(0),
    )
  })

  Scenario('One chunk bigger than the whole budget is still kept', ({ Given, And, When, Then }) => {
    Given('a run of "development"', startRun)
    And('a log budget of 200 bytes with a 50 byte head', () => budget(200, 50))
    And('the step "install" of phase "setup" is running', () => startStep('install', 'setup'))
    When('the step prints one line of 1000 bytes', () => {
      printed = ['y'.repeat(1000)]
      print(printed[0] as string)
    })
    Then('the step\'s log contains that line', () => expect(logText()).toEqual(printed))
  })

  Scenario('Budgets are per step, not per run', ({ Given, And, When, Then }) => {
    Given('a run of "development"', startRun)
    And('a log budget of 2000 bytes with a 500 byte head', () => budget(2000, 500))
    And('the step "install" of phase "setup" is running', () => startStep('install', 'setup'))
    When('the step prints 100 lines of 100 bytes', printBulk)
    And('the step "test" of phase "verify" is running', () => startStep('test', 'verify'))
    And('the step prints "quiet" on stdout', () => print('quiet'))
    Then('the step "test" reports no dropped output', () =>
      expect(runs.logs(run.id, { stepId: byName.get('test')?.id as number }).dropped).toBe(0),
    )
  })

  Scenario('Runs left open by a crash can be found again', ({ Given, And, When, Then }) => {
    let open: Run[] = []
    Given('a run of "development"', startRun)
    And('a second run of "development" that finished as "completed"', () => {
      second = runs.start({ workflow: 'development', taskId: task.id })
      second = runs.finish(second.id, 'completed')
    })
    When('I ask for the runs still marked running', () => {
      open = runs.running()
    })
    Then('only the first run is listed', () =>
      expect(open.map((entry) => entry.id)).toEqual([run.id]),
    )
  })

  Scenario('A paused run remembers where to continue', ({ Given, When, Then, And }) => {
    Given('a run of "development"', startRun)
    When('the run pauses at phase 2', () => {
      run = runs.pause(run.id, 2, 'Waiting for approval of "review".')
    })
    Then('the run is "paused"', () => expect(run.state).toBe('paused'))
    And('the run continues from phase 2', () => expect(run.resumePhase).toBe(2))
    And('the run is the one the task is waiting on', () =>
      expect(runs.pausedFor(task.id)?.id).toBe(run.id),
    )
  })

  Scenario('A paused run is not mistaken for a crash', ({ Given, And, When, Then }) => {
    let open: Run[] = []
    Given('a run of "development"', startRun)
    And('the run pauses at phase 1', () => {
      run = runs.pause(run.id, 1)
    })
    When('I ask for the runs still marked running', () => {
      open = runs.running()
    })
    Then('nothing is listed', () => expect(open).toHaveLength(0))
  })

  Scenario('Resuming a paused run puts it back to work', ({ Given, And, When, Then }) => {
    Given('a run of "development"', startRun)
    And('the run pauses at phase 1', () => {
      run = runs.pause(run.id, 1)
    })
    When('the run resumes', () => {
      run = runs.resume(run.id)
    })
    Then('the run is "running"', () => expect(run.state).toBe('running'))
    And('the task is waiting on nothing', () =>
      expect(runs.pausedFor(task.id)).toBeUndefined(),
    )
  })

  Scenario('A run that is not paused cannot resume', ({ Given, When, Then }) => {
    Given('a run of "development"', startRun)
    When('I resume the run', () => attempt(() => runs.resume(run.id)))
    Then('it is refused', () => expect(failure).toBeDefined())
  })

  Scenario("A task's runs are listed newest first", ({ Given, And, When, Then }) => {
    let listed: Run[] = []
    Given('a run of "development" that finished as "failed"', () => {
      startRun()
      run = runs.finish(run.id, 'failed')
    })
    And('a second run of "development"', () => {
      second = runs.start({ workflow: 'development', taskId: task.id })
    })
    When("I ask for the task's runs", () => {
      listed = runs.forTask(task.id)
    })
    Then('the second run is listed first', () =>
      expect(listed.map((entry) => entry.id)).toEqual([second.id, run.id]),
    )
  })

  Scenario('Deleting a task takes its runs and their output with it', ({
    Given,
    And,
    When,
    Then,
  }) => {
    Given('a run of "development"', startRun)
    And('the step "install" of phase "setup" is running', () => startStep('install', 'setup'))
    And('the step prints "installing" on stdout', () => print('installing'))
    When('the task is deleted', () => {
      tasks.delete(task.id)
    })
    Then('the run is gone', () => expect(runs.get(run.id)).toBeUndefined())
    And('no output is left behind', () => {
      const left = store.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM run_logs')
      expect(left?.n).toBe(0)
    })
  })

  const capEvidence = (bytes: number): void => {
    runs = new RunRepository({ db: store.db, now, newId, evidenceBytes: bytes })
  }

  Scenario('Evidence is kept with the run that produced it', ({ Given, When, Then, And }) => {
    Given('a run of "development"', startRun)
    When('the phase "review" produces the artifact "review" saying "looks good"', () => {
      runs.attachEvidence({
        runId: run.id,
        phase: 'review',
        name: 'review',
        path: '/work/.xaedalon/.factory/tasks/ship-it/artifacts/review/review.md',
        content: 'looks good',
      })
    })
    Then('the run has 1 piece of evidence', () => expect(runs.evidence(run.id)).toHaveLength(1))
    And('the evidence is for the phase "review"', () =>
      expect(runs.evidence(run.id)[0]?.phase).toBe('review'),
    )
    And('the evidence reads "looks good"', () =>
      expect(runs.evidence(run.id)[0]?.content).toBe('looks good'),
    )
    And('the evidence records where the file is', () =>
      expect(runs.evidence(run.id)[0]?.path).toBe(
        '/work/.xaedalon/.factory/tasks/ship-it/artifacts/review/review.md',
      ),
    )
  })

  Scenario('An artifact a phase promised but did not produce is recorded as missing', ({
    Given,
    When,
    Then,
    And,
  }) => {
    Given('a run of "development"', startRun)
    When('the phase "review" promises "review" and produces nothing', () => {
      runs.attachEvidence({
        runId: run.id,
        phase: 'review',
        name: 'review',
        path: '/work/.xaedalon/.factory/tasks/ship-it/artifacts/review/review.md',
        missing: true,
      })
    })
    // A row either way: a promise that was not kept is the fact worth having.
    Then('the run has 1 piece of evidence', () => expect(runs.evidence(run.id)).toHaveLength(1))
    And('the evidence is marked missing', () =>
      expect(runs.evidence(run.id)[0]?.missing).toBe(true),
    )
    And('the evidence has no content', () =>
      expect(runs.evidence(run.id)[0]?.content).toBeUndefined(),
    )
  })

  Scenario('Evidence bigger than the cap keeps the beginning and says so', ({
    Given,
    And,
    When,
    Then,
  }) => {
    Given('a run of "development"', startRun)
    And('an evidence cap of 100 bytes', () => capEvidence(100))
    When('the phase "review" produces the artifact "review" with 500 bytes', () => {
      runs.attachEvidence({
        runId: run.id,
        phase: 'review',
        name: 'review',
        path: '/work/.xaedalon/.factory/tasks/ship-it/artifacts/review/review.md',
        content: 'z'.repeat(500),
      })
    })
    Then('the evidence is marked truncated', () =>
      expect(runs.evidence(run.id)[0]?.truncated).toBe(true),
    )
    And('the evidence records the real size', () =>
      expect(runs.evidence(run.id)[0]?.bytes).toBe(500),
    )
  })

  Scenario('Evidence is replaced when a phase runs again', ({ Given, And, When, Then }) => {
    Given('a run of "development"', startRun)
    And('the phase "review" produced the artifact "review" saying "first"', () => {
      runs.attachEvidence({
        runId: run.id,
        phase: 'review',
        name: 'review',
        path: '/work/.xaedalon/.factory/tasks/ship-it/artifacts/review/review.md',
        content: 'first',
      })
    })
    When('the phase "review" produces the artifact "review" saying "second"', () => {
      runs.attachEvidence({
        runId: run.id,
        phase: 'review',
        name: 'review',
        path: '/work/.xaedalon/.factory/tasks/ship-it/artifacts/review/review.md',
        content: 'second',
      })
    })
    // One row per artifact, not one per attempt: a resumed run re-running a
    // phase should leave the latest evidence, not two versions with no way to
    // tell which decision was made on which. The history lives beside the file,
    // in `versions/`.
    Then('the run has 1 piece of evidence', () => expect(runs.evidence(run.id)).toHaveLength(1))
    And('the evidence reads "second"', () =>
      expect(runs.evidence(run.id)[0]?.content).toBe('second'),
    )
  })

  Scenario('A run for a task that does not exist is refused', ({ When, Then }) => {
    When('I start a run for the task "ghost"', () =>
      attempt(() => runs.start({ workflow: 'development', taskId: 'ghost' })),
    )
    Then('it is refused', () => expect(failure).toBeDefined())
  })

  Rule('a phase is carried out when one run got every step of it done', ({ RuleScenario }) => {
    /** The task's single entry, which is what a run has to be stamped with. */
    const entry = () => task.workflows[0]!
    const runFor = (workflow: string): void => {
      run = runs.start({ workflow, taskId: task.id, entryId: entry().id })
    }
    const stepIn = (describe: string, phase: string, state: 'completed' | 'failed' | null): void => {
      step = runs.startStep(run.id, { phase, index: byName.size, describe, uses: 'shell' })
      byName.set(describe, step)
      if (state !== null) runs.finishStep(step.id, { state, exitCode: state === 'completed' ? 0 : 1 })
    }
    const carried = () => runs.completedPhases(task.id)
    const finishedEntries = () => runs.completedEntries(task.id)

    const givenRun = () => runFor('development')

    RuleScenario('A phase whose every step completed is carried out', ({ Given, And, Then }) => {
      Given('a run of "development" for the first workflow', givenRun)
      And('"build" ran in "compile" and succeeded', () => stepIn('build', 'compile', 'completed'))
      Then('1 phase has been carried out', () => expect(carried()).toHaveLength(1))
    })

    RuleScenario('A phase is not carried out while a step of it is still running', ({
      Given,
      And,
      Then,
    }) => {
      Given('a run of "development" for the first workflow', givenRun)
      And('"build" started in "compile" and has not finished', () =>
        stepIn('build', 'compile', null),
      )
      // Integers over integers: a phase half done has no honest value, and its
      // last step is as likely to fail as its first.
      Then('no phases have been carried out', () => expect(carried()).toEqual([]))
    })

    RuleScenario('A phase whose step failed is not carried out', ({ Given, And, Then }) => {
      Given('a run of "development" for the first workflow', givenRun)
      And('"build" ran in "compile" and failed', () => stepIn('build', 'compile', 'failed'))
      Then('no phases have been carried out', () => expect(carried()).toEqual([]))
    })

    // The one that caught a real bug: judged across all runs of the entry
    // together, the failed row above would veto this for ever.
    RuleScenario('A retry carries out the phase its first attempt failed', ({
      Given,
      And,
      Then,
    }) => {
      Given('a run of "development" for the first workflow', givenRun)
      And('"build" ran in "compile" and failed', () => stepIn('build', 'compile', 'failed'))
      And('a second run of "development" for the first workflow', givenRun)
      And('"build" ran in "compile" and succeeded', () => stepIn('build', 'compile', 'completed'))
      Then('1 phase has been carried out', () => expect(carried()).toHaveLength(1))
    })

    RuleScenario('A workflow that ran twice does not count its phases twice', ({
      Given,
      And,
      Then,
    }) => {
      Given('a run of "development" for the first workflow', givenRun)
      And('"build" ran in "compile" and succeeded', () => stepIn('build', 'compile', 'completed'))
      And('a second run of "development" for the first workflow', givenRun)
      And('"build" ran in "compile" and succeeded a second time', () =>
        stepIn('build', 'compile', 'completed'),
      )
      Then('1 phase has been carried out', () => expect(carried()).toHaveLength(1))
    })

    // Not redundant with counting rows: a phase whose `steps:` list is empty is
    // only a warning, so it never writes a row and could never be counted.
    RuleScenario('A run that finished carries out every phase of its workflow', ({
      Given,
      And,
      Then,
    }) => {
      Given('a run of "development" for the first workflow', givenRun)
      And('the run completed', () => {
        runs.finish(run.id, 'completed')
      })
      Then('its workflow counts as finished', () =>
        expect(finishedEntries()).toEqual([{ entryId: entry().id, workflow: 'development' }]),
      )
    })

    RuleScenario('A run that was refused carries nothing out', ({ Given, And, Then }) => {
      Given('a run of "development" for the first workflow', givenRun)
      And('the run was refused', () => {
        runs.finish(run.id, 'refused')
      })
      Then('no phases have been carried out', () => expect(carried()).toEqual([]))
      And('its workflow does not count as finished', () => expect(finishedEntries()).toEqual([]))
    })

    // A recovery run reuses the failed entry's id with a different workflow
    // name, exactly as `#loopIsDone` has to guard against.
    RuleScenario("A recovery workflow's phases are not credited to the entry that failed", ({
      Given,
      And,
      Then,
    }) => {
      Given('a run of "development" for the first workflow', givenRun)
      And('a run of "diagnose" stamped with the same entry', () => runFor('diagnose'))
      And('"look" ran in "triage" and succeeded', () => stepIn('look', 'triage', 'completed'))
      Then('no phases have been carried out', () => expect(carried()).toEqual([]))
    })
  })

  Rule('a run records the authority it was given', ({ RuleScenario }) => {
    const startUnder = (profile?: ExecutionProfile) => (): void => {
      run = runs.start({
        workflow: 'development',
        taskId: task.id,
        ...(profile === undefined ? {} : { profile }),
      })
    }
    const profileIs = (expected: string) => (): void => {
      expect(run.profile).toBe(expected)
    }

    RuleScenario('A run carries the profile it was started with', ({ When, Then }) => {
      When('a run is started under "full-access"', startUnder('full-access'))
      Then('the run\'s profile is "full-access"', profileIs('full-access'))
    })

    RuleScenario('A run started without one records none', ({ When, Then }) => {
      When('a run is started', startUnder())
      Then('the run states no profile', () => expect(run.profile).toBeUndefined())
    })

    RuleScenario('The profile survives a pause and a resume', ({ When, And, Then }) => {
      When('a run is started under "default"', startUnder('default'))
      And('it pauses at phase 2', () => {
        run = runs.pause(run.id, 2)
      })
      And('it is resumed', () => {
        run = runs.resume(run.id)
      })
      Then('the run\'s profile is "default"', profileIs('default'))
    })
  })
  Rule('a step records what it actually ran', ({ RuleScenario }) => {
    RuleScenario('A step keeps the command that was run', ({ When, Then }) => {
      When('the step "install" runs "npm ci"', () => {
        startRun()
        step = runs.startStep(run.id, {
          phase: 'setup',
          index: 0,
          describe: 'install',
          uses: 'shell',
          command: 'npm ci',
        })
      })
      Then('the step\'s command is "npm ci"', () =>
        expect(runs.steps(run.id)[0]?.command).toBe('npm ci'),
      )
    })

    RuleScenario('A step that ran nothing records nothing', ({ When, Then }) => {
      When('the step "install" of phase "setup" runs and succeeds', () => {
        startRun()
        ranWith('install', 'setup', 0)
      })
      Then('the step states no command', () =>
        expect(runs.steps(run.id)[0]?.command).toBeUndefined(),
      )
    })
  })
})

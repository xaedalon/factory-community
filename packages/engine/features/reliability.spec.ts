import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { EventBus } from '@factory/events'
import {
  DEFAULT_RELIABILITY_POLICY as policy,
  SCORING_MODEL_VERSION,
  deterministicEvaluator,
  type PlanResult,
  type Problem,
  type ReliabilityAssessment,
  type ReliabilityEvaluatorCapability,
  type ResolvedPhase,
  type ResolvedPlan,
  type RunFacts,
  type Task,
  type WorkflowReliability,
} from '@factory/core'
import {
  MIGRATIONS,
  ProjectRepository,
  ReliabilityRepository,
  RunRepository,
  TaskRepository,
  openStore,
  type Store,
} from '@factory/store'
import { Engine, assessReliability, stalenessOf } from '@factory/engine'

const feature = await loadFeature(fileURLToPath(new URL('./reliability.feature', import.meta.url)))

describeFeature(feature, ({ Rule, BeforeEachScenario, AfterEachScenario }) => {
  let store: Store
  let bus: EventBus
  let tasks: TaskRepository
  let runs: RunRepository
  let reliability: ReliabilityRepository
  let engine: Engine
  let task: Task
  let work = ''
  let problems: Problem[] = []
  let plans: Map<string, PlanResult>
  /** Swapped by the scenarios about failure. */
  let assessor: Engine extends never ? never : NonNullable<ConstructorParameters<typeof Engine>[0]['assess']>
  let evaluators: ReliabilityEvaluatorCapability[]

  AfterEachScenario(() => {
    store?.close()
    if (work !== '') rmSync(work, { recursive: true, force: true })
  })

  BeforeEachScenario(() => {
    problems = []
    plans = new Map()
    evaluators = [deterministicEvaluator]
    work = mkdtempSync(join(tmpdir(), 'factory-reliability-'))
    store = openStore({ file: ':memory:', migrations: MIGRATIONS })
    bus = new EventBus({ onSubscriberError: () => {} })
    tasks = new TaskRepository({ db: store.db, events: bus })
    runs = new RunRepository({ db: store.db, events: bus })
    reliability = new ReliabilityRepository({ db: store.db, events: bus })
    const projects = new ProjectRepository({ db: store.db, events: bus })
    const project = projects.add({ name: 'probe', path: work })
    task = tasks.create({ name: 'a task', projectId: project.id })

    assessor = async ({ taskId, facts }) => {
      const found = tasks.get(taskId)
      if (found === undefined) return []
      const outcome = await assessReliability({
        taskId,
        task: { name: found.name, description: found.description },
        reliability,
        evaluators,
        policy,
        trigger: 'run',
        facts,
        workflows: [],
      })
      return outcome.problems
    }
  })

  /** A plan of one shell step, which is the smallest thing that really runs. */
  const shellPhase = (command: string): ResolvedPhase => ({
    name: 'work',
    approval: 'none',
    cwd: work,
    steps: [
      {
        index: 0,
        uses: 'shell',
        planned: { describe: command, command: 'bash', args: ['-c', command] },
        raw: { uses: 'shell', run: command },
      },
    ],
  })

  const givePlan = (command: string, reliability?: WorkflowReliability): void => {
    const plan: ResolvedPlan = {
      workflow: 'build',
      profile: 'default',
      mode: 'once',
      scheduling: 'sequential',
      requires: [],
      provides: [],
      clears: [],
      phases: [shellPhase(command)],
      ...(reliability === undefined ? {} : { reliability }),
    }
    plans.set('build', { plan, problems: [] })
  }

  const build = (): void => {
    engine = new Engine({
      tasks,
      runs,
      env: { PATH: process.env['PATH'] ?? '' },
      plan: ({ workflow }) => plans.get(workflow) ?? { problems: [] },
      events: bus,
      assess: (input) => assessor(input),
    })
  }

  const runIt = async (): Promise<void> => {
    task = tasks.assign(task.id, ['build'])
    task = tasks.act(task.id, 'queue')
    const outcome = await engine.run(task.id)
    task = outcome.task
    problems = [...outcome.problems]
  }

  const succeeds = (): void => {
    givePlan('echo building')
    build()
  }
  const fails = (): void => {
    givePlan('exit 1')
    build()
  }
  const warned = (fragment: string) => (): void => {
    expect(problems.map((problem) => problem.message).join(' | ')).toContain(fragment)
  }

  Rule('a judgement that cannot be made does not fail the work it was judging', ({
    RuleScenario,
  }) => {
    RuleScenario('An assessor that throws leaves the run completed', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('a workflow that succeeds', () => givePlan('echo building'))
      And('an assessor that throws', () => {
        assessor = () => {
          throw new Error('the evaluator exploded')
        }
        build()
      })
      When('the engine works on the task', runIt)
      Then('the run completed', () =>
        expect(runs.forTask(task.id)[0]?.state).toBe('completed'),
      )
      And('the task is done', () => expect(task.state).toBe('done'))
      And('a warning says reliability could not be recalculated', warned('could not be recalculated'))
    })

    RuleScenario('An evaluator that throws still produces an assessment', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given('a task with a failing evaluator and the deterministic one', () => {
        evaluators = [
          {
            id: 'explodes',
            summary: 'always throws',
            evaluate: () => {
              throw new Error('no idea')
            },
          },
          deterministicEvaluator,
        ]
      })
      When('the task is assessed', async () => {
        const outcome = await assessReliability({
          taskId: task.id,
          task: { name: task.name, description: '' },
          reliability,
          evaluators,
          policy,
          trigger: 'manual',
        })
        problems = [...outcome.problems]
      })
      Then('an assessment was recorded', () =>
        expect(reliability.newest(task.id)).toBeDefined(),
      )
      And('a warning names the evaluator that failed', warned('"explodes" failed'))
    })
  })

  Rule('every verdict is judged, whatever the workflow said', ({ RuleScenario }) => {
    RuleScenario('A workflow that declares nothing is still judged', ({ Given, When, Then }) => {
      Given('a workflow that succeeds', succeeds)
      When('the engine works on the task', runIt)
      Then('the task has been assessed', () => expect(reliability.newest(task.id)).toBeDefined())
    })

    RuleScenario('A run that failed is judged too', ({ Given, When, Then }) => {
      Given('a workflow that fails', fails)
      When('the engine works on the task', runIt)
      Then('the task has been assessed', () => expect(reliability.newest(task.id)).toBeDefined())
    })

    RuleScenario('The assessment names the run it judged', ({ Given, When, Then }) => {
      Given('a workflow that succeeds', succeeds)
      When('the engine works on the task', runIt)
      Then('the assessment names the run', () => {
        const run = runs.forTask(task.id)[0]
        expect(reliability.newest(task.id)?.runId).toBe(run?.id)
      })
    })
  })

  Rule('what a workflow declares reaches the judgement it refines', ({ RuleScenario }) => {
    const coverage = (): number | undefined => reliability.newest(task.id)?.coverage

    RuleScenario('A workflow that declares its evidence earns coverage for it', ({
      Given,
      When,
      Then,
    }) => {
      Given(
        'a workflow that succeeds declaring it collects "technical_approach" and "compatibility_considered"',
        () => {
          givePlan('echo building', {
            contributes: ['design'],
            expected_evidence: ['technical_approach', 'compatibility_considered'],
          })
          build()
        },
      )
      When('the engine works on the task', runIt)
      Then('the coverage is above zero', () => {
        expect(coverage()).toBeGreaterThan(0)
      })
    })

    RuleScenario('A workflow that declares nothing earns no coverage', ({
      Given,
      When,
      Then,
    }) => {
      Given('a workflow that succeeds', succeeds)
      When('the engine works on the task', runIt)
      Then('the coverage is zero', () => {
        expect(coverage()).toBe(0)
      })
    })

    RuleScenario('A workflow that says not to judge it is not judged', ({
      Given,
      When,
      Then,
    }) => {
      Given('a workflow that succeeds and asks not to be judged', () => {
        givePlan('echo building', {
          contributes: [],
          expected_evidence: [],
          evaluate_after_run: false,
        })
        build()
      })
      When('the engine works on the task', runIt)
      Then('the task has not been assessed', () => {
        expect(reliability.newest(task.id)).toBeUndefined()
      })
    })
  })

  Rule('what the run did reaches the judgement', ({ RuleScenario }) => {
    RuleScenario('A failed step becomes a finding', ({ Given, When, Then }) => {
      Given('a workflow that fails', fails)
      When('the engine works on the task', runIt)
      Then('the task has at least one driver', () =>
        expect(reliability.drivers(task.id).length).toBeGreaterThan(0),
      )
    })

    RuleScenario('A clean run leaves no findings', ({ Given, When, Then }) => {
      Given('a workflow that succeeds', succeeds)
      When('the engine works on the task', runIt)
      Then('the task has no drivers', () => expect(reliability.drivers(task.id)).toEqual([]))
    })
  })

  Rule('the score moves, and says why', ({ RuleScenario }) => {
    let before = 0

    const assessedOnce = async (): Promise<void> => {
      await assessReliability({
        taskId: task.id,
        task: { name: task.name, description: '' },
        reliability,
        evaluators: [deterministicEvaluator],
        policy,
        trigger: 'manual',
      })
      before = reliability.newest(task.id)?.score ?? 0
    }

    const regressionFound = async (): Promise<void> => {
      const facts: RunFacts = {
        runId: 'run-2',
        workflow: 'validate',
        status: 'failed',
        steps: [
          { phase: 'check', index: 0, uses: 'shell', exitCode: 1, command: 'pnpm test' },
        ],
        denials: [],
        artifacts: [],
        checkCommand: 'pnpm test',
      }
      await assessReliability({
        taskId: task.id,
        task: { name: task.name, description: '' },
        reliability,
        evaluators: [deterministicEvaluator],
        policy,
        trigger: 'run',
        facts,
      })
    }

    RuleScenario('A second assessment carries a delta', ({ Given, When, Then, And }) => {
      Given('a task assessed once', assessedOnce)
      When('the task is assessed again with a regression found', regressionFound)
      Then('the newest assessment has a delta', () =>
        expect(reliability.newest(task.id)?.delta).not.toBe(0),
      )
      And('its causes name the regression', () => {
        const causes = reliability.newest(task.id)?.explanation.causes ?? []
        expect(causes.map((cause) => cause.summary).join(' | ')).toContain('check failed')
      })
    })

    RuleScenario('A finding lowers the score', ({ Given, When, Then }) => {
      Given('a task assessed once', assessedOnce)
      When('the task is assessed again with a regression found', regressionFound)
      Then('the score is lower than it was', () =>
        expect(reliability.newest(task.id)?.score).toBeLessThan(before),
      )
    })

    RuleScenario('The assessment records the dimensions the score came from', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given('a task assessed once', assessedOnce)
      When('the task is assessed again with a regression found', regressionFound)
      Then("the recorded dimensions carry the finding's cost", () => {
        const newest = reliability.newest(task.id) as ReliabilityAssessment
        const drivers = reliability.drivers(task.id)
        const found = drivers.find((d) => d.status === 'open')
        expect(found).toBeDefined()
        // The dimension the finding names reads lower than the baseline it
        // would have had on evidence alone.
        expect(newest.dimensions[(found as { dimension: 'design' }).dimension]).toBeLessThan(
          policy.baseline,
        )
      })
      And('the breakdown adds up to the raw score', () => {
        const newest = reliability.newest(task.id) as ReliabilityAssessment
        for (const line of newest.explanation.contributions) {
          expect(line.score).toBe(newest.dimensions[line.dimension])
        }
      })
    })

    RuleScenario('History keeps both', ({ Given, When, Then }) => {
      Given('a task assessed once', assessedOnce)
      When('the task is assessed again with a regression found', regressionFound)
      Then('the history holds 2 assessments', () =>
        expect(reliability.history(task.id)).toHaveLength(2),
      )
    })
  })

  Rule('an assessment knows when it has fallen behind', ({ RuleScenario }) => {
    let assessment: ReliabilityAssessment
    let staleness: string | undefined

    const assessed = (consideredRunId?: string): void => {
      assessment = reliability.record({
        taskId: task.id,
        trigger: 'run',
        score: 90,
        rawScore: 90,
        coverage: 50,
        delta: 0,
        summary: '',
        dimensions: {
          understanding: 90,
          precedent: 90,
          design: 90,
          implementation: 90,
          regressionSafety: 90,
          verification: 90,
        },
        caps: [],
        explanation: { contributions: [], rawScore: 90, caps: [], effectiveScore: 90, causes: [] },
        ...(consideredRunId === undefined ? {} : { consideredRunId }),
        scoringModelVersion: SCORING_MODEL_VERSION,
      })
      staleness = stalenessOf(assessment, ['run-1', 'run-2', 'run-3'])
    }

    RuleScenario('A fresh assessment is not stale', ({ Given, Then }) => {
      Given('an assessment that considered the newest run', () => assessed('run-3'))
      Then('it is not stale', () => expect(staleness).toBeUndefined())
    })

    RuleScenario('A run since the assessment makes it stale', ({ Given, Then, And }) => {
      Given('an assessment that considered an earlier run', () => assessed('run-1'))
      Then('it is stale', () => expect(staleness).toBeDefined())
      And('it says how many runs have finished since', () => expect(staleness).toContain('2 runs'))
    })

    RuleScenario('An assessment that considered no run is never stale', ({ Given, Then }) => {
      Given('an assessment that considered no run', () => assessed())
      Then('it is not stale', () => expect(staleness).toBeUndefined())
    })
  })
})

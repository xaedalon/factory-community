import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import type { Project, Task, TaskState } from '@factory/core'
import { factoryTools, type McpTool } from '../src/index.js'
import { FakeFactory } from './support.js'

const feature = await loadFeature(fileURLToPath(new URL('./mcp-tools.feature', import.meta.url)))

const CWD = '/repos/factory'

const aProject = (name: string, id: string): Project => ({
  id,
  name,
  path: `/repos/${name}`,
  defaultBranch: 'main',
  worktreesRoot: `/repos/.factory-worktrees/${name}`,
  isRepository: true,
  usesWorktrees: true,
  usesEnvironments: false,
  grantedDirectories: [],
  createdAt: '2026-01-01T00:00:00Z',
})

const aTask = (name: string, projectId: string, state: TaskState = 'draft'): Task => ({
  id: `task-${name.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')}`,
  name,
  description: '',
  projectId,
  state,
  workflows: [{ id: 'entry-1', workflow: 'development', enabled: true, ran: false }],
  flags: [],
  dependsOn: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
})

describeFeature(feature, ({ Background, Rule }) => {
  let factory: FakeFactory
  let answer: Record<string, unknown>
  let tasks: Task[]

  // Failures are not caught here: these scenarios are about what a tool says
  // when it works, and the refusals have their own feature.
  const call = async (name: string, input: unknown = {}): Promise<void> => {
    const chosen = factoryTools.find((candidate) => candidate.name === name) as McpTool
    const parsed = chosen.parse(input)
    if ('problems' in parsed) throw new Error(parsed.problems.join('; '))
    answer = (await chosen.run(parsed.value, { api: factory, cwd: CWD, env: {} })) as Record<
      string,
      unknown
    >
  }

  /** The tasks list route, rebuilt from whatever the scenario has added. */
  const publishTasks = (extra: Record<string, unknown> = {}) => {
    factory.answer('/api/tasks?archived=true', {
      items: tasks.map((task) => ({
        ...task,
        actions: [{ action: 'queue', label: 'Queue', to: 'queued' }],
        ...extra,
      })),
    })
  }

  Background(({ Given, And }) => {
    Given('a Factory with the project "factory"', () => {
      tasks = []
      answer = {}
      factory = new FakeFactory()
      factory.answer('/api/projects', { items: [aProject('factory', 'project-1')] })
      factory.answer(`/api/projects/at?path=${encodeURIComponent(CWD)}`, {
        project: aProject('factory', 'project-1'),
        matchedBy: 'directory',
      })
    })
    And('an agent working in that project', () => publishTasks())
  })

  const listedNames = () =>
    (answer.tasks as { name: string }[] | undefined)?.map((task) => task.name) ?? []

  Rule('a task carries the actions it will accept, never a guess', ({ RuleScenario }) => {
    const detail = (task: Task, actions: string[], extra: Record<string, unknown> = {}) => {
      factory.answer(`/api/tasks/${task.id}`, {
        task,
        actions: actions.map((action) => ({ action, label: action, to: 'queued' })),
        runs: [],
        artifacts: [],
        ...extra,
      })
    }

    RuleScenario('A task offers what the daemon said it offers', ({ Given, When, Then, And }) => {
      Given('a draft task "Add due dates" the daemon says can be queued', () => {
        const task = aTask('Add due dates', 'project-1')
        tasks.push(task)
        detail(task, ['queue'])
        publishTasks()
      })
      When('the agent reads that task', () => call('factory_task_get', { task: 'task-add-due-dates' }))
      Then('the actions offered are "queue"', () => expect(answer.actions).toEqual(['queue']))
      And('it is told to queue it when the plan is right', () =>
        expect(answer.next).toContain('Queue it'),
      )
    })

    RuleScenario('A task waiting for a person says a person has to decide', ({
      Given,
      When,
      Then,
    }) => {
      Given('a task "Add due dates" waiting for approval', () => {
        const task = aTask('Add due dates', 'project-1', 'awaiting_approval')
        tasks.push(task)
        detail(task, ['approve', 'reject'])
        publishTasks()
      })
      When('the agent reads that task', () => call('factory_task_get', { task: 'task-add-due-dates' }))
      Then('it is told a person has to approve or reject it', () =>
        expect(answer.next).toContain('A person has to approve'),
      )
    })

    RuleScenario('Tasks in another project are not listed', ({ Given, And, When, Then }) => {
      Given('a task "Add due dates" in "factory"', () => {
        tasks.push(aTask('Add due dates', 'project-1'))
      })
      And("a task \"Somebody else's\" in another project", () => {
        tasks.push(aTask("Somebody else's", 'project-2'))
        publishTasks()
      })
      When('the agent lists the tasks', () => call('factory_task_list', {}))
      Then('only "Add due dates" is listed', () => expect(listedNames()).toEqual(['Add due dates']))
    })

    RuleScenario('Only tasks that have not finished, when that is what was asked', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('a task "Add due dates" in "factory"', () => {
        tasks.push(aTask('Add due dates', 'project-1', 'running'))
      })
      And('a finished task "Ship it" in "factory"', () => {
        tasks.push(aTask('Ship it', 'project-1', 'done'))
        publishTasks()
      })
      When('the agent lists only the active tasks', () => call('factory_task_list', { active: true }))
      Then('only "Add due dates" is listed', () => expect(listedNames()).toEqual(['Add due dates']))
    })
  })

  Rule('what a project can run is what it is offered', ({ RuleScenario }) => {
    const workflows = (items: unknown[]): void => {
      factory.answer('/api/workflows?project=project-1', { items })
    }
    const offered = (name: string) =>
      (answer.workflows as { name: string }[] | undefined)?.find((item) => item.name === name)

    RuleScenario('A workflow comes with what it needs', ({ Given, When, Then, And }) => {
      Given('the project offers a workflow "development" that needs "analysis"', () =>
        workflows([
          {
            name: 'development',
            valid: true,
            problems: [],
            needs: ['analysis'],
            value: { description: 'Build it', mode: 'once', phases: ['work'] },
          },
        ]),
      )
      When('the agent lists the workflows', () => call('factory_workflow_list', {}))
      Then('"development" is offered', () => expect(offered('development')).toBeDefined())
      And('it says it needs "analysis"', () =>
        expect((offered('development') as { needs?: string[] }).needs).toEqual(['analysis']),
      )
    })

    RuleScenario('A workflow the project cannot run yet is marked, not hidden', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given('the project offers a workflow "merge" it cannot run without worktrees', () =>
        workflows([
          {
            name: 'merge',
            valid: true,
            problems: [],
            unavailable: { flag: 'hasWorktree', setting: 'worktrees' },
            value: { description: 'Merge it', mode: 'once', phases: ['merge'] },
          },
        ]),
      )
      When('the agent lists the workflows', () => call('factory_workflow_list', {}))
      Then('"merge" is offered', () => expect(offered('merge')).toBeDefined())
      And('it says why it is unavailable', () =>
        expect((offered('merge') as { unavailable?: string }).unavailable).toContain('hasWorktree'),
      )
    })

    RuleScenario('A phase says whether somebody has to approve it', ({ Given, When, Then }) => {
      Given('the project offers a phase "publish" that needs approval first', () => {
        factory.answer('/api/phases?project=project-1', {
          items: [
            {
              name: 'publish',
              valid: true,
              problems: [],
              value: { description: 'Publish', approval: 'before', steps: [{ uses: 'shell' }] },
            },
          ],
        })
      })
      When('the agent lists the phases', () => call('factory_phase_list', {}))
      Then('"publish" says its approval is "before"', () =>
        expect((answer.phases as { approval: string }[])[0]?.approval).toBe('before'),
      )
    })
  })

  Rule('a run arrives with its evidence', ({ RuleScenario }) => {
    const withArtifact = (): void => {
      factory.answer('/api/runs/run-1', {
        run: {
          id: 'run-1',
          workflow: 'development',
          state: 'completed',
          attempt: 1,
          workflowIndex: 0,
          startedAt: '2026-01-01T00:00:00Z',
        },
        steps: [
          {
            id: 1,
            runId: 'run-1',
            phase: 'work',
            index: 0,
            describe: 'build',
            uses: 'shell',
            state: 'completed',
            attempts: 1,
            startedAt: '2026-01-01T00:00:00Z',
          },
        ],
        evidence: [
          {
            id: 1,
            runId: 'run-1',
            phase: 'work',
            name: 'report.md',
            path: '/repos/factory/.xaedalon/.factory/tasks/x/artifacts/report.md',
            content: 'the agent wrote this and it must not be here',
            bytes: 43,
            truncated: false,
            missing: false,
            collectedAt: '2026-01-01T00:00:00Z',
          },
        ],
      })
    }

    RuleScenario('A run carries its steps and what it produced', ({ Given, When, Then, And }) => {
      Given('a run that wrote an artifact "report.md"', withArtifact)
      When('the agent reads that run', () => call('factory_run_get', { run: 'run-1' }))
      Then("the run's steps are listed", () =>
        expect((answer.steps as { describe: string }[])[0]?.describe).toBe('build'),
      )
      And('"report.md" is named with its size', () => {
        const evidence = (answer.evidence as { name: string; bytes: number }[])[0]
        expect(evidence?.name).toBe('report.md')
        expect(evidence?.bytes).toBe(43)
      })
    })

    RuleScenario('Evidence is named and sized, never quoted', ({ Given, When, Then }) => {
      Given('a run that wrote an artifact "report.md"', withArtifact)
      When('the agent reads that run', () => call('factory_run_get', { run: 'run-1' }))
      Then("the answer does not contain the artifact's contents", () =>
        expect(JSON.stringify(answer)).not.toContain('must not be here'),
      )
    })
  })

  Rule('logs are bounded, and a log that lost its middle says so', ({ RuleScenario }) => {
    const lines = (count: number, dropped = 0): void => {
      factory.answer('/api/runs/run-1/logs', {
        lines: Array.from({ length: count }, (_value, index) => ({
          at: '2026-01-01T00:00:00Z',
          stream: 'stdout',
          text: `line ${index}`,
        })),
        dropped,
      })
    }

    RuleScenario('Only the tail comes back', ({ Given, When, Then, And }) => {
      Given('a run that printed 500 lines', () => lines(500))
      When('the agent reads the last 10 lines of it', () =>
        call('factory_run_logs', { run: 'run-1', tail: 10 }),
      )
      Then('10 lines come back', () => expect(answer.lines).toHaveLength(10))
      And('it says 490 older lines were not sent', () => expect(answer.older).toBe(490))
    })

    RuleScenario('What Factory dropped is counted apart from what was not sent', ({
      Given,
      When,
      Then,
    }) => {
      Given('a run whose log Factory had to trim by 2048 bytes', () => lines(10, 2048))
      When("the agent reads that run's logs", () => call('factory_run_logs', { run: 'run-1' }))
      Then('it says Factory dropped something', () => {
        expect(answer.droppedByFactory).toBe(2048)
        expect(answer.older).toBe(0)
      })
    })

    RuleScenario("One step's output can be asked for on its own", ({ Given, When, Then }) => {
      Given('a run that printed 500 lines', () => {
        lines(500)
        factory.answer('/api/runs/run-1/logs?step=3', { lines: [], dropped: 0 })
      })
      When('the agent reads the logs of step 3', () =>
        call('factory_run_logs', { run: 'run-1', step: 3 }),
      )
      Then('Factory was asked for step 3 only', () =>
        expect(factory.asked).toContain('GET /api/runs/run-1/logs?step=3'),
      )
    })
  })

  Rule('what is waiting for a person is reported, not answered', ({ RuleScenario }) => {
    RuleScenario('A parked task names its run and where it continues from', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given('a task "Add due dates" parked at a gate in the run "run-1"', () => {
        const task = aTask('Add due dates', 'project-1', 'awaiting_approval')
        tasks.push(task)
        publishTasks()
        factory.answer(`/api/tasks/${task.id}`, {
          task,
          actions: [{ action: 'approve', label: 'Approve', to: 'running' }],
          runs: [
            {
              id: 'run-1',
              workflow: 'development',
              state: 'paused',
              attempt: 1,
              workflowIndex: 0,
              resumePhase: 2,
              startedAt: '2026-01-01T00:00:00Z',
              detail: 'publish asks before it runs',
            },
          ],
          artifacts: [],
        })
      })
      When('the agent asks what is waiting', () => call('factory_approval_list', {}))
      Then('"Add due dates" is waiting', () =>
        expect((answer.approvals as { task: { name: string } }[])[0]?.task.name).toBe(
          'Add due dates',
        ),
      )
      And('the answer names the run "run-1"', () =>
        expect((answer.approvals as { run?: string }[])[0]?.run).toBe('run-1'),
      )
      And('it says a person has to decide', () =>
        expect(answer.next).toContain('A person has to decide'),
      )
    })

    RuleScenario('Nothing waiting says so plainly', ({ Given, When, Then }) => {
      Given('a task "Add due dates" in "factory"', () => {
        tasks.push(aTask('Add due dates', 'project-1'))
        publishTasks()
      })
      When('the agent asks what is waiting', () => call('factory_approval_list', {}))
      Then('nothing is waiting', () => {
        expect(answer.approvals).toEqual([])
        expect(answer.next).toContain('Nothing is waiting')
      })
    })
  })
})

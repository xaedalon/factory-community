import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { DISCLAIMER, type Project, type Task, type TaskState } from '@factory/core'
import {
  AGENT_ACTIONS,
  TOOL_ERROR_CODES,
  factoryTools,
  type McpTool,
  type ToolError,
} from '../src/index.js'
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
  reliabilityEnabled: true,
  createdAt: '2026-01-01T00:00:00Z',
})

const aTask = (name: string, projectId: string, state: TaskState = 'draft'): Task => ({
  id: `task-${name.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')}`,
  name,
  description: 'Tasks should be able to have a due date.',
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
  /** What a tool's own schema said about an input, before anything was sent. */
  let parsed: ReturnType<McpTool['parse']>
  let failure: ToolError | undefined
  let tasks: Task[]

  /** What was sent with a request, so a scenario can assert the ask not the answer. */
  const sentTo = (asked: string): unknown =>
    factory.bodies.get(asked)

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
      failure = undefined
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
      And('it says what the work is for', () =>
        expect(answer.description).toBe('Tasks should be able to have a due date.'),
      )
    })

    RuleScenario('A task an agent asked for says which run asked', ({ Given, When, Then, And }) => {
      Given('a task "Add due dates" that a run asked for', () => {
        const task = {
          ...aTask('Add due dates', 'project-1'),
          createdBy: 'mcp:a-client/1.0',
          createdByRunId: 'run-1',
        }
        tasks.push(task)
        detail(task, ['queue'])
        publishTasks()
      })
      When('the agent reads that task', () => call('factory_task_get', { task: 'task-add-due-dates' }))
      Then('it says which run asked for it', () => expect(answer.createdByRun).toBe('run-1'))
      And('it says what that client called itself', () =>
        expect(answer.createdBy).toBe('mcp:a-client/1.0'),
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
    const printing = (count: number, dropped = 0, steps = [1]): void => {
      factory.answer('/api/runs/run-1', {
        run: {
          id: 'run-1',
          workflow: 'development',
          state: 'completed',
          attempt: 1,
          workflowIndex: 0,
          depth: 0,
          startedAt: '2026-01-01T00:00:00Z',
        },
        steps: steps.map((id) => ({
          id,
          runId: 'run-1',
          phase: `phase-${id}`,
          index: id - 1,
          describe: `step ${id}`,
          uses: 'shell',
          state: 'completed',
          attempts: 1,
          startedAt: '2026-01-01T00:00:00Z',
        })),
        evidence: [],
      })
      // The run's own log: what the engine wrote, which is usually nothing.
      factory.answer('/api/runs/run-1/logs', { lines: [], dropped })
      for (const id of steps) {
        factory.answer(`/api/runs/run-1/logs?step=${id}`, {
          lines: Array.from({ length: count }, (_value, index) => ({
            at: '2026-01-01T00:00:00Z',
            stream: 'stdout',
            text: `step ${id} line ${index}`,
          })),
          dropped: 0,
        })
      }
    }
    const texts = () => (answer.lines as { text: string }[]).map((line) => line.text)

    RuleScenario('The output of every step is gathered, and each line says which', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given('a run with two steps that each printed something', () => printing(1, 0, [1, 2]))
      When("the agent reads that run's logs", () => call('factory_run_logs', { run: 'run-1' }))
      Then("both steps' output comes back", () =>
        expect(texts()).toEqual(['step 1 line 0', 'step 2 line 0']),
      )
      And('each line says which step printed it', () =>
        expect((answer.lines as { step?: number }[]).map((line) => line.step)).toEqual([1, 2]),
      )
    })

    RuleScenario('Only the tail comes back', ({ Given, When, Then, And }) => {
      Given('a run whose step printed 500 lines', () => printing(500))
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
      Given('a run whose log Factory had to trim by 2048 bytes', () => printing(10, 2048))
      When("the agent reads that run's logs", () => call('factory_run_logs', { run: 'run-1' }))
      Then('it says Factory dropped something', () => {
        expect(answer.droppedByFactory).toBe(2048)
        expect(answer.older).toBe(0)
      })
    })

    RuleScenario("One step's output can be asked for on its own", ({ Given, When, Then, And }) => {
      Given('a run whose step printed 500 lines', () => printing(500))
      When('the agent reads the logs of step 3', () =>
        call('factory_run_logs', { run: 'run-1', step: 3 }).catch(() => undefined),
      )
      Then('Factory was asked for step 3 only', () =>
        expect(factory.asked).toContain('GET /api/runs/run-1/logs?step=3'),
      )
      // The run detail is not read at all: one step was named, so there are no
      // other steps to walk.
      And('nothing else was asked for', () =>
        expect(factory.asked).toEqual(['GET /api/runs/run-1/logs?step=3']),
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
  Rule('creating a task starts nothing', ({ RuleScenario }) => {
    RuleScenario('A task lands in the project the agent is working in', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given('the agent is working in "factory"', () => {
        factory.answer('/api/tasks', {
          task: aTask('Add due dates', 'project-1'),
          actions: [{ action: 'queue', label: 'Queue', to: 'queued' }],
        })
      })
      When('the agent creates the task "Add due dates" with the workflow "development"', () =>
        call('factory_task_create', {
          name: 'Add due dates',
          workflows: ['development'],
        }),
      )
      Then('Factory was told to put it in "factory"', () =>
        expect(sentTo('POST /api/tasks')).toMatchObject({ projectId: 'project-1' }),
      )
      And('Factory was told to run "development"', () =>
        expect(sentTo('POST /api/tasks')).toMatchObject({ workflows: ['development'] }),
      )
      And('the agent is told to queue it when the plan is right', () =>
        expect(answer.next).toContain('Queue it'),
      )
    })
  })

  Rule('queueing is what starts work, and cancelling is what stops it', ({ RuleScenario }) => {
    const queueable = (): void => {
      const task = aTask('Add due dates', 'project-1')
      factory.answer(`/api/tasks/${task.id}/actions/queue`, {
        task: { ...task, state: 'queued' },
        actions: [{ action: 'cancel', label: 'Cancel', to: 'cancelled' }],
      })
    }
    const queue = () =>
      call('factory_task_act', { task: 'task-add-due-dates', action: 'queue' }).catch(
        (error: unknown) => {
          failure = error as ToolError
        },
      )

    RuleScenario('There is no tool to start a run, and none to cancel one', ({ Then, And }) => {
      const names = factoryTools.map((tool) => tool.name)
      Then('no tool is called "factory_run_start"', () =>
        expect(names).not.toContain('factory_run_start'),
      )
      And('no tool is called "factory_run_cancel"', () =>
        expect(names).not.toContain('factory_run_cancel'),
      )
    })

    RuleScenario('Queueing asks for the action by name', ({ Given, When, Then }) => {
      Given('a task "Add due dates" that can be queued', queueable)
      When('the agent queues it', queue)
      Then('Factory was asked to queue that task', () =>
        expect(factory.asked).toContain('POST /api/tasks/task-add-due-dates/actions/queue'),
      )
    })

    RuleScenario('Queueing before anybody accepted the disclaimer carries the disclaimer', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given('Factory has not been told what an agent run can reach', () => {
        factory.answer('/api/tasks/task-add-due-dates/actions/queue', {
          status: 409,
          message: 'Nobody has accepted what an agent run can reach.',
          // The real one, imported rather than invented: it is a document, not
          // a sentence, and a fixture that made it a string is how a scenario
          // came to pass while the refusal an agent actually saw said nothing.
          body: { disclaimer: DISCLAIMER },
        })
      })
      When('the agent queues a task', queue)
      Then('it is refused as NOT_ACCEPTED', () => expect(failure?.code).toBe('NOT_ACCEPTED'))
      And('the refusal carries the disclaimer', () =>
        expect(failure?.details.disclaimer).toEqual(DISCLAIMER),
      )
      And('it says a person has to accept it', () =>
        expect(String(failure?.details.accept)).toContain('factory accept'),
      )
    })

    RuleScenario('An action the task does not offer comes back with the ones it does', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given('a task that cannot be queued because it is already running', () => {
        factory.answer('/api/tasks/task-add-due-dates/actions/queue', {
          status: 409,
          message: 'Cannot queue a task that is running.',
          body: { state: 'running', actions: [{ action: 'cancel', label: 'Cancel' }] },
        })
      })
      When('the agent queues it', queue)
      Then('it is refused as ACTION_NOT_AVAILABLE', () =>
        expect(failure?.code).toBe('ACTION_NOT_AVAILABLE'),
      )
      And('the refusal lists the actions it does offer', () =>
        expect(failure?.details.actions).toEqual([{ action: 'cancel', label: 'Cancel' }]),
      )
    })
  })

  Rule('an agent can say one task waits for another', ({ RuleScenario }) => {
    const waiting = (): void => {
      const task = aTask('Ship it', 'project-1')
      const reply = {
        task: { ...task, dependsOn: ['task-groundwork'] },
        actions: [{ action: 'queue', label: 'Queue', to: 'queued' }],
        blockers: [],
      }
      factory.answer(`/api/tasks/${task.id}/dependencies`, reply)
      factory.answer(`/api/tasks/${task.id}/dependencies/task-groundwork`, reply)
    }
    const depend = (remove?: boolean) =>
      call('factory_task_depends_on', {
        task: 'task-ship-it',
        dependsOn: 'task-groundwork',
        ...(remove === undefined ? {} : { remove }),
      }).catch((error: unknown) => {
        failure = error as ToolError
      })

    RuleScenario('A task is made to wait for another', ({ Given, When, Then }) => {
      Given('a task "Ship it" that can be queued', waiting)
      When('the agent makes "Ship it" wait for "task-groundwork"', () => depend())
      Then('Factory was asked to make it wait for "task-groundwork"', () => {
        expect(factory.asked).toContain('POST /api/tasks/task-ship-it/dependencies')
        expect(sentTo('POST /api/tasks/task-ship-it/dependencies')).toMatchObject({
          dependsOn: 'task-groundwork',
        })
      })
    })

    RuleScenario('The waiting can be taken back off', ({ Given, When, Then }) => {
      Given('a task "Ship it" that can be queued', waiting)
      When('the agent stops "Ship it" waiting for "task-groundwork"', () => depend(true))
      Then('Factory was asked to remove that dependency', () =>
        expect(factory.asked).toContain(
          'DELETE /api/tasks/task-ship-it/dependencies/task-groundwork',
        ),
      )
    })

    RuleScenario('A ring comes back in the store\'s own words', ({ Given, And, When, Then }) => {
      Given('a task "Ship it" that can be queued', waiting)
      And('Factory refuses the dependency as "Groundwork already waits for Ship it."', () => {
        factory.answer('/api/tasks/task-ship-it/dependencies', {
          status: 400,
          message: 'Groundwork already waits for Ship it.',
        })
      })
      When('the agent makes "Ship it" wait for "task-groundwork"', () => depend())
      Then('the refusal says "Groundwork already waits for Ship it."', () =>
        expect(failure?.message).toContain('Groundwork already waits for Ship it.'),
      )
    })
  })

  Rule('a workflow is copied rather than assembled', ({ RuleScenario }) => {
    const original = (): void => {
      factory.answer('/api/workflows/development?project=project-1', {
        definition: {
          kind: 'factory.workflow/v1',
          name: 'development',
          description: 'Build it',
          mode: 'once',
          scheduling: 'sequential',
          phases: ['work', 'verify'],
          needs: ['analysis'],
          variables: {},
          extensions: {},
        },
        ref: { scope: 'project', file: '/repos/factory/.xaedalon/.factory/workflows/development.workflow.yaml' },
        problems: [],
      })
      factory.answer('/api/workflows?project=project-1', {
        ref: { scope: 'project', file: '/repos/factory/.xaedalon/.factory/workflows/development-fast.workflow.yaml' },
        problems: [],
      })
    }
    const copy = () =>
      call('factory_workflow_create', { name: 'development-fast', from: 'development' })
    const written = () => sentTo('POST /api/workflows?project=project-1') as {
      definition: { needs?: string[]; phases?: string[]; name?: string }
      scope?: string
    }

    RuleScenario('Copying keeps everything the original had', ({ Given, When, Then, And }) => {
      Given('the project has a workflow "development" that needs "analysis"', original)
      When('the agent copies it as "development-fast"', copy)
      Then('Factory was asked to write "development-fast"', () =>
        expect(written().definition.name).toBe('development-fast'),
      )
      // The fields nobody thought to ask about are the reason to copy at all.
      And('what was written still needs "analysis"', () =>
        expect(written().definition.needs).toEqual(['analysis']),
      )
    })

    RuleScenario('A workflow with no phases and nothing to copy is refused', ({
      When,
      Then,
      And,
    }) => {
      When('the agent writes a workflow with no phases', () =>
        call('factory_workflow_create', { name: 'empty' }).catch((error: unknown) => {
          failure = error as ToolError
        }),
      )
      Then('it is refused', () => expect(failure).toBeDefined())
      And('nothing was written', () =>
        expect(factory.asked.some((asked) => asked.startsWith('POST /api/workflows'))).toBe(false),
      )
    })

    RuleScenario("It goes into the project unless somebody says otherwise", ({
      Given,
      When,
      Then,
    }) => {
      Given('the project has a workflow "development" that needs "analysis"', original)
      When('the agent copies it as "development-fast"', copy)
      Then("it was written into the project's own scope", () =>
        expect(written().scope).toBe('project'),
      )
    })

    /**
     * The write route's answer, which is a `WriteOutcome`.
     *
     * The file is at the top level; `ref` is what the *read* route returns.
     * The stub used to answer in the read route's shape, which is why the
     * reply reading `written.ref.file` looked right and was always undefined.
     */
    const writeRoute = (): void => {
      factory.answer('/api/workflows?project=project-1', {
        status: 'created',
        file: '/repos/factory/.xaedalon/.factory/workflows/design.workflow.yaml',
        etag: 'abc',
      })
    }

    RuleScenario('A workflow can say what it needs when it is written', ({ When, Then }) => {
      When('the agent writes a workflow "design" that needs "analysis"', async () => {
        writeRoute()
        await call('factory_workflow_create', {
          name: 'design',
          phases: ['think'],
          needs: ['analysis'],
        })
      })
      Then('what was written needs "analysis"', () =>
        expect(written().definition.needs).toEqual(['analysis']),
      )
    })

    RuleScenario('What a copy needs beats what the original needed', ({ Given, When, Then }) => {
      Given('the project has a workflow "development" that needs "analysis"', original)
      When('the agent copies it as "development-fast" needing "design"', () =>
        call('factory_workflow_create', {
          name: 'development-fast',
          from: 'development',
          needs: ['design'],
        }),
      )
      Then('what was written needs "design"', () =>
        expect(written().definition.needs).toEqual(['design']),
      )
    })

    RuleScenario('The reply says where the workflow landed', ({ When, Then }) => {
      When('the agent writes a workflow "design" that needs "analysis"', async () => {
        writeRoute()
        await call('factory_workflow_create', {
          name: 'design',
          phases: ['think'],
          needs: ['analysis'],
        })
      })
      Then('the reply names the file it wrote', () =>
        expect(answer.file).toBe(
          '/repos/factory/.xaedalon/.factory/workflows/design.workflow.yaml',
        ),
      )
    })
  })
  Rule("approving is a person's, and the surface says so by not offering it", ({
    RuleScenario,
  }) => {
    const may = (action: string) => () => expect(AGENT_ACTIONS).toContain(action)
    const mayNot = (action: string) => () => expect(AGENT_ACTIONS).not.toContain(action)

    RuleScenario('The action list does not include approving', ({ Then, And }) => {
      Then('an agent may not ask to "approve"', mayNot('approve'))
      And('an agent may not ask to "reject"', mayNot('reject'))
    })

    RuleScenario('Everything else a person can ask for is offered', ({ Then, And }) => {
      Then('an agent may ask to "queue"', may('queue'))
      And('an agent may ask to "cancel"', may('cancel'))
      And('an agent may ask to "mark_done"', may('mark_done'))
    })
  })
  Rule('a refusal says which refusal it is', ({ RuleScenario }) => {
    RuleScenario('A coded refusal carries its code, not its sentence twice', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given('a Factory that refuses with RECURSION_LIMIT', () => {
        factory.answer('/api/tasks', {
          status: 409,
          message: 'This would be 4 levels of work starting work.',
          // Exactly what the route sends, `error` key and all — which is the
          // key that used to win the spread.
          body: {
            error: 'This would be 4 levels of work starting work.',
            code: 'RECURSION_LIMIT',
          },
        })
      })
      When('the agent creates a task', () =>
        call('factory_task_create', { name: 'Too deep' }).catch((error: unknown) => {
          failure = error as ToolError
        }),
      )
      Then('it is refused as RECURSION_LIMIT', () =>
        expect(failure?.code).toBe('RECURSION_LIMIT'),
      )
      And('the refusal does not repeat the sentence in place of the code', () => {
        expect(failure?.details.error).toBeUndefined()
        expect(failure?.details.code).toBeUndefined()
      })
    })

    RuleScenario('Every refusal the orchestration rules can make is recognised', ({
      Then,
      And,
    }) => {
      const known = (code: string) => () =>
        expect(TOOL_ERROR_CODES as readonly string[]).toContain(code)
      Then('"RECURSION_LIMIT" is a code this surface knows', known('RECURSION_LIMIT'))
      And('"FAN_OUT_LIMIT" is a code this surface knows', known('FAN_OUT_LIMIT'))
      And(
        '"SELF_ORCHESTRATION_BLOCKED" is a code this surface knows',
        known('SELF_ORCHESTRATION_BLOCKED'),
      )
      And('"APPROVAL_SEPARATION" is a code this surface knows', known('APPROVAL_SEPARATION'))
    })
  })

  Rule('an agent can ask what it is allowed to work on next', ({ RuleScenario }) => {
    const summary = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
      state: 'assessed',
      score: 88,
      rawScore: 88,
      coverage: 70,
      delta: -2,
      dimensions: { design: 90 },
      caps: [],
      attention: { agent: 2, developer: 1, either: 0, external: 0, potential: {} },
      ...over,
    })
    const judged = (reliability: Record<string, unknown>) => (): void => {
      factory.answer('/api/tasks/task-add-due-dates/reliability', { reliability })
    }
    const ask = () => call('factory_reliability_get', { task: 'task-add-due-dates' })

    RuleScenario('A task nobody has judged says so rather than scoring zero', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given('a task nobody has judged', judged({ state: 'unassessed', attention: { agent: 0, developer: 0, either: 0, external: 0, potential: {} } }))
      When('the agent asks how reliable it is', ask)
      Then('it comes back "unassessed"', () => expect(answer['state']).toBe('unassessed'))
      And('it carries no score', () => expect(answer['score']).toBeUndefined())
      And('it says how to get one', () => expect(String(answer['next'])).toContain('assess'))
    })

    RuleScenario('A judged task comes back with what is waiting for whom', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given('a task judged at 88 with two agent drivers and one for a developer', judged(summary()))
      When('the agent asks how reliable it is', ask)
      Then('the score is 88', () => expect(answer['score']).toBe(88))
      And("it says 2 are the agent's", () =>
        expect((answer['needsAttention'] as { agent: number }).agent).toBe(2),
      )
      And('it says 1 needs a developer', () =>
        expect((answer['needsAttention'] as { developer: number }).developer).toBe(1),
      )
    })

    RuleScenario('The reply says to ask what to do next', ({ Given, When, Then }) => {
      Given('a task judged at 88 with two agent drivers and one for a developer', judged(summary()))
      When('the agent asks how reliable it is', ask)
      Then('it points at the next actions', () =>
        expect(String(answer['next'])).toContain('factory_reliability_next_actions'),
      )
    })

    RuleScenario('Nothing outstanding says so plainly', ({ Given, When, Then }) => {
      Given('a task judged at 98 with nothing outstanding', judged(
        summary({ score: 98, attention: { agent: 0, developer: 0, either: 0, external: 0, potential: {} } }),
      ))
      When('the agent asks how reliable it is', ask)
      Then('it says nothing is outstanding', () =>
        expect(String(answer['next'])).toContain('Nothing is outstanding'),
      )
    })
  })

  Rule('an agent may say a finding stopped being true, not that it does not matter', ({
    RuleScenario,
  }) => {
    const driver = {
      id: 'driver-1',
      title: 'checkout regression',
      description: '',
      type: 'regression',
      severity: 'high',
      status: 'resolved',
      owner: 'agent',
      dimension: 'regressionSafety',
      scoreImpact: -3,
    }
    const willAnswer = (action: string) => (): void => {
      factory.answer(`/api/tasks/task-add-due-dates/reliability/drivers/driver-1/${action}`, {
        driver,
        reliability: {
          state: 'assessed',
          score: 91,
          rawScore: 91,
          coverage: 70,
          attention: { agent: 0, developer: 0, either: 0, external: 0, potential: {} },
        },
      })
    }
    const sentWith = (action: string): { initiator?: unknown } =>
      sentTo(
        `POST /api/tasks/task-add-due-dates/reliability/drivers/driver-1/${action}`,
      ) as { initiator?: unknown }

    /**
     * Called as an agent Factory launched, which is the case that matters.
     *
     * The initiator is not self-reported: it comes from the environment Factory
     * stamped into the process. This drives the tool with one, because a tool
     * that dropped it would leave the daemon unable to tell an agent from a
     * person — and the refusal depends entirely on that.
     */
    const asAgent = async (name: string, input: Record<string, unknown>): Promise<void> => {
      const tool = factoryTools.find((candidate) => candidate.name === name) as McpTool
      const value = tool.parse(input)
      if ('problems' in value) throw new Error(value.problems.join('; '))
      await tool.run(value.value, {
        api: factory,
        cwd: CWD,
        env: {},
        initiator: { label: 'claude', runId: 'run-1', taskId: 'task-1' },
      })
    }

    RuleScenario('Resolving carries the run the agent is inside', ({ Given, When, Then }) => {
      Given('a task with a driver', willAnswer('resolve'))
      When('the agent resolves it', () =>
        asAgent('factory_reliability_resolve_driver', {
          task: 'task-add-due-dates',
          driver: 'driver-1',
        }),
      )
      Then('the daemon was told which run asked', () =>
        expect(sentWith('resolve').initiator).toBeDefined(),
      )
    })

    RuleScenario('Accepting carries it too, so the daemon can refuse', ({
      Given,
      When,
      Then,
    }) => {
      Given('a task with a driver', willAnswer('accept'))
      When('the agent accepts it', () =>
        asAgent('factory_reliability_accept_driver', {
          task: 'task-add-due-dates',
          driver: 'driver-1',
          reason: 'out of support',
        }),
      )
      Then('the daemon was told which run asked', () =>
        expect(sentWith('accept').initiator).toBeDefined(),
      )
    })

    RuleScenario('Accepting demands a reason', ({ When, Then }) => {
      When('the agent tries to accept a driver without a reason', () => {
        const tool = factoryTools.find(
          (candidate) => candidate.name === 'factory_reliability_accept_driver',
        ) as McpTool
        parsed = tool.parse({ task: 'task-add-due-dates', driver: 'driver-1' })
      })
      // Refused by the schema, before anything is sent — the cheapest possible
      // place for it and the one an agent cannot talk its way past.
      Then('the call is refused before it is sent', () => expect('problems' in parsed).toBe(true))
    })
  })

  Rule('no tool sets a score', ({ RuleScenario }) => {
    RuleScenario('There is no tool that sets a score', ({ Then, And }) => {
      // Not "it refuses" — a tool that does not exist is a stronger guarantee
      // than one that says no, and this is the rule the whole subsystem turns
      // on.
      Then('no tool is named "factory_reliability_set"', () =>
        expect(factoryTools.map((tool) => tool.name)).not.toContain('factory_reliability_set'),
      )
      And('no tool takes a score', () => {
        for (const tool of factoryTools) {
          const schema = JSON.stringify(tool.inputSchema)
          expect(schema, tool.name).not.toContain('"score"')
        }
      })
    })

    RuleScenario('The reliability tools are read-first', ({ Then }) => {
      Then('4 of the reliability tools only read', () => {
        const reliability = factoryTools.filter((tool) =>
          tool.name.startsWith('factory_reliability_'),
        )
        const reads = reliability.filter(
          (tool) => !tool.name.includes('resolve') && !tool.name.includes('accept'),
        )
        expect(reads).toHaveLength(4)
      })
    })
  })
})

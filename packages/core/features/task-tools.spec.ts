import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { EventBus } from '@factory/events'
import { CapabilityHost } from '../src/host.js'
import { TERMINAL_KIND, type TerminalCapability } from '../src/terminal.js'
import {
  TASK_TOOL_KIND,
  taskToolOffers,
  type TaskToolCapability,
  type TaskToolContext,
  type TaskToolOffer,
  type TaskToolView,
} from '../src/tools.js'
import type { Project, TaskWorkspace } from '../src/task/project.js'
import type { Task } from '../src/task/state.js'

const feature = await loadFeature(fileURLToPath(new URL('./task-tools.feature', import.meta.url)))

const PROJECT: Project = {
  id: 'p-1',
  name: 'todolist',
  path: '/repos/todolist',
  defaultBranch: 'main',
  worktreesRoot: '/worktrees/todolist',
  isRepository: true,
  usesWorktrees: false,
  usesEnvironments: false,
  grantedDirectories: [],
  createdAt: '2026-01-01T00:00:00.000Z',
}

const TASK: Task = {
  id: 't-1',
  name: 'Add due dates',
  description: '',
  projectId: 'project-1',
  state: 'done',
  workflows: [],
  flags: [],
  dependsOn: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

describeFeature(feature, ({ Background, Rule, BeforeEachScenario }) => {
  let host: CapabilityHost
  let workspace: TaskWorkspace | undefined
  let views: readonly TaskToolView[]
  /** Plugin names switched off, as the host knows them. */
  let switchedOff: Set<string>
  /** One plugin per tool, so "switch the plugin off" is expressible. */
  let registered = 0

  BeforeEachScenario(() => {
    workspace = { path: '/repos/todolist', inWorktree: false, project: PROJECT }
    views = []
    switchedOff = new Set()
    registered = 0
  })

  Background(({ Given }) => {
    Given('a host with no terminal capability', () => {
      host = new CapabilityHost({ events: new EventBus({ onSubscriberError: () => {} }) })
    })
  })

  /**
   * Each tool arrives in its own plugin.
   *
   * Not for realism — for the switch: "disabled" names a plugin, so a scenario
   * about switching one off needs more than one plugin to switch between.
   */
  const provide = async (tool: TaskToolCapability): Promise<string> => {
    const name = `plugin-${(registered += 1)}`
    await host.load({
      name,
      version: '1.0.0',
      register: (context) => {
        context.provide(TASK_TOOL_KIND, tool)
      },
    })
    return name
  }

  /**
   * The same, returning nothing.
   *
   * A step callback is typed `void`, and a concise arrow handing back the
   * plugin name makes every `Given(..., () => give(...))` a step that
   * returns a string where the runner expects none — it runs, and the spec
   * typecheck rejects it.
   */
  const give = async (capability: TaskToolCapability): Promise<void> => {
    await provide(capability)
  }

  const tool = (
    id: string,
    offer: TaskToolCapability['offer'],
    extra: Partial<TaskToolCapability> = {},
  ): TaskToolCapability => ({ id, offer, ...extra })

  const gather = async (deadlineMs?: number): Promise<void> => {
    const context: TaskToolContext = {
      task: TASK,
      ...(workspace === undefined ? {} : { workspace }),
      host,
      env: {},
    }
    views = await taskToolOffers({
      context,
      disabledPlugins: switchedOff,
      ...(deadlineMs === undefined ? {} : { deadlineMs }),
    })
  }

  const view = (id: string): TaskToolView | undefined => views.find((entry) => entry.id === id)
  const ids = () => views.map((entry) => entry.id).join(', ')
  const plain = (): TaskToolOffer => ({})

  Rule('a tool is offered in the order it asked for', ({ RuleScenario }) => {
    RuleScenario('Lower order lists first', ({ Given, And, When, Then }) => {
      Given('a tool "second" with order 20', () =>
        give(tool('second', plain, { order: 20 })),
      )
      And('a tool "first" with order 10', () => give(tool('first', plain, { order: 10 })))
      When('the tools for a task are gathered', () => gather())
      Then('the tools are "first, second"', () => expect(ids()).toBe('first, second'))
    })

    RuleScenario('A tool with no order lands after the ones that named one', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('a tool "built-in" with order 10', () =>
        give(tool('built-in', plain, { order: 10 })),
      )
      // The default is 100, so a third party lands after the built-ins without
      // having to know what they chose.
      And('a tool "third-party" with no order', () => give(tool('third-party', plain)))
      When('the tools for a task are gathered', () => gather())
      Then('the tools are "built-in, third-party"', () =>
        expect(ids()).toBe('built-in, third-party'),
      )
    })

    RuleScenario('Tools with the same order keep the order they registered in', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('a tool "alpha" with order 10', () => give(tool('alpha', plain, { order: 10 })))
      And('a tool "beta" with order 10', () => give(tool('beta', plain, { order: 10 })))
      When('the tools for a task are gathered', () => gather())
      Then('the tools are "alpha, beta"', () => expect(ids()).toBe('alpha, beta'))
    })
  })

  Rule('unavailable is a reason, not a disappearance', ({ RuleScenario }) => {
    RuleScenario('A tool that cannot be used is still offered, with its reason', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given('a tool "diffity" that is unavailable because "diffity is not installed"', () =>
        give(tool('diffity', () => ({ unavailable: 'diffity is not installed' }))),
      )
      When('the tools for a task are gathered', () => gather())
      Then('"diffity" is offered', () => expect(view('diffity')).toBeDefined())
      And('"diffity" says it is unavailable because "diffity is not installed"', () =>
        expect(view('diffity')?.unavailable).toBe('diffity is not installed'),
      )
    })

    RuleScenario('A tool that does not apply to this task is not offered at all', ({
      Given,
      When,
      Then,
    }) => {
      Given('a tool "jira" that offers nothing for this task', () =>
        give(tool('jira', () => undefined)),
      )
      When('the tools for a task are gathered', () => gather())
      Then('there are no tools', () => expect(views).toEqual([]))
    })

    RuleScenario('A tool from a plugin that is switched off is not offered', ({
      Given,
      And,
      When,
      Then,
    }) => {
      let name = ''
      Given('a tool "diffity" that opens a diff', async () => {
        name = await provide(tool('diffity', () => ({ command: { command: 'diffity', args: [] } })))
      })
      And('the plugin that provided it is switched off', () => {
        switchedOff.add(name)
      })
      When('the tools for a task are gathered', () => gather())
      Then('there are no tools', () => expect(views).toEqual([]))
    })
  })

  Rule('what you copy is what the host would run', ({ RuleScenario }) => {
    const wouldRun = (id: string, line: string) => () => expect(view(id)?.command).toBe(line)

    RuleScenario('A tool with no command is a shell in the workspace', ({
      Given,
      When,
      Then,
    }) => {
      Given('a tool "open-terminal" with no command', () => give(tool('open-terminal', plain)))
      When('the tools for a task are gathered', () => gather())
      Then('"open-terminal" would run "cd /repos/todolist"', wouldRun('open-terminal', 'cd /repos/todolist'))
    })

    RuleScenario('A tool with a command appends it', ({ Given, When, Then }) => {
      Given('a tool "open-session" that runs "claude --resume abc"', () =>
        give(
          tool('open-session', () => ({
            command: { command: 'claude', args: ['--resume', 'abc'] },
          })),
        ),
      )
      When('the tools for a task are gathered', () => gather())
      Then(
        '"open-session" would run "cd /repos/todolist && claude --resume abc"',
        wouldRun('open-session', 'cd /repos/todolist && claude --resume abc'),
      )
    })

    RuleScenario('A workspace path with a space is quoted, not interpolated', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('the task\'s workspace is "/repos/my work"', () => {
        workspace = { path: '/repos/my work', inWorktree: false, project: PROJECT }
      })
      And('a tool "open-terminal" with no command', () => give(tool('open-terminal', plain)))
      When('the tools for a task are gathered', () => gather())
      Then(`"open-terminal" would run "cd '/repos/my work'"`, () =>
        expect(view('open-terminal')?.command).toBe(`cd '/repos/my work'`),
      )
    })

    RuleScenario('A tool on a task whose project is missing says no directory', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given("the task's project is not in the database", () => {
        workspace = undefined
      })
      And('a tool "jira" that runs "open https://example.test"', () =>
        give(
          tool('jira', () => ({ command: { command: 'open', args: ['https://example.test'] } }), {
            run: 'detached',
          }),
        ),
      )
      When('the tools for a task are gathered', () => gather())
      Then(
        '"jira" would run "open https://example.test"',
        wouldRun('jira', 'open https://example.test'),
      )
    })
  })

  Rule('whether it can be performed is served, not guessed', ({ RuleScenario }) => {
    const givenTerminal = () =>
      host.load({
        name: 'stub-terminal',
        version: '1.0.0',
        register: (context) => {
          context.provide(TERMINAL_KIND, {
            id: 'stub',
            open: async () => ({ opened: true, command: '' }),
          } satisfies TerminalCapability)
        },
      })

    RuleScenario('With nothing able to open a terminal, a terminal tool is not runnable', ({
      Given,
      When,
      Then,
    }) => {
      Given('a tool "open-terminal" with no command', () => give(tool('open-terminal', plain)))
      When('the tools for a task are gathered', () => gather())
      Then('"open-terminal" is not runnable', () =>
        expect(view('open-terminal')?.runnable).toBe(false),
      )
    })

    RuleScenario('With something able to open one, it is', ({ Given, And, When, Then }) => {
      Given('something that can open a terminal is installed', givenTerminal)
      And('a tool "open-terminal" with no command', () => give(tool('open-terminal', plain)))
      When('the tools for a task are gathered', () => gather())
      Then('"open-terminal" is runnable', () =>
        expect(view('open-terminal')?.runnable).toBe(true),
      )
    })

    RuleScenario('A detached tool is runnable either way', ({ Given, When, Then }) => {
      Given('a tool "diffity" that runs "diffity main" detached', () =>
        give(
          tool('diffity', () => ({ command: { command: 'diffity', args: ['main'] } }), {
            run: 'detached',
          }),
        ),
      )
      When('the tools for a task are gathered', () => gather())
      Then('"diffity" is runnable', () => expect(view('diffity')?.runnable).toBe(true))
    })
  })

  Rule('one misbehaving plugin does not take the page down', ({ RuleScenario }) => {
    RuleScenario('A tool that throws is reported as unavailable', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('a tool "broken" that throws when asked', () =>
        give(
          tool('broken', () => {
            throw new Error('no idea')
          }),
        ),
      )
      And('a tool "fine" with no command', () => give(tool('fine', plain)))
      When('the tools for a task are gathered', () => gather())
      Then('"broken" says it is unavailable', () =>
        expect(view('broken')?.unavailable).toContain('no idea'),
      )
      And('"fine" is offered', () => expect(view('fine')).toBeDefined())
    })

    RuleScenario('A tool that never answers is given a deadline', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('a tool "slow" that never answers', () =>
        give(tool('slow', () => new Promise<TaskToolOffer>(() => {}))),
      )
      And('a tool "fine" with no command', () => give(tool('fine', plain)))
      When('the tools for a task are gathered with a 50ms deadline', () => gather(50))
      Then('"slow" says it is unavailable', () =>
        expect(view('slow')?.unavailable).toContain('did not answer'),
      )
      And('"fine" is offered', () => expect(view('fine')).toBeDefined())
    })
  })

  Rule('the label is the one a capability already has', ({ RuleScenario }) => {
    RuleScenario('displayName is the button', ({ Given, When, Then }) => {
      Given('a tool "diffity" whose display name is "Diffity"', () =>
        give(tool('diffity', plain, { displayName: 'Diffity' })),
      )
      When('the tools for a task are gathered', () => gather())
      Then('"diffity" is labelled "Diffity"', () => expect(view('diffity')?.label).toBe('Diffity'))
    })

    RuleScenario('With no display name the id is the label', ({ Given, When, Then }) => {
      Given('a tool "open-terminal" with no command', () => give(tool('open-terminal', plain)))
      When('the tools for a task are gathered', () => gather())
      Then('"open-terminal" is labelled "open-terminal"', () =>
        expect(view('open-terminal')?.label).toBe('open-terminal'),
      )
    })
  })
})

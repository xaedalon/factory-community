import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CapabilityHost,
  EventBus,
  checkPluginConformance,
  terminalCommand,
  type ConformanceReport,
  type FactoryPlugin,
  type Project,
  type Task,
  type TaskToolCapability,
  type TaskToolContext,
  type TaskToolOffer,
  type TaskWorkspace,
} from '@factory/plugin-sdk'
import claudeProvider from '@factory/provider-claude'
import codexProvider from '@factory/provider-codex'
import terminalPlugin, { openTerminalTool } from '../src/index.js'
import sessionPlugin, { NO_SESSION_YET, openSessionTool } from '@factory/task-session'
import diffityPlugin, { diffityTool } from '@factory/task-diffity'

const feature = await loadFeature(
  fileURLToPath(new URL('./task-tools.feature', import.meta.url)),
)

const PLUGINS: Record<string, FactoryPlugin> = {
  'task-terminal': terminalPlugin,
  'task-session': sessionPlugin,
  'task-diffity': diffityPlugin,
}
const TOOLS: Record<string, TaskToolCapability> = {
  'open-terminal': openTerminalTool,
  'open-session': openSessionTool,
  diffity: diffityTool,
}

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

describeFeature(feature, ({ Background, Rule, Scenario, ScenarioOutline, BeforeEachScenario, AfterEachScenario }) => {
  let host: CapabilityHost
  let root = ''
  let task: Task
  let project: Project
  let workspace: TaskWorkspace | undefined
  let env: Record<string, string | undefined>
  let extraDirectories: string[]
  let offer: TaskToolOffer | undefined
  let report: ConformanceReport

  BeforeEachScenario(() => {
    root = mkdtempSync(join(tmpdir(), 'factory-task-tools-'))
    task = TASK
    project = PROJECT
    workspace = { path: '/repos/todolist', inWorktree: false, project: PROJECT }
    // Empty, so what is installed on the machine running this cannot decide
    // whether a scenario passes.
    env = { PATH: '' }
    extraDirectories = []
    offer = undefined
  })
  AfterEachScenario(() => rmSync(root, { recursive: true, force: true }))

  /** A real executable on disk, because availability genuinely checks. */
  const install = (command: string, where: string): string => {
    const real = join(root, where.replaceAll('/', '_'))
    mkdirSync(real, { recursive: true })
    const file = join(real, command)
    writeFileSync(file, '#!/bin/sh\n')
    chmodSync(file, 0o755)
    return real
  }

  const ask = (id: string) => async () => {
    if (workspace !== undefined) workspace = { ...workspace, project }
    const context: TaskToolContext = {
      task,
      ...(workspace === undefined ? {} : { workspace }),
      host,
      env,
      ...(extraDirectories.length === 0 ? {} : { extraDirectories }),
    }
    offer = await TOOLS[id]?.offer(context)
  }
  const wouldRun = (line: string) => () =>
    expect(terminalCommand({ cwd: workspace?.path ?? '', ...(offer?.command === undefined ? {} : { command: offer.command }) }))
      .toBe(`cd ${workspace?.path ?? ''} && ${line}`)
  const reasonSays = (needle: string) => () => expect(offer?.unavailable).toContain(needle)

  Background(({ Given }) => {
    Given('the claude provider is installed', async () => {
      host = new CapabilityHost({ events: new EventBus({ onSubscriberError: () => {} }) })
      await host.load(claudeProvider)
    })
  })

  ScenarioOutline('Every one of them passes the same conformance suite', ({ When, Then, And }, variables) => {
    When('conformance is checked for "<plugin>"', async () => {
      report = await checkPluginConformance(PLUGINS[variables.plugin] as FactoryPlugin)
    })
    Then('the plugin conforms', () =>
      expect(
        report.passed,
        report.checks.filter((check) => !check.passed).map((check) => check.name).join(', '),
      ).toBe(true),
    )
    And('it provides "<capability>"', () =>
      expect(report.provides).toContain(variables.capability),
    )
  })

  Scenario('They list in the order the row reads in', ({ Then }) => {
    Then('the orders are 10, 20, 30', () =>
      expect([openTerminalTool.order, openSessionTool.order, diffityTool.order]).toEqual([
        10, 20, 30,
      ]),
    )
  })

  Rule('a terminal where the work is', ({ RuleScenario }) => {
    RuleScenario('It offers a shell and no command', ({ When, Then, And }) => {
      When('"open-terminal" is asked what it offers', ask('open-terminal'))
      Then('it offers something', () => expect(offer).toBeDefined())
      And('it offers no command of its own', () => expect(offer?.command).toBeUndefined())
      And('it is available', () => expect(offer?.unavailable).toBeUndefined())
    })

    RuleScenario('A task whose project is missing has nowhere to open', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given("the task's project is not in the database", () => {
        workspace = undefined
      })
      When('"open-terminal" is asked what it offers', ask('open-terminal'))
      Then('it is unavailable', () => expect(offer?.unavailable).toBeDefined())
      And('the reason says there is nowhere to open', reasonSays('nowhere to open'))
    })
  })

  Rule('the conversation the agent was having', ({ RuleScenario }) => {
    const givenSession = (provider: string) => () => {
      task = { ...task, session: { id: 's-99', provider } }
    }

    RuleScenario('A task with a recorded session resumes it by id', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given('the task\'s session is "s-99" on "claude"', givenSession('claude'))
      When('"open-session" is asked what it offers', ask('open-session'))
      // `--resume` comes out of provider.yaml. No plugin spells it.
      Then('it would run "claude --resume s-99"', wouldRun('claude --resume s-99'))
      And('it is available', () => expect(offer?.unavailable).toBeUndefined())
    })

    RuleScenario('A task no agent has run for says so, and says it only once', ({
      When,
      Then,
      And,
    }) => {
      When('"open-session" is asked what it offers', ask('open-session'))
      Then('it is unavailable', () => expect(offer?.unavailable).toBeDefined())
      And('the reason is the no-session-yet sentence', () =>
        expect(offer?.unavailable).toBe(NO_SESSION_YET),
      )
    })

    RuleScenario('A session whose provider has gone names it', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given('the task\'s session is "s-99" on "gone"', givenSession('gone'))
      When('"open-session" is asked what it offers', ask('open-session'))
      Then('it is unavailable', () => expect(offer?.unavailable).toBeDefined())
      And('the reason names "gone"', reasonSays('gone'))
    })

    RuleScenario('A provider that cannot resume by id says that instead', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('the codex provider is installed', () => host.load(codexProvider))
      And('the task\'s session is "s-99" on "codex"', givenSession('codex'))
      When('"open-session" is asked what it offers', ask('open-session'))
      Then('it is unavailable', () => expect(offer?.unavailable).toBeDefined())
      And('the reason says it has no way to resume', reasonSays('no way to resume'))
    })
  })

  Rule("the task's changes, in Diffity", ({ RuleScenario }) => {
    const givenInstalled = () => {
      env.PATH = install('diffity', '/usr/local/bin')
    }

    RuleScenario('It diffs the branch against its base', ({ Given, When, Then, And }) => {
      Given('"diffity" is installed', givenInstalled)
      When('"diffity" is asked what it offers', ask('diffity'))
      Then('it would run "diffity --new main"', () => {
        // Order matters: `diffity main --new` is refused, the flag being read
        // as a second git ref.
        expect(offer?.command?.args).toEqual(['--new', 'main'])
      })
      And('it asks for a detached run', () => expect(diffityTool.run).toBe('detached'))
      And('it is available', () => expect(offer?.unavailable).toBeUndefined())
    })

    RuleScenario('It runs the binary where it was actually found', ({ Given, When, Then }) => {
      Given('"diffity" is installed somewhere PATH does not mention', () => {
        extraDirectories = [install('diffity', '/opt/homebrew/bin')]
      })
      When('"diffity" is asked what it offers', ask('diffity'))
      Then('it would run the full path to it', () =>
        expect(offer?.command?.command).toBe(join(extraDirectories[0] as string, 'diffity')),
      )
    })

    RuleScenario('Not installed says how to install it', ({ When, Then, And }) => {
      When('"diffity" is asked what it offers', ask('diffity'))
      Then('it is unavailable', () => expect(offer?.unavailable).toBeDefined())
      And('the reason says "npm install -g diffity"', reasonSays('npm install -g diffity'))
    })

    RuleScenario('A project that is not a git repository cannot be diffed', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('"diffity" is installed', givenInstalled)
      And('the project is not a git repository', () => {
        project = { ...PROJECT, isRepository: false }
      })
      When('"diffity" is asked what it offers', ask('diffity'))
      Then('it is unavailable', () => expect(offer?.unavailable).toBeDefined())
      And('the reason says Diffity needs one', reasonSays('needs one'))
    })

    RuleScenario('A task whose project is missing has nothing to diff', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('"diffity" is installed', givenInstalled)
      And("the task's project is not in the database", () => {
        workspace = undefined
      })
      When('"diffity" is asked what it offers', ask('diffity'))
      Then('it is unavailable', () => expect(offer?.unavailable).toBeDefined())
    })
  })
})

import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import type { Project } from '@factory/core'
import { ToolError, factoryTools, type McpTool } from '../src/index.js'
import { FakeFactory } from './support.js'

const feature = await loadFeature(
  fileURLToPath(new URL('./project-context.feature', import.meta.url)),
)

const CWD = '/repos/factory/packages/core'

const project = (name: string, path: string, id = `project-${name}`): Project => ({
  id,
  name,
  path,
  defaultBranch: 'main',
  worktreesRoot: `/repos/.factory-worktrees/${name}`,
  isRepository: true,
  usesWorktrees: true,
  usesEnvironments: false,
  grantedDirectories: [],
  createdAt: '2026-01-01T00:00:00Z',
})

describeFeature(feature, ({ Background, Rule, Scenario }) => {
  let factory: FakeFactory
  let answer: Record<string, unknown> | undefined
  let failure: ToolError | undefined
  let projects: Project[]

  const tool = (name: string): McpTool =>
    factoryTools.find((candidate) => candidate.name === name) as McpTool

  const call = async (name: string, input: unknown): Promise<void> => {
    answer = undefined
    failure = undefined
    const chosen = tool(name)
    const parsed = chosen.parse(input)
    if ('problems' in parsed) throw new Error(parsed.problems.join('; '))
    try {
      answer = (await chosen.run(parsed.value, {
        api: factory,
        cwd: CWD,
        env: {},
      })) as Record<string, unknown>
    } catch (error) {
      failure = error as ToolError
    }
  }

  const at = (path: string) => `/api/projects/at?path=${encodeURIComponent(path)}`
  const named = (name: string) => () =>
    expect((answer?.project as { name: string } | undefined)?.name).toBe(name)
  const refused = (code: string) => () => {
    expect(failure).toBeInstanceOf(ToolError)
    expect(failure?.code).toBe(code)
  }

  Background(({ Given }) => {
    Given('an MCP server started in "/repos/factory/packages/core"', () => {
      answer = undefined
      failure = undefined
      projects = []
      factory = new FakeFactory()
    })
  })

  Scenario('The directory the server was started in is the project', ({ Given, When, Then, And }) => {
    Given('that directory is in the project "factory"', () => {
      factory.answer(at(CWD), {
        project: project('factory', '/repos/factory'),
        matchedBy: 'ancestor',
      })
    })
    When('the agent asks which project it is in', () => call('factory_project_current', {}))
    Then('the project is "factory"', named('factory'))
    And('Factory was asked about "/repos/factory/packages/core"', () =>
      expect(factory.asked).toContain(`GET ${at(CWD)}`),
    )
    And('the answer says the directory it used', () => expect(answer?.directory).toBe(CWD))
  })

  Scenario('A worktree says which task is being worked on', ({ Given, When, Then, And }) => {
    Given('that directory is a worktree of the task "Add due dates" in "factory"', () => {
      factory.answer(at(CWD), {
        project: project('factory', '/repos/factory'),
        matchedBy: 'worktree',
        task: { id: 'task-1', name: 'Add due dates', state: 'running' },
      })
    })
    When('the agent asks which project it is in', () => call('factory_project_current', {}))
    Then('the project is "factory"', named('factory'))
    And('the answer names the task "Add due dates"', () =>
      expect((answer?.task as { name: string } | undefined)?.name).toBe('Add due dates'),
    )
  })

  Scenario('A directory in no project says what to do about it', ({ Given, When, Then, And }) => {
    Given('that directory is in no project', () => {
      factory.answer(at(CWD), { status: 404, message: `${CWD} is not inside any project.` })
    })
    When('the agent asks which project it is in', () => call('factory_project_current', {}))
    Then('it is refused as PROJECT_NOT_FOUND', refused('PROJECT_NOT_FOUND'))
    And('the refusal says to pass a project or ask somebody to add the repository', () => {
      expect(failure?.message).toContain('Pass `project`')
      expect(failure?.message).toContain('add')
    })
  })

  Scenario('Two projects with an equal claim are both named', ({ Given, When, Then, And }) => {
    Given('that directory is claimed by "factory" and "factory-again"', () => {
      factory.answer(at(CWD), {
        status: 409,
        message: `${CWD} is in more than one project: factory, factory-again.`,
        body: { projects: ['factory', 'factory-again'] },
      })
    })
    When('the agent asks which project it is in', () => call('factory_project_current', {}))
    Then('it is refused as PROJECT_AMBIGUOUS', refused('PROJECT_AMBIGUOUS'))
    And('the refusal names both', () =>
      expect(failure?.details.projects).toEqual(['factory', 'factory-again']),
    )
  })

  Rule('a project the caller named is the one used', ({ RuleScenario }) => {
    const twoProjects = () => {
      projects = [
        project('factory', '/repos/factory'),
        project('todolist', '/repos/todolist', 'project-todo'),
      ]
      factory.answer('/api/projects', { items: projects })
    }
    const askedAboutADirectory = () =>
      factory.asked.some((asked) => asked.includes('/api/projects/at'))

    RuleScenario('A name is looked up among the projects', ({ Given, When, Then, And }) => {
      Given('the projects "factory" and "todolist"', twoProjects)
      When('the agent asks for the project "todolist"', () =>
        call('factory_project_get', { project: 'todolist' }),
      )
      Then('the project is "todolist"', named('todolist'))
      And('Factory was not asked about any directory', () =>
        expect(askedAboutADirectory()).toBe(false),
      )
    })

    RuleScenario('An id is looked up among the projects', ({ Given, When, Then }) => {
      Given('the projects "factory" and "todolist"', twoProjects)
      When("the agent asks for the project by todolist's id", () =>
        call('factory_project_get', { project: 'project-todo' }),
      )
      Then('the project is "todolist"', named('todolist'))
    })

    RuleScenario('A name matches whatever case it was typed in', ({ Given, When, Then }) => {
      Given('the projects "factory" and "todolist"', twoProjects)
      When('the agent asks for the project "ToDoList"', () =>
        call('factory_project_get', { project: 'ToDoList' }),
      )
      Then('the project is "todolist"', named('todolist'))
    })

    RuleScenario('Anything starting with a separator is treated as a path', ({
      Given,
      When,
      Then,
    }) => {
      Given('the projects "factory" and "todolist"', () => {
        twoProjects()
        factory.answer(at('/repos/todolist/src'), {
          project: projects[1] as Project,
          matchedBy: 'ancestor',
        })
      })
      When('the agent asks for the project "/repos/todolist/src"', () =>
        call('factory_project_get', { project: '/repos/todolist/src' }),
      )
      Then('Factory was asked about "/repos/todolist/src"', () =>
        expect(factory.asked).toContain(`GET ${at('/repos/todolist/src')}`),
      )
    })

    RuleScenario('A name nobody has says what there is', ({ Given, When, Then, And }) => {
      Given('the projects "factory" and "todolist"', twoProjects)
      When('the agent asks for the project "factoree"', () =>
        call('factory_project_get', { project: 'factoree' }),
      )
      Then('it is refused as PROJECT_NOT_FOUND', refused('PROJECT_NOT_FOUND'))
      And('the refusal lists "factory" and "todolist"', () =>
        expect(failure?.details.projects).toEqual(['factory', 'todolist']),
      )
    })
  })
})

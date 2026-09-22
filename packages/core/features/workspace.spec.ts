import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { workspaceFor, type Workspace } from '../src/task/project.js'

const feature = await loadFeature(fileURLToPath(new URL('./workspace.feature', import.meta.url)))

/** POSIX join, which is all these absolute fixtures need. */
const join = (...parts: string[]): string => parts.join('/')

describeFeature(feature, ({ Scenario, Rule, BeforeEachScenario }) => {
  let project: Parameters<typeof workspaceFor>[1]
  let task: { directory?: string; flags: string[] }
  let onDisk: Set<string>
  let result: Workspace | undefined

  BeforeEachScenario(() => {
    project = facilities(false)
    task = { flags: [] }
    onDisk = new Set()
    result = undefined
  })

  const facilities = (usesWorktrees: boolean) => ({
    path: '/repos/todolist',
    worktreesRoot: '/worktrees/todolist',
    usesWorktrees,
    usesEnvironments: false,
  })

  const ask = (): void => {
    result = workspaceFor(task, project, (path) => onDisk.has(path), join)
  }

  const inPlace = () => {
    project = facilities(false)
  }
  const withWorktrees = () => {
    project = facilities(true)
  }
  const named = (directory: string) => () => {
    task = { ...task, directory }
  }
  const leftOver = (path: string) => () => {
    onDisk.add(path)
  }
  const workspaceIs = (path: string) => () => expect(result?.path).toBe(path)
  const isWorktree = (yes: boolean) => () => expect(result?.inWorktree).toBe(yes)
  const consideredNone = () => expect(result?.worktree).toBeUndefined()

  Scenario('A project that works in place runs in its own checkout', ({
    Given,
    And,
    When,
    Then,
  }) => {
    Given('the project "todolist" at "/repos/todolist" works in place', inPlace)
    And('the task\'s directory is "add-due-dates"', named('add-due-dates'))
    When('I ask where its steps run', ask)
    Then('the workspace is "/repos/todolist"', workspaceIs('/repos/todolist'))
    And('it is not a worktree', isWorktree(false))
  })

  Scenario('A project that works in place never looks for a worktree', ({
    Given,
    And,
    When,
    Then,
  }) => {
    Given('the project "todolist" at "/repos/todolist" works in place', inPlace)
    And('the task\'s directory is "add-due-dates"', named('add-due-dates'))
    And(
      'a directory is left over at "/worktrees/todolist/add-due-dates"',
      leftOver('/worktrees/todolist/add-due-dates'),
    )
    When('I ask where its steps run', ask)
    Then('the workspace is "/repos/todolist"', workspaceIs('/repos/todolist'))
    And('no worktree was considered', consideredNone)
  })

  Scenario("A project using worktrees runs in the task's own one", ({
    Given,
    And,
    When,
    Then,
  }) => {
    Given('the project "todolist" at "/repos/todolist" uses worktrees', withWorktrees)
    And('the task\'s directory is "add-due-dates"', named('add-due-dates'))
    And(
      'a directory is left over at "/worktrees/todolist/add-due-dates"',
      leftOver('/worktrees/todolist/add-due-dates'),
    )
    When('I ask where its steps run', ask)
    Then(
      'the workspace is "/worktrees/todolist/add-due-dates"',
      workspaceIs('/worktrees/todolist/add-due-dates'),
    )
    And('it is a worktree', isWorktree(true))
  })

  Scenario('A worktree that is not there falls back to the repository', ({
    Given,
    And,
    When,
    Then,
  }) => {
    Given('the project "todolist" at "/repos/todolist" uses worktrees', withWorktrees)
    And('the task\'s directory is "add-due-dates"', named('add-due-dates'))
    When('I ask where its steps run', ask)
    Then('the workspace is "/repos/todolist"', workspaceIs('/repos/todolist'))
    And('it is not a worktree', isWorktree(false))
    // The path is carried even when nothing is there, so `doctor` can name the
    // directory it looked for without building it a second time.
    And('the worktree it looked for was "/worktrees/todolist/add-due-dates"', () =>
      expect(result?.worktree).toBe('/worktrees/todolist/add-due-dates'),
    )
  })

  Scenario('A task with no directory of its own runs in the repository', ({
    Given,
    And,
    When,
    Then,
  }) => {
    Given('the project "todolist" at "/repos/todolist" uses worktrees', withWorktrees)
    And('the task has no directory', () => {
      task = { flags: [] }
    })
    When('I ask where its steps run', ask)
    Then('the workspace is "/repos/todolist"', workspaceIs('/repos/todolist'))
    And('no worktree was considered', consideredNone)
  })

  Rule('the disk is trusted, not the flag', ({ RuleScenario }) => {
    RuleScenario('A worktree that exists is used even without the flag', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('the project "todolist" at "/repos/todolist" uses worktrees', withWorktrees)
      And('the task\'s directory is "add-due-dates"', named('add-due-dates'))
      // Stated rather than implied: the flag is never read here, and this is
      // the case the daemon and doctor used to answer differently.
      And('the task does not have the flag "hasWorktree"', () =>
        expect(task.flags).not.toContain('hasWorktree'),
      )
      And(
        'a directory is left over at "/worktrees/todolist/add-due-dates"',
        leftOver('/worktrees/todolist/add-due-dates'),
      )
      When('I ask where its steps run', ask)
      Then(
        'the workspace is "/worktrees/todolist/add-due-dates"',
        workspaceIs('/worktrees/todolist/add-due-dates'),
      )
      And('it is a worktree', isWorktree(true))
    })

    RuleScenario('The flag alone does not conjure one', ({ Given, And, When, Then }) => {
      Given('the project "todolist" at "/repos/todolist" uses worktrees', withWorktrees)
      And('the task\'s directory is "add-due-dates"', named('add-due-dates'))
      And('the task has the flag "hasWorktree"', () => {
        task = { ...task, flags: ['hasWorktree'] }
      })
      When('I ask where its steps run', ask)
      Then('the workspace is "/repos/todolist"', workspaceIs('/repos/todolist'))
      And('it is not a worktree', isWorktree(false))
    })
  })
})

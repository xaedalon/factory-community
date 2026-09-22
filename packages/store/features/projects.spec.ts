import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EventBus, type FactoryEvent } from '@factory/events'
import type { ExecutionProfile, Project, Task } from '@factory/core'
import {
  MIGRATIONS,
  ProjectRepository,
  TaskRepository,
  openStore,
  type Store,
} from '../src/index.js'

const feature = await loadFeature(fileURLToPath(new URL('./projects.feature', import.meta.url)))

describeFeature(feature, ({ Background, Rule, Scenario, AfterEachScenario }) => {
  let store: Store
  let projects: ProjectRepository
  let tasks: TaskRepository
  let root = ''
  let repo = ''
  let project: Project | undefined
  let task: Task | undefined
  let listed: Project[] = []
  let failure: unknown
  let events: FactoryEvent[] = []
  let plain = ''
  let tick = 0

  AfterEachScenario(() => {
    store?.close()
    rmSync(root, { recursive: true, force: true })
  })

  // Built in Background: Background steps run first, before anything in
  // BeforeEachScenario would exist.
  Background(({ Given, And }) => {
    Given('an empty store', () => {
      tick = 0
      failure = undefined
      project = undefined
      task = undefined
      listed = []
      events = []
      plain = ''
      root = mkdtempSync(join(tmpdir(), 'factory-projects-'))
      store = openStore({ file: ':memory:', migrations: MIGRATIONS })
      let ids = 0
      const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString()
      const bus = new EventBus({ onSubscriberError: () => {} })
      bus.onAny((event) => events.push(event))
      projects = new ProjectRepository({
        db: store.db,
        events: bus,
        now,
        newId: () => `project-${++ids}`,
      })
      tasks = new TaskRepository({ db: store.db, now, newId: () => `task-${++ids}` })
    })
    And('a directory that is a git repository', () => {
      repo = join(root, 'factory')
      mkdirSync(join(repo, '.git'), { recursive: true })
    })
  })

  const attempt = (work: () => void): void => {
    try {
      work()
    } catch (error) {
      failure = error
    }
  }
  const add = (name: string, path = repo): void => {
    attempt(() => {
      project = projects.add({ name, path })
    })
  }

  Scenario('Adding a project', ({ When, Then, And }) => {
    When('I add the project "factory" at that directory', () => add('factory'))
    Then('the project is stored', () => expect(projects.list()).toHaveLength(1))
    And('the project\'s branch is "main"', () => expect(project?.defaultBranch).toBe('main'))
    // Never inside the repository: a worktree under the working copy shows up
    // as untracked and removing one can touch tracked files.
    And('the project has somewhere to put worktrees', () => {
      expect(project?.worktreesRoot).toBeDefined()
      expect(project?.worktreesRoot.startsWith(`${repo}/`)).toBe(false)
    })
  })

  Scenario('A project needs a directory that exists', ({ When, Then, And }) => {
    When('I add the project "ghost" at a path that does not exist', () =>
      add('ghost', join(root, 'nowhere')),
    )
    Then('it is refused', () => expect(failure).toBeDefined())
    And('the error names the path', () =>
      expect((failure as Error).message).toContain('nowhere'),
    )
  })

  Scenario('A project needs a directory, not a file', ({ When, Then }) => {
    When('I add the project "afile" at a file', () => {
      const file = join(root, 'notes.md')
      writeFileSync(file, 'hello')
      add('afile', file)
    })
    Then('it is refused', () => expect(failure).toBeDefined())
  })

  Scenario('A directory that is not a repository is allowed, and said so', ({
    Given,
    When,
    Then,
    And,
  }) => {
    let plain = ''
    Given('a directory that is not a git repository', () => {
      plain = join(root, 'notes')
      mkdirSync(plain, { recursive: true })
    })
    When('I add the project "notes" at that directory', () => add('notes', plain))
    Then('the project is stored', () => expect(projects.list()).toHaveLength(1))
    And('the project is marked as not being a repository', () =>
      expect(project?.isRepository).toBe(false),
    )
  })

  Scenario('Names are unique', ({ Given, When, Then, And }) => {
    Given('the project "factory" exists', () => add('factory'))
    When('I add the project "factory" at that directory again', () => add('factory'))
    Then('it is refused', () => expect(failure).toBeDefined())
    And('the error says the name is taken', () =>
      expect((failure as Error).message).toContain('already a project'),
    )
  })

  Scenario('A task can belong to a project', ({ Given, When, Then }) => {
    Given('the project "factory" exists', () => add('factory'))
    When('I create a task "Add due dates" in "factory"', () => {
      task = tasks.create({ name: 'Add due dates', projectId: project?.id as string })
    })
    Then('the task belongs to "factory"', () => expect(task?.projectId).toBe(project?.id))
  })

  Scenario('A task need not belong to one', ({ When, Then }) => {
    When('I create a task "Add due dates" with no project', () => {
      task = tasks.create({ name: 'Add due dates' })
    })
    Then('the task belongs to no project', () => expect(task?.projectId).toBeUndefined())
  })

  Scenario('Removing a project leaves its tasks without one', ({ Given, And, When, Then }) => {
    Given('the project "factory" exists', () => add('factory'))
    And('a task "Add due dates" in "factory"', () => {
      task = tasks.create({ name: 'Add due dates', projectId: project?.id as string })
    })
    When('I remove the project', () => {
      projects.remove(project?.id as string)
    })
    Then('the task still exists', () => expect(tasks.get(task?.id as string)).toBeDefined())
    And('the task belongs to no project', () =>
      expect(tasks.get(task?.id as string)?.projectId).toBeUndefined(),
    )
  })

  Scenario('Projects are listed by name', ({ Given, And, When, Then }) => {
    Given('the project "zebra" exists', () => {
      mkdirSync(join(root, 'zebra'), { recursive: true })
      add('zebra', join(root, 'zebra'))
    })
    And('the project "alpha" exists', () => {
      mkdirSync(join(root, 'alpha'), { recursive: true })
      add('alpha', join(root, 'alpha'))
    })
    When('I list the projects', () => {
      listed = projects.list()
    })
    Then('they are "alpha, zebra" in that order', () =>
      expect(listed.map((entry) => entry.name)).toEqual(['alpha', 'zebra']),
    )
  })

  const addWith = (name: string, path: string, usesWorktrees: boolean): void => {
    attempt(() => {
      project = projects.add({ name, path, usesWorktrees })
    })
  }
  const givenPlainDirectory = (): void => {
    plain = join(root, 'notes')
    mkdirSync(plain, { recursive: true })
  }
  const setWorktrees = (on: boolean): void => {
    attempt(() => {
      project = projects.setWorktrees(project?.id as string, on)
    })
  }

  Scenario('A project gives each task its own worktree unless it says otherwise', ({
    When,
    Then,
  }) => {
    When('I add the project "factory" at that directory', () => add('factory'))
    Then('the project uses worktrees', () => expect(project?.usesWorktrees).toBe(true))
  })

  Scenario('A project can be added to work in its own checkout instead', ({ When, Then, And }) => {
    When('I add the project "factory" at that directory, working in place', () =>
      addWith('factory', repo, false),
    )
    Then('the project does not use worktrees', () => expect(project?.usesWorktrees).toBe(false))
    // Turning the setting back on must not have lost where they went.
    And('the project still remembers where worktrees would go', () =>
      expect(project?.worktreesRoot ?? '').not.toBe(''),
    )
  })

  Scenario('A directory that is not a repository works in place from the start', ({
    Given,
    When,
    Then,
  }) => {
    Given('a directory that is not a git repository', givenPlainDirectory)
    When('I add the project "notes" at that directory', () => add('notes', plain))
    // A worktree there is impossible, not merely unwanted.
    Then('the project does not use worktrees', () => expect(project?.usesWorktrees).toBe(false))
  })

  Scenario('Asking for worktrees where there is no repository is refused', ({
    Given,
    When,
    Then,
    And,
  }) => {
    Given('a directory that is not a git repository', givenPlainDirectory)
    When('I add the project "notes" at that directory, using worktrees', () =>
      addWith('notes', plain, true),
    )
    Then('it is refused', () => expect(failure).toBeDefined())
    And('the error says it is not a git repository', () =>
      expect((failure as Error).message).toContain('not a git repository'),
    )
  })

  Scenario('Worktrees can be turned off after the project was added', ({ Given, When, Then }) => {
    Given('the project "factory" exists', () => add('factory'))
    When('I turn its worktrees off', () => setWorktrees(false))
    Then('the project does not use worktrees', () => expect(project?.usesWorktrees).toBe(false))
  })

  Scenario('Turning worktrees back on needs a repository', ({ Given, And, When, Then }) => {
    Given('a directory that is not a git repository', givenPlainDirectory)
    And('the project "notes" exists there', () => add('notes', plain))
    When('I turn its worktrees on', () => setWorktrees(true))
    Then('it is refused', () => expect(failure).toBeDefined())
  })

  Scenario('Turning worktrees on notices a directory that has since become one', ({
    Given,
    And,
    When,
    Then,
  }) => {
    Given('a directory that is not a git repository', givenPlainDirectory)
    And('the project "notes" exists there', () => add('notes', plain))
    // `is_repository` is written once when the project is added and never
    // refreshed, so trusting it would strand anyone who ran `git init` later.
    And('the directory becomes a git repository', () => {
      mkdirSync(join(plain, '.git'), { recursive: true })
    })
    When('I turn its worktrees on', () => setWorktrees(true))
    Then('the project uses worktrees', () => expect(project?.usesWorktrees).toBe(true))
    And('the project is no longer marked as not being a repository', () =>
      expect(project?.isRepository).toBe(true),
    )
  })

  Scenario('Changing the setting is announced', ({ Given, When, Then }) => {
    Given('the project "factory" exists', () => add('factory'))
    When('I turn its worktrees off', () => setWorktrees(false))
    Then('a "project.changed" event says so', () => {
      const changed = events.find((event) => event.name === 'project.changed')
      expect(changed?.payload).toMatchObject({ name: 'factory', usesWorktrees: false })
    })
  })

  Scenario('Changing a project that is not there is refused', ({ When, Then }) => {
    When('I turn worktrees off on a project that does not exist', () =>
      attempt(() => projects.setWorktrees('nope', false)),
    )
    Then('it is refused', () => expect(failure).toBeDefined())
  })

  Rule('a project can be renamed, and its branch re-pointed', ({ RuleScenario }) => {
    const exists = (): void => add('factory')
    const rename =
      (to: string, which?: () => string) =>
      (): void =>
        attempt(() => {
          project = projects.rename(which?.() ?? (project as Project).id, to)
        })
    const repoint =
      (to: string) =>
      (): void =>
        attempt(() => {
          project = projects.setDefaultBranch((project as Project).id, to)
        })

    RuleScenario('A project can be renamed', ({ Given, When, Then, And }) => {
      Given('the project "factory" exists', exists)
      When('I rename it to "factory-core"', rename('factory-core'))
      Then("the project is called \"factory-core\"", () =>
        expect(project?.name).toBe('factory-core'),
      )
      // The whole reason this is a rename and not remove-and-add-again.
      And('its tasks still belong to it', () => {
        const owned = tasks.create({ name: 'a task', projectId: (project as Project).id })
        expect(tasks.get(owned.id)?.projectId).toBe((project as Project).id)
      })
    })

    RuleScenario('Renaming is announced', ({ Given, When, Then }) => {
      Given('the project "factory" exists', exists)
      When('I rename it to "factory-core"', rename('factory-core'))
      Then('a "project.changed" event says so', () => {
        const changed = events.find((event) => event.name === 'project.changed')
        expect(changed?.payload).toMatchObject({ name: 'factory-core' })
      })
    })

    RuleScenario('A name still has to be unique', ({ Given, And, When, Then }) => {
      Given('the project "factory" exists', exists)
      And('the project "notes" exists there', () => add('notes'))
      When('I rename "notes" to "factory"', rename('factory'))
      Then('it is refused', () => expect(failure).toBeDefined())
    })

    RuleScenario('A project keeps its name when renamed to what it already is', ({
      Given,
      When,
      Then,
    }) => {
      Given('the project "factory" exists', exists)
      // The uniqueness check has to skip the project's own row, or this
      // collides with itself.
      When('I rename it to "factory"', rename('factory'))
      Then("the project is called \"factory\"", () => expect(project?.name).toBe('factory'))
    })

    RuleScenario('An empty name is refused', ({ Given, When, Then }) => {
      Given('the project "factory" exists', exists)
      When('I rename it to ""', rename(''))
      Then('it is refused', () => expect(failure).toBeDefined())
    })

    RuleScenario('The branch work starts from can be re-pointed', ({ Given, When, Then }) => {
      Given('the project "factory" exists', exists)
      When('I point it at the branch "develop"', repoint('develop'))
      Then("the project's branch is \"develop\"", () =>
        expect(project?.defaultBranch).toBe('develop'),
      )
    })

    RuleScenario('Re-pointing the branch is announced', ({ Given, When, Then }) => {
      Given('the project "factory" exists', exists)
      When('I point it at the branch "develop"', repoint('develop'))
      Then('a "project.changed" event says so', () => {
        const changed = events.find((event) => event.name === 'project.changed')
        expect(changed?.payload).toMatchObject({ name: 'factory' })
      })
    })

    RuleScenario('An empty branch is refused', ({ Given, When, Then }) => {
      Given('the project "factory" exists', exists)
      When('I point it at the branch ""', repoint(''))
      Then('it is refused', () => expect(failure).toBeDefined())
    })

    RuleScenario('Renaming a project that is not there is refused', ({ When, Then }) => {
      When('I rename a project that does not exist', () =>
        attempt(() => projects.rename('nope', 'anything')),
      )
      Then('it is refused', () => expect(failure).toBeDefined())
    })
  })

  Rule('a project can choose its own square, or let the name decide', ({ RuleScenario }) => {
    const exists = (): void => add('factory')
    const chooseTone =
      (tone: number | undefined) =>
      (): void =>
        attempt(() => {
          project = projects.setAppearance((project as Project).id, { tone })
        })
    const chooseLetters =
      (initials: string | undefined) =>
      (): void =>
        attempt(() => {
          project = projects.setAppearance((project as Project).id, { initials })
        })
    const editColumn =
      (column: string, value: unknown) =>
      (): void => {
        store.db.run(
          `UPDATE projects SET ${column} = ? WHERE id = ?`,
          value as string,
          (project as Project).id,
        )
        project = projects.get((project as Project).id)
      }

    RuleScenario('A new project has chosen neither', ({ When, Then, And }) => {
      When('I add the project "factory" at that directory', exists)
      Then('the project has no chosen colour', () => expect(project?.tone).toBeUndefined())
      And('the project has no chosen letters', () => expect(project?.initials).toBeUndefined())
    })

    RuleScenario('A colour can be chosen', ({ Given, When, Then }) => {
      Given('the project "factory" exists', exists)
      When('I choose colour 3 for it', chooseTone(3))
      Then("the project's colour is 3", () => expect(project?.tone).toBe(3))
    })

    RuleScenario('Letters can be chosen', ({ Given, When, Then }) => {
      Given('the project "factory" exists', exists)
      When('I choose the letters "fx" for it', chooseLetters('fx'))
      // Upper-cased in the store, so a square is the same whichever side wrote it.
      Then("the project's letters are \"FX\"", () => expect(project?.initials).toBe('FX'))
    })

    RuleScenario('More than two letters is cut to two', ({ Given, When, Then }) => {
      Given('the project "factory" exists', exists)
      When('I choose the letters "abcd" for it', chooseLetters('abcd'))
      Then("the project's letters are \"AB\"", () => expect(project?.initials).toBe('AB'))
    })

    RuleScenario('Empty letters hand the square back to the name', ({ Given, And, When, Then }) => {
      Given('the project "factory" exists', exists)
      And('the letters "FX" are chosen for it', chooseLetters('FX'))
      When('I choose the letters "" for it', chooseLetters(''))
      Then('the project has no chosen letters', () => expect(project?.initials).toBeUndefined())
    })

    RuleScenario('A colour can be handed back to the name', ({ Given, And, When, Then }) => {
      Given('the project "factory" exists', exists)
      And('colour 3 is chosen for it', chooseTone(3))
      When('I clear its colour', chooseTone(undefined))
      Then('the project has no chosen colour', () => expect(project?.tone).toBeUndefined())
    })

    RuleScenario('A colour outside the palette is refused', ({ Given, When, Then }) => {
      Given('the project "factory" exists', exists)
      When('I choose colour 9 for it', chooseTone(9))
      Then('it is refused', () => expect(failure).toBeDefined())
    })

    RuleScenario('Choosing the square is announced', ({ Given, When, Then }) => {
      Given('the project "factory" exists', exists)
      When('I choose colour 3 for it', chooseTone(3))
      Then('a "project.changed" event says so', () => {
        const changed = events.find((event) => event.name === 'project.changed')
        expect(changed?.payload).toMatchObject({ name: 'factory' })
      })
    })

    // The whole reason the override exists: a derivation cannot survive this.
    RuleScenario('A chosen square survives a rename', ({ Given, And, When, Then }) => {
      Given('the project "factory" exists', exists)
      And('colour 3 is chosen for it', chooseTone(3))
      When('I rename it to "factory-core"', () =>
        attempt(() => {
          project = projects.rename((project as Project).id, 'factory-core')
        }),
      )
      Then("the project's colour is 3", () => expect(project?.tone).toBe(3))
    })

    RuleScenario('A colour edited into nonsense reads as unchosen', ({ Given, And, Then }) => {
      Given('the project "factory" exists', exists)
      And('its colour column is edited by hand to 99', editColumn('tone', 99))
      Then('the project has no chosen colour', () => expect(project?.tone).toBeUndefined())
    })
  })

  Rule('a project says how much authority its runs get, and what else they may reach', ({
    RuleScenario,
  }) => {
    const exists = (): void => add('factory')
    const setProfile = (profile: ExecutionProfile | undefined) => (): void => {
      attempt(() => {
        project = projects.setProfile((project as Project).id, profile)
      })
    }
    const grant = (directory: string) => (): void => {
      attempt(() => {
        project = projects.grantDirectory((project as Project).id, directory)
      })
    }
    const revoke = (directory: string) => (): void => {
      attempt(() => {
        project = projects.revokeDirectory((project as Project).id, directory)
      })
    }
    /** Straight into the column, which is what a hand edit looks like. */
    const columnSays = (column: string, value: string) => (): void => {
      store.db.run(`UPDATE projects SET ${column} = ? WHERE id = ?`, value, (project as Project).id)
      project = projects.get((project as Project).id)
    }
    const granted = (expected: string) => (): void => {
      expect((project as Project).grantedDirectories.join(', ')).toBe(expected)
    }
    const noGrants = (): void => {
      expect((project as Project).grantedDirectories).toEqual([])
    }
    const unstated = (): void => {
      expect((project as Project).profile).toBeUndefined()
    }

    RuleScenario('A new project states no profile', ({ Given, Then, And }) => {
      Given('the project "factory" exists', exists)
      Then('it states no profile', unstated)
      And('it has granted no directories', noGrants)
    })

    RuleScenario('A profile can be stated and read back', ({ Given, When, Then }) => {
      Given('the project "factory" exists', exists)
      When('I set its profile to "full-access"', setProfile('full-access'))
      Then('its profile is "full-access"', () =>
        expect((project as Project).profile).toBe('full-access'),
      )
    })

    RuleScenario('A profile can be cleared back to unstated', ({ Given, And, When, Then }) => {
      Given('the project "factory" exists', exists)
      And('its profile is "full-access"', setProfile('full-access'))
      When('I clear its profile', setProfile(undefined))
      Then('it states no profile', unstated)
    })

    RuleScenario('Changing the profile is announced', ({ Given, When, Then }) => {
      Given('the project "factory" exists', exists)
      When('I set its profile to "full-access"', setProfile('full-access'))
      Then('a "project.changed" event says so', () => {
        const changed = events.filter((event) => event.name === 'project.changed')
        expect(changed.at(-1)?.payload).toMatchObject({ name: 'factory' })
      })
    })

    RuleScenario('Setting a profile on a project that is not there is refused', ({
      When,
      Then,
    }) => {
      When('I set the profile of a project that does not exist', () =>
        attempt(() => projects.setProfile('nope', 'full-access')),
      )
      Then('it is refused', () => expect(failure).toBeDefined())
    })

    RuleScenario('A granted directory is remembered', ({ Given, When, Then }) => {
      Given('the project "factory" exists', exists)
      When('I grant it the directory "/repos/shared-library"', grant('/repos/shared-library'))
      Then('its granted directories are "/repos/shared-library"', granted('/repos/shared-library'))
    })

    RuleScenario('Granting the same directory twice changes nothing', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('the project "factory" exists', exists)
      And('it has been granted "/repos/shared-library"', grant('/repos/shared-library'))
      When('I grant it the directory "/repos/shared-library"', grant('/repos/shared-library'))
      Then('its granted directories are "/repos/shared-library"', granted('/repos/shared-library'))
    })

    RuleScenario('Granted directories are kept in order', ({ Given, And, When, Then }) => {
      Given('the project "factory" exists', exists)
      And('it has been granted "/repos/zoo"', grant('/repos/zoo'))
      When('I grant it the directory "/repos/aardvark"', grant('/repos/aardvark'))
      Then(
        'its granted directories are "/repos/aardvark, /repos/zoo"',
        granted('/repos/aardvark, /repos/zoo'),
      )
    })

    RuleScenario('A relative directory cannot be granted', ({ Given, When, Then }) => {
      Given('the project "factory" exists', exists)
      When('I grant it the directory "../shared-library"', grant('../shared-library'))
      Then('it is refused', () => expect(failure).toBeDefined())
    })

    RuleScenario('A granted directory can be taken back', ({ Given, And, When, Then }) => {
      Given('the project "factory" exists', exists)
      And('it has been granted "/repos/shared-library"', grant('/repos/shared-library'))
      When('I revoke the directory "/repos/shared-library"', revoke('/repos/shared-library'))
      Then('it has granted no directories', noGrants)
    })

    RuleScenario('A column edited by hand into nonsense reads as no grants', ({
      Given,
      And,
      Then,
    }) => {
      Given('the project "factory" exists', exists)
      And(
        'its granted directories column says "not json"',
        columnSays('granted_directories', 'not json'),
      )
      Then('it has granted no directories', noGrants)
    })

    RuleScenario('A profile edited by hand into nonsense reads as unstated', ({
      Given,
      And,
      Then,
    }) => {
      Given('the project "factory" exists', exists)
      And('its profile column says "sort-of-safe"', columnSays('profile', 'sort-of-safe'))
      Then('it states no profile', unstated)
    })
  })
})

import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EventBus, type FactoryEvent } from '@factory/events'
import type { ExecutionProfile, Project, Task } from '@factory/core'
import {
  AmbiguousProjectError,
  MIGRATIONS,
  ProjectRepository,
  TaskRepository,
  openStore,
  type ProjectAt,
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

  Scenario('A task cannot be created without one', ({ When, Then, And }) => {
    When('I create a task "Add due dates" with no project', () => {
      // Cast away the requirement on purpose: the type stops this at the call
      // sites inside Factory, and the check exists for everything that reaches
      // the repository without passing through the compiler — the API, a
      // plugin, a migration written later.
      attempt(() => {
        task = tasks.create({ name: 'Add due dates' } as unknown as Parameters<
          TaskRepository['create']
        >[0])
      })
    })
    Then('it is refused', () => expect(failure).toBeDefined())
    And('the error says a task needs a project', () =>
      expect((failure as Error).message).toContain('needs a project'),
    )
  })

  Scenario('A project with nothing in it is removed', ({ Given, When, Then }) => {
    Given('the project "factory" exists', () => add('factory'))
    When('I remove the project', () => {
      attempt(() => projects.remove(project?.id as string))
    })
    Then('the project is gone', () => expect(projects.list()).toHaveLength(0))
  })

  Scenario('Removing a project that still has tasks is refused', ({ Given, And, When, Then }) => {
    Given('the project "factory" exists', () => add('factory'))
    And('a task "Add due dates" in "factory"', () => {
      task = tasks.create({ name: 'Add due dates', projectId: project?.id as string })
    })
    When('I remove the project', () => {
      attempt(() => projects.remove(project?.id as string))
    })
    Then('it is refused', () => expect(failure).toBeDefined())
    And('the error says 1 task is still in it', () =>
      expect((failure as Error).message).toContain('1 task still in it'),
    )
    And('the project is still there', () => expect(projects.list()).toHaveLength(1))
    And('the task still exists', () => expect(tasks.get(task?.id as string)).toBeDefined())
  })

  // Counted with SQL rather than `list()`, which hides archived tasks. A count
  // that skipped them would promise a removal the foreign key then refuses.
  Scenario('An archived task counts, and the refusal says so', ({ Given, And, When, Then }) => {
    Given('the project "factory" exists', () => add('factory'))
    And('a task "Add due dates" in "factory"', () => {
      task = tasks.create({ name: 'Add due dates', projectId: project?.id as string })
    })
    And('a task "Ship it" in "factory" that has been archived', () => {
      const shipped = tasks.create({ name: 'Ship it', projectId: project?.id as string })
      tasks.act(shipped.id, 'archive')
    })
    When('I remove the project', () => {
      attempt(() => projects.remove(project?.id as string))
    })
    Then('it is refused', () => expect(failure).toBeDefined())
    And('the error says 2 tasks are still in it', () =>
      expect((failure as Error).message).toContain('2 tasks still in it'),
    )
    And('the error says 1 of them is archived', () =>
      expect((failure as Error).message).toContain('(1 archived)'),
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

    RuleScenario('A profile the store does not recognise is kept, not discarded', ({
      Given,
      And,
      Then,
    }) => {
      Given('the project "factory" exists', exists)
      And('its profile column says "sort-of-safe"', columnSays('profile', 'sort-of-safe'))
      Then('its profile is "sort-of-safe"', () => expect(project?.profile).toBe('sort-of-safe'))
    })

    RuleScenario('A blank profile column still reads as unstated', ({ Given, And, Then }) => {
      Given('the project "factory" exists', exists)
      And('its profile column says ""', columnSays('profile', ''))
      Then('it states no profile', unstated)
    })
  })
  Rule('the database refuses it too, not only the repository', ({ RuleScenario }) => {
    RuleScenario('A task written straight into the database without a project is refused', ({
      Given,
      When,
      Then,
    }) => {
      Given('the project "factory" exists', () => add('factory'))
      // Raw SQL on purpose: the point is what is true when nothing has been
      // through `create`, which is where the type and the message live.
      When('a task with no project is written straight into the database', () =>
        attempt(() =>
          store.db.run(
            `INSERT INTO tasks (id, name, state, created_at, updated_at, project_id)
             VALUES ('t-1', 'Add due dates', 'draft', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', NULL)`,
          ),
        ),
      )
      Then('the database refuses it', () => expect(failure).toBeDefined())
    })

    RuleScenario('A project deleted straight out of the database is refused', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('the project "factory" exists', () => add('factory'))
      And('a task "Add due dates" in "factory"', () => {
        task = tasks.create({ name: 'Add due dates', projectId: project?.id as string })
      })
      When('the project row is deleted straight out of the database', () =>
        attempt(() => store.db.run('DELETE FROM projects WHERE id = ?', project?.id as string)),
      )
      Then('the database refuses it', () => expect(failure).toBeDefined())
      And('the task still exists', () => expect(tasks.get(task?.id as string)).toBeDefined())
    })
  })
  Rule('a directory is asked which project it is in', ({ RuleScenario }) => {
    let answer: ProjectAt | undefined

    /**
     * Cleared per scenario: `at` returns undefined for "no project there".
     *
     * Takes a function rather than a string because the steps are registered
     * before Background runs — `ask(repo)` would capture the empty string it
     * still was, and a scenario expecting "no project" would pass for that
     * reason rather than the one it names.
     */
    const ask = (path: () => string) => () => {
      answer = undefined
      attempt(() => {
        answer = projects.at(path())
      })
    }
    const inside = (...parts: string[]) => {
      const path = join(repo, ...parts)
      mkdirSync(path, { recursive: true })
      return path
    }
    const named = (name: string) => () => expect(answer?.project.name).toBe(name)
    const by = (how: string) => () => expect(answer?.matchedBy).toBe(how)

    RuleScenario('A project\'s own directory is the project', ({ Given, When, Then, And }) => {
      Given('the project "factory" exists', () => add('factory'))
      When('I ask which project is at that directory', ask(() => repo))
      Then('the answer is "factory"', named('factory'))
      And('it matched the project\'s own directory', by('directory'))
    })

    RuleScenario('A directory inside a project is the project', ({ Given, When, Then, And }) => {
      Given('the project "factory" exists', () => add('factory'))
      When('I ask which project is at "packages/core/src" inside it', () =>
        ask(() => inside('packages', 'core', 'src'))(),
      )
      Then('the answer is "factory"', named('factory'))
      And('it matched an ancestor', by('ancestor'))
    })

    RuleScenario('A directory the project is inside is not the project', ({
      Given,
      When,
      Then,
    }) => {
      Given('the project "factory" exists', () => add('factory'))
      When('I ask which project is at the directory above it', ask(() => root))
      Then('there is no project there', () => expect(answer).toBeUndefined())
    })

    RuleScenario('A sibling whose name starts the same way is not inside', ({
      Given,
      When,
      Then,
    }) => {
      Given('the project "factory" exists', () => add('factory'))
      When('I ask which project is at the sibling "factory-pro"', () => {
        const sibling = join(root, 'factory-pro')
        mkdirSync(sibling, { recursive: true })
        ask(() => sibling)()
      })
      Then('there is no project there', () => expect(answer).toBeUndefined())
    })

    RuleScenario('The innermost project wins', ({ Given, And, When, Then }) => {
      Given('the project "factory" exists', () => add('factory'))
      And('the project "web" exists at "apps/web" inside it', () => {
        add('web', inside('apps', 'web'))
      })
      When('I ask which project is at "apps/web/src" inside "factory"', () =>
        ask(() => inside('apps', 'web', 'src'))(),
      )
      Then('the answer is "web"', named('web'))
    })

    RuleScenario('Two projects at one directory are refused by name', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('the project "factory" exists', () => add('factory'))
      And('the project "factory-again" exists at the same directory', () => add('factory-again'))
      When('I ask which project is at that directory', ask(() => repo))
      Then('it is refused', () => expect(failure).toBeInstanceOf(AmbiguousProjectError))
      And('the refusal names "factory" and "factory-again"', () =>
        expect((failure as AmbiguousProjectError).names).toEqual(['factory', 'factory-again']),
      )
    })

    RuleScenario('A task\'s worktree is the project, and says which task', ({
      Given,
      And,
      When,
      Then,
    }) => {
      let worktree = ''
      Given('the project "factory" exists', () => add('factory'))
      And('a task "Add due dates" in "factory" has a worktree', () => {
        task = tasks.create({ name: 'Add due dates', projectId: project?.id as string })
        worktree = join(project?.worktreesRoot as string, task.directory as string)
        mkdirSync(worktree, { recursive: true })
      })
      When('I ask which project is at that worktree', () => ask(() => worktree)())
      Then('the answer is "factory"', named('factory'))
      And('it matched a worktree', by('worktree'))
      And('it names the directory "add-due-dates"', () =>
        expect(answer?.taskDirectory).toBe('add-due-dates'),
      )
    })

    RuleScenario('A relative path is refused', ({ Given, When, Then }) => {
      Given('the project "factory" exists', () => add('factory'))
      When('I ask which project is at "../somewhere"', ask(() => '../somewhere'))
      Then('it is refused', () => expect(failure).toBeDefined())
    })
  })

  Rule('a project carries the one command that checks its own work', ({ RuleScenario }) => {
    const exists = (): void => add('factory')
    const setCheck = (check: string | undefined) => (): void =>
      attempt(() => {
        project = projects.setCheck((project as Project).id, check)
      })
    const hasNone = (): void => expect(project?.check).toBeUndefined()
    const is = (command: string) => (): void => expect(project?.check).toBe(command)

    RuleScenario('A new project has no check command', ({ When, Then }) => {
      When('I add the project "factory" at that directory', exists)
      Then('the project has no check command', hasNone)
    })

    RuleScenario('A check command can be given when the project is added', ({ When, Then }) => {
      When('I add the project "factory" with the check command "pnpm test"', () =>
        attempt(() => {
          project = projects.add({ name: 'factory', path: repo, check: 'pnpm test' })
        }),
      )
      Then('the project\'s check command is "pnpm test"', is('pnpm test'))
    })

    RuleScenario('A check command can be set later', ({ Given, When, Then }) => {
      Given('the project "factory" exists', exists)
      When('I set its check command to "make check"', setCheck('make check'))
      Then('the project\'s check command is "make check"', is('make check'))
    })

    RuleScenario('Whitespace around it is not part of the command', ({ Given, When, Then }) => {
      Given('the project "factory" exists', exists)
      When('I set its check command to "  pnpm test  "', setCheck('  pnpm test  '))
      Then('the project\'s check command is "pnpm test"', is('pnpm test'))
    })

    RuleScenario('A blank check command clears it', ({ Given, And, When, Then }) => {
      Given('the project "factory" exists', exists)
      And('its check command is "pnpm test"', setCheck('pnpm test'))
      When('I set its check command to "   "', setCheck('   '))
      Then('the project has no check command', hasNone)
    })

    RuleScenario('A check command edited to blank by hand reads as unset', ({
      Given,
      And,
      Then,
    }) => {
      Given('the project "factory" exists', exists)
      And('its check command column is edited by hand to "   "', () => {
        store.db.run(
          'UPDATE projects SET check_command = ? WHERE id = ?',
          '   ',
          (project as Project).id,
        )
        project = projects.get((project as Project).id)
      })
      Then('the project has no check command', hasNone)
    })

    RuleScenario('Setting it is announced', ({ Given, When, Then }) => {
      Given('the project "factory" exists', exists)
      When('I set its check command to "pnpm test"', setCheck('pnpm test'))
      Then('a "project.changed" event says so', () =>
        expect(events.filter((event) => event.name === 'project.changed')).not.toHaveLength(0),
      )
    })

    RuleScenario('It survives a rename', ({ Given, And, When, Then }) => {
      Given('the project "factory" exists', exists)
      And('its check command is "pnpm test"', setCheck('pnpm test'))
      When('I rename it to "factory-core"', () =>
        attempt(() => {
          project = projects.rename((project as Project).id, 'factory-core')
        }),
      )
      Then('the project\'s check command is "pnpm test"', is('pnpm test'))
    })
  })

  Rule('a project says which model judges its work, and whether one does at all', ({
    RuleScenario,
  }) => {
    const exists = (): void => add('factory')
    const setModel = (model: string | undefined) => (): void =>
      attempt(() => {
        project = projects.setReliabilityModel((project as Project).id, model)
      })
    const namesNone = (): void => expect(project?.reliabilityModel).toBeUndefined()
    const is = (model: string) => (): void => expect(project?.reliabilityModel).toBe(model)

    RuleScenario('A new project has no judging model', ({ When, Then }) => {
      When('I add the project "factory" at that directory', exists)
      Then('the project names no judging model', namesNone)
    })

    RuleScenario('A judging model can be chosen', ({ Given, When, Then }) => {
      Given('the project "factory" exists', exists)
      When('I set its judging model to "claude-opus-5-5"', setModel('claude-opus-5-5'))
      Then('the project\'s judging model is "claude-opus-5-5"', is('claude-opus-5-5'))
    })

    RuleScenario('Whitespace around it is not part of the model', ({ Given, When, Then }) => {
      Given('the project "factory" exists', exists)
      When('I set its judging model to "  claude-opus-5-5  "', setModel('  claude-opus-5-5  '))
      Then('the project\'s judging model is "claude-opus-5-5"', is('claude-opus-5-5'))
    })

    RuleScenario('A blank model clears it', ({ Given, And, When, Then }) => {
      Given('the project "factory" exists', exists)
      And('its judging model is "claude-opus-5-5"', setModel('claude-opus-5-5'))
      When('I set its judging model to "   "', setModel('   '))
      Then('the project names no judging model', namesNone)
    })

    RuleScenario('A model edited to blank by hand reads as unset', ({ Given, And, Then }) => {
      Given('the project "factory" exists', exists)
      And('its judging model column is edited by hand to "   "', () => {
        store.db.run(
          'UPDATE projects SET reliability_model = ? WHERE id = ?',
          '   ',
          (project as Project).id,
        )
        project = projects.get((project as Project).id)
      })
      Then('the project names no judging model', namesNone)
    })

    RuleScenario('Judging is on until somebody turns it off', ({ When, Then }) => {
      When('I add the project "factory" at that directory', exists)
      Then('the project is judged', () => {
        expect(project?.reliabilityEnabled).toBe(true)
      })
    })

    RuleScenario('Judging can be turned off', ({ Given, When, Then }) => {
      Given('the project "factory" exists', exists)
      When('I stop its work being judged', () =>
        attempt(() => {
          project = projects.setReliabilityEnabled((project as Project).id, false)
        }),
      )
      Then('the project is not judged', () => {
        expect(project?.reliabilityEnabled).toBe(false)
      })
    })

    RuleScenario('Turning judging off keeps the model that was chosen', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('the project "factory" exists', exists)
      And('its judging model is "claude-opus-5-5"', setModel('claude-opus-5-5'))
      When('I stop its work being judged', () =>
        attempt(() => {
          project = projects.setReliabilityEnabled((project as Project).id, false)
        }),
      )
      Then('the project\'s judging model is "claude-opus-5-5"', is('claude-opus-5-5'))
    })

    RuleScenario('Choosing a model is announced', ({ Given, When, Then }) => {
      Given('the project "factory" exists', exists)
      When('I set its judging model to "claude-opus-5-5"', setModel('claude-opus-5-5'))
      Then('a "project.changed" event says so', () =>
        expect(events.filter((event) => event.name === 'project.changed')).not.toHaveLength(0),
      )
    })

    RuleScenario('The choice survives a rename', ({ Given, And, When, Then }) => {
      Given('the project "factory" exists', exists)
      And('its judging model is "claude-opus-5-5"', setModel('claude-opus-5-5'))
      When('I rename it to "factory-core"', () =>
        attempt(() => {
          project = projects.rename((project as Project).id, 'factory-core')
        }),
      )
      Then('the project\'s judging model is "claude-opus-5-5"', is('claude-opus-5-5'))
    })
  })
})

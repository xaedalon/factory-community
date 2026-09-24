import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventBus } from '@factory/events'
import { REQUESTABLE_ACTIONS, type Task, type TaskEdge } from '@factory/core'
import {
  MIGRATIONS,
  ProjectRepository,
  RunRepository,
  TaskRepository,
  openStore,
  type Store,
} from '../src/index.js'

const feature = await loadFeature(fileURLToPath(new URL('./tasks.feature', import.meta.url)))

describeFeature(feature, ({ Background, Rule, Scenario, AfterEachScenario }) => {
  let store: Store
  let tasks: TaskRepository
  let runs: RunRepository
  let task: Task | undefined
  let byName: Map<string, string>
  let failure: unknown
  let tick = 0
  let minted = 0
  let home = ''
  let roots: string[] = []

  AfterEachScenario(() => {
    store?.close()
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  })

  // A directory that looks like a git repository, for a project to point at.
  const somewhere = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'factory-tasks-'))
    mkdirSync(join(root, '.git'), { recursive: true })
    roots.push(root)
    return root
  }
  const projectsIn = (): ProjectRepository =>
    new ProjectRepository({
      db: store.db,
      now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString(),
      newId: () => `project-${(minted += 1)}`,
    })

  // Built in Background, not BeforeEachScenario: the runner executes Background
  // steps first, so anything created there would not exist yet.
  Background(({ Given, And }) => {
    Given('an empty store', () => {
      tick = 0
      minted = 0
      roots = []
      byName = new Map()
      failure = undefined
      task = undefined
      store = openStore({ file: ':memory:', migrations: MIGRATIONS })
      tasks = new TaskRepository({
        db: store.db,
        events: new EventBus({ onSubscriberError: () => {} }),
        // Monotonic and fake, so ordering assertions are about ordering rather
        // than about how fast the test happened to run.
        now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString(),
        // Monotonic per call, not per task: entry ids come from here too, and
        // a task with three workflows would otherwise mint the same id three
        // times and collide on (task_id, entry_id).
        newId: () => `id-${(minted += 1)}`,
      })
      runs = new RunRepository({
        db: store.db,
        now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString(),
        newId: () => `run-${(minted += 1)}`,
      })
    })
    // Every task needs one now, so it is stated in the Background rather than
    // conjured by the harness: a task with no project would run wherever the
    // daemon was started.
    And('a project to put tasks in', () => {
      home = projectsIn().add({ name: 'sample', path: somewhere() }).id
    })
  })

  // Returns nothing on purpose: the step callbacks are typed `void`, and a
  // concise arrow that returns the task silently breaks the typecheck.
  const create = (name: string, workflows: string[] = []): void => {
    const created = tasks.create({ name, workflows, projectId: home })
    byName.set(name, created.id)
    task = created
  }
  const idOf = (name: string) => byName.get(name) as string
  const act = (action: Parameters<TaskRepository['act']>[1], reason?: string) => {
    try {
      task = tasks.act(task!.id, action, reason === undefined ? {} : { reason })
    } catch (error) {
      failure = error
    }
  }
  const offered = () => tasks.actions(task!.id).map((entry) => entry.action).sort().join(', ')

  Scenario('A new task starts as a draft', ({ When, Then, And }) => {
    When('I create a task "Add due dates"', () => create('Add due dates'))
    Then('the task is "draft"', () => expect(task?.state).toBe('draft'))
    And('its history is empty', () => expect(tasks.history(task!.id)).toHaveLength(0))
  })

  Scenario('A draft with no workflows cannot be queued', ({ When, Then }) => {
    When('I create a task "Add due dates"', () => create('Add due dates'))
    // Queueing something with nothing to run would put it in front of the
    // scheduler only to be rejected there.
    Then('"queue" is not offered', () => expect(offered()).not.toContain('queue'))
  })

  Scenario('Assigning a workflow makes it queueable', ({ Given, When, Then }) => {
    Given('a task "Add due dates"', () => create('Add due dates'))
    When('I assign the workflow "development"', () => {
      task = tasks.assign(task!.id, ['development'])
    })
    Then('"queue" is offered', () => expect(offered()).toContain('queue'))
  })

  Scenario('Queueing puts it in line', ({ Given, When, Then, And }) => {
    Given('a task "Add due dates" with the workflow "development"', () =>
      create('Add due dates', ['development']),
    )
    When('I queue it', () => act('queue'))
    Then('the task is "queued"', () => expect(task?.state).toBe('queued'))
    And('it has a place in the queue', () => expect(task?.queuePosition).toBeGreaterThan(0))
  })

  Scenario('Tasks queue behind each other', ({ Given, And, When, Then }) => {
    Given('a task "First" with the workflow "development"', () => create('First', ['development']))
    And('a task "Second" with the workflow "development"', () => create('Second', ['development']))
    When('I queue "First"', () => {
      task = tasks.act(idOf('First'), 'queue')
    })
    And('I queue "Second"', () => {
      task = tasks.act(idOf('Second'), 'queue')
    })
    Then('"Second" is behind "First" in the queue', () => {
      const first = tasks.get(idOf('First'))!
      const second = tasks.get(idOf('Second'))!
      expect(second.queuePosition!).toBeGreaterThan(first.queuePosition!)
    })
  })

  Scenario('Every transition is recorded', ({ Given, When, Then, And }) => {
    Given('a task "Add due dates" with the workflow "development"', () =>
      create('Add due dates', ['development']),
    )
    When('I queue it', () => act('queue'))
    Then('its history has 1 entry', () => expect(tasks.history(task!.id)).toHaveLength(1))
    And('the entry says it went from "draft" to "queued"', () => {
      const [entry] = tasks.history(task!.id)
      expect(entry?.from).toBe('draft')
      expect(entry?.to).toBe('queued')
    })
  })

  const givenRunning = () => {
    create('Add due dates', ['development'])
    act('queue')
    act('start')
  }

  Scenario('A blocked task records why', ({ Given, When, Then, And }) => {
    Given('a running task', givenRunning)
    When('it is blocked because "the tests failed"', () => act('block', 'the tests failed'))
    Then('the task is "blocked"', () => expect(task?.state).toBe('blocked'))
    And('the reason is "the tests failed"', () =>
      expect(task?.blockedReason).toBe('the tests failed'),
    )
  })

  Scenario('Retrying clears the reason', ({ Given, And, When, Then }) => {
    Given('a running task', givenRunning)
    And('it is blocked because "the tests failed"', () => act('block', 'the tests failed'))
    When('I retry it', () => act('retry'))
    Then('the task is "queued"', () => expect(task?.state).toBe('queued'))
    And('there is no reason recorded', () => expect(task?.blockedReason).toBeUndefined())
  })

  Scenario('A finished task can be run again', ({ Given, When, Then, And }) => {
    Given('a running task', givenRunning)
    When('it completes', () => act('complete'))
    Then('the task is "done"', () => expect(task?.state).toBe('done'))
    And('it has a completion time', () => expect(task?.completedAt).toBeDefined())
    When('I queue it again', () => act('queue'))
    Then('the task is "queued"', () => expect(task?.state).toBe('queued'))
    // A task claiming to be both done and queued is the kind of contradiction
    // that makes a board impossible to read.
    And('it no longer has a completion time', () => expect(task?.completedAt).toBeUndefined())
  })

  Scenario('An action the state does not allow is refused', ({ Given, When, Then, And }) => {
    Given('a task "Add due dates" with the workflow "development"', () =>
      create('Add due dates', ['development']),
    )
    When('I try to approve it', () => act('approve'))
    Then('it is refused', () => expect(failure).toBeDefined())
    And('the error says what is available instead', () =>
      expect((failure as Error).message).toContain('Available:'),
    )
  })

  Scenario('The available actions depend on the state', ({ Given, Then, When }) => {
    Given('a task "Add due dates" with the workflow "development"', () =>
      create('Add due dates', ['development']),
    )
    Then('the offered actions are "archive, cancel, mark_done, queue"', () =>
      expect(offered()).toBe('archive, cancel, mark_done, queue'),
    )
    When('I queue it', () => act('queue'))
    Then('the offered actions are "cancel, mark_done"', () =>
      expect(offered()).toBe('cancel, mark_done'),
    )
  })

  Scenario('Internal actions are not offered to a person', ({ Given, When, Then }) => {
    Given('a task "Add due dates" with the workflow "development"', () =>
      create('Add due dates', ['development']),
    )
    When('I queue it', () => act('queue'))
    // `start` belongs to the scheduler. Offering it would invite someone to
    // bypass the concurrency cap by hand.
    Then('"start" is not offered', () => expect(offered()).not.toContain('start'))
  })

  const givenAwaiting = () => {
    givenRunning()
    // Through the real door: the engine asks for this when a phase needs a
    // person, so the fixture must too.
    act('await_approval')
  }

  Scenario('A task awaiting approval can be approved or rejected', ({ Given, Then }) => {
    Given('a task awaiting approval', givenAwaiting)
    Then('the offered actions are "approve, cancel, reject"', () =>
      expect(offered()).toBe('approve, cancel, reject'),
    )
  })

  Scenario('Approving resumes it', ({ Given, When, Then }) => {
    Given('a task awaiting approval', givenAwaiting)
    When('I approve it', () => act('approve'))
    Then('the task is "running"', () => expect(task?.state).toBe('running'))
  })

  Scenario('Rejecting blocks it', ({ Given, When, Then }) => {
    Given('a task awaiting approval', givenAwaiting)
    When('I reject it', () => act('reject'))
    Then('the task is "blocked"', () => expect(task?.state).toBe('blocked'))
  })

  Scenario('Archiving hides it from the board', ({ Given, When, Then, And }) => {
    Given('a task "Add due dates" with the workflow "development"', () =>
      create('Add due dates', ['development']),
    )
    When('I archive it', () => act('archive'))
    Then('the task is "archived"', () => expect(task?.state).toBe('archived'))
    And('it is not in the default listing', () => expect(tasks.list()).toHaveLength(0))
    And('it is in the listing that includes archived tasks', () =>
      expect(tasks.list({ includeArchived: true })).toHaveLength(1),
    )
  })

  Scenario('A restored task comes back as a draft', ({ Given, And, When, Then }) => {
    Given('a task "Add due dates" with the workflow "development"', () =>
      create('Add due dates', ['development']),
    )
    And('it is archived', () => act('archive'))
    When('I restore it', () => act('restore'))
    Then('the task is "draft"', () => expect(task?.state).toBe('draft'))
  })

  Scenario('Cancelling is possible from anywhere that is still live', ({ Given, When, Then }) => {
    Given('a running task', givenRunning)
    When('I cancel it', () => act('cancel'))
    Then('the task is "cancelled"', () => expect(task?.state).toBe('cancelled'))
  })

  Scenario('A transition and its history are written together', ({ Given, When, Then }) => {
    Given('a task "Add due dates" with the workflow "development"', () =>
      create('Add due dates', ['development']),
    )
    When('a transition fails partway', () => {
      // The history insert is forced to fail, which must take the state change
      // with it: a recorded transition that did not happen, or a transition
      // with no record, are both worse than the write simply failing.
      store.db.exec('DROP TABLE task_history')
      act('queue')
    })
    Then('no history was recorded', () => {
      expect(failure).toBeDefined()
      expect(tasks.get(task!.id)?.state).toBe('draft')
    })
  })

  Rule('Editing the list keeps what each entry already knows', ({ RuleScenario }) => {
    /**
     * Two of three finished.
     *
     * "Has run" is derived from the runs rather than stored, so the fixture has
     * to produce real ones — which is the point: nothing can claim an entry ran
     * without a run to show for it.
     */
    const twoDone = (): void => {
      create('Add due dates', ['one', 'two', 'three'])
      for (const entry of task!.workflows.slice(0, 2)) {
        const run = runs.start({ workflow: entry.workflow, taskId: task!.id, entryId: entry.id })
        runs.finish(run.id, 'completed')
        task = tasks.finished(task!.id, entry.id)
      }
      task = tasks.get(task!.id)
    }
    const names = () => task!.workflows.map((entry) => entry.workflow)
    const ticked = (name: string) =>
      task!.workflows.find((entry) => entry.workflow === name)?.enabled
    const assign = (selection: Parameters<typeof tasks.assign>[1]): void => {
      try {
        task = tasks.assign(task!.id, selection)
      } catch (error) {
        failure = error
      }
    }
    const entriesExcept = (name: string) =>
      task!.workflows.filter((entry) => entry.workflow !== name).map((entry) => ({ ...entry }))

    const givenTwoDone = 'a task with "one", "two" and "three", of which "one" and "two" have run'

    RuleScenario("Reordering keeps every entry's tick", ({ Given, When, Then, And }) => {
      Given(givenTwoDone, twoDone)
      When('I put the same workflows in a different order', () =>
        assign([...task!.workflows].reverse().map((entry) => ({ ...entry }))),
      )
      // The edit that used to cost you every finished workflow.
      Then('"one" and "two" are still unticked', () => {
        expect(ticked('one')).toBe(false)
        expect(ticked('two')).toBe(false)
      })
      And('"three" is still ticked', () => expect(ticked('three')).toBe(true))
    })

    RuleScenario('Adding a workflow leaves the others alone', ({ Given, When, Then, And }) => {
      Given(givenTwoDone, twoDone)
      When('I add "four" to the end', () =>
        assign([...task!.workflows.map((entry) => ({ ...entry })), 'four']),
      )
      Then('"one" and "two" are still unticked', () => {
        expect(ticked('one')).toBe(false)
        expect(ticked('two')).toBe(false)
      })
      And('"four" is ticked', () => expect(ticked('four')).toBe(true))
    })

    RuleScenario('Saving an unedited list changes nothing', ({ Given, When, Then }) => {
      Given(givenTwoDone, twoDone)
      When('I assign the same list of workflows', () =>
        assign(task!.workflows.map((entry) => ({ ...entry }))),
      )
      Then('"one" and "two" are still unticked', () => {
        expect(ticked('one')).toBe(false)
        expect(ticked('two')).toBe(false)
      })
    })

    RuleScenario('A workflow that has never run can be taken off', ({ Given, When, Then }) => {
      Given(givenTwoDone, twoDone)
      When('I take "three" off the list', () => assign(entriesExcept('three')))
      Then('the list is "one, two"', () => expect(names()).toEqual(['one', 'two']))
    })

    RuleScenario('A workflow that has run cannot be taken off', ({ Given, When, Then, And }) => {
      Given(givenTwoDone, twoDone)
      When('I take "two" off the list', () => assign(entriesExcept('two')))
      Then('the change is refused', () => expect(failure).toBeInstanceOf(Error))
      And('the refusal names "two"', () => expect(String(failure)).toContain('two'))
    })

    // All or nothing: the refusal is raised before anything is written.
    RuleScenario('Nothing is half-applied when a removal is refused', ({ Given, When, Then }) => {
      Given(givenTwoDone, twoDone)
      When('I take "two" off the list', () => assign(entriesExcept('two')))
      Then('the list is still "one, two, three"', () => {
        expect(tasks.get(task!.id)?.workflows.map((entry) => entry.workflow)).toEqual([
          'one',
          'two',
          'three',
        ])
      })
    })
  })

  Rule('A workflow is ticked until the engine has finished with it', ({ RuleScenario }) => {
    const ticked = (name: string) =>
      task!.workflows.find((entry) => entry.workflow === name)?.enabled
    const canQueue = () =>
      tasks.actions(task!.id).some((available) => available.action === 'queue')

    RuleScenario('A new task has everything ticked', ({ Given, Then }) => {
      Given('a task "Add due dates" with the workflow "development"', () =>
        create('Add due dates', ['development']),
      )
      Then('"development" is ticked', () => expect(ticked('development')).toBe(true))
    })

    const allOff = (): void => {
      create('Add due dates', ['one', 'two', 'three'])
      task = tasks.assign(
        task!.id,
        task!.workflows.map((entry) => ({ ...entry, enabled: false })),
      )
    }

    RuleScenario('A task with nothing ticked cannot be queued', ({ Given, And, Then }) => {
      Given('a task with "one", "two" and "three", of which "one" and "two" have run', allOff)
      And('"three" is unticked as well', () => undefined)
      // One click should never set five agents on a repository because
      // everything happened to be finished.
      Then('it cannot be queued', () => expect(canQueue()).toBe(false))
    })

    RuleScenario('Ticking one back on makes it queueable again', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('a task with "one", "two" and "three", of which "one" and "two" have run', allOff)
      And('"three" is unticked as well', () => undefined)
      When('I tick "one" back on', () => {
        task = tasks.assign(
          task!.id,
          task!.workflows.map((entry) =>
            entry.workflow === 'one' ? { ...entry, enabled: true } : { ...entry },
          ),
        )
      })
      Then('it can be queued', () => expect(canQueue()).toBe(true))
    })
  })

  Rule('A task can be renamed without losing where its work lives', ({ RuleScenario }) => {
    let directoryBefore = ''

    const givenTask = (): void => {
      create('Add due dates', ['development'])
      directoryBefore = task?.directory ?? ''
    }
    const renameTo = (name: string): void => {
      try {
        task = tasks.rename(task!.id, name)
      } catch (error) {
        failure = error
      }
    }

    RuleScenario('Renaming changes the name', ({ Given, When, Then }) => {
      Given('a task "Add due dates" with the workflow "development"', givenTask)
      When('I rename it to "Add due dates and times"', () => renameTo('Add due dates and times'))
      Then('the task is called "Add due dates and times"', () =>
        expect(task?.name).toBe('Add due dates and times'),
      )
    })

    RuleScenario('Renaming leaves the directory alone', ({ Given, When, Then }) => {
      Given('a task "Add due dates" with the workflow "development"', givenTask)
      When('I rename it to "Something else entirely"', () => renameTo('Something else entirely'))
      // Otherwise the worktree it is working in becomes unreachable, and a
      // later step runs in the repository instead without saying so.
      Then('its directory is unchanged', () => {
        expect(task?.directory).toBe(directoryBefore)
        expect(directoryBefore).not.toBe('')
      })
    })

    RuleScenario('A task cannot be renamed to nothing', ({ Given, When, Then }) => {
      Given('a task "Add due dates" with the workflow "development"', givenTask)
      When('I rename it to "   "', () => renameTo('   '))
      Then('the rename is refused', () => expect(failure).toBeInstanceOf(Error))
    })
  })

  Rule('A task says what it is for, separately from what it is called', ({ RuleScenario }) => {
    let directoryBefore = ''

    const givenTask = (): void => {
      create('Add due dates', ['development'])
      directoryBefore = task?.directory ?? ''
    }
    const givenDescribed = (description: string): void => {
      givenTask()
      task = tasks.describe(task!.id, description)
    }
    const describeAs = (description: string): void => {
      task = tasks.describe(task!.id, description)
    }

    RuleScenario('A task with no description has an empty one, not a missing one', ({
      Given,
      Then,
    }) => {
      Given('a task "Add due dates" with the workflow "development"', givenTask)
      // '' rather than undefined, so `{{ task.description }}` resolves to
      // nothing instead of warning about a key the dictionary documents.
      Then('its description is empty', () => expect(task?.description).toBe(''))
    })

    RuleScenario('Describing a task', ({ Given, When, Then }) => {
      Given('a task "Add due dates" with the workflow "development"', givenTask)
      When('I describe it as "Every todo gets an optional due date, shown on the list."', () =>
        describeAs('Every todo gets an optional due date, shown on the list.'),
      )
      Then('its description is "Every todo gets an optional due date, shown on the list."', () =>
        expect(task?.description).toBe('Every todo gets an optional due date, shown on the list.'),
      )
    })

    RuleScenario('A description can be cleared', ({ Given, When, Then }) => {
      Given('a task "Add due dates" described as "Something provisional"', () =>
        givenDescribed('Something provisional'),
      )
      When('I describe it as ""', () => describeAs(''))
      Then('its description is empty', () => expect(task?.description).toBe(''))
    })

    RuleScenario('Renaming leaves the description alone', ({ Given, When, Then }) => {
      Given('a task "Add due dates" described as "Every todo gets an optional due date."', () =>
        givenDescribed('Every todo gets an optional due date.'),
      )
      When('I rename it to "Something else entirely"', () => {
        task = tasks.rename(task!.id, 'Something else entirely')
      })
      Then('its description is "Every todo gets an optional due date."', () =>
        expect(task?.description).toBe('Every todo gets an optional due date.'),
      )
    })

    RuleScenario('Describing leaves the name and the directory alone', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given('a task "Add due dates" with the workflow "development"', givenTask)
      When('I describe it as "A brief."', () => describeAs('A brief.'))
      Then('the task is called "Add due dates"', () => expect(task?.name).toBe('Add due dates'))
      And('its directory is unchanged', () => {
        expect(task?.directory).toBe(directoryBefore)
        expect(directoryBefore).not.toBe('')
      })
    })
  })

  Rule('A task remembers the agent session its steps share', ({ RuleScenario }) => {
    const given = () => {
      task = tasks.create({ name: 'Add due dates', projectId: home })
    }
    const record = (id: string) => () => {
      task = tasks.rememberSession((task as Task).id, { id, provider: 'claude' })
    }
    const carries = (id: string) => () => expect(task?.session?.id).toBe(id)

    RuleScenario('A new task has no session', ({ Given, Then }) => {
      Given('the task "Add due dates" exists', given)
      Then('it carries no session', () => expect(task?.session).toBeUndefined())
    })

    RuleScenario('A session is written down and read back', ({ Given, When, Then, And }) => {
      Given('the task "Add due dates" exists', given)
      When('the session "s-1" for "claude" is recorded', record('s-1'))
      Then('it carries the session "s-1"', carries('s-1'))
      And('the session belongs to "claude"', () =>
        expect(task?.session?.provider).toBe('claude'),
      )
    })

    RuleScenario('The first one recorded is the one it keeps', ({ Given, And, When, Then }) => {
      Given('the task "Add due dates" exists', given)
      And('the session "s-1" for "claude" is recorded', record('s-1'))
      When('the session "s-2" for "claude" is recorded', record('s-2'))
      Then('it carries the session "s-1"', carries('s-1'))
    })

    RuleScenario('A session for a task that is not there is an error', ({ When, Then }) => {
      When('the session "s-1" is recorded for a task that does not exist', () => {
        try {
          tasks.rememberSession('nope', { id: 's-1', provider: 'claude' })
        } catch (error) {
          failure = error
        }
      })
      Then('it fails', () => expect(failure).toBeInstanceOf(Error))
    })
  })

  Rule('A task\'s directory is a single path segment, whoever chose it', ({ RuleScenario }) => {
    const created = (name: string, directory?: string) => (): void => {
      task = tasks.create({
        name,
        projectId: home,
        ...(directory === undefined ? {} : { directory }),
      })
    }
    const directoryIs = (expected: string) => (): void => {
      expect(task?.directory).toBe(expected)
    }
    const noSeparator = (): void => {
      expect(task?.directory).not.toContain('/')
      expect(task?.directory).not.toContain('\\')
      expect(task?.directory).not.toContain('..')
    }

    RuleScenario('A directory derived from the name is slugged', ({ When, Then }) => {
      When('a task called "Add due dates" is created', created('Add due dates'))
      Then('its directory is "add-due-dates"', directoryIs('add-due-dates'))
    })

    RuleScenario('A supplied directory is slugged too', ({ When, Then }) => {
      When(
        'a task is created asking for the directory "Add Due Dates"',
        created('Add due dates', 'Add Due Dates'),
      )
      Then('its directory is "add-due-dates"', directoryIs('add-due-dates'))
    })

    RuleScenario('A supplied directory cannot climb out', ({ When, Then, And }) => {
      When(
        'a task is created asking for the directory "../../escape"',
        created('Add due dates', '../../escape'),
      )
      Then('its directory is "escape"', directoryIs('escape'))
      And('its directory contains no separator', noSeparator)
    })

    RuleScenario('An absolute supplied directory cannot restart the path', ({
      When,
      Then,
      And,
    }) => {
      When(
        'a task is created asking for the directory "/etc/passwd"',
        created('Add due dates', '/etc/passwd'),
      )
      Then('its directory is "etc-passwd"', directoryIs('etc-passwd'))
      And('its directory contains no separator', noSeparator)
    })

    RuleScenario('A supplied directory that slugs away still gets a name', ({ When, Then }) => {
      When(
        'a task is created asking for the directory "../.."',
        created('Add due dates', '../..'),
      )
      Then('its directory is "task"', directoryIs('task'))
    })

    RuleScenario('Two tasks never share a directory, even when both ask for one', ({
      Given,
      When,
      Then,
    }) => {
      Given(
        'a task is created asking for the directory "shared"',
        created('First task', 'shared'),
      )
      When(
        'a task is created asking for the directory "shared"',
        created('Second task', 'shared'),
      )
      Then('its directory is "shared-2"', directoryIs('shared-2'))
    })
  })

  Rule('A task can be made to wait for another in the same project', ({ RuleScenario }) => {
    let edges: readonly TaskEdge[] = []

    // These scenarios need projects of their own, beside the one every task
    // gets from the Background, because the rule is about two of them.
    const projects = new Map<string, string>()
    const addProject = (name: string) => (): void => {
      projects.set(name, projectsIn().add({ name, path: somewhere() }).id)
    }
    const createIn = (name: string, project: string) => (): void => {
      const created = tasks.create({ name, projectId: projects.get(project) as string })
      byName.set(name, created.id)
      task = created
    }
    const exists = (name: string) => (): void => create(name)
    const waitFor = (name: string, blocker: string) => (): void => {
      try {
        task = tasks.dependOn(idOf(name), idOf(blocker))
      } catch (error) {
        failure = error
      }
    }
    const stopWaiting = (name: string, blocker: string) => (): void => {
      task = tasks.independ(idOf(name), idOf(blocker))
    }
    const waitsFor = (name: string, blockers: readonly string[]) => (): void => {
      expect(tasks.get(idOf(name))?.dependsOn).toEqual(blockers.map(idOf))
    }
    const refused = (): void => expect(failure).toBeInstanceOf(Error)
    const refusalSays = (fragment: string) => (): void => {
      expect((failure as Error).message).toContain(fragment)
    }
    const rowsLeft = (): number =>
      store.db.all<{ task_id: string }>('SELECT task_id FROM task_dependencies').length

    RuleScenario('A new task waits for nothing', ({ Given, Then }) => {
      Given('the task "Add due dates" exists', exists('Add due dates'))
      Then('it waits for nothing', () => expect(task?.dependsOn).toEqual([]))
    })

    RuleScenario('One task is made to wait for another', ({ Given, And, When, Then }) => {
      Given('the task "Scaffold" exists', exists('Scaffold'))
      And('the task "The model" exists', exists('The model'))
      When('"The model" is made to wait for "Scaffold"', waitFor('The model', 'Scaffold'))
      Then('"The model" waits for "Scaffold"', waitsFor('The model', ['Scaffold']))
      And('"Scaffold" waits for nothing', waitsFor('Scaffold', []))
    })

    RuleScenario('The same edge twice is one edge', ({ Given, And, When, Then }) => {
      Given('the task "Scaffold" exists', exists('Scaffold'))
      And('the task "The model" exists', exists('The model'))
      And('"The model" is made to wait for "Scaffold"', waitFor('The model', 'Scaffold'))
      When('"The model" is made to wait for "Scaffold" again', waitFor('The model', 'Scaffold'))
      Then('"The model" waits for exactly 1 task', () => {
        expect(tasks.get(idOf('The model'))?.dependsOn).toHaveLength(1)
        expect(failure).toBeUndefined()
      })
    })

    RuleScenario('The edge can be taken back', ({ Given, And, When, Then }) => {
      Given('the task "Scaffold" exists', exists('Scaffold'))
      And('the task "The model" exists', exists('The model'))
      And('"The model" is made to wait for "Scaffold"', waitFor('The model', 'Scaffold'))
      When('"The model" stops waiting for "Scaffold"', stopWaiting('The model', 'Scaffold'))
      Then('"The model" waits for nothing', waitsFor('The model', []))
    })

    RuleScenario('Taking back an edge that is not there is not an error', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('the task "Scaffold" exists', exists('Scaffold'))
      And('the task "The model" exists', exists('The model'))
      When('"The model" stops waiting for "Scaffold"', stopWaiting('The model', 'Scaffold'))
      Then('"The model" waits for nothing', waitsFor('The model', []))
    })

    RuleScenario('A task cannot wait for itself', ({ Given, When, Then, And }) => {
      Given('the task "Scaffold" exists', exists('Scaffold'))
      When('"Scaffold" is made to wait for "Scaffold"', waitFor('Scaffold', 'Scaffold'))
      Then('it is refused', refused)
      And('the refusal says it cannot depend on itself', () => {
        expect((failure as Error).message).toBe('"Scaffold" cannot depend on itself.')
      })
    })

    RuleScenario('A task cannot wait for one in another project', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('the project "one" exists', addProject('one'))
      And('the project "two" exists', addProject('two'))
      And('the task "Scaffold" exists in "one"', createIn('Scaffold', 'one'))
      And('the task "The model" exists in "two"', createIn('The model', 'two'))
      When('"The model" is made to wait for "Scaffold"', waitFor('The model', 'Scaffold'))
      Then('it is refused', refused)
      And('the refusal says they are in different projects', refusalSays('different projects'))
    })

    RuleScenario('A task cannot wait for one that is not there', ({ Given, When, Then }) => {
      Given('the task "The model" exists', exists('The model'))
      When('"The model" is made to wait for a task that does not exist', () => {
        try {
          tasks.dependOn(idOf('The model'), 'nope')
        } catch (error) {
          failure = error
        }
      })
      Then('it is refused', refused)
    })

    RuleScenario('An edge that would make a ring is refused', ({ Given, And, When, Then }) => {
      Given('the task "Scaffold" exists', exists('Scaffold'))
      And('the task "The model" exists', exists('The model'))
      And('"The model" is made to wait for "Scaffold"', waitFor('The model', 'Scaffold'))
      When('"Scaffold" is made to wait for "The model"', waitFor('Scaffold', 'The model'))
      Then('it is refused', refused)
      And('the refusal says it would make a ring', refusalSays('ring'))
    })

    RuleScenario('A longer ring is refused too', ({ Given, And, When, Then }) => {
      Given('the task "One" exists', exists('One'))
      And('the task "Two" exists', exists('Two'))
      And('the task "Three" exists', exists('Three'))
      And('"Two" is made to wait for "One"', waitFor('Two', 'One'))
      And('"Three" is made to wait for "Two"', waitFor('Three', 'Two'))
      When('"One" is made to wait for "Three"', waitFor('One', 'Three'))
      Then('it is refused', refused)
      And('the refusal says it would make a ring', refusalSays('ring'))
    })

    RuleScenario('Deleting the waiting task removes the edge', ({ Given, And, When, Then }) => {
      Given('the task "Scaffold" exists', exists('Scaffold'))
      And('the task "The model" exists', exists('The model'))
      And('"The model" is made to wait for "Scaffold"', waitFor('The model', 'Scaffold'))
      When('"The model" is deleted', () => {
        tasks.delete(idOf('The model'))
      })
      Then('no dependency rows are left', () => expect(rowsLeft()).toBe(0))
    })

    RuleScenario('Deleting the blocker removes the edge', ({ Given, And, When, Then }) => {
      Given('the task "Scaffold" exists', exists('Scaffold'))
      And('the task "The model" exists', exists('The model'))
      And('"The model" is made to wait for "Scaffold"', waitFor('The model', 'Scaffold'))
      When('"Scaffold" is deleted', () => {
        tasks.delete(idOf('Scaffold'))
      })
      Then('no dependency rows are left', () => expect(rowsLeft()).toBe(0))
    })

    RuleScenario('Another project\'s edges are left out', ({ Given, And, When, Then }) => {
      Given('the project "one" exists', addProject('one'))
      And('the project "two" exists', addProject('two'))
      And('the task "Scaffold" exists in "one"', createIn('Scaffold', 'one'))
      And('the task "The model" exists in "one"', createIn('The model', 'one'))
      And('the task "Groundwork" exists in "two"', createIn('Groundwork', 'two'))
      And('the task "The view" exists in "two"', createIn('The view', 'two'))
      And('"The model" is made to wait for "Scaffold"', waitFor('The model', 'Scaffold'))
      And('"The view" is made to wait for "Groundwork"', waitFor('The view', 'Groundwork'))
      When('I ask for the edges in "one"', () => {
        edges = tasks.dependenciesIn(projects.get('one') as string)
      })
      Then('there is 1 edge', () => {
        expect(edges).toEqual([{ taskId: idOf('The model'), dependsOn: idOf('Scaffold') }])
      })
    })

    RuleScenario('A project\'s edges are read together', ({ Given, And, When, Then }) => {
      Given('the project "one" exists', addProject('one'))
      And('the task "Scaffold" exists in "one"', createIn('Scaffold', 'one'))
      And('the task "The model" exists in "one"', createIn('The model', 'one'))
      And('"The model" is made to wait for "Scaffold"', waitFor('The model', 'Scaffold'))
      When('I ask for the edges in "one"', () => {
        edges = tasks.dependenciesIn(projects.get('one') as string)
      })
      Then('there is 1 edge', () => {
        expect(edges).toEqual([{ taskId: idOf('The model'), dependsOn: idOf('Scaffold') }])
      })
    })
  })

  Rule('A task can be marked done by hand', ({ RuleScenario }) => {
    const givenDraft = (workflows: string[] = []) => (): void =>
      create('Add due dates', workflows)
    const markDone = (): void => act('mark_done')
    const isDone = (): void => expect(task?.state).toBe('done')

    RuleScenario('A draft can be marked done', ({ Given, When, Then, And }) => {
      Given('a task "Add due dates" with the workflow "development"', givenDraft(['development']))
      When('I mark it done', markDone)
      Then('the task is "done"', isDone)
      And('it has a completion time', () => expect(task?.completedAt).toBeDefined())
    })

    RuleScenario('A task with nothing planned can be marked done', ({ Given, When, Then }) => {
      Given('a task "Add due dates"', givenDraft())
      When('I mark it done', markDone)
      Then('the task is "done"', isDone)
    })

    RuleScenario('A queued task marked done leaves the queue', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('a task "Add due dates" with the workflow "development"', givenDraft(['development']))
      And('I queue it', () => act('queue'))
      When('I mark it done', markDone)
      Then('the task is "done"', isDone)
      And('it has no place in the queue', () => expect(task?.queuePosition).toBeUndefined())
    })

    RuleScenario('A blocked task can be marked done', ({ Given, And, When, Then }) => {
      Given('a running task', givenRunning)
      And('it is blocked because "the tests failed"', () => act('block', 'the tests failed'))
      When('I mark it done', markDone)
      Then('the task is "done"', isDone)
      And('there is no reason recorded', () => expect(task?.blockedReason).toBeUndefined())
    })

    RuleScenario('A running task cannot be marked done by hand', ({ Given, When, Then }) => {
      Given('a running task', givenRunning)
      When('I mark it done', markDone)
      Then('it is refused', () => expect(failure).toBeInstanceOf(Error))
    })

    RuleScenario('A task awaiting approval cannot be marked done by hand', ({
      Given,
      When,
      Then,
    }) => {
      Given('a task awaiting approval', () => {
        givenRunning()
        act('await_approval')
      })
      When('I mark it done', markDone)
      Then('it is refused', () => expect(failure).toBeInstanceOf(Error))
    })

    RuleScenario('Marking done is recorded like any other move', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given('a task "Add due dates" with the workflow "development"', givenDraft(['development']))
      When('I mark it done', markDone)
      Then('its history has 1 entry', () => expect(tasks.history(task!.id)).toHaveLength(1))
      And('the entry says it went from "draft" to "done"', () => {
        const [entry] = tasks.history(task!.id)
        expect(entry?.from).toBe('draft')
        expect(entry?.to).toBe('done')
      })
    })

    RuleScenario('A task marked done by hand earned nothing', ({ Given, When, Then, And }) => {
      Given('a task "Add due dates" with the workflow "development"', givenDraft(['development']))
      When('I mark it done', markDone)
      Then('it has no flags', () => expect(tasks.flags(task!.id)).toEqual([]))
      // Nothing ran, so nothing is ticked off. A hand-done task shows no
      // progress, which is the honest reading.
      And('its workflow is still ticked', () =>
        expect(task?.workflows.every((entry) => entry.enabled)).toBe(true),
      )
    })

    RuleScenario('Completing is still the engine\'s alone', ({ Given, Then }) => {
      Given('a running task', givenRunning)
      Then('"complete" is not offered', () => expect(offered()).not.toContain('complete'))
    })
  })

  Rule('The scheduler can block a task that is still queued', ({ RuleScenario }) => {
    const givenQueued = (): void => {
      create('Add due dates', ['development'])
      act('queue')
    }
    const blocked = (): void => act('block', 'Task 2 was cancelled')

    RuleScenario('A queued task can be blocked with a reason', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('a task "Add due dates" with the workflow "development"', () =>
        create('Add due dates', ['development']),
      )
      And('I queue it', () => act('queue'))
      When('it is blocked because "Task 2 was cancelled"', blocked)
      Then('the task is "blocked"', () => expect(task?.state).toBe('blocked'))
      And('the reason is "Task 2 was cancelled"', () =>
        expect(task?.blockedReason).toBe('Task 2 was cancelled'),
      )
    })

    RuleScenario('Blocking leaves the queue', ({ Given, And, When, Then }) => {
      Given('a task "Add due dates" with the workflow "development"', () =>
        create('Add due dates', ['development']),
      )
      And('I queue it', () => act('queue'))
      When('it is blocked because "Task 2 was cancelled"', blocked)
      Then('it has no place in the queue', () => expect(task?.queuePosition).toBeUndefined())
    })

    RuleScenario('Retrying puts it back in line', ({ Given, And, When, Then }) => {
      Given('a task "Add due dates" with the workflow "development"', () =>
        create('Add due dates', ['development']),
      )
      And('I queue it', () => act('queue'))
      And('it is blocked because "Task 2 was cancelled"', blocked)
      When('I retry it', () => act('retry'))
      Then('the task is "queued"', () => expect(task?.state).toBe('queued'))
      And('there is no reason recorded', () => expect(task?.blockedReason).toBeUndefined())
    })

    RuleScenario('Blocking is never offered to a person', ({ Given, And, Then }) => {
      Given('a task "Add due dates" with the workflow "development"', givenQueued)
      And('I queue it', () => {
        // Queued by the Given: the step is here because the scenario reads
        // better with it, and acting again would be refused.
      })
      Then('"block" is not offered', () => expect(offered()).not.toContain('block'))
    })
  })
  Rule('a task can be moved to another project', ({ RuleScenario }) => {
    let elsewhere = ''
    const givenOther = (): void => {
      elsewhere = projectsIn().add({ name: 'other', path: somewhere() }).id
    }
    const move = (name: string, to: string) => (): void => {
      try {
        task = tasks.move(idOf(name), to)
      } catch (error) {
        failure = error
      }
    }

    RuleScenario('A draft task is moved', ({ Given, And, When, Then }) => {
      Given('the project "other" also exists', givenOther)
      And('the task "Add due dates" exists', () => create('Add due dates'))
      When('I move it to "other"', () => move('Add due dates', elsewhere)())
      Then('the task belongs to "other"', () => expect(task?.projectId).toBe(elsewhere))
    })

    RuleScenario('Moving a running task is refused', ({ Given, And, When, Then }) => {
      Given('the project "other" also exists', givenOther)
      And('the task "Add due dates" exists', () => create('Add due dates', ['development']))
      And('"Add due dates" is running', () => {
        tasks.act(idOf('Add due dates'), 'queue')
        tasks.act(idOf('Add due dates'), 'start')
      })
      When('I move it to "other"', () => move('Add due dates', elsewhere)())
      Then('it is refused', () => expect(failure).toBeDefined())
      And('the error says the task is running', () =>
        expect((failure as Error).message).toContain('running'),
      )
    })

    RuleScenario('Moving a task that something waits for is refused', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('the project "other" also exists', givenOther)
      And('the task "Add due dates" exists', () => create('Add due dates'))
      And('the task "Ship it" exists', () => create('Ship it'))
      And('"Ship it" waits for "Add due dates"', () => {
        tasks.dependOn(idOf('Ship it'), idOf('Add due dates'))
      })
      When('I move "Add due dates" to "other"', () => move('Add due dates', elsewhere)())
      Then('it is refused', () => expect(failure).toBeDefined())
      And('the error mentions what it is waiting on', () =>
        expect((failure as Error).message).toContain('waits'),
      )
    })

    RuleScenario('Moving to a project that is not there is refused', ({ Given, When, Then }) => {
      Given('the task "Add due dates" exists', () => create('Add due dates'))
      When('I move it to a project that does not exist', () =>
        move('Add due dates', 'project-nowhere')(),
      )
      Then('it is refused', () => expect(failure).toBeDefined())
    })

    RuleScenario('Moving it where it already is changes nothing', ({ Given, When, Then }) => {
      let before = ''
      Given('the task "Add due dates" exists', () => {
        create('Add due dates')
        before = tasks.get(idOf('Add due dates'))?.updatedAt as string
      })
      When('I move it to the project it is already in', () => move('Add due dates', home)())
      Then('the task is unchanged', () => {
        expect(task?.projectId).toBe(home)
        expect(task?.updatedAt).toBe(before)
      })
    })
  })
  Rule('which actions exist to ask for is published too', ({ RuleScenario }) => {
    const mayNot = (action: string) => () =>
      expect(REQUESTABLE_ACTIONS as readonly string[]).not.toContain(action)

    RuleScenario("The engine's own moves are not on it", ({ Then, And }) => {
      Then('a client may not ask for "start"', mayNot('start'))
      And('a client may not ask for "idle"', mayNot('idle'))
      And('a client may not ask for "await_approval"', mayNot('await_approval'))
      And('a client may not ask for "block"', mayNot('block'))
      And('a client may not ask for "complete"', mayNot('complete'))
    })

    RuleScenario('The list is exactly the moves somebody may make', ({ Then }) => {
      Then(
        'a client may ask for exactly "queue, approve, reject, mark_done, retry, cancel, archive, restore"',
        () =>
          expect(REQUESTABLE_ACTIONS).toEqual([
            'queue',
            'approve',
            'reject',
            'mark_done',
            'retry',
            'cancel',
            'archive',
            'restore',
          ]),
      )
    })
  })
  Rule('how many tasks a run has asked for is counted, never kept', ({ RuleScenario }) => {
    let made: Task[] = []
    const createdBy = (runId: string, count: number) => () => {
      made = []
      for (let index = 0; index < count; index += 1) {
        made.push(
          tasks.create({
            name: `Asked for ${runId} ${index}`,
            projectId: home,
            createdByRunId: runId,
          }),
        )
      }
    }
    const asked = (runId: string, count: number) => () =>
      expect(tasks.countCreatedBy(runId)).toBe(count)

    RuleScenario('A run that has asked for nothing has asked for nothing', ({ Then }) => {
      Then('"run-1" has asked for 0 tasks', asked('run-1', 0))
    })

    RuleScenario('Tasks a run asked for are counted', ({ Given, Then }) => {
      Given('two tasks created by "run-1"', createdBy('run-1', 2))
      Then('"run-1" has asked for 2 tasks', asked('run-1', 2))
    })

    RuleScenario('A task somebody else asked for is not counted', ({ Given, And, Then }) => {
      Given('two tasks created by "run-1"', createdBy('run-1', 2))
      And('a task created by "run-2"', () => {
        tasks.create({ name: 'Elsewhere', projectId: home, createdByRunId: 'run-2' })
      })
      Then('"run-1" has asked for 2 tasks', asked('run-1', 2))
    })

    RuleScenario('An archived task still counts', ({ Given, And, Then }) => {
      Given('two tasks created by "run-1"', createdBy('run-1', 2))
      And('one of them is archived', () => {
        tasks.act((made[0] as Task).id, 'archive')
      })
      Then('"run-1" has asked for 2 tasks', asked('run-1', 2))
    })
  })
})

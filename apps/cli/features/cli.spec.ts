import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DISCLAIMER_VERSION } from '@factory/core'
import { run } from '../src/main.js'
import type { CommandResult } from '../src/context.js'
import { DaemonError, type DaemonClient } from '../src/daemon.js'

const feature = await loadFeature(fileURLToPath(new URL('./cli.feature', import.meta.url)))

describeFeature(feature, ({ Background, Rule, Scenario, AfterEachScenario }) => {
  let root = ''
  let workDir = ''
  let projectScope = ''
  let userScope = ''
  let result: CommandResult
  let output = ''
  let streamed: string[] = []
  /**
   * A stand-in for the daemon.
   *
   * The API itself is specified against a real one in apps/daemon; what this
   * feature owns is what the command prints and what exit code it returns, so
   * the responses are canned and the requests are recorded.
   */
  let daemon: DaemonClient | undefined
  let asked: { path: string; method: string; body?: unknown }[] = []

  const fakeDaemon = (answer: (path: string, method: string) => unknown): DaemonClient => ({
    url: 'http://127.0.0.1:7317',
    request: async (path, init = {}) => {
      const method = init.method ?? 'GET'
      asked.push({ path, method, ...(init.body === undefined ? {} : { body: init.body }) })
      const value = answer(path, method)
      if (value instanceof Error) throw value
      return value as never
    },
  })

  const task = (over: Record<string, unknown> = {}) => ({
    id: 'task-1',
    name: 'Add due dates',
    state: 'queued',
    workflows: ['development'],
    flags: [],
    nextWorkflow: 0,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  })

  /** A daemon that knows about these projects and nothing else. */
  const daemonWithProjects = (...names: string[]) => (): void => {
    asked = []
    daemon = fakeDaemon((path, method) =>
      method === 'POST'
        ? { task: task({ state: 'draft' }), actions: [{ action: 'queue', label: 'Queue' }] }
        : path.startsWith('/api/projects')
          ? { items: names.map((name, index) => ({ id: `pr-${index + 1}`, name })) }
          : { items: [] },
    )
  }
  const createdIn = () =>
    (asked.find((entry) => entry.method === 'POST')?.body as { projectId?: string })?.projectId

  const file = (path: string, contents: string) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, contents)
  }
  const phase = (scope: string, name: string, body: string) =>
    file(join(scope, 'phases', `${name}.phase.yaml`), body)
  const givenWritesFile = () => {
    workflow(projectScope, 'writes', 'name: writes\nphases: [write]\n')
    phase(projectScope, 'write', 'name: write\nsteps: [{run: "touch written.txt"}]\n')
  }

  const workflow = (scope: string, name: string, body: string) =>
    file(join(scope, 'workflows', `${name}.workflow.yaml`), body)

  const invoke = async (line: string, env: Record<string, string | undefined> = {}) => {
    streamed = []
    result = await run({
      ...(daemon === undefined ? {} : { daemon }),
      argv: line.split(' ').filter((part) => part.length > 0),
      // Steps run here, so the workspace is the repository root rather than the
      // nested directory the other commands are invoked from.
      cwd: workDir,
      write: (text) => streamed.push(text),
      // A generated environment, never the ambient one: the suite must behave
      // the same on a laptop with agents installed and in a bare CI container.
      //
      // FACTORY_URL included, because `setup` asks the daemon first and falls
      // back to the files. Without pinning it, a Factory the developer happens
      // to have running answers instead — and the scenario then describes their
      // machine rather than the empty one it set up. Port 9 is discard; nothing
      // listens there.
      //
      // PATH is the two system directories rather than empty. It *was* empty,
      // and that was decorative: the runner spawned steps with `process.env`,
      // so `bash` was found through the developer's own PATH and this claim was
      // untrue for every step that ran. Now the runner is handed this
      // environment and nothing else, so the scenarios that run a real
      // workflow need somewhere to find `bash` — and two fixed system
      // directories keep the isolation the comment above promises, while
      // `resolveCommand` still finds no agent, which is what the
      // nothing-installed scenarios depend on.
      env: {
        FACTORY_HOME: userScope,
        FACTORY_URL: 'http://127.0.0.1:9',
        PATH: '/usr/bin:/bin',
        NO_COLOR: '1',
        ...env,
      },
    })
    // A run streams as it happens and returns only its summary, so the two
    // together are what someone actually saw.
    output = [...streamed, ...result.lines].join('\n')
  }

  AfterEachScenario(() => rmSync(root, { recursive: true, force: true }))

  // All setup lives in the Background step, not in BeforeEachScenario: the
  // runner executes Background steps FIRST, so anything built in
  // BeforeEachScenario is not there yet when Background runs. Getting this
  // wrong fails every scenario at once, in ways that look like product bugs.
  Background(({ Given }) => {
    Given('a project scope and a user scope', () => {
      // Reset per scenario: a stub left behind by an earlier one would answer
      // for a later one that never asked for a daemon.
      daemon = undefined
      asked = []
      root = mkdtempSync(join(tmpdir(), 'factory-cli-'))
      workDir = join(root, 'work')
      projectScope = join(workDir, '.xaedalon', '.factory')
      userScope = join(root, 'home', '.xaedalon', '.factory')

      // .git marks the repository root, so it belongs beside `.xaedalon` — not
      // in the working directory below it, which would stop the walk-up early.
      mkdirSync(join(workDir, '.git'), { recursive: true })
      mkdirSync(join(workDir, 'src'), { recursive: true })
      mkdirSync(userScope, { recursive: true })
      file(join(userScope, 'config.yaml'), 'kind: factory.scope/v1\nscope: user\n')
      // The disclaimer, accepted. `factory run` refuses without it, for the
      // same reason the daemon refuses to queue — so every scenario about
      // something else needs an installation where somebody said yes. The
      // scenarios about accepting it delete this first.
      file(
        join(userScope, 'settings.json'),
        JSON.stringify({ security: { acceptedVersion: DISCLAIMER_VERSION } }),
      )

      mkdirSync(projectScope, { recursive: true })
      file(join(projectScope, 'config.yaml'), 'kind: factory.scope/v1\nscope: project\n')
    })
  })

  Scenario('config path shows where Factory is reading from', ({ When, Then, And }) => {
    When('I run "config path"', () => invoke('config path'))
    Then('it succeeds', () => expect(result.exitCode).toBe(0))
    And('the output lists the scopes in order "project, user, builtin"', () => {
      expect(output.indexOf('project')).toBeLessThan(output.indexOf('user'))
      expect(output.indexOf('user')).toBeLessThan(output.indexOf('builtin'))
    })
    And('the output says new definitions go to the project scope', () =>
      expect(output).toContain('written to the project scope'),
    )
  })

  Scenario('init creates a scope that is ready to use', ({ Given, When, Then, And }) => {
    Given('the project scope does not exist yet', () =>
      rmSync(projectScope, { recursive: true, force: true }),
    )
    When('I run "init"', () => invoke('init'))
    Then('it succeeds', () => expect(result.exitCode).toBe(0))
    And('a scope config is written', () =>
      expect(existsSync(join(projectScope, 'config.yaml'))).toBe(true),
    )
    And('a workflows directory is created', () =>
      expect(existsSync(join(projectScope, 'workflows'))).toBe(true),
    )
    And('a phases directory is created', () =>
      expect(existsSync(join(projectScope, 'phases'))).toBe(true),
    )
  })

  Scenario('init is safe to run twice', ({ When, And, Then }) => {
    When('I run "init"', () => invoke('init'))
    And('I run "init"', () => invoke('init'))
    Then('it succeeds', () => expect(result.exitCode).toBe(0))
    And('the output says it is already initialised', () =>
      expect(output).toContain('Already initialised'),
    )
  })

  Scenario('workflow list shows what is available and where it came from', ({ Given, When, Then, And }) => {
    Given('the project scope defines the workflow "release"', () =>
      workflow(projectScope, 'release', 'name: release\nphases: []\n'),
    )
    When('I run "workflow list"', () => invoke('workflow list'))
    Then('it succeeds', () => expect(result.exitCode).toBe(0))
    And('the output mentions "release"', () => expect(output).toContain('release'))
    And('the output mentions "hello-world"', () => expect(output).toContain('hello-world'))
  })

  Scenario('workflow list marks a definition that shadows another', ({ Given, When, Then, And }) => {
    Given('the project scope defines the workflow "hello-world"', () =>
      workflow(projectScope, 'hello-world', 'name: hello-world\nphases: []\n'),
    )
    When('I run "workflow list"', () => invoke('workflow list'))
    Then('it succeeds', () => expect(result.exitCode).toBe(0))
    And('the output says something shadows the builtin scope', () =>
      expect(output).toContain('shadows builtin'),
    )
  })

  Scenario('workflow show prints the file and where it came from', ({ Given, When, Then, And }) => {
    Given('the project scope defines the workflow "release"', () =>
      workflow(projectScope, 'release', 'name: release\ndescription: Ship it.\nphases: []\n'),
    )
    When('I run "workflow show release"', () => invoke('workflow show release'))
    Then('it succeeds', () => expect(result.exitCode).toBe(0))
    And('the output mentions the project scope', () => expect(output).toContain('project scope'))
    And("the output contains the file's own text", () =>
      expect(output).toContain('description: Ship it.'),
    )
  })

  Scenario('workflow show explains a name that does not exist', ({ When, Then, And }) => {
    When('I run "workflow show nowhere"', () => invoke('workflow show nowhere'))
    Then('it fails', () => expect(result.exitCode).toBe(1))
    And('the output suggests running why', () => expect(output).toContain('factory why'))
  })

  Scenario('why lists every path that was tried', ({ Given, When, Then, And }) => {
    Given('the project scope defines the workflow "hello-world"', () =>
      workflow(projectScope, 'hello-world', 'name: hello-world\nphases: []\n'),
    )
    When('I run "why workflow hello-world"', () => invoke('why workflow hello-world'))
    Then('it succeeds', () => expect(result.exitCode).toBe(0))
    And('the output marks the project copy as used', () => expect(output).toMatch(/used\s+project/))
    And('the output marks the builtin copy as hidden', () =>
      expect(output).toMatch(/hidden\s+builtin/),
    )
    And('the output mentions the user scope path that does not exist', () =>
      expect(output).toMatch(/absent\s+user/),
    )
  })

  Scenario('doctor is quiet when nothing is wrong', ({ When, Then }) => {
    When('I run "doctor"', () => invoke('doctor'))
    Then('the output reports the number of rules run', () => expect(output).toContain('rule(s)'))
  })

  Scenario('doctor says what it could not check without a daemon', ({ When, Then }) => {
    When('I run "doctor"', () => invoke('doctor'))
    Then('the output says the running checks were not run', () =>
      expect(output).toContain('need a running daemon'),
    )
  })

  Scenario('doctor adds what the daemon found', ({ Given, When, Then, And }) => {
    Given('a daemon reporting a problem of its own', () => {
      daemon = fakeDaemon(() => ({
        problems: [
          {
            severity: 'warning',
            message: 'Project "work" has Factory\'s own output committed to git.',
            rule: 'doctor.productOutputTracked',
          },
        ],
      }))
    })
    When('I run "doctor"', () => invoke('doctor'))
    Then("the output carries the daemon's problem", () =>
      expect(output).toContain('committed to git'),
    )
    And('it does not say the running checks were missed', () =>
      expect(output).not.toContain('need a running daemon'),
    )
  })

  Scenario('a problem both halves found is reported once', ({ Given, When, Then }) => {
    Given('a daemon reporting a problem this installation also has', () => {
      workflow(projectScope, 'dangling', 'name: dangling\nphases: [nowhere]\n')
      // Word for word what the local rule produces, because that is what the
      // daemon running the same rule over its own chain would send back. An
      // approximation here would dedupe nothing and the scenario would pass
      // without the thing it is about ever happening.
      daemon = fakeDaemon(() => ({
        problems: [
          {
            severity: 'error',
            message:
              'Workflow "dangling" names a phase "nowhere" that does not exist in any scope.',
            rule: 'doctor.missingPhase',
          },
        ],
      }))
    })
    When('I run "doctor"', () => invoke('doctor'))
    Then('the problem appears once', () =>
      expect(output.split('does not exist in any scope').length - 1).toBe(1),
    )
  })

  Scenario('doctor reports a definition that does not validate', ({ Given, When, Then, And }) => {
    Given('the project scope defines a broken workflow "oops"', () =>
      workflow(projectScope, 'oops', 'name: oops\nmode: banana\nphases: []\n'),
    )
    When('I run "doctor"', () => invoke('doctor'))
    Then('it fails', () => expect(result.exitCode).toBe(1))
    And('the output names the file and line', () =>
      expect(output).toContain('oops.workflow.yaml:2:7'),
    )
    And('the output names the field "mode"', () => expect(output).toContain('mode:'))
  })

  Scenario('doctor reports a workflow naming a phase that does not exist', ({ Given, When, Then, And }) => {
    Given('the project scope defines the workflow "dangling" naming a missing phase', () =>
      workflow(projectScope, 'dangling', 'name: dangling\nphases: [nowhere]\n'),
    )
    When('I run "doctor"', () => invoke('doctor'))
    Then('it fails', () => expect(result.exitCode).toBe(1))
    And('the output says the phase does not exist', () =>
      expect(output).toContain('"nowhere" that does not exist'),
    )
  })

  Scenario('doctor warns about an agent that is not installed', ({ When, Then, And }) => {
    // PATH is empty in these runs, so no provider is found — which is exactly
    // the situation a fresh checkout on a new machine is in.
    When('I run "doctor"', () => invoke('doctor'))
    Then('the output warns that a provider is not installed', () =>
      expect(output).toContain('was not found'),
    )
    // "not found on PATH" leaves somebody with nowhere to go; the one sentence
    // that fixes it on any machine is the config key.
    And('the output says how to point Factory at it', () =>
      expect(output).toContain('providers.claude.command'),
    )
  })

  Scenario('a warning alone does not fail the command', ({ Given, When, Then }) => {
    Given('the project scope defines the workflow "hello-world"', () =>
      workflow(projectScope, 'hello-world', 'name: hello-world\nphases: []\n'),
    )
    When('I run "doctor"', () => invoke('doctor'))
    Then('it succeeds', () => expect(result.exitCode).toBe(0))
  })

  Scenario('capabilities lists what is installed and who provided it', ({ When, Then, And }) => {
    When('I run "capabilities"', () => invoke('capabilities'))
    Then('it succeeds', () => expect(result.exitCode).toBe(0))
    And('the output mentions "step-kind"', () => expect(output).toContain('step-kind'))
    And('the output mentions "provider"', () => expect(output).toContain('provider'))
    And('the output mentions "doctor-rule"', () => expect(output).toContain('doctor-rule'))
  })

  Scenario('provider list says which agents are actually present', ({ When, Then, And }) => {
    When('I run "provider list"', () => invoke('provider list'))
    Then('it succeeds', () => expect(result.exitCode).toBe(0))
    And('the output mentions "claude"', () => expect(output).toContain('claude'))
    And('the output marks codex as having an unverified descriptor', () =>
      expect(output).toContain('unverified descriptor'),
    )
  })

  Scenario('step-kind list says which kinds can run', ({ When, Then, And }) => {
    When('I run "step-kind list"', () => invoke('step-kind list'))
    Then('it succeeds', () => expect(result.exitCode).toBe(0))
    And('the output marks "shell" as runnable', () => expect(output).toMatch(/shell\s+runnable/))
  })

  Scenario('json output is machine-readable', ({ Given, When, Then, And }) => {
    Given('the project scope defines the workflow "release"', () =>
      workflow(projectScope, 'release', 'name: release\nphases: []\n'),
    )
    When('I run "workflow list --json"', () => invoke('workflow list --json'))
    Then('it succeeds', () => expect(result.exitCode).toBe(0))
    And('the output parses as JSON', () => expect(() => JSON.parse(output)).not.toThrow())
  })

  Scenario('an unknown command explains itself', ({ When, Then, And }) => {
    When('I run "frobnicate"', () => invoke('frobnicate'))
    Then('it is a usage error', () => expect(result.exitCode).toBe(2))
    And('the output shows the usage', () => expect(output).toContain('Usage'))
  })

  Scenario('no arguments shows the usage', ({ When, Then, And }) => {
    When('I run ""', () => invoke(''))
    Then('it is a usage error', () => expect(result.exitCode).toBe(2))
    And('the output shows the usage', () => expect(output).toContain('Usage'))
  })

  Scenario('running the built-in workflow works out of the box', ({ When, Then, And }) => {
    When('I run "run hello-world --yes"', () => invoke('run hello-world --yes'))
    Then('it succeeds', () => expect(result.exitCode).toBe(0))
    And('the output says it completed', () => expect(output).toContain('Completed'))
  })

  Scenario('a dry run prints the command and runs nothing', ({ Given, When, Then, And }) => {
    Given('the project defines a workflow that writes a file', givenWritesFile)
    When('I run "run writes --dry-run"', () => invoke('run writes --dry-run'))
    Then('it succeeds', () => expect(result.exitCode).toBe(0))
    And('no file was written', () => expect(existsSync(join(workDir, 'written.txt'))).toBe(false))
  })

  Scenario('running it for real writes the file', ({ Given, When, Then, And }) => {
    Given('the project defines a workflow that writes a file', givenWritesFile)
    When('I run "run writes --yes"', () => invoke('run writes --yes'))
    Then('it succeeds', () => expect(result.exitCode).toBe(0))
    And('the file was written', () => expect(existsSync(join(workDir, 'written.txt'))).toBe(true))
  })

  Scenario('task details fill the template tokens', ({ Given, When, Then, And }) => {
    Given('the project defines a workflow that echoes the ticket', () => {
      workflow(projectScope, 'greeting', 'name: greeting\nphases: [announce]\n')
      phase(
        projectScope,
        'announce',
        'name: announce\nsteps: [{run: "echo ticket-is-{{ task.ticketId }}"}]\n',
      )
    })
    When('I run "run greeting --ticket WW2-1234 --yes"', () =>
      invoke('run greeting --ticket WW2-1234 --yes'),
    )
    Then('it succeeds', () => expect(result.exitCode).toBe(0))
    And('the output mentions "WW2-1234"', () => expect(output).toContain('WW2-1234'))
  })

  Scenario('an approval gate stops a run with no terminal', ({ When, Then, And }) => {
    // No --yes and no terminal: assuming approval would let a gate someone put
    // there on purpose pass unread.
    When('I run "run hello-world"', () => invoke('run hello-world'))
    Then('it fails', () => expect(result.exitCode).toBe(1))
    And('the output says there is no terminal to ask', () =>
      expect(output).toContain('no terminal to ask'),
    )
  })

  Scenario('running a workflow that does not exist explains itself', ({ When, Then, And }) => {
    When('I run "run nowhere"', () => invoke('run nowhere'))
    Then('it fails', () => expect(result.exitCode).toBe(1))
    And('the output says there is no such workflow', () =>
      expect(output).toContain('No workflow named'),
    )
  })

  Scenario('colour is suppressed when NO_COLOR is set', ({ When, Then, And }) => {
    When('I run "config path" with NO_COLOR set', () => invoke('config path', { NO_COLOR: '1' }))
    Then('it succeeds', () => expect(result.exitCode).toBe(0))
    And('the output contains no escape codes', () =>
      expect(output).not.toContain(String.fromCharCode(27)),
    )
  })

  Scenario('tasks are listed from the daemon', ({ Given, When, Then, And }) => {
    Given('a daemon with a task "Add due dates" that is queued', () => {
      asked = []
      daemon = fakeDaemon(() => ({ items: [task({ actions: [{ action: 'cancel', label: 'Cancel' }] })] }))
    })
    When('I run "task list"', () => invoke('task list'))
    Then('the output contains "Add due dates"', () => expect(output).toContain('Add due dates'))
    And('the output contains "queued"', () => expect(output).toContain('queued'))
  })

  Scenario('nothing to list says how to make one', ({ Given, When, Then, And }) => {
    Given('a daemon with no tasks', () => {
      asked = []
      daemon = fakeDaemon(() => ({ items: [] }))
    })
    When('I run "task list"', () => invoke('task list'))
    Then('the output contains "No tasks"', () => expect(output).toContain('No tasks'))
    And('the output contains "factory task new"', () =>
      expect(output).toContain('factory task new'),
    )
  })

  Scenario('a task is created with its workflows in order', ({ Given, When, Then, And }) => {
    // One project, because a task needs one — and with exactly one there is
    // nothing for the command line to say about it.
    Given('a daemon with no tasks', daemonWithProjects('work'))
    When('I run "task new Add due dates --workflow worktree-create --workflow development"', () =>
      invoke('task new Add due dates --workflow worktree-create --workflow development'),
    )
    // Order matters: they run in the order they were given.
    Then('the daemon was asked to create a task with workflows "worktree-create, development"', () => {
      const post = asked.find((entry) => entry.method === 'POST')
      expect((post?.body as { workflows: string[] }).workflows).toEqual([
        'worktree-create',
        'development',
      ])
    })
    And('the output says how to start it', () =>
      expect(output).toContain('factory task queue'),
    )
  })

  Scenario('a task is moved to another project', ({ Given, When, Then, And }) => {
    Given('a daemon with the projects "work" and "elsewhere"', () => {
      asked = []
      daemon = fakeDaemon((path, method) =>
        method === 'PATCH'
          ? { task: task({ state: 'draft' }) }
          : path.startsWith('/api/projects')
            ? { items: [{ id: 'pr-1', name: 'work' }, { id: 'pr-2', name: 'elsewhere' }] }
            : { items: [task()] },
      )
    })
    When('I run "task move task-1 elsewhere"', () => invoke('task move task-1 elsewhere'))
    Then('the daemon was asked to move it to "elsewhere"', () => {
      const patch = asked.find((entry) => entry.method === 'PATCH')
      expect((patch?.body as { projectId: string }).projectId).toBe('pr-2')
    })
    And('the output says where it is now', () => expect(output).toContain('elsewhere'))
  })

  Scenario('moving to a project that is not there says which exist', ({
    Given,
    When,
    Then,
    And,
  }) => {
    Given('a daemon with the projects "work" and "elsewhere"', () => {
      asked = []
      daemon = fakeDaemon((path) =>
        path.startsWith('/api/projects')
          ? { items: [{ id: 'pr-1', name: 'work' }, { id: 'pr-2', name: 'elsewhere' }] }
          : { items: [task()] },
      )
    })
    When('I run "task move task-1 nowhere"', () => invoke('task move task-1 nowhere'))
    Then('it fails', () => expect(result.exitCode).toBe(1))
    And('the output names both projects', () => {
      expect(output).toContain('work')
      expect(output).toContain('elsewhere')
    })
  })

  Scenario('a task lands in the only project there is', ({ Given, When, Then }) => {
    Given('a daemon with one project "work"', daemonWithProjects('work'))
    When('I run "task new Add due dates"', () => invoke('task new Add due dates'))
    Then('the daemon was asked to create it in "work"', () => expect(createdIn()).toBe('pr-1'))
  })

  Scenario('with no project there is nowhere to put a task', ({ Given, When, Then, And }) => {
    Given('a daemon with no projects', daemonWithProjects())
    When('I run "task new Add due dates"', () => invoke('task new Add due dates'))
    Then('it fails', () => expect(result.exitCode).toBe(1))
    And('the output contains "needs a project"', () =>
      expect(output).toContain('needs a project'),
    )
    And('the output says how to add one', () =>
      expect(output).toContain('factory project add'),
    )
  })

  Scenario('with more than one project the task says which', ({ Given, When, Then, And }) => {
    Given('a daemon with the projects "work" and "elsewhere"', daemonWithProjects('work', 'elsewhere'))
    When('I run "task new Add due dates"', () => invoke('task new Add due dates'))
    Then('it fails', () => expect(result.exitCode).toBe(1))
    And('the output contains "--project"', () => expect(output).toContain('--project'))
    And('the output names both projects', () => {
      expect(output).toContain('work')
      expect(output).toContain('elsewhere')
    })
  })

  Scenario('showing a task lists what it can do next', ({ Given, When, Then }) => {
    Given('a daemon with a task "Add due dates" that is queued', () => {
      asked = []
      // Two shapes, because `show` resolves the short id against the listing
      // before it asks for the task.
      daemon = fakeDaemon((path) =>
        path.startsWith('/api/tasks?')
          ? { items: [task()] }
          : {
              task: task(),
              actions: [{ action: 'cancel', label: 'Cancel' }],
              history: [],
              runs: [],
            },
      )
    })
    When('I run "task show task-1"', () => invoke('task show task-1'))
    // Printed from what the daemon offered, never from a list kept here.
    Then('the output contains "factory task cancel"', () =>
      expect(output).toContain('factory task cancel'),
    )
  })

  Scenario('an action the task cannot take explains what it can', ({ Given, When, Then, And }) => {
    Given('a daemon that refuses with the actions "queue, cancel"', () => {
      asked = []
      daemon = fakeDaemon((path) =>
        path.startsWith('/api/tasks?')
          ? { items: [task()] }
          : new DaemonError(409, 'Cannot approve a task that is queued.', {
              error: 'Cannot approve a task that is queued.',
              actions: [{ action: 'queue' }, { action: 'cancel' }],
            }),
      )
    })
    When('I run "task approve task-1"', () => invoke('task approve task-1'))
    Then('the command fails', () => expect(result.exitCode).toBe(1))
    And('the output contains "Available: queue, cancel"', () =>
      expect(output).toContain('Available: queue, cancel'),
    )
  })

  Scenario('no daemon is explained rather than reported as a crash', ({
    Given,
    When,
    Then,
    And,
  }) => {
    Given('no daemon is running', () => {
      asked = []
      daemon = fakeDaemon(() => new DaemonError(0, 'Cannot reach the Factory daemon at http://127.0.0.1:7317.'))
    })
    When('I run "task list"', () => invoke('task list'))
    Then('the command fails', () => expect(result.exitCode).toBe(1))
    And('the output contains "Cannot reach the Factory daemon"', () =>
      expect(output).toContain('Cannot reach the Factory daemon'),
    )
    And('the output contains "factory-daemon"', () => expect(output).toContain('factory-daemon'))
  })

  Scenario('the short id the listing prints is enough to act on', ({ Given, When, Then }) => {
    Given('a daemon with a task "Add due dates" that is queued', () => {
      asked = []
      daemon = fakeDaemon((path, method) =>
        method === 'POST'
          ? { task: task({ state: 'cancelled' }), actions: [] }
          : { items: [task({ id: 'task-1a2b3c4d-0000-0000-0000-000000000000' })] },
      )
    })
    When('I run "task cancel task-1a2"', () => invoke('task cancel task-1a2'))
    // The listing abbreviates, so the commands have to accept the abbreviation
    // — and the daemon still gets the exact id it expects.
    Then('the daemon was asked to act on the full id', () => {
      const post = asked.find((entry) => entry.method === 'POST')
      expect(post?.path).toContain('task-1a2b3c4d-0000-0000-0000-000000000000')
    })
  })

  Scenario('an id that matches two tasks is refused rather than guessed', ({
    Given,
    When,
    Then,
    And,
  }) => {
    Given('a daemon with two tasks whose ids start the same way', () => {
      asked = []
      daemon = fakeDaemon(() => ({
        items: [
          task({ id: 'task-1aaaaaaa-0000-0000-0000-000000000000' }),
          task({ id: 'task-1bbbbbbb-0000-0000-0000-000000000000' }),
        ],
      }))
    })
    When('I run "task cancel task-1"', () => invoke('task cancel task-1'))
    Then('the command fails', () => expect(result.exitCode).toBe(1))
    And('the output says which ones it matched', () => {
      expect(output).toContain('matches 2 tasks')
      expect(asked.some((entry) => entry.method === 'POST')).toBe(false)
    })
  })

  Scenario('setup says what is missing when nothing is installed', ({ When, Then, And }) => {
    // PATH is empty in these runs and no daemon is stubbed, so this is a fresh
    // machine seen through the files alone.
    When('I run "setup"', () => invoke('setup'))
    Then('the output contains "Install a coding agent"', () =>
      expect(output).toContain('Install a coding agent'),
    )
    And('the output says how to install one', () => expect(output).toContain('npm install -g'))
    And('the output says Factory cannot run work yet', () =>
      expect(output).toContain('cannot run work'),
    )
  })

  Scenario('setup works without a daemon, and says so', ({ Given, When, Then }) => {
    Given('no daemon is running', () => {
      asked = []
      daemon = fakeDaemon(() => new DaemonError(0, 'Cannot reach the Factory daemon.'))
    })
    When('I run "setup"', () => invoke('setup'))
    // Which is exactly when somebody runs it.
    Then('the output says the daemon is not running', () =>
      expect(output).toContain('daemon is not running'),
    )
  })

  Scenario('setup prefers the daemon, which can see the database', ({ Given, When, Then }) => {
    Given('a daemon reporting one outstanding step', () => {
      asked = []
      daemon = fakeDaemon(() => ({
        items: [
          {
            id: 'a-project',
            title: 'Add a repository',
            summary: 'A project is the repository Factory does the work in.',
            done: false,
            essential: true,
            actions: [{ label: 'Add one on the Projects page', url: '/projects' }],
          },
        ],
        ready: false,
        remaining: 1,
      }))
    })
    When('I run "setup"', () => invoke('setup'))
    // Whether a repository has been added is not a question a file can answer.
    Then('the output contains "Add a repository"', () =>
      expect(output).toContain('Add a repository'),
    )
  })

  Rule('a foreground run is one conversation too', ({ RuleScenario }) => {
    RuleScenario('The phases of one run share one session', ({ Given, When, Then, And }) => {
      Given(
        'the project defines a workflow with two agent phases carrying a session',
        () => {
          workflow(projectScope, 'pipeline', 'name: pipeline\nphases: [first, second]\n')
          for (const name of ['first', 'second']) {
            phase(
              projectScope,
              name,
              [
                `name: ${name}`,
                'steps: [{uses: agent, provider: claude, session: task, prompt: go}]',
                '',
              ].join('\n'),
            )
          }
        },
      )
      When('I run "run pipeline --dry-run"', () => invoke('run pipeline --dry-run'))
      Then('it succeeds', () => expect(result.exitCode).toBe(0))
      // Read off the printed commands, which is what a dry run is for — and
      // the same argv the real run would spawn.
      And('the first phase starts a session', () =>
        expect(output).toMatch(/--session-id [0-9a-f-]{36}/),
      )
      And('the second phase resumes the same one', () => {
        const started = /--session-id ([0-9a-f-]{36})/.exec(output)?.[1]
        expect(started).toBeDefined()
        expect(output).toContain(`--resume ${started as string}`)
      })
    })
  })

  Rule('a foreground run says what the agent was refused, and does not call it success', ({
    RuleScenario,
  }) => {
    /**
     * A stand-in for the agent CLI that speaks its transcript format.
     *
     * Pointed at through `providers.claude.command`, which is the documented
     * way to tell Factory where an agent is — so everything downstream is the
     * real thing: the real descriptor, the real reader, the real runner and
     * the real command. Only the binary is a stub, because a scenario that
     * needed a logged-in Claude Code would run nowhere.
     *
     * The shapes are the ones measured on 2.1.281, including the `result`
     * event that says `success` on the run where the command was refused.
     */
    const stubAgent = (denied?: string): string => {
      const path = join(root, 'stub-agent')
      const events = [
        JSON.stringify({ type: 'system', subtype: 'init' }),
        ...(denied === undefined
          ? []
          : [
              JSON.stringify({
                type: 'assistant',
                message: {
                  content: [
                    { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: denied } },
                  ],
                },
              }),
              JSON.stringify({
                type: 'system',
                subtype: 'permission_denied',
                tool_use_id: 'toolu_1',
                message: 'Permission for this tool use was denied.',
              }),
            ]),
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'All done.' }] },
        }),
        JSON.stringify({ type: 'result', subtype: 'success', is_error: false }),
      ]
      // Exits 0, like the real thing on a run whose command was refused. That
      // is the entire point of the scenario.
      file(path, `#!/bin/sh\n${events.map((line) => `echo '${line}'`).join('\n')}\nexit 0\n`)
      chmodSync(path, 0o755)
      file(
        join(projectScope, 'config.yaml'),
        `kind: factory.scope/v1\nscope: project\nproviders:\n  claude:\n    command: ${path}\n`,
      )
      return path
    }
    const agentPhase = (): void => {
      workflow(projectScope, 'probe', 'name: probe\nphases: [work]\n')
      phase(
        projectScope,
        'work',
        'name: work\nsteps: [{uses: agent, provider: claude, prompt: go}]\n',
      )
    }

    RuleScenario('A refused command is named, and the run does not succeed', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('an agent whose transcript reports "pnpm install" denied', () => {
        stubAgent('pnpm install')
      })
      And('the project defines a workflow with one agent phase', agentPhase)
      When('I run "run probe --yes"', () => invoke('run probe --yes'))
      Then('it fails', () => expect(result.exitCode).not.toBe(0))
      // On one line, and the refusal's own. `toContain('pnpm install')` alone
      // passes on the trace line the tool call already wrote, and kept passing
      // with the refusal report deleted entirely.
      And('one line says that command did not run, and names it', () => {
        const line = output.split('\n').find((text) => text.includes('did not run'))
        expect(line, output).toBeDefined()
        expect(line).toContain('pnpm install')
      })
      // The summary line itself, not the absence of the word anywhere: the
      // agent's own prose is in this output too.
      And('the output does not say the run completed', () =>
        expect(output).not.toContain('Completed.'),
      )
    })

    RuleScenario('A run with nothing refused still succeeds', ({ Given, And, When, Then }) => {
      Given('an agent whose transcript reports no refusal', () => {
        stubAgent()
      })
      And('the project defines a workflow with one agent phase', agentPhase)
      When('I run "run probe --yes"', () => invoke('run probe --yes'))
      Then('it succeeds', () => expect(result.exitCode).toBe(0))
      And('the output says the run completed', () => expect(output).toContain('Completed.'))
    })
  })

  Rule('the plugin switches are reachable when the board is not', ({ RuleScenario }) => {
    const settingsFile = () => join(userScope, 'settings.json')
    const saved = (): Record<string, unknown> =>
      existsSync(settingsFile())
        ? (JSON.parse(readFileSync(settingsFile(), 'utf8')) as Record<string, unknown>)
        : {}

    RuleScenario('The list says what is installed and whether it is on', ({
      When,
      Then,
      And,
    }) => {
      When('I run "plugins"', () => invoke('plugins'))
      Then('it succeeds', () => expect(result.exitCode).toBe(0))
      And('the output mentions "@factory/task-diffity"', () =>
        expect(output).toContain('@factory/task-diffity'),
      )
      And('the output says the core built-ins are required', () =>
        expect(output).toContain('required'),
      )
    })

    RuleScenario('Switching one off writes the settings', ({ When, Then, And }) => {
      When('I run "plugins disable @factory/task-diffity"', () =>
        invoke('plugins disable @factory/task-diffity'),
      )
      Then('it succeeds', () => expect(result.exitCode).toBe(0))
      And('the settings file holds "@factory/task-diffity"', () =>
        expect((saved().plugins as { disabled: string[] }).disabled).toEqual([
          '@factory/task-diffity',
        ]),
      )
      // The host has no unload, so honesty is the only option available.
      And('it says a restart will unload it', () => expect(output).toContain('Restart'))
    })

    RuleScenario('Switching it back on removes it', ({ Given, When, Then, And }) => {
      Given('"@factory/task-diffity" is switched off', () =>
        invoke('plugins disable @factory/task-diffity'),
      )
      When('I run "plugins enable @factory/task-diffity"', () =>
        invoke('plugins enable @factory/task-diffity'),
      )
      Then('it succeeds', () => expect(result.exitCode).toBe(0))
      And('nothing is switched off', () =>
        expect((saved().plugins as { disabled: string[] }).disabled).toEqual([]),
      )
    })

    RuleScenario('A core built-in cannot be switched off', ({ When, Then, And }) => {
      When('I run "plugins disable @factory/core/builtin-steps"', () =>
        invoke('plugins disable @factory/core/builtin-steps'),
      )
      Then('it fails', () => expect(result.exitCode).toBe(1))
      And('the output says it would leave Factory unable to do anything', () =>
        expect(output).toContain('unable to do anything'),
      )
    })

    RuleScenario('Switching off something nothing claims is refused', ({ When, Then }) => {
      When('I run "plugins disable @acme/imaginary"', () =>
        invoke('plugins disable @acme/imaginary'),
      )
      Then('it fails', () => expect(result.exitCode).toBe(1))
    })

    RuleScenario('A verb nobody recognises is a usage error', ({ When, Then }) => {
      When('I run "plugins wiggle @factory/task-diffity"', () =>
        invoke('plugins wiggle @factory/task-diffity'),
      )
      Then('it is a usage error', () => expect(result.exitCode).toBe(2))
    })
  })

  Rule('the terminal can accept the disclaimer, read the profile, and stop everything', ({
    RuleScenario,
  }) => {
    const unaccepted = (): void => {
      // The Background accepts it for every other scenario, so these remove it.
      // Safe here, unlike with a running daemon: the CLI builds its context per
      // invocation, so it reads the file each time.
      rmSync(join(userScope, 'settings.json'), { force: true })
    }
    const stoppedGroups = (signalled: number, killed: number, stopped: string[]) => (): void => {
      daemon = fakeDaemon((path, method) =>
        path === '/api/runs/stop' && method === 'POST'
          ? { stopped, signalled, killed }
          : new DaemonError(404, `unexpected ${method} ${path}`),
      )
    }
    const accepted = (): number | undefined =>
      (
        JSON.parse(readFileSync(join(userScope, 'settings.json'), 'utf8')) as {
          security?: { acceptedVersion?: number }
        }
      ).security?.acceptedVersion

    RuleScenario('The disclaimer can be read without agreeing to it', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given('nothing has been accepted', unaccepted)
      When('I run "accept --show"', () => invoke('accept --show'))
      Then('it succeeds', () => expect(result.exitCode).toBe(0))
      And('the output says what an agent can do inside the workspace', () =>
        expect(output).toContain('inside the workspace'),
      )
      And('the output names the profile that removes the boundaries', () =>
        expect(output).toContain('Full Access'),
      )
      And('the output says it has not been accepted', () =>
        expect(output).toContain('Not accepted'),
      )
      And('nothing was recorded', () =>
        expect(existsSync(join(userScope, 'settings.json'))).toBe(false),
      )
    })

    RuleScenario('Accepting it records the current version', ({ Given, When, Then, And }) => {
      Given('nothing has been accepted', unaccepted)
      When('I run "accept"', () => invoke('accept'))
      Then('it succeeds', () => expect(result.exitCode).toBe(0))
      And('the output says Factory will not ask again', () =>
        expect(output).toContain('will not ask again'),
      )
      And('the settings file records the accepted version', () =>
        expect(accepted()).toBe(DISCLAIMER_VERSION),
      )
    })

    RuleScenario('Accepting it twice says so and changes nothing', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('nothing has been accepted', unaccepted)
      And('I have run "accept"', () => invoke('accept'))
      When('I run "accept"', () => invoke('accept'))
      Then('it succeeds', () => expect(result.exitCode).toBe(0))
      And('the output says it was already accepted', () =>
        expect(output).toContain('Already accepted'),
      )
    })

    RuleScenario('Running a workflow before accepting is refused', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given('nothing has been accepted', unaccepted)
      When('I run "run hello-world --yes"', () => invoke('run hello-world --yes'))
      Then('it fails', () => expect(result.exitCode).not.toBe(0))
      And('the output says how to accept it', () => expect(output).toContain('factory accept'))
    })

    RuleScenario('A dry run needs no acceptance', ({ Given, When, Then }) => {
      Given('nothing has been accepted', unaccepted)
      When('I run "run hello-world --dry-run"', () => invoke('run hello-world --dry-run'))
      Then('it succeeds', () => expect(result.exitCode).toBe(0))
    })

    RuleScenario('The installation profile can be read', ({ When, Then, And }) => {
      When('I run "profile"', () => invoke('profile'))
      Then('it succeeds', () => expect(result.exitCode).toBe(0))
      And('the output says the profile is "Default"', () => expect(output).toContain('Default'))
    })

    RuleScenario('The installation profile can be changed', ({ When, Then, And }) => {
      When('I run "profile full-access"', () => invoke('profile full-access'))
      Then('it succeeds', () => expect(result.exitCode).toBe(0))
      And('the output says the profile is "Full Access"', () =>
        expect(output).toContain('Full Access'),
      )
      And('the output warns about what Full Access removes', () =>
        expect(output).toContain('workspace boundary'),
      )
    })

    RuleScenario('A profile that is not one is refused', ({ When, Then, And }) => {
      When('I run "profile sort-of-safe"', () => invoke('profile sort-of-safe'))
      Then('it fails', () => expect(result.exitCode).not.toBe(0))
      And('the output names the profiles', () => expect(output).toContain('full-access'))
    })

    RuleScenario('Stopping needs to be asked for plainly', ({ When, Then, And }) => {
      When('I run "stop"', () => invoke('stop'))
      Then('the exit code is 2', () => expect(result.exitCode).toBe(2))
      And('the output mentions "--all"', () => expect(output).toContain('--all'))
    })

    RuleScenario('Stopping everything reports what it stopped', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given(
        'the daemon says two process groups were stopped',
        stoppedGroups(2, 1, ['task-1', 'task-2']),
      )
      When('I run "stop --all"', () => invoke('stop --all'))
      Then('it succeeds', () => expect(result.exitCode).toBe(0))
      And('the output says 2 process groups were stopped', () =>
        expect(output).toContain('Stopped 2 process groups'),
      )
    })

    RuleScenario('Stopping when nothing runs says so', ({ Given, When, Then, And }) => {
      Given('the daemon says nothing was running', stoppedGroups(0, 0, []))
      When('I run "stop --all"', () => invoke('stop --all'))
      Then('it succeeds', () => expect(result.exitCode).toBe(0))
      And('the output says nothing was running', () =>
        expect(output).toContain('Nothing was running'),
      )
    })
  })

  Rule('the terminal can order the work as well as watch it', ({ RuleScenario }) => {
    /**
     * A daemon that answers the dependency routes.
     *
     * `/api/tasks?archived=true` is here because both ends of a dependency go
     * through the same prefix resolution the other commands use, and that
     * resolution asks for the listing.
     */
    const dependencyDaemon = (
      answer: (path: string, method: string) => unknown,
      tasks: Record<string, unknown>[] = [],
    ) => (): void => {
      asked = []
      daemon = fakeDaemon((path, method) => {
        if (path.startsWith('/api/tasks?')) return { items: tasks }
        return answer(path, method)
      })
    }
    const accepts = dependencyDaemon((path, method) =>
      path.includes('/dependencies') && (method === 'POST' || method === 'DELETE')
        ? {
            task: task({ name: 'The model' }),
            blockers: method === 'POST' ? [{ id: 'task-2', name: 'Scaffold' }] : [],
          }
        : new DaemonError(404, `unexpected ${method} ${path}`),
    )
    const askedFor = (method: string, fragment: string) => (): void => {
      expect(
        asked.some((entry) => entry.method === method && entry.path.includes(fragment)),
      ).toBe(true)
    }

    const projects = (items: Record<string, unknown>[]) => items
    const projectDaemon = (
      items: Record<string, unknown>[],
      answer: (path: string, method: string) => unknown,
    ) => (): void => {
      asked = []
      daemon = fakeDaemon((path, method) => {
        if (path === '/api/projects') return { items }
        return answer(path, method)
      })
    }
    const WORK = { id: 'pr-1', name: 'work' }

    RuleScenario('One task can be made to wait for another', ({ Given, When, Then, And }) => {
      Given('a daemon that accepts a dependency', accepts)
      When('I run "task depends task-1 task-2"', () => invoke('task depends task-1 task-2'))
      Then('it succeeds', () => expect(result.exitCode).toBe(0))
      And('the output says it waits for "Scaffold"', () =>
        expect(output).toContain('The model waits for Scaffold.'),
      )
      And('the daemon was asked to add the dependency', askedFor('POST', '/dependencies'))
    })

    RuleScenario('The dependency can be taken back', ({ Given, When, Then, And }) => {
      Given('a daemon that accepts a dependency', accepts)
      When('I run "task depends task-1 task-2 --remove"', () =>
        invoke('task depends task-1 task-2 --remove'),
      )
      Then('it succeeds', () => expect(result.exitCode).toBe(0))
      And(
        'the daemon was asked to remove the dependency',
        askedFor('DELETE', '/dependencies/task-2'),
      )
    })

    RuleScenario('Both ids are resolved from a prefix', ({ Given, When, Then, And }) => {
      Given(
        'a daemon with two tasks and a dependency to add',
        dependencyDaemon(
          (path, method) =>
            path.includes('/dependencies') && method === 'POST'
              ? { task: task({ name: 'The model' }), blockers: [{ id: 'b', name: 'Scaffold' }] }
              : new DaemonError(404, `unexpected ${method} ${path}`),
          [
            task({ id: 'task-100-full-id-0000-000000000000', name: 'The model' }),
            task({ id: 'task-200-full-id-0000-000000000000', name: 'Scaffold' }),
          ],
        ),
      )
      When('I run "task depends task-100 task-200"', () =>
        invoke('task depends task-100 task-200'),
      )
      Then('it succeeds', () => expect(result.exitCode).toBe(0))
      And('the daemon was asked about the full ids', () => {
        const call = asked.find((entry) => entry.method === 'POST')
        expect(call?.path).toContain('task-100-full-id-0000-000000000000')
        expect(call?.body).toEqual({ dependsOn: 'task-200-full-id-0000-000000000000' })
      })
    })

    RuleScenario("A refusal is passed through in the daemon's own words", ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given(
        'a daemon that refuses a dependency as a ring',
        dependencyDaemon(
          () =>
            new DaemonError(
              400,
              '"Scaffold" cannot wait for "The model": that would make a ring, because "The model" already waits for "Scaffold", however far around.',
            ),
        ),
      )
      When('I run "task depends task-1 task-2"', () => invoke('task depends task-1 task-2'))
      Then('it fails', () => expect(result.exitCode).not.toBe(0))
      And('the output says it would make a ring', () => expect(output).toContain('ring'))
    })

    RuleScenario('Asking for a dependency without both ends says so', ({ When, Then, And }) => {
      When('I run "task depends task-1"', () => invoke('task depends task-1'))
      Then('the exit code is 2', () => expect(result.exitCode).toBe(2))
      And('the output mentions "waits-for-id"', () => expect(output).toContain('waits-for-id'))
    })

    RuleScenario('A task can be marked done from the terminal', ({ Given, When, Then, And }) => {
      Given(
        'a daemon that accepts an action',
        dependencyDaemon((path, method) =>
          method === 'POST' && path.includes('/actions/')
            ? { task: task({ state: 'done' }), actions: [] }
            : new DaemonError(404, `unexpected ${method} ${path}`),
        ),
      )
      When('I run "task done task-1"', () => invoke('task done task-1'))
      Then('it succeeds', () => expect(result.exitCode).toBe(0))
      And('the daemon was asked to mark it done', askedFor('POST', '/actions/mark_done'))
    })

    RuleScenario('A whole project can be queued', ({ Given, When, Then, And }) => {
      Given(
        'a daemon with a project to queue',
        projectDaemon(projects([WORK]), (path, method) =>
          path === '/api/projects/pr-1/queue' && method === 'POST'
            ? {
                queued: [task({ name: 'Scaffold' }), task({ name: 'The model' })],
                skipped: [{ task: task({ name: 'Nothing planned' }), reason: 'nothing in its plan is ticked' }],
              }
            : new DaemonError(404, `unexpected ${method} ${path}`),
        ),
      )
      When('I run "project queue work"', () => invoke('project queue work'))
      Then('it succeeds', () => expect(result.exitCode).toBe(0))
      And('the output lists the tasks it queued in order', () => {
        expect(output).toContain('Queued 2 tasks in work:')
        expect(output.indexOf('Scaffold')).toBeLessThan(output.indexOf('The model'))
      })
      And('the output says what it skipped', () =>
        expect(output).toContain('nothing in its plan is ticked'),
      )
    })

    RuleScenario('Queueing a project with nothing to queue says so', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given(
        'a daemon with a project and nothing to queue',
        projectDaemon(projects([WORK]), () => ({ queued: [], skipped: [] })),
      )
      When('I run "project queue work"', () => invoke('project queue work'))
      Then('it succeeds', () => expect(result.exitCode).toBe(0))
      And('the output says there was nothing to queue', () =>
        expect(output).toContain('Nothing to queue in work.'),
      )
    })

    RuleScenario('A project is found by part of its name', ({ Given, When, Then }) => {
      Given(
        'a daemon with a project to queue',
        projectDaemon(projects([WORK]), () => ({ queued: [task()], skipped: [] })),
      )
      When('I run "project queue wo"', () => invoke('project queue wo'))
      Then('it succeeds', () => expect(result.exitCode).toBe(0))
    })

    const alike = projectDaemon(
      projects([
        { id: 'pr-1', name: 'web' },
        { id: 'pr-2', name: 'webhooks' },
      ]),
      (path, method) =>
        path === '/api/projects/pr-1/queue' && method === 'POST'
          ? { queued: [task({ name: 'Scaffold' })], skipped: [] }
          : new DaemonError(404, `unexpected ${method} ${path}`),
    )

    RuleScenario('A name matching two projects is refused', ({ Given, When, Then, And }) => {
      Given('a daemon with two projects whose names start alike', alike)
      When('I run "project queue we"', () => invoke('project queue we'))
      Then('it fails', () => expect(result.exitCode).not.toBe(0))
      And('the output names both projects', () => {
        expect(output).toContain('web')
        expect(output).toContain('webhooks')
      })
    })

    RuleScenario('An exact name wins over a longer one starting the same way', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given('a daemon with two projects whose names start alike', alike)
      When('I run "project queue web"', () => invoke('project queue web'))
      Then('it succeeds', () => expect(result.exitCode).toBe(0))
      And('it was "web" that was queued', () => {
        expect(output).toContain('in web:')
        expect(asked.some((entry) => entry.path === '/api/projects/pr-1/queue')).toBe(true)
      })
    })

    RuleScenario('A project that is not there is refused', ({ Given, When, Then, And }) => {
      Given(
        'a daemon with a project to queue',
        projectDaemon(projects([WORK]), () => ({ queued: [], skipped: [] })),
      )
      When('I run "project queue nowhere"', () => invoke('project queue nowhere'))
      Then('it fails', () => expect(result.exitCode).not.toBe(0))
      And('the output says there is no such project', () =>
        expect(output).toContain('No project called "nowhere".'),
      )
    })

    RuleScenario('A whole project can be stopped', ({ Given, When, Then, And }) => {
      Given(
        'a daemon with a project to stop',
        projectDaemon(projects([WORK]), (path, method) =>
          path === '/api/projects/pr-1/stop' && method === 'POST'
            ? { cancelled: [task(), task({ name: 'Two' })], signalled: 2, killed: 0 }
            : new DaemonError(404, `unexpected ${method} ${path}`),
        ),
      )
      When('I run "project stop work"', () => invoke('project stop work'))
      Then('it succeeds', () => expect(result.exitCode).toBe(0))
      And('the output says 2 tasks were cancelled', () =>
        expect(output).toContain('Cancelled 2 tasks in work.'),
      )
    })

    RuleScenario('Stopping a project where nothing runs says so', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given(
        'a daemon with a project and nothing running',
        projectDaemon(projects([WORK]), () => ({ cancelled: [], signalled: 0, killed: 0 })),
      )
      When('I run "project stop work"', () => invoke('project stop work'))
      Then('it succeeds', () => expect(result.exitCode).toBe(0))
      And('the output says nothing was running there', () =>
        expect(output).toContain('Nothing was running in work.'),
      )
    })

    RuleScenario('A project command needs a name', ({ When, Then }) => {
      When('I run "project queue"', () => invoke('project queue'))
      Then('the exit code is 2', () => expect(result.exitCode).toBe(2))
    })

    RuleScenario('An unknown project command says what there is', ({ When, Then, And }) => {
      When('I run "project nonsense work"', () => invoke('project nonsense work'))
      Then('the exit code is 2', () => expect(result.exitCode).toBe(2))
      And('the output mentions "queue"', () => expect(output).toContain('queue'))
    })

    const projectAcceptor = (scaffolded?: Record<string, unknown>) => (): void => {
      asked = []
      daemon = fakeDaemon((path, method) =>
        path === '/api/projects' && method === 'POST'
          ? {
              project: { id: 'pr-9', name: 'work', path: '/repos/work', usesWorktrees: true },
              ...(scaffolded === undefined ? {} : { scaffolded }),
            }
          : new DaemonError(404, `unexpected ${method} ${path}`),
      )
    }
    const sentBody = () => asked.find((entry) => entry.method === 'POST')?.body as
      | Record<string, unknown>
      | undefined

    RuleScenario('A repository can be added from the terminal', ({ Given, When, Then, And }) => {
      Given('a daemon that accepts a project', projectAcceptor())
      When('I run "project add work /repos/work"', () => invoke('project add work /repos/work'))
      Then('it succeeds', () => expect(result.exitCode).toBe(0))
      And('the output says where it was added', () =>
        expect(output).toContain('work added at /repos/work.'),
      )
      And('the daemon was told the name and the path', () =>
        expect(sentBody()).toEqual({ name: 'work', path: '/repos/work' }),
      )
    })

    RuleScenario('A project can be added to work in its own checkout', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given('a daemon that accepts a project', () => {
        asked = []
        daemon = fakeDaemon((path, method) =>
          path === '/api/projects' && method === 'POST'
            ? { project: { id: 'pr-9', name: 'work', path: '/repos/work', usesWorktrees: false } }
            : new DaemonError(404, `unexpected ${method} ${path}`),
        )
      })
      When('I run "project add work /repos/work --in-place"', () =>
        invoke('project add work /repos/work --in-place'),
      )
      Then('it succeeds', () => expect(result.exitCode).toBe(0))
      And('the output says work happens in that checkout', () =>
        expect(output).toContain('one task runs at a time'),
      )
      And('the daemon was told not to use worktrees', () =>
        expect(sentBody()).toEqual({ name: 'work', path: '/repos/work', usesWorktrees: false }),
      )
    })

    RuleScenario('What scaffolding wrote is said out loud', ({ Given, When, Then, And }) => {
      Given(
        'a daemon that accepts a project and scaffolds two files',
        projectAcceptor({ written: ['.xaedalon/.factory/workflows/worktree-create.workflow.yaml', '.xaedalon/.factory/phases/worktree.phase.yaml'], kept: [] }),
      )
      When('I run "project add work /repos/work"', () => invoke('project add work /repos/work'))
      Then('it succeeds', () => expect(result.exitCode).toBe(0))
      And('the output names both files', () => {
        expect(output).toContain('worktree-create.workflow.yaml')
        expect(output).toContain('worktree.phase.yaml')
      })
    })

    RuleScenario("A path the repository refuses comes back in its own words", ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given('a daemon that refuses the path', () => {
        asked = []
        daemon = fakeDaemon(
          () => new DaemonError(400, '"/nowhere" is not a git repository.'),
        )
      })
      When('I run "project add work /nowhere"', () => invoke('project add work /nowhere'))
      Then('it fails', () => expect(result.exitCode).not.toBe(0))
      And('the output says it is not a git repository', () =>
        expect(output).toContain('not a git repository'),
      )
    })

    RuleScenario('Adding a project needs a name and a path', ({ When, Then, And }) => {
      When('I run "project add work"', () => invoke('project add work'))
      Then('the exit code is 2', () => expect(result.exitCode).toBe(2))
      And('the output mentions "<path>"', () => expect(output).toContain('<path>'))
    })
  })
  Rule('`factory mcp` serves the protocol and says nothing else', ({ RuleScenario }) => {
    /** A pipe of strings: what the client sent, and what came back where. */
    let sent: string[] = []
    let written: string[] = []
    let errors: string[] = []
    /** Whether anything ever asked stdin for a chunk. */
    let read = false
    let atATerminal = false

    const pipe = () => ({
      input: {
        async *[Symbol.asyncIterator]() {
          read = true
          for (const chunk of sent) yield chunk
        },
      },
      output: { write: (text: string) => void written.push(text) },
      error: { write: (text: string) => void errors.push(text) },
    })
    const frames = () =>
      written
        .join('')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as { result?: { tools?: { name: string }[] } })

    const serveIt = async (): Promise<void> => {
      streamed = []
      written = []
      errors = []
      read = false
      result = await run({
        argv: ['mcp'],
        cwd: workDir,
        env: { FACTORY_HOME: userScope, FACTORY_URL: 'http://127.0.0.1:9', PATH: '/usr/bin:/bin' },
        write: (text) => streamed.push(text),
        // Handed over exactly as `bin.ts` hands them over: always, with the
        // terminal reported separately. Leaving them out here would specify a
        // shape the product does not produce, which is how the hang survived.
        streams: pipe(),
        stdinIsTty: atATerminal,
      })
      output = [...streamed, ...result.lines].join('\n')
    }

    RuleScenario('It answers a client over the pipe it was given', ({ Given, When, Then, And }) => {
      Given('a client that initializes and lists the tools', () => {
        atATerminal = false
        sent = [
          `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'a-client' } } })}\n`,
          `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`,
        ]
      })
      When('I run "mcp"', serveIt)
      Then('it succeeds', () => expect(result.exitCode).toBe(0))
      And('two frames were written to the pipe', () => expect(frames()).toHaveLength(2))
      // The whole contract of stdio transport, asserted rather than assumed:
      // `bin.ts` prints every line a command returns, so this one returns none.
      And('nothing was printed', () => expect(output).toBe(''))
      And('the tools include "factory_project_current"', () =>
        expect(frames()[1]?.result?.tools?.map((tool) => tool.name)).toContain(
          'factory_project_current',
        ),
      )
    })

    RuleScenario('At a terminal it explains itself rather than waiting', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given('a person typing it, with a terminal on stdin', () => {
        atATerminal = true
        // A frame is waiting, so a server that read stdin would find one and
        // answer it. Nothing should.
        sent = [`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`]
      })
      When('I run "mcp"', serveIt)
      Then('it fails', () => expect(result.exitCode).not.toBe(0))
      And('the output says an MCP client starts it', () =>
        expect(output).toContain('An MCP client starts it'),
      )
      And("the output shows what to put in a client's configuration", () =>
        expect(output).toContain('"mcpServers"'),
      )
      And('nothing was read from stdin', () => {
        expect(read).toBe(false)
        expect(written).toEqual([])
      })
    })

    RuleScenario('Given no streams at all it says the same thing', ({ When, Then, And }) => {
      When('I run "mcp" with no pipe at all', () => invoke('mcp'))
      Then('it fails', () => expect(result.exitCode).not.toBe(0))
      And('the output says an MCP client starts it', () =>
        expect(output).toContain('An MCP client starts it'),
      )
    })

    RuleScenario('It is in the help', ({ When, Then }) => {
      When('I run "--help"', () => invoke('--help'))
      Then('the output mentions "factory mcp"', () => expect(output).toContain('factory mcp'))
    })
  })
})

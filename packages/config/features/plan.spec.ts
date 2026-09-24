import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { EventBus } from '@factory/events'
import {
  CapabilityHost,
  STEP_KIND,
  builtinStepsPlugin,
  closedWithExtensions,
  defineStepKind,
  PROJECT_TOKENS,
  TASK_TOKENS,
  tokenDictionary,
  type ExecutionProfile,
  type PlanResult,
  type ResolvedPhase,
  type TaskContext,
  type TokenNamespace,
} from '@factory/core'
import claudeProvider from '@factory/provider-claude'
import copilotProvider from '@factory/provider-copilot'
import { Sandbox } from './support.js'
import { resolveScopes } from '../src/scopes.js'
import { planWorkflow } from '../src/plan.js'

const feature = await loadFeature(fileURLToPath(new URL('./plan.feature', import.meta.url)))

/** A step kind that validates but has no planner — the half-seam case. */
const unrunnablePlugin = {
  name: 'acme-http',
  version: '1.0.0',
  register(context: { provide: (kind: string, capability: unknown) => void }) {
    context.provide(
      STEP_KIND,
      defineStepKind({
        id: 'http',
        summary: 'Makes an HTTP request.',
        schema: closedWithExtensions({ url: z.string().min(1) }),
      }),
    )
  },
}

describeFeature(feature, ({ Background, Rule, Scenario, BeforeEachScenario, AfterEachScenario }) => {
  let box: Sandbox
  let host: CapabilityHost
  let project = ''
  let result: PlanResult
  let taskId: string | undefined

  const phase = (name: string): ResolvedPhase | undefined =>
    result.plan?.phases.find((p) => p.name === name)
  const errors = () => result.problems.filter((p) => p.severity === 'error')
  const warnings = () => result.problems.filter((p) => p.severity === 'warning')
  const anyMessage = (needle: string) =>
    result.problems.some((p) => p.message.toLowerCase().includes(needle.toLowerCase()))

  BeforeEachScenario(() => {
    box = new Sandbox()
    project = box.scope('work')
    taskId = undefined
  })
  AfterEachScenario(() => box.cleanup())

  Background(({ Given }) => {
    Given('the built-in step kinds and one agent provider are registered', async () => {
      host = new CapabilityHost({ events: new EventBus({ onSubscriberError: () => {} }) })
      await host.loadAll([builtinStepsPlugin, claudeProvider])
    })
  })

  const plan = (name: string) => {
    const chain = resolveScopes({
      cwd: box.dir('work', 'src'),
      env: { FACTORY_HOME: box.scope('home', 'user') },
    })
    result = planWorkflow({
      chain,
      host,
      workflow: name,
      workspace: box.dir('work'),
      ...(taskId === undefined ? {} : { task: { ticketId: taskId } }),
    })
  }
  // Returns void deliberately: a concise arrow handing back the written path
  // makes every `And(..., () => workflow(...))` a step that returns a string
  // where the runner expects nothing.
  const workflow = (name: string, phaseName: string): void => {
    box.workflow(project, name, `name: ${name}\nphases: [${phaseName}]\n`)
  }

  Scenario('The built-in workflow plans', ({ When, Then, And }) => {
    When('the workflow "hello-world" is planned', () => plan('hello-world'))
    Then('planning succeeds', () => expect(errors()).toEqual([]))
    And('the plan has 1 phase', () => expect(result.plan?.phases).toHaveLength(1))
    And('phase "greet" requires approval', () => expect(phase('greet')?.approval).toBe('before'))
    And('phase "greet" step 0 runs "bash"', () =>
      expect(phase('greet')?.steps[0]?.planned.command).toBe('bash'),
    )
  })

  Scenario('A shell step becomes a bash command', ({ Given, And, When, Then }) => {
    Given('the project scope defines a phase "build" running "npm test"', () => {
      box.phase(project, 'build', 'name: build\nsteps: [{run: npm test}]\n')
    })
    And('the project scope defines a workflow "ci" with the phase "build"', () =>
      workflow('ci', 'build'),
    )
    When('the workflow "ci" is planned', () => plan('ci'))
    Then('planning succeeds', () => expect(errors()).toEqual([]))
    And('phase "build" step 0 runs "bash"', () =>
      expect(phase('build')?.steps[0]?.planned.command).toBe('bash'),
    )
    And('phase "build" step 0 passes "npm test"', () =>
      expect(phase('build')?.steps[0]?.planned.args).toContain('npm test'),
    )
  })

  Scenario("An agent step becomes the provider's command", ({ Given, And, When, Then }) => {
    Given('the project scope defines a phase "analyse" with an agent step', () => {
      box.phase(project, 'analyse', 'name: analyse\nsteps: [{uses: agent, prompt: Analyse this}]\n')
    })
    And('the project scope defines a workflow "review" with the phase "analyse"', () =>
      workflow('review', 'analyse'),
    )
    When('the workflow "review" is planned', () => plan('review'))
    Then('planning succeeds', () => expect(errors()).toEqual([]))
    And('phase "analyse" step 0 runs "claude"', () =>
      expect(phase('analyse')?.steps[0]?.planned.command).toBe('claude'),
    )
    And('phase "analyse" step 0 passes the prompt', () =>
      expect(phase('analyse')?.steps[0]?.planned.args).toContain('Analyse this'),
    )
  })

  Scenario('Variables are substituted before the step is planned', ({ Given, And, When, Then }) => {
    Given('the project scope defines a phase "greet-task" echoing "{{ task.ticketId }}"', () => {
      box.phase(project, 'greet-task', 'name: greet-task\nsteps: [{run: "echo {{ task.ticketId }}"}]\n')
    })
    And('the project scope defines a workflow "greeting" with the phase "greet-task"', () =>
      workflow('greeting', 'greet-task'),
    )
    When('the workflow "greeting" is planned for the task "WW2-1234"', () => {
      taskId = 'WW2-1234'
      plan('greeting')
    })
    Then('planning succeeds', () => expect(errors()).toEqual([]))
    And('phase "greet-task" step 0 passes "WW2-1234"', () =>
      expect(phase('greet-task')?.steps[0]?.planned.args.join(' ')).toContain('WW2-1234'),
    )
  })

  Scenario('A token that does not resolve is a warning naming it', ({ Given, And, When, Then }) => {
    Given('the project scope defines a phase "typo" echoing "{{ task.nmae }}"', () => {
      box.phase(project, 'typo', 'name: typo\nsteps: [{run: "echo {{ task.nmae }}"}]\n')
    })
    And('the project scope defines a workflow "oops" with the phase "typo"', () =>
      workflow('oops', 'typo'),
    )
    When('the workflow "oops" is planned for the task "WW2-1234"', () => {
      taskId = 'WW2-1234'
      plan('oops')
    })
    Then('planning succeeds', () => expect(errors()).toEqual([]))
    And('there is a warning about an unresolved token', () =>
      expect(warnings().some((p) => p.rule === 'variables.unknownKey')).toBe(true),
    )
    And('the warning names "task.nmae"', () => expect(anyMessage('task.nmae')).toBe(true))
  })

  Scenario('A namespace Factory does not own is left alone', ({ Given, And, When, Then }) => {
    Given('the project scope defines a phase "template" echoing "{{ mustache.name }}"', () => {
      box.phase(project, 'template', 'name: template\nsteps: [{run: "echo {{ mustache.name }}"}]\n')
    })
    And('the project scope defines a workflow "templating" with the phase "template"', () =>
      workflow('templating', 'template'),
    )
    When('the workflow "templating" is planned', () => plan('templating'))
    Then('planning succeeds', () => expect(errors()).toEqual([]))
    And('there are no warnings about unresolved tokens', () =>
      expect(warnings().some((p) => p.rule === 'variables.unknownKey')).toBe(false),
    )
    And('phase "template" step 0 passes "{{ mustache.name }}"', () =>
      expect(phase('template')?.steps[0]?.planned.args.join(' ')).toContain('{{ mustache.name }}'),
    )
  })

  Scenario('working_dir is honoured rather than merely documented', ({ Given, And, When, Then }) => {
    Given('the project scope defines a phase "web-build" with working directory "web"', () => {
      box.phase(project, 'web-build', 'name: web-build\nworking_dir: web\nsteps: [{run: npm test}]\n')
    })
    And('the project scope defines a workflow "site" with the phase "web-build"', () =>
      workflow('site', 'web-build'),
    )
    When('the workflow "site" is planned', () => plan('site'))
    Then('planning succeeds', () => expect(errors()).toEqual([]))
    And('phase "web-build" runs in a directory ending "web"', () =>
      expect(phase('web-build')?.cwd.endsWith('/web')).toBe(true),
    )
  })

  Scenario('A workflow naming a phase that does not exist fails clearly', ({ Given, When, Then, And }) => {
    Given('the project scope defines a workflow "broken" with the phase "absent"', () =>
      workflow('broken', 'absent'),
    )
    When('the workflow "broken" is planned', () => plan('broken'))
    Then('planning fails', () => expect(result.plan).toBeUndefined())
    And('a problem names the missing phase "absent"', () => expect(anyMessage('absent')).toBe(true))
  })

  Scenario('A workflow that does not exist fails clearly', ({ When, Then, And }) => {
    When('the workflow "nowhere" is planned', () => plan('nowhere'))
    Then('planning fails', () => expect(result.plan).toBeUndefined())
    And('a problem says there is no such workflow', () =>
      expect(anyMessage('no workflow named')).toBe(true),
    )
  })

  Scenario('A step kind that cannot run is reported, not skipped', ({ Given, And, When, Then }) => {
    Given('a plugin registers a "http" step kind with no planner', async () => {
      await host.load(unrunnablePlugin as never)
    })
    And('the project scope defines a phase "fetch" using the "http" step kind', () => {
      box.phase(project, 'fetch', 'name: fetch\nsteps: [{uses: http, url: https://example.com}]\n')
    })
    And('the project scope defines a workflow "fetching" with the phase "fetch"', () =>
      workflow('fetching', 'fetch'),
    )
    When('the workflow "fetching" is planned', () => plan('fetching'))
    Then('planning fails', () => expect(result.plan).toBeUndefined())
    And('a problem says the step kind cannot be run', () =>
      expect(anyMessage('written but not run')).toBe(true),
    )
  })

  Scenario('An agent step naming an unknown provider fails clearly', ({ Given, And, When, Then }) => {
    Given('the project scope defines a phase "wrong-agent" using the provider "gemini"', () => {
      box.phase(
        project,
        'wrong-agent',
        'name: wrong-agent\nsteps: [{uses: agent, provider: gemini, prompt: Hi}]\n',
      )
    })
    And('the project scope defines a workflow "guess" with the phase "wrong-agent"', () =>
      workflow('guess', 'wrong-agent'),
    )
    When('the workflow "guess" is planned', () => plan('guess'))
    Then('planning fails', () => expect(result.plan).toBeUndefined())
    And('a problem lists the installed providers', () => expect(anyMessage('installed')).toBe(true))
  })

  Scenario('With one provider installed a step need not name it', ({ Given, And, When, Then }) => {
    Given('the project scope defines a phase "analyse" with an agent step', () => {
      box.phase(project, 'analyse', 'name: analyse\nsteps: [{uses: agent, prompt: Analyse this}]\n')
    })
    And('the project scope defines a workflow "review" with the phase "analyse"', () =>
      workflow('review', 'analyse'),
    )
    When('the workflow "review" is planned', () => plan('review'))
    Then('planning succeeds', () => expect(errors()).toEqual([]))
    And('phase "analyse" step 0 runs "claude"', () =>
      expect(phase('analyse')?.steps[0]?.planned.command).toBe('claude'),
    )
  })

  Scenario('With several providers installed an unnamed step is ambiguous', ({ Given, And, When, Then }) => {
    Given('a second agent provider is registered', async () => {
      await host.load(copilotProvider)
    })
    And('the project scope defines a phase "analyse" with an agent step', () => {
      box.phase(project, 'analyse', 'name: analyse\nsteps: [{uses: agent, prompt: Analyse this}]\n')
    })
    And('the project scope defines a workflow "review" with the phase "analyse"', () =>
      workflow('review', 'analyse'),
    )
    When('the workflow "review" is planned', () => plan('review'))
    Then('planning fails', () => expect(result.plan).toBeUndefined())
    And('a problem says the step does not say which agent to use', () =>
      expect(anyMessage('does not say which agent')).toBe(true),
    )
  })

  Scenario('A setting the chosen agent ignores is warned about at planning time', ({ Given, And, When, Then }) => {
    Given('the project scope defines a phase "effortful" asking for effort on copilot', () => {
      box.phase(
        project,
        'effortful',
        'name: effortful\nsteps: [{uses: agent, provider: copilot, prompt: Hi, effort: max}]\n',
      )
    })
    And('the project scope defines a workflow "effortfully" with the phase "effortful"', () =>
      workflow('effortfully', 'effortful'),
    )
    And('the copilot provider is registered', async () => {
      await host.load(copilotProvider)
    })
    When('the workflow "effortfully" is planned', () => plan('effortfully'))
    Then('planning succeeds', () => expect(errors()).toEqual([]))
    And('there is a warning about effort', () =>
      expect(warnings().some((p) => p.rule === 'provider.effortUnsupported')).toBe(true),
    )
  })

  Rule('a step may name an agent, and the agent supplies the settings', ({ RuleScenario }) => {
    /** Every argument of every planned step, as one string. */
    const commandLine = () =>
      (result.plan?.phases ?? [])
        .flatMap((resolved) => resolved.steps)
        .flatMap((planned) => [planned.planned.command, ...planned.planned.args])
        .join(' ')

    const givenAgent = (): void => {
      box.agent(project, 'developer', 'name: developer\nprovider: claude\nmodel: strong\n')
    }

    RuleScenario("The named agent's provider and model are used", ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given(
        'the project scope defines an agent "developer" using claude and the strong model',
        givenAgent,
      )
      And('the project scope defines a phase "build" whose step names the agent "developer"', () => {
        box.phase(project, 'build', 'name: build\nsteps: [{agent: developer, prompt: Do it}]\n')
      })
      And('the project scope defines a workflow "building" with the phase "build"', () =>
        workflow('building', 'build'),
      )
      When('the workflow "building" is planned', () => plan('building'))
      Then('planning succeeds', () => expect(errors()).toEqual([]))
      // `strong` is a role; claude maps it to `opus`. Asserting the rendered
      // argument rather than the field proves the agent reached the provider.
      And('the planned command carries the strong model', () =>
        expect(commandLine()).toContain('--model opus'),
      )
    })

    RuleScenario("A setting on the step beats the agent's", ({ Given, And, When, Then }) => {
      Given(
        'the project scope defines an agent "developer" using claude and the strong model',
        givenAgent,
      )
      And(
        'the project scope defines a phase "build" whose step names "developer" but asks for the fast model',
        () => {
          box.phase(
            project,
            'build',
            'name: build\nsteps: [{agent: developer, model: fast, prompt: Do it}]\n',
          )
        },
      )
      And('the project scope defines a workflow "building" with the phase "build"', () =>
        workflow('building', 'build'),
      )
      When('the workflow "building" is planned', () => plan('building'))
      Then('planning succeeds', () => expect(errors()).toEqual([]))
      And('the planned command carries the fast model', () =>
        expect(commandLine()).toContain('--model haiku'),
      )
    })

    RuleScenario('Naming an agent that does not exist fails clearly', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('the project scope defines a phase "build" whose step names the agent "nobody"', () => {
        box.phase(project, 'build', 'name: build\nsteps: [{agent: nobody, prompt: Do it}]\n')
      })
      And('the project scope defines a workflow "building" with the phase "build"', () =>
        workflow('building', 'build'),
      )
      When('the workflow "building" is planned', () => plan('building'))
      Then('planning fails', () => expect(errors().length).toBeGreaterThan(0))
      And('a problem mentions "nobody"', () => expect(anyMessage('nobody')).toBe(true))
    })
  })

  Rule('an artifact is promised to the agent and looked for in the same place', ({
    RuleScenario,
  }) => {
    const artifactsDir = () => box.dir('work', 'artifacts-root')

    const planForTask = (name: string): void => {
      const chain = resolveScopes({
        cwd: box.dir('work', 'src'),
        env: { FACTORY_HOME: box.scope('home', 'user') },
      })
      result = planWorkflow({
        chain,
        host,
        workflow: name,
        workspace: box.dir('work'),
        task: { name: 'Check it', directory: 'check-it' },
        artifacts: artifactsDir(),
      })
    }
    const onlyStep = () => result.plan?.phases[0]?.steps[0]
    const prompt = () => (onlyStep()?.planned.args ?? []).at(-1) ?? ''

    const givenWriting = (): void => {
      box.phase(
        project,
        'review',
        'name: review\nsteps: [{uses: agent, provider: claude, artifact: analysis, prompt: "Look at it.\\nThen say so."}]\n',
      )
    }
    const givenPlain = (): void => {
      box.phase(project, 'plain', 'name: plain\nsteps: [{uses: agent, provider: claude, prompt: Just this.}]\n')
    }

    RuleScenario('The prompt names the file the plan will collect', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given(
        'the project scope defines a phase "review" whose agent step writes the artifact "analysis"',
        givenWriting,
      )
      And('the project scope defines a workflow "reviewing" with the phase "review"', () =>
        workflow('reviewing', 'review'),
      )
      When('the workflow "reviewing" is planned for a task', () => planForTask('reviewing'))
      Then('planning succeeds', () => expect(errors()).toEqual([]))
      And('the step carries the artifact "analysis"', () =>
        expect(onlyStep()?.artifact?.name).toBe('analysis'),
      )
      // The whole point of the rule: one path, said twice, identical.
      And('the prompt tells the agent to write to exactly that path', () =>
        expect(prompt()).toContain(`Write your output to ${onlyStep()?.artifact?.path}`),
      )
    })

    RuleScenario("The path is Markdown, under the task's own artifacts directory", ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given(
        'the project scope defines a phase "review" whose agent step writes the artifact "analysis"',
        givenWriting,
      )
      And('the project scope defines a workflow "reviewing" with the phase "review"', () =>
        workflow('reviewing', 'review'),
      )
      When('the workflow "reviewing" is planned for a task', () => planForTask('reviewing'))
      Then('the artifact is at "artifacts/analysis/analysis.md"', () =>
        expect(onlyStep()?.artifact?.path).toBe(
          `${artifactsDir()}/analysis/analysis.md`,
        ),
      )
    })

    RuleScenario('A step with no artifact has nothing added to its prompt', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given(
        'the project scope defines a phase "plain" whose agent step writes no artifact',
        givenPlain,
      )
      And('the project scope defines a workflow "plainly" with the phase "plain"', () =>
        workflow('plainly', 'plain'),
      )
      When('the workflow "plainly" is planned for a task', () => planForTask('plainly'))
      Then('the prompt is exactly what was written', () => expect(prompt()).toBe('Just this.'))
    })

    RuleScenario("What the timeline shows is the prompt as written", ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given(
        'the project scope defines a phase "review" whose agent step writes the artifact "analysis"',
        givenWriting,
      )
      And('the project scope defines a workflow "reviewing" with the phase "review"', () =>
        workflow('reviewing', 'review'),
      )
      When('the workflow "reviewing" is planned for a task', () => planForTask('reviewing'))
      // Factory's own sentence in the run timeline, the step row and
      // `--dry-run` would be its own small lie about what was asked for.
      Then("the step is described by the author's first line", () =>
        expect(onlyStep()?.planned.describe).toBe('claude: Look at it.'),
      )
    })
  })

  Rule('the token dictionary documents tokens that actually resolve', ({ RuleScenario }) => {
    let dictionary: readonly TokenNamespace[] = []

    /** Every documented key of a namespace, as the tokens a step would write. */
    const tokensOf = (table: Readonly<Record<string, string>>, namespace: string): string[] =>
      Object.keys(table).map((key) => `{{ ${namespace}.${key} }}`)

    /** A TaskContext with every documented field set to something recognisable. */
    const fullTask = (): TaskContext =>
      Object.fromEntries(
        Object.keys(TASK_TOKENS).map((key) => [key, `<${key}>`]),
      ) as unknown as TaskContext

    const fullProject = (): Record<string, string> =>
      Object.fromEntries(Object.keys(PROJECT_TOKENS).map((key) => [key, `<${key}>`]))

    /** One shell step echoing the tokens, so the planned command carries them. */
    const phaseUsing = (tokens: readonly string[]): void => {
      box.phase(project, 'vocabulary', `name: vocabulary\nsteps: [{run: 'echo ${tokens.join(' ')}'}]\n`)
    }

    const planWith = (task: TaskContext, projectValues: Record<string, string>): void => {
      const chain = resolveScopes({
        cwd: box.dir('work', 'src'),
        env: { FACTORY_HOME: box.scope('home', 'user') },
      })
      result = planWorkflow({
        chain,
        host,
        workflow: 'vocabulary',
        workspace: box.dir('work'),
        task,
        project: projectValues,
      })
    }

    const command = (): string =>
      (result.plan?.phases[0]?.steps[0]?.planned.args ?? []).join(' ')
    const unresolved = (): readonly string[] =>
      result.problems
        .filter((problem) => problem.rule === 'variables.unknownKey')
        .map((problem) => problem.message)

    RuleScenario('Every task token the dictionary lists resolves to a value', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('a phase whose step uses every task token the dictionary documents', () => {
        phaseUsing(tokensOf(TASK_TOKENS, 'task'))
      })
      And('the project scope defines a workflow "vocabulary" with that phase', () =>
        workflow('vocabulary', 'vocabulary'),
      )
      When('the workflow "vocabulary" is planned for a task with every field set', () => {
        planWith(fullTask(), {})
      })
      Then('planning succeeds', () => expect(result.plan).toBeDefined())
      And('no token was left unresolved', () => expect(unresolved()).toEqual([]))
      // The compiler proves the *keys* match TaskContext. Only running it
      // proves something actually puts a value behind each one.
      //
      // `artifacts` is the exception, and deliberately: the resolver derives it
      // from the same root it gives the wrapper, so a caller's value for it is
      // overridden rather than trusted. That is what keeps the prompt and the
      // collector naming one file.
      And('every documented task token was replaced by its value', () => {
        for (const key of Object.keys(TASK_TOKENS)) {
          if (key === 'artifacts') continue
          expect(command()).toContain(`<${key}>`)
        }
        expect(command()).not.toContain('{{')
      })
      And('the artifacts token is the root the plan derived, not one it was handed', () => {
        expect(command()).toContain('/artifacts')
        expect(command()).not.toContain('<artifacts>')
      })
    })

    RuleScenario('Every project token the dictionary lists resolves to a value', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('a phase whose step uses every project token the dictionary documents', () => {
        phaseUsing(tokensOf(PROJECT_TOKENS, 'project'))
      })
      And('the project scope defines a workflow "vocabulary" with that phase', () =>
        workflow('vocabulary', 'vocabulary'),
      )
      When('the workflow "vocabulary" is planned with every project value set', () => {
        planWith(fullTask(), fullProject())
      })
      Then('planning succeeds', () => expect(result.plan).toBeDefined())
      And('no token was left unresolved', () => expect(unresolved()).toEqual([]))
    })

    RuleScenario('A task token the dictionary does not list is a warning', ({
      Given,
      And,
      When,
      Then,
    }) => {
      // The token in the user's own example, which does not exist. Better a
      // named warning than a shell command containing a literal `{{ }}`.
      Given('a phase whose step uses "{{ task.worktreePath }}"', () => {
        phaseUsing(['{{ task.worktreePath }}'])
      })
      And('the project scope defines a workflow "vocabulary" with that phase', () =>
        workflow('vocabulary', 'vocabulary'),
      )
      When('the workflow "vocabulary" is planned for a task with every field set', () => {
        planWith(fullTask(), {})
      })
      Then('a problem names the unresolved token "{{ task.worktreePath }}"', () =>
        expect(unresolved().join('\n')).toContain('{{ task.worktreePath }}'),
      )
      And('the problem lists what the namespace does have', () =>
        expect(unresolved().join('\n')).toContain('directory'),
      )
    })

    RuleScenario('The dictionary says which namespaces it cannot fill itself', ({
      When,
      Then,
      And,
    }) => {
      When('the token dictionary is read', () => {
        dictionary = tokenDictionary()
      })
      const sourceOf = (namespace: string): string | undefined =>
        dictionary.find((entry) => entry.namespace === namespace)?.source
      Then('"task" and "project" are filled by Factory', () => {
        expect(sourceOf('task')).toBe('factory')
        expect(sourceOf('project')).toBe('factory')
      })
      // A workflow's `variables:` are whatever that workflow declared, so an
      // empty list here is accurate rather than broken — and the editor holding
      // the definition is the only thing that can fill it in.
      And('"workflow", "phase" and "variables" come from the definition', () => {
        expect(sourceOf('workflow')).toBe('definition')
        expect(sourceOf('phase')).toBe('definition')
        expect(sourceOf('variables')).toBe('definition')
      })
    })
  })

  Rule('the task namespace is complete however the plan was reached', ({ RuleScenario }) => {
    const planNoTask = (name: string): void => {
      const chain = resolveScopes({
        cwd: box.dir('work', 'src'),
        env: { FACTORY_HOME: box.scope('home', 'user') },
      })
      // No `task`, and no `artifacts` — exactly what `factory run` hands over.
      result = planWorkflow({ chain, host, workflow: name, workspace: box.dir('work') })
    }
    const command = (): string =>
      (result.plan?.phases[0]?.steps[0]?.planned.args ?? []).join(' ')
    const unresolved = (): readonly string[] =>
      result.problems
        .filter((problem) => problem.rule === 'variables.unknownKey')
        .map((problem) => problem.message)

    RuleScenario('A plan with no task at all still resolves the artifacts root', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('the project scope defines a phase "reader" that reads an earlier artifact', () => {
        box.phase(
          project,
          'reader',
          `name: reader\nsteps: [{run: 'cat {{ task.artifacts }}/analysis/analysis.md'}]\n`,
        )
      })
      And('the project scope defines a workflow "reading" with the phase "reader"', () =>
        workflow('reading', 'reader'),
      )
      When('the workflow "reading" is planned with no task', () => planNoTask('reading'))
      Then('planning succeeds', () => expect(result.plan).toBeDefined())
      And('no token was left unresolved', () => expect(unresolved()).toEqual([]))
      And('the command names an absolute artifacts path', () => {
        expect(command()).toContain('/artifacts/analysis/analysis.md')
        expect(command()).not.toContain('{{')
      })
    })

    RuleScenario('A documented token nobody supplied is empty, not missing', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('the project scope defines a phase "ticketed" that echoes the ticket', () => {
        box.phase(project, 'ticketed', `name: ticketed\nsteps: [{run: 'echo {{ task.ticketId }}'}]\n`)
      })
      And('the project scope defines a workflow "ticketing" with the phase "ticketed"', () =>
        workflow('ticketing', 'ticketed'),
      )
      When('the workflow "ticketing" is planned with no task', () => planNoTask('ticketing'))
      Then('planning succeeds', () => expect(result.plan).toBeDefined())
      // The dictionary documents ticketId, so it resolves — to nothing.
      And('no token was left unresolved', () => expect(unresolved()).toEqual([]))
    })

    RuleScenario('The artifacts token and the wrapper name the same root', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('the project scope defines a phase "both" that reads an artifact and writes one', () => {
        box.phase(
          project,
          'both',
          'name: both\nsteps: [{uses: agent, provider: claude, artifact: report, prompt: "Read {{ task.artifacts }}/analysis/analysis.md"}]\n',
        )
      })
      And('the project scope defines a workflow "bothly" with the phase "both"', () =>
        workflow('bothly', 'both'),
      )
      When('the workflow "bothly" is planned with no task', () => planNoTask('bothly'))
      // The bug this guards: two derivations of one root, so the phase reads
      // from somewhere nothing writes to.
      Then('the path it was told to read from is under the same root it writes to', () => {
        const root = result.plan?.phases[0]?.steps[0]?.artifact?.path.replace(
          /\/report\/report\.md$/,
          '',
        )
        expect(root).toBeDefined()
        expect(command()).toContain(`${root as string}/analysis/analysis.md`)
      })
    })
  })

  Rule('the project namespace is complete too, for the same reason', ({ RuleScenario }) => {
    const usingToken = (token: string) => (): void => {
      box.phase(project, 'vocabulary', `name: vocabulary\nsteps: [{run: 'echo ${token}'}]\n`)
    }
    const planNoProject = (): void => {
      const chain = resolveScopes({
        cwd: box.dir('work', 'src'),
        env: { FACTORY_HOME: box.scope('home', 'user') },
      })
      // No `project`, exactly what `factory run` hands over.
      result = planWorkflow({ chain, host, workflow: 'vocabulary', workspace: box.dir('work') })
    }
    const stillUnresolved = (): readonly string[] =>
      result.problems
        .filter((problem) => problem.rule === 'variables.unknownKey')
        .map((problem) => problem.message)

    RuleScenario('A documented project token nobody supplied is empty, not literal', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('a phase whose step uses "{{ project.check }}"', usingToken('{{ project.check }}'))
      And('the project scope defines a workflow "vocabulary" with that phase', () =>
        workflow('vocabulary', 'vocabulary'),
      )
      When('the workflow "vocabulary" is planned with no project at all', planNoProject)
      Then('no token was left unresolved', () => expect(stillUnresolved()).toEqual([]))
      // The rendered argv, because the warning going away is not the point —
      // the literal `{{ … }}` reaching bash is.
      And('no token survived into the command', () =>
        expect(result.plan?.phases[0]?.steps[0]?.planned.args.join(' ')).not.toContain('{{'),
      )
    })

    RuleScenario('A misspelled project token is still a warning', ({ Given, And, When, Then }) => {
      Given('a phase whose step uses "{{ project.chekc }}"', usingToken('{{ project.chekc }}'))
      And('the project scope defines a workflow "vocabulary" with that phase', () =>
        workflow('vocabulary', 'vocabulary'),
      )
      When('the workflow "vocabulary" is planned with no project at all', planNoProject)
      Then('a problem names the unresolved token "{{ project.chekc }}"', () =>
        expect(stillUnresolved().join('\n')).toContain('{{ project.chekc }}'),
      )
    })
  })

  Rule('one session per plan, started by the first agent step that needs it', ({
    RuleScenario,
  }) => {
    let session: { id: string; started: boolean } | undefined

    const planWithSession = (name: string) => (): void => {
      const chain = resolveScopes({
        cwd: box.dir('work', 'src'),
        env: { FACTORY_HOME: box.scope('home', 'user') },
      })
      result = planWorkflow({
        chain,
        host,
        workflow: name,
        workspace: box.dir('work'),
        ...(session === undefined ? {} : { session }),
      })
    }

    /**
     * Two phases, one agent step each, both carrying a session.
     *
     * `session: task` is opted into — by the step or by the agent it names, the
     * way the real definitions do it. A step that says nothing gets no session,
     * which is a scenario of its own in the provider suite.
     */
    const twoAgentPhases = (): void => {
      box.phase(
        project,
        'first',
        'name: first\nsteps: [{uses: agent, prompt: one, session: task}]\n',
      )
      box.phase(
        project,
        'second',
        'name: second\nsteps: [{uses: agent, prompt: two, session: task}]\n',
      )
      box.workflow(project, 'review', 'name: review\nphases: [first, second]\n')
    }

    /** Every agent step of the plan, in the order it would run. */
    const agentSteps = () =>
      (result.plan?.phases ?? []).flatMap((entry) =>
        entry.steps.filter((step) => step.uses === 'agent'),
      )
    const startsWith = (index: number, id: string) => () =>
      expect(agentSteps()[index]?.planned.session).toEqual({
        id,
        provider: 'claude',
        creates: true,
      })
    const resumesWith = (index: number, id: string) => () =>
      expect(agentSteps()[index]?.planned.session).toEqual({
        id,
        provider: 'claude',
        creates: false,
      })

    RuleScenario('The first agent step starts the session', ({ Given, When, Then, And }) => {
      Given('the project scope defines a workflow "review" with two agent phases', twoAgentPhases)
      When('the workflow "review" is planned with the new session "s-1"', () => {
        session = { id: 's-1', started: false }
        planWithSession('review')()
      })
      Then('planning succeeds', () => expect(errors()).toEqual([]))
      And('the first agent step starts the session "s-1"', startsWith(0, 's-1'))
    })

    RuleScenario('A later agent step continues it', ({ Given, When, Then }) => {
      Given('the project scope defines a workflow "review" with two agent phases', twoAgentPhases)
      When('the workflow "review" is planned with the new session "s-1"', () => {
        session = { id: 's-1', started: false }
        planWithSession('review')()
      })
      Then('the second agent step resumes the session "s-1"', resumesWith(1, 's-1'))
    })

    RuleScenario('Two agent steps in one phase follow the same rule', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('the project scope defines a phase "twice" with two agent steps', () => {
        box.phase(
          project,
          'twice',
          'name: twice\nsteps: [{uses: agent, prompt: one, session: task}, ' +
            '{uses: agent, prompt: two, session: task}]\n',
        )
      })
      And('the project scope defines a workflow "double" with the phase "twice"', () =>
        workflow('double', 'twice'),
      )
      When('the workflow "double" is planned with the new session "s-1"', () => {
        session = { id: 's-1', started: false }
        planWithSession('double')()
      })
      Then('the first agent step starts the session "s-1"', startsWith(0, 's-1'))
      // Within a phase as much as across phases: the counter is the plan's,
      // not the phase's.
      And('the second step of "twice" resumes the session "s-1"', resumesWith(1, 's-1'))
    })

    RuleScenario('A shell step in between does not consume the session', ({
      Given,
      When,
      Then,
    }) => {
      Given(
        'the project scope defines a workflow "mixed" with a shell phase then an agent phase',
        () => {
          box.phase(project, 'build', 'name: build\nsteps: [{run: npm test}]\n')
          box.phase(
            project,
            'look',
            'name: look\nsteps: [{uses: agent, prompt: look, session: task}]\n',
          )
          box.workflow(project, 'mixed', 'name: mixed\nphases: [build, look]\n')
        },
      )
      When('the workflow "mixed" is planned with the new session "s-1"', () => {
        session = { id: 's-1', started: false }
        planWithSession('mixed')()
      })
      Then('the first agent step starts the session "s-1"', startsWith(0, 's-1'))
    })

    RuleScenario('A session that already exists is continued from the very first step', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given('the project scope defines a workflow "review" with two agent phases', twoAgentPhases)
      When('the workflow "review" is planned with the existing session "s-1"', () => {
        session = { id: 's-1', started: true }
        planWithSession('review')()
      })
      Then('the first agent step resumes the session "s-1"', resumesWith(0, 's-1'))
      // Nothing may claim to start a session on a re-run: the engine records on
      // that claim, and a second recording would overwrite the first.
      And('no step starts a session', () =>
        expect(agentSteps().some((step) => step.planned.session?.creates === true)).toBe(false),
      )
    })

    RuleScenario("The starting step carries a retry that resumes instead", ({
      Given,
      When,
      Then,
    }) => {
      Given('the project scope defines a workflow "review" with two agent phases', twoAgentPhases)
      When('the workflow "review" is planned with the new session "s-1"', () => {
        session = { id: 's-1', started: false }
        planWithSession('review')()
      })
      Then("the first agent step's retry resumes the session \"s-1\"", () => {
        const retry = agentSteps()[0]?.planned.retryArgs ?? []
        expect(retry.join(' ')).toContain('--resume s-1')
        expect(retry.join(' ')).not.toContain('--session-id')
      })
    })

    RuleScenario('A later step needs no retry command of its own', ({ Given, When, Then }) => {
      Given('the project scope defines a workflow "review" with two agent phases', twoAgentPhases)
      When('the workflow "review" is planned with the new session "s-1"', () => {
        session = { id: 's-1', started: false }
        planWithSession('review')()
      })
      // Its command is already the resuming one, so running it again is fine.
      Then('the second agent step has no separate retry command', () =>
        expect(agentSteps()[1]?.planned.retryArgs).toBeUndefined(),
      )
    })

    RuleScenario('Planning with no session renders no session flags', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given('the project scope defines a workflow "review" with two agent phases', twoAgentPhases)
      When('the workflow "review" is planned', () => {
        session = undefined
        planWithSession('review')()
      })
      Then('planning succeeds', () => expect(errors()).toEqual([]))
      And('no step mentions a session', () => {
        expect(agentSteps().every((step) => step.planned.session === undefined)).toBe(true)
        expect(
          agentSteps().every((step) => !step.planned.args.join(' ').includes('--session-id')),
        ).toBe(true)
      })
    })
  })

  Rule('a phase runs inside the workspace, or the plan is refused', ({ RuleScenario }) => {
    const phaseIn = (name: string, workingDir: string) => (): void => {
      box.phase(
        project,
        name,
        `name: ${name}\nworking_dir: ${workingDir}\nsteps: [{run: npm test}]\n`,
      )
    }
    const planAs = (profile: ExecutionProfile) => (): void => {
      const chain = resolveScopes({
        cwd: box.dir('work', 'src'),
        env: { FACTORY_HOME: box.scope('home', 'user') },
      })
      result = planWorkflow({ chain, host, workflow: 'site', workspace: box.dir('work'), profile })
    }
    const named = (severity: 'error' | 'warning') => (): void => {
      const matching = result.problems.filter(
        (problem) =>
          problem.severity === severity && problem.rule === 'plan.outsideWorkspace',
      )
      expect(matching).toHaveLength(1)
      expect(matching[0]?.field).toContain('working_dir')
    }

    RuleScenario('A relative working directory inside the workspace is fine', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given(
        'the project scope defines a phase "web-build" with working directory "web"',
        phaseIn('web-build', 'web'),
      )
      And('the project scope defines a workflow "site" with the phase "web-build"', () =>
        workflow('site', 'web-build'),
      )
      When('the workflow "site" is planned', () => plan('site'))
      Then('planning succeeds', () => expect(errors()).toEqual([]))
    })

    RuleScenario('An absolute working directory is refused', ({ Given, And, When, Then }) => {
      Given(
        'the project scope defines a phase "escape" with working directory "/tmp"',
        phaseIn('escape', '/tmp'),
      )
      And('the project scope defines a workflow "site" with the phase "escape"', () =>
        workflow('site', 'escape'),
      )
      When('the workflow "site" is planned', () => plan('site'))
      Then('planning fails', () => expect(result.plan).toBeUndefined())
      And("a problem names the phase's working directory", named('error'))
      And('the problem says which profile allows it', () => {
        expect(anyMessage('Full Access')).toBe(true)
      })
    })

    RuleScenario('A working directory that climbs out is refused', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given(
        'the project scope defines a phase "escape" with working directory "../../elsewhere"',
        phaseIn('escape', '../../elsewhere'),
      )
      And('the project scope defines a workflow "site" with the phase "escape"', () =>
        workflow('site', 'escape'),
      )
      When('the workflow "site" is planned', () => plan('site'))
      Then('planning fails', () => expect(result.plan).toBeUndefined())
      And("a problem names the phase's working directory", named('error'))
    })

    RuleScenario('A working directory that climbs out and back is fine', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given(
        'the project scope defines a phase "web-build" with working directory "../work/web"',
        phaseIn('web-build', '../work/web'),
      )
      And('the project scope defines a workflow "site" with the phase "web-build"', () =>
        workflow('site', 'web-build'),
      )
      When('the workflow "site" is planned', () => plan('site'))
      Then('planning succeeds', () => expect(errors()).toEqual([]))
    })

    RuleScenario('Full Access allows it and says so', ({ Given, And, When, Then }) => {
      Given(
        'the project scope defines a phase "escape" with working directory "/tmp"',
        phaseIn('escape', '/tmp'),
      )
      And('the project scope defines a workflow "site" with the phase "escape"', () =>
        workflow('site', 'escape'),
      )
      When('the workflow "site" is planned under Full Access', planAs('full-access'))
      Then('planning succeeds', () => expect(errors()).toEqual([]))
      And("a warning names the phase's working directory", named('warning'))
      And('phase "escape" runs in "/tmp"', () => expect(phase('escape')?.cwd).toBe('/tmp'))
    })
  })
  Rule('a workflow that would run nothing is refused rather than run', ({ RuleScenario }) => {
    const nothingToRun = () =>
      expect(anyMessage('nothing to run')).toBe(true)

    RuleScenario('A workflow with no phases at all', ({ Given, When, Then, And }) => {
      Given('the project scope defines a workflow "design" with no phases', () => {
        box.workflow(project, 'design', 'name: design\nphases: []\n')
      })
      When('the workflow "design" is planned', () => plan('design'))
      Then('planning fails', () => expect(result.plan).toBeUndefined())
      And('a problem says the workflow has nothing to run', nothingToRun)
    })

    RuleScenario('A workflow whose only phase has no steps', ({ Given, And, When, Then }) => {
      Given('the project scope defines a phase "think" with no steps', () => {
        box.phase(project, 'think', 'name: think\nsteps: []\n')
      })
      And('the project scope defines a workflow "design" with the phase "think"', () =>
        workflow('design', 'think'),
      )
      When('the workflow "design" is planned', () => plan('design'))
      Then('planning fails', () => expect(result.plan).toBeUndefined())
      And('a problem says the workflow has nothing to run', nothingToRun)
    })

    RuleScenario('One empty phase beside a real one is not refused', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('the project scope defines a phase "think" with no steps', () => {
        box.phase(project, 'think', 'name: think\nsteps: []\n')
      })
      And('the project scope defines a phase "work" that prints "building"', () => {
        box.phase(project, 'work', 'name: work\nsteps: [{run: echo building}]\n')
      })
      And('the project scope defines a workflow "design" with the phases "think, work"', () => {
        box.workflow(project, 'design', 'name: design\nphases: [think, work]\n')
      })
      When('the workflow "design" is planned', () => plan('design'))
      Then('planning succeeds', () => expect(errors()).toEqual([]))
    })
  })

  Rule('a step cannot argue its way past the profile it runs under', ({ RuleScenario }) => {
    const planUnder = (profile: ExecutionProfile) => (): void => {
      const chain = resolveScopes({
        cwd: box.dir('work', 'src'),
        env: { FACTORY_HOME: box.scope('home', 'user') },
      })
      result = planWorkflow({
        chain,
        host,
        workflow: 'review',
        workspace: box.dir('work'),
        profile,
      })
    }
    const phasePassing = (name: string, args: string) => (): void => {
      box.phase(
        project,
        name,
        `name: ${name}\nsteps: [{uses: agent, prompt: Do it, args: [${args}]}]\n`,
      )
    }
    const tooMuchAuthority = (): void => {
      const matching = result.problems.filter(
        (problem) => problem.rule === 'plan.argsWidenProfile',
      )
      expect(matching, JSON.stringify(result.problems)).toHaveLength(1)
      expect(matching[0]?.severity).toBe('error')
      expect(matching[0]?.message).toContain('bypassPermissions')
    }

    RuleScenario('A step whose args would grant Full Access is refused', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given(
        'the project scope defines a phase "sneaky" passing "--permission-mode bypassPermissions"',
        phasePassing('sneaky', "'--permission-mode', 'bypassPermissions'"),
      )
      And('the project scope defines a workflow "review" with the phase "sneaky"', () =>
        workflow('review', 'sneaky'),
      )
      When('the workflow "review" is planned', () => plan('review'))
      Then('planning fails', () => expect(result.plan).toBeUndefined())
      And(
        'a problem says the step asks for more authority than the profile allows',
        tooMuchAuthority,
      )
    })

    RuleScenario('A named agent cannot do it either', ({ Given, And, When, Then }) => {
      Given(
        'the project scope defines an agent "sneaky" passing "--permission-mode bypassPermissions"',
        () => {
          box.agent(
            project,
            'sneaky',
            "name: sneaky\nprovider: claude\nargs: ['--permission-mode', 'bypassPermissions']\n",
          )
        },
      )
      And('the project scope defines a phase "build" whose step names the agent "sneaky"', () => {
        box.phase(project, 'build', 'name: build\nsteps: [{agent: sneaky, prompt: Do it}]\n')
      })
      And('the project scope defines a workflow "building" with the phase "build"', () =>
        workflow('building', 'build'),
      )
      When('the workflow "building" is planned', () => plan('building'))
      Then('planning fails', () => expect(result.plan).toBeUndefined())
      And(
        'a problem says the step asks for more authority than the profile allows',
        tooMuchAuthority,
      )
    })

    RuleScenario('Under Full Access the same step plans', ({ Given, And, When, Then }) => {
      Given(
        'the project scope defines a phase "sneaky" passing "--permission-mode bypassPermissions"',
        phasePassing('sneaky', "'--permission-mode', 'bypassPermissions'"),
      )
      And('the project scope defines a workflow "review" with the phase "sneaky"', () =>
        workflow('review', 'sneaky'),
      )
      When('the workflow "review" is planned under Full Access', planUnder('full-access'))
      Then('planning succeeds', () => expect(errors()).toEqual([]))
    })

    RuleScenario('An ordinary argument still works', ({ Given, And, When, Then }) => {
      Given(
        'the project scope defines a phase "verbose" passing "--verbose"',
        phasePassing('verbose', "'--verbose'"),
      )
      And('the project scope defines a workflow "review" with the phase "verbose"', () =>
        workflow('review', 'verbose'),
      )
      When('the workflow "review" is planned', () => plan('review'))
      Then('planning succeeds', () => expect(errors()).toEqual([]))
      And('phase "verbose" step 0 passes "--verbose"', () =>
        expect(phase('verbose')?.steps[0]?.planned.args).toContain('--verbose'),
      )
    })
  })

  Rule("the gate runs the project's own command, or refuses to run at all", ({ RuleScenario }) => {
    /**
     * Planned the way the daemon plans.
     *
     * `check` is always present and empty when the project has never set one —
     * that is `projectVariables`, and it is what makes "no check command" an
     * *empty command* rather than an unknown token. A scenario that left the
     * key out would be describing a caller Factory does not have.
     */
    const planWithCheck = (check: string) => (): void => {
      const chain = resolveScopes({
        cwd: box.dir('work', 'src'),
        env: { FACTORY_HOME: box.scope('home', 'user') },
      })
      result = planWorkflow({
        chain,
        host,
        workflow: 'validate',
        workspace: box.dir('work'),
        project: { check },
      })
    }
    let check = ''
    const setCheck = (value: string) => (): void => {
      check = value
    }
    const planned = (): void => planWithCheck(check)()
    const noCommand = (): void => {
      const matching = result.problems.filter((problem) => problem.rule === 'plan.emptyCommand')
      expect(matching, JSON.stringify(result.problems)).toHaveLength(1)
      expect(matching[0]?.severity).toBe('error')
    }

    RuleScenario("The built-in gate runs the project's check command", ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('the project\'s check command is "pnpm test"', setCheck('pnpm test'))
      And(
        'the project scope defines a workflow "validate" with the phase "project-check"',
        () => workflow('validate', 'project-check'),
      )
      When('the workflow "validate" is planned', planned)
      Then('planning succeeds', () => expect(errors()).toEqual([]))
      // The rendered argv, not the phase file: what a step actually runs is
      // the only thing that can disagree with what it was supposed to.
      And("phase \"project-check\" step 0 runs the project's check command", () =>
        expect(phase('project-check')?.steps[0]?.planned.args).toEqual(['-c', 'pnpm test']),
      )
    })

    RuleScenario('A project with no check command cannot plan the gate', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('the project has no check command', setCheck(''))
      And(
        'the project scope defines a workflow "validate" with the phase "project-check"',
        () => workflow('validate', 'project-check'),
      )
      When('the workflow "validate" is planned', planned)
      Then('planning fails', () => expect(result.plan).toBeUndefined())
      And('a problem says the step has no command to run', noCommand)
    })

    RuleScenario('A run with no project at all cannot plan the gate either', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given(
        'the project scope defines a workflow "validate" with the phase "project-check"',
        () => workflow('validate', 'project-check'),
      )
      When('the workflow "validate" is planned with no project at all', () => {
        const chain = resolveScopes({
          cwd: box.dir('work', 'src'),
          env: { FACTORY_HOME: box.scope('home', 'user') },
        })
        result = planWorkflow({ chain, host, workflow: 'validate', workspace: box.dir('work') })
      })
      Then('planning fails', () => expect(result.plan).toBeUndefined())
      And('a problem says the step has no command to run', noCommand)
    })

    RuleScenario('Any step whose command resolves to nothing is refused', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('the project scope defines a phase "empty" running "{{ project.check }}"', () => {
        box.phase(project, 'empty', "name: empty\nsteps: [{run: '{{ project.check }}'}]\n")
      })
      And('the project has no check command', setCheck(''))
      And('the project scope defines a workflow "validate" with the phase "empty"', () =>
        workflow('validate', 'empty'),
      )
      When('the workflow "validate" is planned', planned)
      Then('planning fails', () => expect(result.plan).toBeUndefined())
      And('a problem says the step has no command to run', noCommand)
    })
  })
})

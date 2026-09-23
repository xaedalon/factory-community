import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EventBus, type FactoryEvent } from '@factory/events'
import { runPlan, type RunResult } from '../src/run/runner.js'
import type { ResolvedPhase, ResolvedPlan } from '../src/plan/resolve.js'
import type { Approval } from '../src/schema/phase.js'
import type { ExecutionProfile } from '../src/security/profile.js'

const feature = await loadFeature(fileURLToPath(new URL('./run.feature', import.meta.url)))

/** A phase whose steps are real bash commands — the runner spawns them. */
const phase = (
  name: string,
  commands: string[],
  options: { cwd?: string; approval?: Approval; retries?: number } = {},
): ResolvedPhase => ({
  name,
  approval: options.approval ?? 'none',
  cwd: options.cwd ?? process.cwd(),
  steps: commands.map((command, index) => ({
    index,
    uses: 'shell',
    planned: { describe: command, command: 'bash', args: ['-c', command] },
    // The step as written: what the runner reads `retries` from.
    raw: { uses: 'shell', run: command, ...(options.retries === undefined ? {} : { retries: options.retries }) },
  })),
})

describeFeature(feature, ({ Scenario, Rule, BeforeEachScenario, AfterEachScenario }) => {
  let phases: ResolvedPhase[] = []
  let mode: 'once' | 'loop' = 'once'
  let requires: string[] = []
  let timeoutSeconds: number | undefined
  let approvalAnswer = true
  let approvalsAsked: string[] = []
  /** Set when the scenario is picking up from an approval already given. */
  let resuming = false
  let output = ''
  let events: FactoryEvent[] = []
  let result: RunResult
  let sandbox: string | undefined
  /** Seconds the runner asked to wait, rather than seconds actually spent. */
  let waited: number[] = []
  let profile: ExecutionProfile
  let env: Readonly<Record<string, string | undefined>>

  BeforeEachScenario(() => {
    phases = []
    mode = 'once'
    requires = []
    timeoutSeconds = undefined
    approvalAnswer = true
    approvalsAsked = []
    resuming = false
    output = ''
    events = []
    sandbox = undefined
    waited = []
    profile = 'default'
    // Curated rather than `process.env`, so a machine that happens to export a
    // token does not change what these scenarios observe. The three the shell
    // commands here actually need, and nothing that looks like a credential.
    env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG }
  })
  AfterEachScenario(() => {
    if (sandbox !== undefined) rmSync(sandbox, { recursive: true, force: true })
  })

  const plan = (): ResolvedPlan => ({
    workflow: 'test',
    profile,
    mode,
    scheduling: 'parallel',
    requires,
    provides: [],
    clears: [],
    phases,
  })

  const execute = async (dryRun = false) => {
    const bus = new EventBus({ onSubscriberError: () => {} })
    bus.onAny((event) => events.push(event))
    result = await runPlan({
      plan: plan(),
      env,
      dryRun,
      events: bus,
      wait: async (seconds) => {
        waited.push(seconds)
      },
      ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
      ...(resuming ? { startPhase: 0, approved: true } : {}),
      onOutput: (chunk) => {
        output += chunk
      },
      onApproval: async (target) => {
        approvalsAsked.push(target.name)
        return approvalAnswer
      },
    })
  }

  const names = () => events.map((event) => event.name)
  const reached = (name: string) => !result.skipped.includes(name)
  const problemSays = (needle: string) =>
    result.problems.some((problem) => problem.message.toLowerCase().includes(needle.toLowerCase()))

  Scenario('A plan runs its steps in order', ({ Given, When, Then, And }) => {
    Given('a phase "build" running "echo one" then "echo two"', () => {
      phases = [phase('build', ['echo one', 'echo two'])]
    })
    When('the plan is run', () => execute())
    Then('the run completed', () => expect(result.status).toBe('completed'))
    And('the output was "one" then "two"', () =>
      expect(output.indexOf('one')).toBeLessThan(output.indexOf('two')),
    )
  })

  Scenario('Phases run in the order the workflow lists them', ({ Given, And, When, Then }) => {
    Given('a phase "first" running "echo alpha"', () => {
      phases.push(phase('first', ['echo alpha']))
    })
    And('a phase "second" running "echo beta"', () => {
      phases.push(phase('second', ['echo beta']))
    })
    When('the plan is run', () => execute())
    Then('the run completed', () => expect(result.status).toBe('completed'))
    And('the output was "alpha" then "beta"', () =>
      expect(output.indexOf('alpha')).toBeLessThan(output.indexOf('beta')),
    )
  })

  Scenario('A failing step stops the run', ({ Given, When, Then, And }) => {
    Given('a phase "build" running "exit 3" then "echo unreachable"', () => {
      phases = [phase('build', ['exit 3', 'echo unreachable'])]
    })
    When('the plan is run', () => execute())
    Then('the run failed', () => expect(result.status).toBe('failed'))
    And('the output does not contain "unreachable"', () =>
      expect(output).not.toContain('unreachable'),
    )
    And('a problem says the step exited 3', () => expect(problemSays('exited 3')).toBe(true))
  })

  Scenario('Phases after a failure are not reached', ({ Given, And, When, Then }) => {
    Given('a phase "build" running "exit 1"', () => {
      phases.push(phase('build', ['exit 1']))
    })
    And('a phase "later" running "echo later"', () => {
      phases.push(phase('later', ['echo later']))
    })
    When('the plan is run', () => execute())
    Then('the run failed', () => expect(result.status).toBe('failed'))
    And('"later" was not reached', () => expect(reached('later')).toBe(false))
  })

  Scenario('A step that hangs is killed', ({ Given, And, When, Then }) => {
    Given('a phase "build" running "sleep 30"', () => {
      phases = [phase('build', ['sleep 30'])]
    })
    And('a step deadline of 1 second', () => {
      timeoutSeconds = 1
    })
    When('the plan is run', () => execute())
    Then('the run timed out', () => expect(result.status).toBe('timed-out'))
    And('a problem says the step was killed', () => expect(problemSays('killed after')).toBe(true))
  })

  Scenario('A step that cannot start is reported', ({ Given, When, Then }) => {
    Given('a phase "build" whose step runs a command that does not exist', () => {
      phases = [
        {
          name: 'build',
          approval: 'none',
          cwd: process.cwd(),
          steps: [
            {
              index: 0,
              uses: 'shell',
              planned: { describe: 'missing', command: 'definitely-not-a-real-binary', args: [] },
              raw: { uses: 'shell', run: 'definitely-not-a-real-binary' },
            },
          ],
        },
      ]
    })
    When('the plan is run', () => execute())
    Then('the run failed', () => expect(result.status).toBe('failed'))
  })

  Scenario("Steps run in the phase's working directory", ({ Given, When, Then, And }) => {
    Given('a phase "build" running "pwd" in a subdirectory', () => {
      sandbox = mkdtempSync(join(tmpdir(), 'factory-run-'))
      const inner = join(sandbox, 'inner')
      mkdirSync(inner)
      phases = [phase('build', ['pwd'], { cwd: inner })]
    })
    When('the plan is run', () => execute())
    Then('the run completed', () => expect(result.status).toBe('completed'))
    And('the output names the subdirectory', () => expect(output).toContain('inner'))
  })

  Scenario('A phase requiring approval pauses until it is given', ({ Given, And, When, Then }) => {
    Given('a phase "check" running "echo checked" that requires approval', () => {
      phases = [phase('check', ['echo checked'], { approval: 'after' })]
    })
    And('approval will be given', () => {
      approvalAnswer = true
    })
    When('the plan is run', () => execute())
    Then('the run completed', () => expect(result.status).toBe('completed'))
    And('approval was requested for "check"', () => expect(approvalsAsked).toContain('check'))
  })

  Scenario('Withholding approval stops the run', ({ Given, And, When, Then }) => {
    Given('a phase "check" running "echo checked" that requires approval', () => {
      phases.push(phase('check', ['echo checked'], { approval: 'after' }))
    })
    And('a phase "after" running "echo after"', () => {
      phases.push(phase('after', ['echo after']))
    })
    And('approval will be withheld', () => {
      approvalAnswer = false
    })
    When('the plan is run', () => execute())
    Then('the run was declined', () => expect(result.status).toBe('declined'))
    And('"after" was not reached', () => expect(reached('after')).toBe(false))
    And('the output does not contain "after"', () => expect(output).not.toContain('after'))
  })

  Scenario('Approval is asked for after the phase has run', ({ Given, And, When, Then }) => {
    Given('a phase "check" running "echo checked" that requires approval', () => {
      phases = [phase('check', ['echo checked'], { approval: 'after' })]
    })
    And('approval will be given', () => {
      approvalAnswer = true
    })
    When('the plan is run', () => execute())
    // The point of a gate is to look at what the phase produced, so it cannot
    // come before the phase has produced it.
    Then('the output contains "checked"', () => expect(output).toContain('checked'))
  })

  Scenario('A dry run executes nothing', ({ Given, When, Then, And }) => {
    Given('a phase "build" running "echo should-not-run"', () => {
      phases = [phase('build', ['echo should-not-run'])]
    })
    When('the plan is run as a dry run', () => execute(true))
    Then('the run completed', () => expect(result.status).toBe('completed'))
    And('there was no output', () => expect(output).toBe(''))
  })

  Scenario('A dry run does not stop at an approval gate', ({ Given, And, When, Then }) => {
    Given('a phase "check" running "echo checked" that requires approval', () => {
      phases.push(phase('check', ['echo checked'], { approval: 'after' }))
    })
    And('a phase "after" running "echo after"', () => {
      phases.push(phase('after', ['echo after']))
    })
    When('the plan is run as a dry run', () => execute(true))
    Then('the run completed', () => expect(result.status).toBe('completed'))
    And('a problem says it would pause for approval', () =>
      expect(problemSays('would pause')).toBe(true),
    )
    And('"after" was reached', () => expect(reached('after')).toBe(true))
  })

  Scenario('A loop workflow runs one pass, and says who repeats it', ({
    Given,
    And,
    When,
    Then,
  }) => {
    Given('a phase "build" running "echo once"', () => {
      phases = [phase('build', ['echo once'])]
    })
    And('the workflow loops', () => {
      mode = 'loop'
    })
    When('the plan is run', () => execute())
    Then('the run completed', () => expect(result.status).toBe('completed'))
    And('a problem explains that the scheduler is what repeats it', () =>
      expect(problemSays('scheduler')).toBe(true),
    )
    // A loop is a scheduling property; the pass itself is an ordinary run.
    And('"build" ran', () => expect(output).toContain('once'))
  })

  Scenario('Conditions are reported as unchecked', ({ Given, And, When, Then }) => {
    Given('a phase "build" running "echo one"', () => {
      phases = [phase('build', ['echo one'])]
    })
    And('the workflow requires "hasWorktree"', () => {
      requires = ['hasWorktree']
    })
    When('the plan is run', () => execute())
    Then('the run completed', () => expect(result.status).toBe('completed'))
    And('a problem says the requirement is not being checked', () =>
      expect(problemSays('not being checked')).toBe(true),
    )
  })

  Scenario('Events are emitted for observers', ({ Given, When, Then, And }) => {
    Given('a phase "build" running "echo one"', () => {
      phases = [phase('build', ['echo one'])]
    })
    When('the plan is run', () => execute())
    Then('the events include "run.started" and "run.completed"', () => {
      expect(names()).toContain('run.started')
      expect(names()).toContain('run.completed')
    })
    And('the events include "step.started" and "step.completed"', () => {
      expect(names()).toContain('step.started')
      expect(names()).toContain('step.completed')
    })
  })

  /**
   * A step that fails the first time and succeeds the second, without a clock:
   * a marker file it creates on the first attempt decides the exit code of the
   * next one. Nothing here depends on timing.
   */
  const flakyPhase = (retries: number): ResolvedPhase => {
    const marker = join(mkdtempSync(join(tmpdir(), 'factory-retry-')), 'tried')
    return phase('flaky', [`if [ -f ${marker} ]; then exit 0; else touch ${marker}; exit 7; fi`], {
      retries,
    })
  }

  Scenario('A step that says so is retried', ({ Given, When, Then, And }) => {
    Given('a phase "flaky" whose step fails once then succeeds, with 2 retries', () => {
      phases = [flakyPhase(2)]
    })
    When('the plan is run', () => execute())
    Then('the run completed', () => expect(result.status).toBe('completed'))
    And('the step took 2 attempts', () => expect(result.steps[0]?.attempts).toBe(2))
  })

  Scenario('Retries run out', ({ Given, When, Then, And }) => {
    Given('a phase "broken" whose step always fails, with 1 retry', () => {
      phases = [phase('broken', ['exit 3'], { retries: 1 })]
    })
    When('the plan is run', () => execute())
    Then('the run failed', () => expect(result.status).toBe('failed'))
    And('the step took 2 attempts', () => expect(result.steps[0]?.attempts).toBe(2))
  })

  Scenario('A step with no retries runs once', ({ Given, When, Then, And }) => {
    Given('a phase "build" running "exit 1"', () => {
      phases = [phase('build', ['exit 1'])]
    })
    When('the plan is run', () => execute())
    Then('the run failed', () => expect(result.status).toBe('failed'))
    And('the step took 1 attempt', () => expect(result.steps[0]?.attempts).toBe(1))
  })

  Scenario('The delay between attempts is the one the step asked for', ({ Given, When, Then }) => {
    Given('a phase "slow" whose step always fails, with 1 retry after 5 seconds', () => {
      phases = [phase('slow', ['exit 1'], { retries: 1 })]
      const step = phases[0]?.steps[0]
      if (step !== undefined) (step.raw as Record<string, unknown>).retry_delay = 5
    })
    // Injected rather than waited for: a test that actually slept five seconds
    // would be a test nobody runs.
    When('the plan is run', () => execute())
    Then('it waited 5 seconds between attempts', () => expect(waited).toEqual([5]))
  })

  Rule('an authorisation gate asks before anything of its phase has run', ({ RuleScenario }) => {
    const givenGated = (): void => {
      phases = [phase('deploy', ['echo deployed'], { approval: 'before' })]
    }

    RuleScenario('Nothing runs until approval is given', ({ Given, And, When, Then }) => {
      Given('a phase "deploy" running "echo deployed" that asks before running', givenGated)
      And('approval will be withheld', () => {
        approvalAnswer = false
      })
      When('the plan is run', () => execute())
      Then('the run was declined', () => expect(result.status).toBe('declined'))
      // The whole point: the command never ran.
      And('the output does not contain "deployed"', () => expect(output).not.toContain('deployed'))
    })

    RuleScenario('Approving runs the phase that was being asked about', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('a phase "deploy" running "echo deployed" that asks before running', givenGated)
      And('approval will be given', () => {
        approvalAnswer = true
      })
      When('the plan is run', () => execute())
      Then('the run completed', () => expect(result.status).toBe('completed'))
      And('the output contains "deployed"', () => expect(output).toContain('deployed'))
    })

    RuleScenario('The gate names the phase before it runs', ({ Given, And, When, Then }) => {
      Given('a phase "deploy" running "echo deployed" that asks before running', givenGated)
      And('approval will be withheld', () => {
        approvalAnswer = false
      })
      When('the plan is run', () => execute())
      Then('approval was requested for "deploy"', () => expect(approvalsAsked).toContain('deploy'))
    })

    RuleScenario('A declined authorisation comes back to the same phase', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('a phase "deploy" running "echo deployed" that asks before running', givenGated)
      And('approval will be withheld', () => {
        approvalAnswer = false
      })
      When('the plan is run', () => execute())
      // Counted as not reached, which is what tells the engine to resume *into*
      // this phase rather than past it. Resuming past would approve a phase and
      // then skip it — the one outcome nobody could mean.
      Then('"deploy" was not reached', () => expect(result.skipped).toContain('deploy'))
    })

    RuleScenario('Resuming into an approved phase does not ask twice', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('a phase "deploy" running "echo deployed" that asks before running', givenGated)
      // A `before` gate sits at the top of the phase the run comes back to, so
      // without this it would ask again the instant it was let through.
      And('the run is resuming into it, already approved', () => {
        resuming = true
      })
      And('approval will be withheld', () => {
        approvalAnswer = false
      })
      When('the plan is run', () => execute())
      Then('the run completed', () => expect(result.status).toBe('completed'))
      And('nothing was asked', () => expect(approvalsAsked).toEqual([]))
      And('the output contains "deployed"', () => expect(output).toContain('deployed'))
    })

    RuleScenario('A dry run says which side of the phase it would stop on', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given('a phase "deploy" running "echo deployed" that asks before running', givenGated)
      When('the plan is run as a dry run', () => execute(true))
      Then('the run completed', () => expect(result.status).toBe('completed'))
      And('a problem says it would pause before its steps', () =>
        expect(
          result.problems.some(
            (problem) =>
              problem.rule === 'run.wouldPause' && problem.message.includes('before its steps'),
          ),
        ).toBe(true),
      )
    })
  })

  Rule('a retry can need a different command than the first attempt', ({ RuleScenario }) => {
    let log = ''

    /** Two commands, distinguishable in a file, so the order is observable. */
    const twoCommands = (options: { separateRetry: boolean }) => (): void => {
      sandbox = mkdtempSync(join(tmpdir(), 'factory-retry-args-'))
      log = join(sandbox, 'log')
      // With a separate retry command the first attempt always fails and the
      // second always succeeds, so the two are told apart by what they wrote.
      // Without one, the same command runs again, so it has to stop failing by
      // itself — it succeeds once the log has two lines in it.
      const command = options.separateRetry
        ? `echo first >> ${log}; exit 1`
        : `echo again >> ${log}; test "$(grep -c . ${log})" -ge 2`
      phases = [
        {
          name: 'work',
          approval: 'none',
          cwd: sandbox,
          steps: [
            {
              index: 0,
              uses: 'agent',
              planned: {
                describe: 'first attempt',
                command: 'bash',
                args: ['-c', command],
                ...(options.separateRetry
                  ? { retryArgs: ['-c', `echo second >> ${log}; exit 0`] }
                  : {}),
              },
              raw: { uses: 'agent', retries: 2 },
            },
          ],
        },
      ]
    }
    const lines = () => readFileSync(log, 'utf8').trim().split('\n')

    RuleScenario('The second attempt runs the command the plan gave it for retries', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given(
        'a step that fails once, with a different command for the retry',
        twoCommands({ separateRetry: true }),
      )
      When('the plan is run', () => execute())
      Then('the run completed', () => expect(result.status).toBe('completed'))
      // Order matters as much as presence: the *first* attempt must be the
      // starting command, or nothing would ever create the session.
      And('both commands ran, in that order', () => expect(lines()).toEqual(['first', 'second']))
    })

    RuleScenario('A step with no retry command simply runs the same one again', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given(
        'a step that fails once and has no separate retry command',
        twoCommands({ separateRetry: false }),
      )
      When('the plan is run', () => execute())
      Then('the run completed', () => expect(result.status).toBe('completed'))
      And('the same command ran twice', () => expect(lines()).toEqual(['again', 'again']))
    })
  })

  Rule("the profile decides what a step's process can see", ({ RuleScenario }) => {
    /**
     * A step that reports one variable rather than dumping the environment:
     * the assertion is then about the one name the scenario is written about,
     * and no value can reach the log.
     */
    const reporting = (name: string, needs?: string) => (): void => {
      const command = `if [ -n "$${name}" ]; then echo "${name} present"; else echo "${name} absent"; fi`
      phases = [
        {
          name: 'build',
          approval: 'none',
          cwd: process.cwd(),
          steps: [
            {
              index: 0,
              uses: 'shell',
              planned: {
                describe: command,
                command: 'bash',
                args: ['-c', command],
                ...(needs === undefined ? {} : { passEnv: [needs] }),
              },
              raw: { uses: 'shell', run: command },
            },
          ],
        },
      ]
    }
    const alsoHolding = (name: string) => (): void => {
      env = { ...env, [name]: 'sensitive-value' }
    }

    RuleScenario('A confined step cannot see a credential', ({ Given, And, When, Then }) => {
      Given('the environment also holds "GITHUB_TOKEN"', alsoHolding('GITHUB_TOKEN'))
      And(
        'a phase "build" that prints whether "GITHUB_TOKEN" is set',
        reporting('GITHUB_TOKEN'),
      )
      When('the plan is run', () => execute())
      Then('the run completed', () => expect(result.status).toBe('completed'))
      And('the output says "GITHUB_TOKEN" was absent', () =>
        expect(output).toContain('GITHUB_TOKEN absent'),
      )
    })

    RuleScenario('A confined step can still see its PATH', ({ Given, And, When, Then }) => {
      Given('the environment also holds "GITHUB_TOKEN"', alsoHolding('GITHUB_TOKEN'))
      And('a phase "build" that prints whether "PATH" is set', reporting('PATH'))
      When('the plan is run', () => execute())
      Then('the run completed', () => expect(result.status).toBe('completed'))
      And('the output says "PATH" was present', () => expect(output).toContain('PATH present'))
    })

    RuleScenario("The step's own output says what was withheld", ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('the environment also holds "GITHUB_TOKEN"', alsoHolding('GITHUB_TOKEN'))
      And(
        'a phase "build" that prints whether "GITHUB_TOKEN" is set',
        reporting('GITHUB_TOKEN'),
      )
      When('the plan is run', () => execute())
      Then('the output names the withheld "GITHUB_TOKEN"', () => {
        expect(output).toContain('Factory withheld')
        expect(output).toContain('GITHUB_TOKEN')
        expect(output).not.toContain('sensitive-value')
      })
    })

    RuleScenario('An unconfined step can see everything', ({ Given, And, When, Then }) => {
      Given('the plan runs under Full Access', () => {
        profile = 'full-access'
      })
      And('the environment also holds "GITHUB_TOKEN"', alsoHolding('GITHUB_TOKEN'))
      And(
        'a phase "build" that prints whether "GITHUB_TOKEN" is set',
        reporting('GITHUB_TOKEN'),
      )
      When('the plan is run', () => execute())
      Then('the run completed', () => expect(result.status).toBe('completed'))
      And('the output says "GITHUB_TOKEN" was present', () =>
        expect(output).toContain('GITHUB_TOKEN present'),
      )
      And('the output names nothing withheld', () =>
        expect(output).not.toContain('Factory withheld'),
      )
    })

    RuleScenario('What the provider declared survives', ({ Given, And, When, Then }) => {
      Given('the environment also holds "ANTHROPIC_API_KEY"', alsoHolding('ANTHROPIC_API_KEY'))
      And(
        'a phase "build" that prints whether "ANTHROPIC_API_KEY" is set, needing it',
        reporting('ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY'),
      )
      When('the plan is run', () => execute())
      Then('the run completed', () => expect(result.status).toBe('completed'))
      And('the output says "ANTHROPIC_API_KEY" was present', () =>
        expect(output).toContain('ANTHROPIC_API_KEY present'),
      )
    })
  })
  Rule('a step that asks for stdin gets it', ({ RuleScenario }) => {
    let promptPath = ''
    /** A step that copies whatever it is given on stdin to its output. */
    const reading = (stdin?: string): ResolvedPhase => ({
      name: 'ask',
      approval: 'none',
      cwd: process.cwd(),
      steps: [
        {
          index: 0,
          uses: 'shell',
          planned: {
            describe: 'read stdin',
            command: 'bash',
            args: ['-c', 'cat'],
            ...(stdin === undefined ? {} : { stdin }),
          },
          raw: { uses: 'shell', run: 'cat' },
        },
      ],
    })

    RuleScenario('The file a step asks for arrives on its stdin', ({ Given, And, When, Then }) => {
      Given('a file "prompt.txt" holding "hello from the file"', () => {
        sandbox = mkdtempSync(join(tmpdir(), 'factory-stdin-'))
        promptPath = join(sandbox, 'prompt.txt')
        writeFileSync(promptPath, 'hello from the file\n')
      })
      And('a phase "ask" whose step reads stdin and takes "prompt.txt" as input', () => {
        phases = [reading(promptPath)]
      })
      When('the plan is run', () => execute())
      Then('the run completed', () => expect(result.status).toBe('completed'))
      And('the output says "hello from the file"', () =>
        expect(output).toContain('hello from the file'),
      )
    })

    RuleScenario('A step that asks for nothing still gets a closed stdin', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given('a phase "ask" whose step reads stdin', () => {
        phases = [reading()]
      })
      When('the plan is run', () => execute())
      Then('the run completed', () => expect(result.status).toBe('completed'))
      And('the output is empty', () => expect(output.trim()).toBe(''))
    })

    RuleScenario('A file that is not there is the step\'s failure, not the runner\'s', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given('a phase "ask" whose step takes a missing file as input', () => {
        sandbox = mkdtempSync(join(tmpdir(), 'factory-stdin-'))
        phases = [reading(join(sandbox, 'nowhere.txt'))]
      })
      When('the plan is run', () => execute())
      Then('the run failed', () => expect(result.status).toBe('failed'))
      And('the step says it could not open its input', () =>
        expect(output).toContain('nowhere.txt'),
      )
    })
  })
})

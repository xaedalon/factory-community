import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventBus } from '@factory/events'
import {
  CapabilityHost,
  PROVIDER_KIND,
  checkAgentStep,
  checkPluginConformance,
  permissionArgsFor,
  type AgentStep,
  type ExecutionProfile,
  type ProviderCapability,
  type RenderedCommand,
} from '@factory/core'
import type { Problem } from '@factory/core'
import claudePlugin from '../src/index.js'
import codexPlugin from '@factory/provider-codex'
import copilotPlugin from '@factory/provider-copilot'

const feature = await loadFeature(fileURLToPath(new URL('./providers.feature', import.meta.url)))

const PLUGINS = { claude: claudePlugin, codex: codexPlugin, copilot: copilotPlugin }

describeFeature(feature, ({ Background, Rule, Scenario, ScenarioOutline, BeforeEachScenario }) => {
  let host: CapabilityHost
  let step: Partial<AgentStep> & { uses: 'agent'; prompt: string }
  let rendered: RenderedCommand
  let problems: Problem[] = []
  let conformed = false
  let allowed: string[] = []

  const provider = (id: string): ProviderCapability =>
    host.get<ProviderCapability>(PROVIDER_KIND, id) as ProviderCapability

  /** Flatten argv so a scenario can assert on a flag and its value together. */
  const argv = () => rendered.args.join(' ')

  BeforeEachScenario(() => {
    step = { uses: 'agent', prompt: '' }
    allowed = []
    problems = []
    conformed = false
  })

  Background(({ Given }) => {
    Given('the claude, codex and copilot providers are registered', async () => {
      host = new CapabilityHost({ events: new EventBus({ onSubscriberError: () => {} }) })
      await host.loadAll([claudePlugin, codexPlugin, copilotPlugin])
    })
  })

  Scenario('The registered providers are discoverable', ({ Then, And }) => {
    Then('the host has a "provider" capability "claude"', () =>
      expect(host.has(PROVIDER_KIND, 'claude')).toBe(true),
    )
    And('the host has a "provider" capability "codex"', () =>
      expect(host.has(PROVIDER_KIND, 'codex')).toBe(true),
    )
    And('the host has a "provider" capability "copilot"', () =>
      expect(host.has(PROVIDER_KIND, 'copilot')).toBe(true),
    )
  })

  Scenario("A model role resolves to the provider's own identifier", ({ Then, And }) => {
    Then('"strong" resolves to "opus" for "claude"', () =>
      expect(provider('claude').resolveModel('strong')).toBe('opus'),
    )
    And('"strong" resolves to "claude-opus-5.5" for "copilot"', () =>
      expect(provider('copilot').resolveModel('strong')).toBe('claude-opus-5.5'),
    )
  })

  Scenario('A literal model identifier passes through untouched', ({ Then }) => {
    Then('"claude-fable-5" resolves to "claude-fable-5" for "claude"', () =>
      expect(provider('claude').resolveModel('claude-fable-5')).toBe('claude-fable-5'),
    )
  })

  Scenario('Rendering a step produces the command claude actually takes', ({ Given, And, When, Then }) => {
    Given('an agent step with the prompt "Analyse WW2-1234"', () => {
      step.prompt = 'Analyse WW2-1234'
    })
    And('the step asks for model "strong" and effort "max"', () => {
      step = { ...step, model: 'strong', effort: 'max' }
    })
    When('it is rendered for "claude"', () => {
      rendered = provider('claude').render(step)
    })
    Then('the command is "claude"', () => expect(rendered.command).toBe('claude'))
    And('the arguments include "--restricted"', () => expect(argv()).toContain('--restricted'),
    )
    And('the arguments include "--model opus"', () => expect(argv()).toContain('--model opus'))
    And('the arguments include "--effort max"', () => expect(argv()).toContain('--effort max'))
    And('the prompt is the last argument', () =>
      expect(rendered.args.at(-1)).toBe('Analyse WW2-1234'),
    )
    And('stdin is redirected from "/dev/null"', () => expect(rendered.stdin).toBe('/dev/null'))
  })

  Scenario('A sub-agent is passed as a flag', ({ Given, And, When, Then }) => {
    Given('an agent step with the prompt "Analyse WW2-1234"', () => {
      step.prompt = 'Analyse WW2-1234'
    })
    And('the step asks for the sub-agent "deep-researcher"', () => {
      step = { ...step, subagent: 'deep-researcher' }
    })
    When('it is rendered for "claude"', () => {
      rendered = provider('claude').render(step)
    })
    Then('the arguments include "--agent deep-researcher"', () =>
      expect(argv()).toContain('--agent deep-researcher'),
    )
  })

  Scenario('A step with no session gets no session arguments', ({ Given, When, Then, And }) => {
    Given('an agent step with the prompt "One shot"', () => {
      step.prompt = 'One shot'
    })
    When('it is rendered for "claude"', () => {
      rendered = provider('claude').render(step)
    })
    Then('the arguments do not include "--session-id"', () =>
      expect(rendered.args).not.toContain('--session-id'),
    )
    And('it reports no session', () => expect(rendered.session).toBeUndefined())
  })

  Scenario('A prompt containing quotes needs no escaping', ({ Given, When, Then }) => {
    const tricky = 'Fix the "broken" test; don\'t guess'
    Given('an agent step with the prompt "Fix the \\"broken\\" test; don\'t guess"', () => {
      step.prompt = tricky
    })
    When('it is rendered for "claude"', () => {
      rendered = provider('claude').render(step)
    })
    // argv, not a shell string: the prompt is one element and nothing has to be
    // escaped. The prototype concatenated a command line and handed it to bash.
    Then('the prompt is passed as a single argument', () => {
      expect(rendered.args.filter((a) => a === tricky)).toHaveLength(1)
    })
  })

  Scenario('A setting the provider does not have is a warning, not silence', ({ Given, And, When, Then }) => {
    Given('an agent step with the prompt "Analyse"', () => {
      step.prompt = 'Analyse'
    })
    And('the step asks for effort "max"', () => {
      step = { ...step, effort: 'max' }
    })
    When('the step is checked against "copilot"', () => {
      problems = checkAgentStep(provider('copilot'), step as AgentStep)
    })
    Then('there is a warning about effort', () =>
      expect(problems.some((p) => p.rule === 'provider.effortUnsupported')).toBe(true),
    )
  })

  Scenario('Asking to carry a session on a provider that cannot is a warning', ({ Given, And, When, Then }) => {
    Given('an agent step with the prompt "Analyse"', () => {
      step.prompt = 'Analyse'
    })
    And('the step carries a session with the identity "run-42"', () => {
      step = { ...step, session: 'workflow' }
    })
    When('the step is checked against "codex"', () => {
      problems = checkAgentStep(provider('codex'), step as AgentStep)
    })
    Then('there is a warning about sessions', () =>
      expect(problems.some((p) => p.rule === 'provider.sessionUnsupported')).toBe(true),
    )
  })

  Scenario('An unverified descriptor says so', ({ Given, When, Then }) => {
    Given('an agent step with the prompt "Analyse"', () => {
      step.prompt = 'Analyse'
    })
    When('the step is checked against "codex"', () => {
      problems = checkAgentStep(provider('codex'), step as AgentStep)
    })
    Then('there is a warning that the descriptor is unverified', () =>
      expect(problems.some((p) => p.rule === 'provider.provisional')).toBe(true),
    )
  })

  Scenario('A verified descriptor does not claim to be unverified', ({ Given, When, Then }) => {
    Given('an agent step with the prompt "Analyse"', () => {
      step.prompt = 'Analyse'
    })
    When('the step is checked against "claude"', () => {
      problems = checkAgentStep(provider('claude'), step as AgentStep)
    })
    Then('there is no warning that the descriptor is unverified', () =>
      expect(problems.some((p) => p.rule === 'provider.provisional')).toBe(false),
    )
  })

  Scenario('Availability reports whether the executable is really there', ({ Then, And }) => {
    // A stand-in executable rather than the real CLI: whether Claude Code
    // happens to be installed on the machine running the suite is not part of
    // this contract, and a test that depends on it only runs in one place.
    Then('"claude" is available when its directory is on PATH', () => {
      const bin = mkdtempSync(join(tmpdir(), 'factory-bin-'))
      try {
        const fake = join(bin, 'claude')
        writeFileSync(fake, '#!/bin/sh\nexit 0\n')
        chmodSync(fake, 0o755)
        expect(provider('claude').availability({ PATH: bin }).available).toBe(true)
      } finally {
        rmSync(bin, { recursive: true, force: true })
      }
    })
    And('"claude" is unavailable when PATH is empty', () =>
      expect(provider('claude').availability({ PATH: '' }).available).toBe(false),
    )
    And('the unavailable reason names the command', () =>
      expect(provider('claude').availability({ PATH: '' }).reason).toContain('claude'),
    )
  })

  ScenarioOutline('Every provider plugin passes the conformance suite', ({ When, Then }, vars) => {
    When('the "<provider>" plugin is checked for conformance', async () => {
      const report = await checkPluginConformance(PLUGINS[String(vars.provider) as keyof typeof PLUGINS])
      conformed = report.passed
      if (!report.passed) {
        throw new Error(
          report.checks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.detail}`).join('; '),
        )
      }
    })
    Then('the plugin conforms', () => expect(conformed).toBe(true))
  })
  Rule('starting a session and continuing one are different commands', ({ RuleScenario }) => {
    /** The scope, the id, and whether the session is already there. */
    let identity: { sessionId?: string; resumeSession?: boolean } = {}

    const carries = (id: string) => () => {
      step = { ...step, session: 'task' }
      identity = { sessionId: id }
    }
    const renderFor = (id: string) => () => {
      rendered = provider(id).render({ ...step, ...identity })
    }
    const excludes = (needle: string) => () => expect(argv()).not.toContain(needle)

    RuleScenario('Starting a session names it', ({ Given, And, When, Then }) => {
      Given('an agent step with the prompt "Analyse"', () => {
        step.prompt = 'Analyse'
      })
      And('the step carries a session with the identity "run-42"', carries('run-42'))
      When('it is rendered for "claude"', renderFor('claude'))
      Then('the arguments include "--session-id run-42"', () =>
        expect(argv()).toContain('--session-id run-42'),
      )
      // Reported rather than left for a caller to infer: whether a flag went in
      // depends on the scope, the id and this descriptor, and only the code
      // that just decided knows all three.
      And('it reports starting the session "run-42"', () =>
        expect(rendered.session).toEqual({ id: 'run-42', resumed: false }),
      )
    })

    RuleScenario('Continuing one resumes it by that id', ({ Given, And, When, Then }) => {
      Given('an agent step with the prompt "Continue"', () => {
        step.prompt = 'Continue'
      })
      And('the step carries a session with the identity "run-42"', carries('run-42'))
      And('the session already exists', () => {
        identity = { ...identity, resumeSession: true }
      })
      When('it is rendered for "claude"', renderFor('claude'))
      Then('the arguments include "--resume run-42"', () =>
        expect(argv()).toContain('--resume run-42'),
      )
      // Both flags would be a contradiction, and Claude refuses the pair.
      And('the arguments do not include "--session-id"', excludes('--session-id'))
      And('it reports continuing the session "run-42"', () =>
        expect(rendered.session).toEqual({ id: 'run-42', resumed: true }),
      )
    })

    RuleScenario('One flag that does both is used for both', ({ Given, And, When, Then }) => {
      Given('an agent step with the prompt "Continue"', () => {
        step.prompt = 'Continue'
      })
      And('the step carries a session with the identity "run-42"', carries('run-42'))
      And('the session already exists', () => {
        identity = { ...identity, resumeSession: true }
      })
      When('it is rendered for "copilot"', renderFor('copilot'))
      Then('the arguments include "--session-id run-42"', () =>
        expect(argv()).toContain('--session-id run-42'),
      )
    })

    RuleScenario('A provider that cannot carry a session gets no id', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('an agent step with the prompt "Continue"', () => {
        step.prompt = 'Continue'
      })
      And('the step carries a session with the identity "run-42"', carries('run-42'))
      When('it is rendered for "codex"', renderFor('codex'))
      Then('the arguments do not include "run-42"', excludes('run-42'))
      And('it reports no session', () => expect(rendered.session).toBeUndefined())
    })

    RuleScenario('A session scope of none carries no id either', ({ Given, And, When, Then }) => {
      Given('an agent step with the prompt "One shot"', () => {
        step.prompt = 'One shot'
      })
      And('the step is given the identity "run-42" but no session scope', () => {
        identity = { sessionId: 'run-42' }
      })
      When('it is rendered for "claude"', renderFor('claude'))
      Then('the arguments do not include "run-42"', excludes('run-42'))
      And('it reports no session', () => expect(rendered.session).toBeUndefined())
    })

    RuleScenario('An id nobody supplied renders no flag at all', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('an agent step with the prompt "Continue"', () => {
        step.prompt = 'Continue'
      })
      And('the step carries a session with no identity', () => {
        step = { ...step, session: 'task' }
        identity = {}
      })
      When('it is rendered for "claude"', renderFor('claude'))
      Then('the arguments do not include "--session-id"', excludes('--session-id'))
      And('it reports no session', () => expect(rendered.session).toBeUndefined())
    })
  })

  Rule('the profile decides what the CLI is allowed to do', ({ RuleScenario }) => {
    const withPrompt = (prompt: string) => (): void => {
      step = { uses: 'agent', prompt }
    }
    const allowing = (directory: string) => (): void => {
      allowed = [directory]
    }
    const renderAs = (id: string, profile: ExecutionProfile) => (): void => {
      rendered = provider(id).render({
        prompt: step.prompt,
        profile,
        ...(allowed.length === 0 ? {} : { allowedDirectories: allowed }),
      })
    }
    const includes = (fragment: string) => (): void => {
      expect(argv()).toContain(fragment)
    }
    const excludes = (fragment: string) => (): void => {
      expect(argv()).not.toContain(fragment)
    }

    RuleScenario('The Default profile confines the agent and never waits', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given('an agent step with the prompt "Analyse WW2-1234"', withPrompt('Analyse WW2-1234'))
      When('it is rendered for "claude" under "default"', renderAs('claude', 'default'))
      Then('the arguments include "--restricted"', includes('--restricted'))
      And('the arguments name the tools the agent needs', () => {
        // Named because `--restricted` removes the code-running tools unless
        // `--tools` does — measured, after `--tools default` did not.
        expect(argv()).toContain('--tools')
        for (const tool of ['Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep']) {
          expect(argv()).toContain(tool)
        }
      })
      And('the arguments include "--permission-prompts none"', includes('--permission-prompts none'))
      And('the arguments do not include "bypassPermissions"', excludes('bypassPermissions'))
    })

    /** The value of `--allowedTools`, which is one comma-separated argument. */
    const allowList = (): string[] => {
      const at = rendered.args.indexOf('--allowedTools')
      return at === -1 ? [] : (rendered.args[at + 1] ?? '').split(',')
    }
    const allows = (command: string) => (): void => {
      expect(allowList()).toContain(`Bash(${command} *)`)
    }
    const doesNotAllow = (command: string) => (): void => {
      expect(allowList().some((rule) => rule.startsWith(`Bash(${command}`))).toBe(false)
    }

    RuleScenario("The Default profile lets the agent run the project's package manager", ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given('an agent step with the prompt "Analyse WW2-1234"', withPrompt('Analyse WW2-1234'))
      When('it is rendered for "claude" under "default"', renderAs('claude', 'default'))
      Then('the arguments allow "pnpm"', allows('pnpm'))
      And('the arguments allow "npm"', allows('npm'))
    })

    RuleScenario('No interpreter is on the allow-list', ({ Given, When, Then, And }) => {
      Given('an agent step with the prompt "Analyse WW2-1234"', withPrompt('Analyse WW2-1234'))
      When('it is rendered for "claude" under "default"', renderAs('claude', 'default'))
      Then('the arguments do not allow "node"', doesNotAllow('node'))
      And('the arguments do not allow "python"', doesNotAllow('python'))
      // The one that undoes the whole profile: `Bash` on its own allows every
      // command, including a redirect out of the workspace. Measured.
      And('the arguments do not allow a bare tool name', () => {
        expect(allowList()).not.toContain('Bash')
        for (const rule of allowList()) expect(rule).toMatch(/^Bash\(.+ \*\)$/)
      })
    })

    RuleScenario('Full Access needs no allow-list', ({ Given, When, Then }) => {
      Given('an agent step with the prompt "Analyse WW2-1234"', withPrompt('Analyse WW2-1234'))
      When('it is rendered for "claude" under "full-access"', renderAs('claude', 'full-access'))
      Then('the arguments do not include "--allowedTools"', excludes('--allowedTools'))
    })

    RuleScenario('The Full Access profile removes the restriction', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given('an agent step with the prompt "Analyse WW2-1234"', withPrompt('Analyse WW2-1234'))
      When('it is rendered for "claude" under "full-access"', renderAs('claude', 'full-access'))
      Then(
        'the arguments include "--permission-mode bypassPermissions"',
        includes('--permission-mode bypassPermissions'),
      )
      And('the arguments do not include "--restricted"', excludes('--restricted'))
    })

    RuleScenario('A confined agent is given the directories it legitimately needs', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('an agent step with the prompt "Analyse WW2-1234"', withPrompt('Analyse WW2-1234'))
      And(
        'the artifacts directory "/repos/todolist/.xaedalon/.factory/tasks/t/artifacts" is allowed',
        allowing('/repos/todolist/.xaedalon/.factory/tasks/t/artifacts'),
      )
      When('it is rendered for "claude" under "default"', renderAs('claude', 'default'))
      Then(
        'the arguments include "--add-dir /repos/todolist/.xaedalon/.factory/tasks/t/artifacts"',
        includes('--add-dir /repos/todolist/.xaedalon/.factory/tasks/t/artifacts'),
      )
    })

    RuleScenario('An unconfined agent is given no directory grants', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('an agent step with the prompt "Analyse WW2-1234"', withPrompt('Analyse WW2-1234'))
      And(
        'the artifacts directory "/repos/todolist/.xaedalon/.factory/tasks/t/artifacts" is allowed',
        allowing('/repos/todolist/.xaedalon/.factory/tasks/t/artifacts'),
      )
      When('it is rendered for "claude" under "full-access"', renderAs('claude', 'full-access'))
      Then('the arguments do not include "--add-dir"', excludes('--add-dir'))
    })

    RuleScenario('Copilot keeps its own path and network checking under Default', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given('an agent step with the prompt "Analyse WW2-1234"', withPrompt('Analyse WW2-1234'))
      When('it is rendered for "copilot" under "default"', renderAs('copilot', 'default'))
      Then('the arguments include "--allow-all-tools"', includes('--allow-all-tools'))
      And('the arguments do not include "--allow-all-paths"', excludes('--allow-all-paths'))
      And('the arguments do not include "--allow-all-urls"', excludes('--allow-all-urls'))
    })

    RuleScenario('Copilot under Full Access allows everything', ({ Given, When, Then }) => {
      Given('an agent step with the prompt "Analyse WW2-1234"', withPrompt('Analyse WW2-1234'))
      When('it is rendered for "copilot" under "full-access"', renderAs('copilot', 'full-access'))
      Then('the arguments include "--allow-all"', includes('--allow-all'))
    })

    RuleScenario('Codex claims nothing under either profile', ({ Given, When, Then }) => {
      Given('an agent step with the prompt "Analyse WW2-1234"', withPrompt('Analyse WW2-1234'))
      When('it is rendered for "codex" under "default"', renderAs('codex', 'default'))
      Then('no permission arguments are rendered', () => {
        expect(permissionArgsFor(provider('codex').descriptor, 'default')).toEqual([])
      })
    })
  })
})

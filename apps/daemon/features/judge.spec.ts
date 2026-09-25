import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { EventBus } from '@factory/events'
import {
  CapabilityHost,
  PROVIDER_KIND,
  providerFromDescriptor,
  type ProviderDescriptor,
} from '@factory/core'
import type { Project } from '@factory/core'
import type { Runtime } from '@factory/runtime'
import { agentFor, type JudgeFor } from '../src/reliability-agent.js'

const feature = await loadFeature(fileURLToPath(new URL('./judge.feature', import.meta.url)))

describeFeature(feature, ({ Rule }) => {
  Rule('a judge that cannot be asked says so, and is not replaced', ({ RuleScenario }) => {
    let host: CapabilityHost
    let binDir: string
    let env: Record<string, string | undefined>
    let project: Project
    let judge: JudgeFor

    /**
     * A descriptor with only what `agentFor` and `render` read.
     *
     * `effortFlag` on claude and not on codex, so "an effort this CLI ignores"
     * is a property of the fixture rather than of a mock.
     */
    const descriptor = (id: string, effort: boolean): ProviderDescriptor =>
      ({
        kind: 'factory.provider/v1',
        id,
        displayName: id,
        command: id,
        supports: [],
        models: { strong: 'a-strong-model', balanced: 'b', fast: 'c' },
        modelFlag: '--model',
        ...(effort ? { effortFlag: '--effort' } : {}),
        promptFlag: '-p',
        permissionArgs: [],
        extraArgs: [],
        effortValues: [],
        provisional: false,
        forbiddenArgs: [],
        denialPatterns: [],
        passEnv: [],
        env: {},
      }) as unknown as ProviderDescriptor

    /** On PATH means installed: `availability` asks the filesystem, not a flag. */
    const install = (id: string): void => {
      const file = join(binDir, id)
      writeFileSync(file, '#!/bin/sh\necho ok\n')
      chmodSync(file, 0o755)
    }

    const startWith = async (installed: readonly string[]): Promise<void> => {
      binDir = join(tmpdir(), `judge-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`)
      mkdirSync(binDir, { recursive: true })
      env = { PATH: [binDir].join(delimiter) }
      host = new CapabilityHost({ events: new EventBus({ onSubscriberError: () => {} }), env })
      await host.load({
        name: 'providers',
        version: '1.0.0',
        register: (context) => {
          context.provide(PROVIDER_KIND, providerFromDescriptor(descriptor('claude', true)))
          context.provide(PROVIDER_KIND, providerFromDescriptor(descriptor('codex', false)))
        },
      })
      for (const id of installed) install(id)
    }

    const runtime = (): Runtime =>
      ({
        host,
        env,
        settings: { current: () => ({ reliability: {} }) },
      }) as unknown as Runtime

    const ask = (over: Partial<Project>): void => {
      project = {
        id: 'p1',
        name: 'probe',
        path: binDir,
        reliabilityEnabled: true,
        ...over,
      } as unknown as Project
      judge = agentFor({ runtime: runtime(), project, profile: 'default', cwd: binDir })
    }

    const both = async (): Promise<void> => startWith(['claude', 'codex'])
    const onlyClaude = async (): Promise<void> => startWith(['claude'])

    RuleScenario("A project's own provider is the one asked", ({ Given, And, Then }) => {
      Given('"claude" and "codex" are both installed', both)
      And('the project judges with "codex" using "strong"', () =>
        ask({ reliabilityProvider: 'codex', reliabilityModel: 'strong' }),
      )
      Then('the judge is "codex"', () => expect(judge.agent).toBeDefined())
    })

    RuleScenario('A named provider whose command is missing yields no judge', ({
      Given,
      And,
      Then,
    }) => {
      Given('"claude" is installed and "codex" is not', onlyClaude)
      And('the project judges with "codex" using "strong"', () =>
        ask({ reliabilityProvider: 'codex', reliabilityModel: 'strong' }),
      )
      Then('there is no judge', () => expect(judge.agent).toBeUndefined())
    })

    RuleScenario('And it says which provider, and why', ({ Given, And, Then }) => {
      Given('"claude" is installed and "codex" is not', onlyClaude)
      And('the project judges with "codex" using "strong"', () =>
        ask({ reliabilityProvider: 'codex', reliabilityModel: 'strong' }),
      )
      Then('it warns that "codex" could not be found', () => {
        expect(judge.problems).toHaveLength(1)
        expect(judge.problems[0]?.message).toContain('codex')
        expect(judge.problems[0]?.message).toContain('not found')
      })
      And('the warning is a "reliability.judgeUnavailable"', () =>
        expect(judge.problems[0]?.rule).toBe('reliability.judgeUnavailable'),
      )
    })

    RuleScenario('The installed one is not quietly used instead', ({ Given, And, Then }) => {
      Given('"claude" is installed and "codex" is not', onlyClaude)
      And('the project judges with "codex" using "strong"', () =>
        ask({ reliabilityProvider: 'codex', reliabilityModel: 'strong' }),
      )
      Then('the judge is not "claude"', () => expect(judge.agent).toBeUndefined())
    })

    RuleScenario('A provider nobody registered reads differently', ({ Given, And, Then }) => {
      Given('"claude" is installed and "codex" is not', onlyClaude)
      And('the project judges with "nonesuch" using "strong"', () =>
        ask({ reliabilityProvider: 'nonesuch', reliabilityModel: 'strong' }),
      )
      Then('it warns that no such provider is registered', () =>
        expect(judge.problems[0]?.message).toContain('no such provider is registered'),
      )
    })

    RuleScenario('Naming nothing at all is silent', ({ Given, And, Then }) => {
      Given('"claude" and "codex" are both installed', both)
      And('the project names no provider but judges using "strong"', () =>
        ask({ reliabilityModel: 'strong' }),
      )
      Then('the judge is "claude"', () => expect(judge.agent).toBeDefined())
      And('nothing is warned about', () => expect(judge.problems).toEqual([]))
    })

    RuleScenario('Judging switched off asks nothing and says nothing', ({ Given, And, Then }) => {
      Given('"claude" and "codex" are both installed', both)
      And('the project has judging switched off', () =>
        ask({ reliabilityEnabled: false, reliabilityProvider: 'codex', reliabilityModel: 'strong' }),
      )
      Then('there is no judge', () => expect(judge.agent).toBeUndefined())
      And('nothing is warned about', () => expect(judge.problems).toEqual([]))
    })

    RuleScenario('An effort the provider ignores still asks, and says it was ignored', ({
      Given,
      And,
      Then,
    }) => {
      Given('"claude" and "codex" are both installed', both)
      // codex is the fixture without an effort flag, which is why it is the one
      // asked here: the mismatch is a property of the descriptor, not a mock.
      And('the project judges with "codex" using "strong" at "high"', () =>
        ask({
          reliabilityProvider: 'codex',
          reliabilityModel: 'strong',
          reliabilityEffort: 'high',
        }),
      )
      Then('there is a judge', () => expect(judge.agent).toBeDefined())
      And('it warns that the effort is ignored', () =>
        expect(judge.problems.map((problem) => problem.rule)).toContain(
          'provider.effortUnsupported',
        ),
      )
    })
  })
})

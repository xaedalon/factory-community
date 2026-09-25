import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CapabilityHost,
  PROVIDER_KIND,
  providerFromDescriptor,
  parseProviderDescriptor,
  type Problem,
} from '@factory/core'
import { Sandbox } from './support.js'
import { resolveScopes, type ScopeChain } from '../src/scopes.js'
import { builtinDoctorPlugin, doctorContext, runDoctor } from '../src/doctor.js'
import { writeSettings } from '../src/settings.js'

const feature = await loadFeature(
  fileURLToPath(new URL('./installation-doctor.feature', import.meta.url)),
)

describeFeature(feature, ({ Background, Rule }) => {
  let box: Sandbox
  let host: CapabilityHost
  let userRoot = ''
  let problems: readonly Problem[] = []

  Background(({ Given }) => {
    Given('the built-in doctor rules are registered', async () => {
      box = new Sandbox()
      host = new CapabilityHost()
      await host.load(builtinDoctorPlugin)
      userRoot = box.scope('home', 'user')
      problems = []
    })
  })

  const chainNow = (): ScopeChain =>
    resolveScopes({ cwd: box.dir('work'), env: { FACTORY_HOME: userRoot } })

  const run = async (): Promise<void> => {
    const chain = chainNow()
    const report = await runDoctor(doctorContext({ chain, host, env: {} }))
    problems = report.problems
  }

  const config = (contents: string) => () => {
    writeFileSync(join(userRoot, 'config.yaml'), contents)
  }
  const about = (rule: string) => problems.filter((problem) => problem.rule === rule)
  const anySays = (needle: string) =>
    problems.some((problem) => problem.message.toLowerCase().includes(needle.toLowerCase()))
  const switchOff = (id: string) => () => {
    writeSettings(chainNow(), { plugins: { disabled: [id] } })
  }

  Rule('a scope config that does not parse said nothing at all', ({ RuleScenario }) => {
    RuleScenario('A config that is not valid YAML is an error naming the file', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given("the user scope's config is not valid YAML", config('scope: user\n  plugins: ][\n'))
      When('doctor runs', run)
      Then('it reports that the config could not be read', () =>
        expect(about('doctor.scopeConfigUnreadable')).toHaveLength(1),
      )
      And('the problem names the config file', () =>
        expect(about('doctor.scopeConfigUnreadable')[0]?.file?.endsWith('config.yaml')).toBe(true),
      )
      // The consequence, not just the syntax error: this is what makes the
      // diagnostic worth printing.
      And("it says the scope's plugins are being ignored", () =>
        expect(anySays('plugins')).toBe(true),
      )
    })

    RuleScenario('A config that is a list rather than a mapping is reported too', ({
      Given,
      When,
      Then,
    }) => {
      Given("the user scope's config is a list", config('- one\n- two\n'))
      When('doctor runs', run)
      Then('it reports that nothing in the config is read', () =>
        expect(about('doctor.scopeConfigShape')).toHaveLength(1),
      )
    })

    RuleScenario('A config of comments only is fine', ({ Given, When, Then }) => {
      Given("the user scope's config is comments only", config('# nothing but a comment\n'))
      When('doctor runs', run)
      Then('it reports nothing about the config', () => {
        expect(about('doctor.scopeConfigUnreadable')).toEqual([])
        expect(about('doctor.scopeConfigShape')).toEqual([])
      })
    })

    RuleScenario('A config that parses is fine', ({ Given, When, Then }) => {
      Given('the user scope declares a plugin', () => {
        box.file(join('home', '.xaedalon', '.factory', 'plugins', 'x.mjs'), 'export default {}\n')
        writeFileSync(
          join(userRoot, 'config.yaml'),
          'kind: factory.scope/v1\nscope: user\nplugins:\n  - ./plugins/x.mjs\n',
        )
      })
      When('doctor runs', run)
      Then('it reports nothing about the config', () => {
        expect(about('doctor.scopeConfigUnreadable')).toEqual([])
        expect(about('doctor.scopeConfigShape')).toEqual([])
      })
    })
  })

  Rule('what is switched off is said out loud', ({ RuleScenario }) => {
    RuleScenario('A plugin switched off is reported as a warning', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given('the plugin "@acme/thing" is switched off', switchOff('@acme/thing'))
      When('doctor runs', run)
      Then('it warns that "@acme/thing" is switched off', () =>
        expect(about('doctor.pluginSwitchedOff')[0]?.message).toContain('@acme/thing'),
      )
      // Switching one off is a choice, not a fault.
      And('it is a warning, not an error', () =>
        expect(about('doctor.pluginSwitchedOff')[0]?.severity).toBe('warning'),
      )
    })

    RuleScenario('One still loaded says a restart will unload it', ({ Given, When, Then }) => {
      Given(
        'the plugin "@factory/config/builtin-doctor" is switched off',
        switchOff('@factory/config/builtin-doctor'),
      )
      When('doctor runs', run)
      Then('the warning says restarting will unload it', () =>
        expect(about('doctor.pluginSwitchedOff')[0]?.message).toContain('restarting'),
      )
    })

    RuleScenario('With nothing switched off it says nothing', ({ When, Then }) => {
      When('doctor runs', run)
      Then('it warns about nothing being switched off', () =>
        expect(about('doctor.pluginSwitchedOff')).toEqual([]),
      )
    })

    RuleScenario('An id nothing declares any more is reported separately', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given('the plugin "@acme/long-gone" is switched off', switchOff('@acme/long-gone'))
      When('doctor runs', run)
      Then('it warns that "@acme/long-gone" is no longer declared', () =>
        expect(about('doctor.unknownDisabledPlugin')).toHaveLength(1),
      )
      And('it says switching it on will forget it', () =>
        expect(about('doctor.unknownDisabledPlugin')[0]?.message).toContain('switch it on'),
      )
    })

    RuleScenario('A declared plugin that is switched off is not called unknown', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('the user scope declares a plugin', () => {
        box.file(join('home', '.xaedalon', '.factory', 'plugins', 'x.mjs'), 'export default {}\n')
        writeFileSync(
          join(userRoot, 'config.yaml'),
          'kind: factory.scope/v1\nscope: user\nplugins:\n  - ./plugins/x.mjs\n',
        )
      })
      And('that declared plugin is switched off', switchOff('./plugins/x.mjs'))
      When('doctor runs', run)
      Then('it warns that it is switched off', () =>
        expect(about('doctor.pluginSwitchedOff')).toHaveLength(1),
      )
      And('nothing calls it unknown', () =>
        expect(about('doctor.unknownDisabledPlugin')).toEqual([]),
      )
    })
  })

  Rule("doctor says how much a provider's own CLI is confining it", ({ RuleScenario }) => {
    /** A provider registered from a descriptor the scenario describes. */
    const providing = (permissionArgs: unknown) => async (): Promise<void> => {
      const parsed = parseProviderDescriptor({
        kind: 'factory.provider/v1',
        id: 'probe',
        displayName: 'Probe',
        command: 'probe',
        models: { strong: 'big', balanced: 'mid', fast: 'small' },
        permissionArgs,
      })
      expect(parsed.error, JSON.stringify(parsed.error?.issues)).toBeUndefined()
      const descriptor = parsed.descriptor as NonNullable<typeof parsed.descriptor>
      await host.load({
        name: '@probe/provider',
        version: '0.0.0',
        register: (context) => {
          context.provide(PROVIDER_KIND, providerFromDescriptor(descriptor))
        },
      })
    }
    const warnsOnly = (rule: string) => (): void => {
      const found = about(rule)
      expect(found).toHaveLength(1)
      expect(found[0]?.severity).toBe('warning')
    }

    RuleScenario('A provider using one list for both profiles is reported', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given('a provider whose permission arguments are one list', providing(['--yolo']))
      When('doctor runs', run)
      Then('it warns that the provider cannot tell the profiles apart', () =>
        expect(anySays('same permission arguments for every execution profile')).toBe(true),
      )
      And('it says how to give it a per-profile list', () =>
        expect(anySays('"default" and a "full-access"')).toBe(true),
      )
      And('it is a warning, not an error', warnsOnly('doctor.providerProfileUnaware'))
    })

    RuleScenario('A provider that passes nothing under Default is reported', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given(
        'a provider that passes no arguments under Default',
        providing({ default: [], 'full-access': ['--yolo'] }),
      )
      When('doctor runs', run)
      Then('it warns that the CLI adds no confinement of its own', () =>
        expect(anySays('adds no confinement of its own')).toBe(true),
      )
      And("it says Factory's own boundary still applies", () =>
        expect(anySays('workspace boundary and environment filtering still apply')).toBe(true),
      )
      And('it is a warning, not an error', warnsOnly('doctor.providerUnconfined'))
    })

    RuleScenario('A provider that distinguishes the profiles is not reported', ({
      Given,
      When,
      Then,
    }) => {
      Given(
        'a provider with different arguments per profile',
        providing({ default: ['--safe'], 'full-access': ['--yolo'] }),
      )
      When('doctor runs', run)
      Then('nothing is said about profiles', () => {
        expect(about('doctor.providerProfileUnaware')).toEqual([])
        expect(about('doctor.providerUnconfined')).toEqual([])
      })
    })
  })
  Rule('a workflow that lists no phases is reported', ({ RuleScenario }) => {
    const emptyWorkflow = () => {
      box.workflow(userRoot, 'design', 'name: design\nphases: []\n')
    }

    RuleScenario('A workflow with no phases is a warning naming it', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given('the user scope has a workflow "design" with no phases', emptyWorkflow)
      When('doctor runs', run)
      Then('a warning says "design" will do nothing', () => {
        const found = about('doctor.emptyWorkflow')
        expect(found).toHaveLength(1)
        expect(found[0]?.severity).toBe('warning')
        expect(found[0]?.message).toContain('"design"')
      })
      And('it says a task that runs it is refused', () => expect(anySays('refused')).toBe(true))
    })

    RuleScenario('A workflow with a phase is not reported', ({ Given, When, Then }) => {
      Given('the user scope has a workflow "design" with a phase', () => {
        box.phase(userRoot, 'design', 'name: design\nsteps: [{run: echo hello}]\n')
        box.workflow(userRoot, 'design', 'name: design\nphases: [design]\n')
      })
      When('doctor runs', run)
      Then('nothing is reported about empty workflows', () =>
        expect(about('doctor.emptyWorkflow')).toEqual([]),
      )
    })
  })
})

import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Problem } from '@factory/core'
import { Sandbox } from './support.js'
import {
  SETTINGS_FILE,
  SETTINGS_KIND,
  readSettings,
  settingsPath,
  writeSettings,
  type FactorySettings,
  type UiTheme,
} from '../src/settings.js'
import type { Scope, ScopeChain } from '../src/scopes.js'

const feature = await loadFeature(fileURLToPath(new URL('./settings.feature', import.meta.url)))

describeFeature(feature, ({ Scenario, Rule, BeforeEachScenario, AfterEachScenario }) => {
  let box: Sandbox
  let chain: ScopeChain
  let userRoot = ''
  let settings: FactorySettings
  let problems: readonly Problem[]

  BeforeEachScenario(() => {
    box = new Sandbox()
    problems = []
  })
  AfterEachScenario(() => box.cleanup())

  /** A chain with one writable user scope, which is all these need. */
  const chainWith = (root: string): ScopeChain => {
    const user: Scope = { kind: 'user', root, writable: true, exists: true, legacy: false }
    return { scopes: [user], defaultWriteScope: 'user' }
  }

  const givenUserScope = (relative = 'home') => () => {
    userRoot = box.scope(relative, 'user')
    chain = chainWith(userRoot)
  }
  const read = () => {
    const result = readSettings(chain)
    settings = result.settings
    problems = result.problems
  }
  const save = (patch: Parameters<typeof writeSettings>[1]) => () => {
    problems = writeSettings(chain, patch).problems
  }
  const scaleIs = (n: number) => () => expect(settings.ui.scale).toBe(n)
  const themeIs = (value: UiTheme) => () => expect(settings.ui.theme).toBe(value)
  const says = (needle: string) =>
    problems.some((problem) => problem.message.toLowerCase().includes(needle.toLowerCase()))
  const file = () => join(userRoot, SETTINGS_FILE)

  Scenario('An installation with no settings file has defaults', ({ Given, When, Then, And }) => {
    Given('a user scope with no settings file', givenUserScope())
    When('the settings are read', read)
    Then('the interface scale is 1', scaleIs(1))
    And('the theme is "system"', themeIs('system'))
    And('no plugins are switched off', () => expect(settings.plugins.disabled).toEqual([]))
    And('nothing is reported', () => expect(problems).toEqual([]))
    // Reading must not create. A file that appears because something looked at
    // it is worse than one that is missing.
    And('no file was created', () => expect(existsSync(file())).toBe(false))
  })

  Scenario('What was saved is what is read back', ({ Given, When, And, Then }) => {
    Given('a user scope with no settings file', givenUserScope())
    When('the interface scale is set to 2', save({ ui: { scale: 2 } }))
    And('the settings are read', read)
    Then('the interface scale is 2', scaleIs(2))
  })

  Scenario('Saving one half does not drop the other', ({ Given, And, When, Then }) => {
    Given('a user scope with no settings file', givenUserScope())
    And('the plugin "@factory/diffity" is switched off', () => {
      writeSettings(chain, { plugins: { disabled: ['@factory/diffity'] } })
    })
    When('the interface scale is set to 2', save({ ui: { scale: 2 } }))
    And('the settings are read', read)
    Then('the interface scale is 2', scaleIs(2))
    And('"@factory/diffity" is still switched off', () =>
      expect(settings.plugins.disabled).toEqual(['@factory/diffity']),
    )
  })

  Scenario('The file says which kind it is', ({ Given, When, Then }) => {
    Given('a user scope with no settings file', givenUserScope())
    When('the interface scale is set to 2', save({ ui: { scale: 2 } }))
    Then('the file on disk names the settings kind', () =>
      expect(readFileSync(file(), 'utf8')).toContain(SETTINGS_KIND),
    )
  })

  Scenario('A theme is saved and read back', ({ Given, When, And, Then }) => {
    Given('a user scope with no settings file', givenUserScope())
    When('the theme is set to "light"', save({ ui: { theme: 'light' } }))
    And('the settings are read', read)
    Then('the theme is "light"', themeIs('light'))
  })

  Scenario('Saving the theme does not drop the scale', ({ Given, When, And, Then }) => {
    Given('a user scope with no settings file', givenUserScope())
    When('the interface scale is set to 2', save({ ui: { scale: 2 } }))
    And('the theme is set to "light"', save({ ui: { theme: 'light' } }))
    And('the settings are read', read)
    Then('the interface scale is 2', scaleIs(2))
    And('the theme is "light"', themeIs('light'))
  })

  Rule('a file that will not load leaves the tool working', ({ RuleScenario }) => {
    const givenFile = (contents: string) => () => {
      userRoot = box.scope('home', 'user')
      chain = chainWith(userRoot)
      writeFileSync(join(userRoot, SETTINGS_FILE), contents)
    }

    RuleScenario('Unparseable JSON is reported, and the defaults apply', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given('a settings file that is not JSON', givenFile('{ not json'))
      When('the settings are read', read)
      Then('the interface scale is 1', scaleIs(1))
      And('a problem says the file is not valid JSON', () =>
        expect(says('not valid json')).toBe(true),
      )
    })

    RuleScenario('A key nobody recognises is reported with a suggestion', ({
      Given,
      When,
      Then,
    }) => {
      Given('a settings file with "scaal" instead of "scale"', givenFile('{"ui":{"scaal":2}}'))
      When('the settings are read', read)
      Then('a problem suggests "scale"', () => expect(says('scale')).toBe(true))
    })

    RuleScenario('A scale beyond what the board supports is refused', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given('a settings file asking for a scale of 40', givenFile('{"ui":{"scale":40}}'))
      When('the settings are read', read)
      Then('a problem names the field "ui.scale"', () =>
        expect(problems.some((problem) => problem.field === 'ui.scale')).toBe(true),
      )
      And('the interface scale is 1', scaleIs(1))
    })

    RuleScenario('A theme nobody recognises is refused', ({ Given, When, Then, And }) => {
      Given('a settings file asking for the theme "sepia"', givenFile('{"ui":{"theme":"sepia"}}'))
      When('the settings are read', read)
      Then('a problem names the field "ui.theme"', () =>
        expect(problems.some((problem) => problem.field === 'ui.theme')).toBe(true),
      )
      And('the theme is "system"', themeIs('system'))
    })

    RuleScenario('A write that would not load back is refused before it lands', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given('a user scope with no settings file', givenUserScope())
      When('a scale of 40 is saved', save({ ui: { scale: 40 } }))
      Then('it is refused', () => expect(problems.length).toBeGreaterThan(0))
      // Read back through the schema *before* the rename, so a refusal leaves
      // no file at all rather than one Factory cannot load.
      And('no file was created', () => expect(existsSync(file())).toBe(false))
    })

    RuleScenario('A write with an unrecognised theme is refused before it lands', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given('a user scope with no settings file', givenUserScope())
      // Off the wire this would just be a string; the cast stands in for that —
      // `writeSettings` itself doesn't trust the type, only the schema does.
      When('the theme is set to "sepia"', save({ ui: { theme: 'sepia' as UiTheme } }))
      Then('it is refused', () => expect(problems.length).toBeGreaterThan(0))
      And('no file was created', () => expect(existsSync(file())).toBe(false))
    })
  })

  Rule('the path comes off the resolved chain', ({ RuleScenario }) => {
    RuleScenario('The settings sit beside config.yaml in the user scope', ({ Given, Then }) => {
      Given('a user scope with no settings file', givenUserScope())
      Then('the settings path is "settings.json" in the user scope', () =>
        expect(settingsPath(chain)).toBe(join(userRoot, 'settings.json')),
      )
    })

    RuleScenario('A user scope at the old path is still the user scope', ({ Given, Then }) => {
      Given('a user scope at the legacy ".factory" path', () => {
        userRoot = box.legacyScope('home', 'user')
        chain = chainWith(userRoot)
      })
      Then('the settings path is inside that directory', () =>
        expect(settingsPath(chain)?.startsWith(userRoot)).toBe(true),
      )
    })

    RuleScenario('With no user scope there is nowhere to save', ({ Given, When, Then, And }) => {
      Given('a chain with no user scope', () => {
        chain = { scopes: [], defaultWriteScope: 'user' }
      })
      When('the interface scale is set to 2', save({ ui: { scale: 2 } }))
      Then('it is refused', () => expect(problems.length).toBeGreaterThan(0))
      And('a problem says there is no user scope', () =>
        expect(says('no user scope')).toBe(true),
      )
    })
  })
})

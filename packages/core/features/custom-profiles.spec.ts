import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { parseProviderDescriptor, permissionArgsFor } from '../src/providers/descriptor.js'
import type { ProviderDescriptor } from '../src/providers/descriptor.js'
import {
  isBuiltInProfile,
  isConfined,
  isKnownProfile,
  profileLabel,
  type ProfileNames,
} from '../src/security/profile.js'

const feature = await loadFeature(fileURLToPath(new URL('./custom-profiles.feature', import.meta.url)))

describeFeature(feature, ({ Rule, BeforeEachScenario }) => {
  /** What this installation defines, as the guards are given it. */
  let defined: ProfileNames

  BeforeEachScenario(() => {
    defined = { names: [], describe: () => undefined }
  })

  const define = (name: string, description?: string): void => {
    const names = [...defined.names, name]
    defined = {
      names,
      describe: (asked) =>
        asked === name && description !== undefined ? description : undefined,
    }
  }

  Rule('a name Factory does not ship is still a profile, and still confined', ({ RuleScenario }) => {
    RuleScenario('The two Factory ships are the built-in ones', ({ Then, And }) => {
      Then('"default" is a built-in profile', () => expect(isBuiltInProfile('default')).toBe(true))
      And('"full-access" is a built-in profile', () =>
        expect(isBuiltInProfile('full-access')).toBe(true),
      )
      And('"development" is not a built-in profile', () =>
        expect(isBuiltInProfile('development')).toBe(false),
      )
    })

    RuleScenario('A profile nobody shipped is confined', ({ Then, And }) => {
      Then('the profile "development" is confined', () => expect(isConfined('development')).toBe(true))
      And('the profile "anything-at-all" is confined', () =>
        expect(isConfined('anything-at-all')).toBe(true),
      )
      And('the profile "full-access" is not confined', () =>
        expect(isConfined('full-access')).toBe(false),
      )
    })

    RuleScenario('A custom profile cannot be spelled to escape confinement', ({ Then, And }) => {
      Then('the profile "Full-Access" is confined', () => expect(isConfined('Full-Access')).toBe(true))
      And('the profile "full access" is confined', () =>
        expect(isConfined('full access')).toBe(true),
      )
      And('the profile "full_access" is confined', () =>
        expect(isConfined('full_access')).toBe(true),
      )
    })
  })

  Rule('what may be stored is what is known, not what is shipped', ({ RuleScenario }) => {
    RuleScenario('A built-in is known without anything being defined', ({ Given, Then, And }) => {
      Given('no profiles are defined', () => {})
      Then('"default" is a known profile', () =>
        expect(isKnownProfile('default', defined)).toBe(true),
      )
      And('"full-access" is a known profile', () =>
        expect(isKnownProfile('full-access', defined)).toBe(true),
      )
    })

    RuleScenario('A name nobody defined is not known', ({ Given, Then }) => {
      Given('no profiles are defined', () => {})
      Then('"development" is not a known profile', () =>
        expect(isKnownProfile('development', defined)).toBe(false),
      )
    })

    RuleScenario('A defined name is known', ({ Given, Then }) => {
      Given('the profile "development" is defined', () => define('development'))
      Then('"development" is a known profile', () =>
        expect(isKnownProfile('development', defined)).toBe(true),
      )
    })

    RuleScenario('Defining one does not make every name known', ({ Given, Then }) => {
      Given('the profile "development" is defined', () => define('development'))
      Then('"something-else" is not a known profile', () =>
        expect(isKnownProfile('something-else', defined)).toBe(false),
      )
    })
  })

  Rule('a custom profile starts from the confined list, never from nothing', ({ RuleScenario }) => {
    let descriptor: ProviderDescriptor

    const describe = (permissionArgs: unknown): void => {
      const parsed = parseProviderDescriptor({
        id: 'probe',
        displayName: 'Probe',
        command: 'probe',
        promptFlag: '-p',
        models: { strong: 'a', balanced: 'b', fast: 'c' },
        permissionArgs,
      })
      expect(parsed.error, JSON.stringify(parsed.error?.issues)).toBeUndefined()
      descriptor = parsed.descriptor as ProviderDescriptor
    }
    const twoProfiles = (): void =>
      describe({ default: ['--restricted'], 'full-access': ['--yolo'] })
    const given = (profile: string): readonly string[] => permissionArgsFor(descriptor, profile)

    RuleScenario('A custom profile gets the confined arguments', ({ Given, Then, And }) => {
      Given(
        'a provider whose Default passes "--restricted" and whose Full Access passes "--yolo"',
        twoProfiles,
      )
      Then('the profile "development" is given "--restricted"', () =>
        expect(given('development')).toContain('--restricted'),
      )
      And('the profile "development" is not given "--yolo"', () =>
        expect(given('development')).not.toContain('--yolo'),
      )
    })

    RuleScenario('The built-ins are unchanged', ({ Given, Then, And }) => {
      Given(
        'a provider whose Default passes "--restricted" and whose Full Access passes "--yolo"',
        twoProfiles,
      )
      Then('the profile "default" is given "--restricted"', () =>
        expect(given('default')).toContain('--restricted'),
      )
      And('the profile "full-access" is given "--yolo"', () =>
        expect(given('full-access')).toContain('--yolo'),
      )
    })

    RuleScenario('A descriptor that predates profiles answers the same for a custom one', ({
      Given,
      Then,
    }) => {
      Given('a provider that passes "--same" whatever the profile', () => describe(['--same']))
      Then('the profile "development" is given "--same"', () =>
        expect(given('development')).toContain('--same'),
      )
    })
  })

  Rule('each profile has one name for a person', ({ RuleScenario }) => {
    RuleScenario('The built-ins keep the names they already had', ({ Then, And }) => {
      Then('"default" reads as "Default"', () => expect(profileLabel('default')).toBe('Default'))
      And('"full-access" reads as "Full Access"', () =>
        expect(profileLabel('full-access')).toBe('Full Access'),
      )
    })

    RuleScenario('A custom profile reads as what it called itself', ({ Given, Then }) => {
      Given('the profile "development" is defined, described as "Build tools"', () =>
        define('development', 'Build tools'),
      )
      Then('"development" reads as "Build tools"', () =>
        expect(profileLabel('development', defined)).toBe('Build tools'),
      )
    })

    RuleScenario('A custom profile that described nothing reads as its own name', ({
      Given,
      Then,
    }) => {
      Given('the profile "development" is defined', () => define('development'))
      Then('"development" reads as "development"', () =>
        expect(profileLabel('development', defined)).toBe('development'),
      )
    })
  })
})

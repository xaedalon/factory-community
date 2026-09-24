import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { parseProfile, type Profile } from '../src/schema/profile.js'
import type { Problem } from '../src/problems.js'
import {
  NO_GRANTS,
  parseProviderDescriptor,
  permissionArgsFor,
  unsupportedBy,
  type ProfileGrants,
} from '../src/providers/descriptor.js'
import { render } from '../src/providers/capability.js'
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

  Rule('a profile is a definition, and says what it is', ({ RuleScenario }) => {
    let profile: Profile | undefined
    let problems: readonly Problem[] = []

    const given = (_ctx: unknown, text: string): void => {
      const result = parseProfile(parseYaml(text))
      profile = result.profile
      problems = result.problems
    }
    const errors = (): readonly Problem[] => problems.filter((p) => p.severity === 'error')

    RuleScenario('A profile carries what it widens', ({ Given, Then, And }) => {
      Given('the profile file:', given)
      Then('it parses', () => {
        expect(errors(), JSON.stringify(problems)).toEqual([])
        expect(profile).toBeDefined()
      })
      And('it allows "cargo"', () => expect(profile?.commands).toContain('cargo'))
      And('it extends "default"', () => expect(profile?.extends).toBe('default'))
    })

    RuleScenario('A profile cannot take a name Factory ships', ({ Given, Then, And }) => {
      Given('the profile file:', given)
      Then('it is refused', () => expect(errors()).not.toHaveLength(0))
      And('the refusal names the field "name"', () =>
        expect(errors().map((p) => p.field)).toContain('name'),
      )
    })

    RuleScenario('A profile cannot extend Full Access', ({ Given, Then }) => {
      Given('the profile file:', given)
      Then('it is refused', () => expect(errors()).not.toHaveLength(0))
    })

    RuleScenario('A profile that widens nothing says so', ({ Given, Then, And }) => {
      Given('the profile file:', given)
      Then('it parses', () => expect(profile).toBeDefined())
      And('it warns that it allows nothing', () =>
        expect(problems.map((p) => p.rule)).toContain('profile.allowsNothing'),
      )
    })

    RuleScenario('A key Factory does not know is refused, with a suggestion', ({
      Given,
      Then,
      And,
    }) => {
      Given('the profile file:', given)
      Then('it is refused', () => expect(errors()).not.toHaveLength(0))
      And('the refusal suggests "commands"', () =>
        expect(errors().map((p) => p.message).join(' ')).toContain('commands'),
      )
    })
  })

  Rule('what a profile allows reaches the command line, once', ({ RuleScenario }) => {
    let descriptor: ProviderDescriptor
    let grants: ProfileGrants
    let argv: readonly string[] = []

    const provider = (extra: Record<string, unknown> = {}, allowed: string[] = []): void => {
      const parsed = parseProviderDescriptor({
        id: 'probe',
        displayName: 'Probe',
        command: 'probe',
        promptFlag: '-p',
        models: { strong: 'a', balanced: 'b', fast: 'c' },
        permissionArgs: {
          default: ['--restricted', ...(allowed.length > 0 ? ['--allowedTools', allowed.join(',')] : [])],
          'full-access': ['--yolo'],
        },
        ...extra,
      })
      expect(parsed.error, JSON.stringify(parsed.error?.issues)).toBeUndefined()
      descriptor = parsed.descriptor as ProviderDescriptor
      grants = NO_GRANTS
    }
    const allows = (extra: Record<string, unknown> = {}, already: string[] = []): void =>
      provider({ commandAllowFlag: '--allowedTools', commandPattern: 'Bash({command} *)', ...extra }, already)
    const grant = (next: Partial<ProfileGrants>): void => {
      grants = { ...NO_GRANTS, ...grants, ...next }
    }
    const renderWith = (profile: string): void => {
      argv = render(descriptor, { prompt: 'do it', profile, grants }).args
    }
    /** The value that follows a flag, which is where a variadic option's whole list lives. */
    const valueOf = (flag: string): string => {
      const at = argv.indexOf(flag)
      expect(at, `${flag} is not in ${argv.join(' ')}`).toBeGreaterThan(-1)
      return argv[at + 1] ?? ''
    }
    const appearsOnce = (flag: string) => (): void => {
      expect(argv.filter((a) => a === flag)).toHaveLength(1)
    }

    RuleScenario("A profile's commands are added to the confined list", ({ Given, And, When, Then }) => {
      Given('a provider that allows commands with "--allowedTools" as "Bash({command} *)"', () =>
        allows(),
      )
      And('a profile allowing "cargo" and "make"', () => grant({ commands: ['cargo', 'make'] }))
      When('the command is rendered', () => renderWith('development'))
      Then('the argv still carries "--restricted"', () => expect(argv).toContain('--restricted'))
      And('"--allowedTools" appears once', appearsOnce('--allowedTools'))
      And('its value carries "Bash(cargo *)"', () =>
        expect(valueOf('--allowedTools')).toContain('Bash(cargo *)'),
      )
      And('its value carries "Bash(make *)"', () =>
        expect(valueOf('--allowedTools')).toContain('Bash(make *)'),
      )
    })

    RuleScenario("The profile's own entries join the ones Default already passes", ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('a provider that allows commands with "--allowedTools" as "Bash({command} *)"', () =>
        allows(),
      )
      And('whose Default already allows "Bash(pnpm *)"', () => allows({}, ['Bash(pnpm *)']))
      And('a profile allowing "cargo"', () => grant({ commands: ['cargo'] }))
      When('the command is rendered', () => renderWith('development'))
      Then('its value carries "Bash(pnpm *)"', () =>
        expect(valueOf('--allowedTools')).toContain('Bash(pnpm *)'),
      )
      And('its value carries "Bash(cargo *)"', () =>
        expect(valueOf('--allowedTools')).toContain('Bash(cargo *)'),
      )
    })

    RuleScenario('The list it folded in does not linger as a loose argument', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('a provider that allows commands with "--allowedTools" as "Bash({command} *)"', () =>
        allows(),
      )
      And('whose Default already allows "Bash(pnpm *)"', () => allows({}, ['Bash(pnpm *)']))
      And('a profile allowing "cargo"', () => grant({ commands: ['cargo'] }))
      When('the command is rendered', () => renderWith('development'))
      Then('no argument is a bare "Bash(pnpm *)"', () => {
        // Inside the merged value, yes. As an argv element of its own, never.
        expect(argv).not.toContain('Bash(pnpm *)')
      })
    })

    RuleScenario('Denied commands are rendered where a provider has a deny-list', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('a provider that allows commands with "--allowedTools" as "Bash({command} *)"', () =>
        allows(),
      )
      And('that denies commands with "--disallowedTools"', () =>
        allows({ commandDenyFlag: '--disallowedTools' }),
      )
      And('a profile allowing "git" and denying "git push"', () =>
        grant({ commands: ['git'], denyCommands: ['git push'] }),
      )
      When('the command is rendered', () => renderWith('development'))
      Then('"--disallowedTools" appears once', appearsOnce('--disallowedTools'))
      And('the denied value carries "Bash(git push *)"', () =>
        expect(valueOf('--disallowedTools')).toContain('Bash(git push *)'),
      )
    })

    RuleScenario("A provider's own arguments are appended verbatim", ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('a provider that allows commands with "--allowedTools" as "Bash({command} *)"', () =>
        allows(),
      )
      And('a profile passing "--disallow-temp-dir" to that provider', () =>
        grant({ args: ['--disallow-temp-dir'] }),
      )
      When('the command is rendered', () => renderWith('development'))
      Then('the argv carries "--disallow-temp-dir"', () =>
        expect(argv).toContain('--disallow-temp-dir'),
      )
    })

    RuleScenario('A built-in profile renders exactly as it always did', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('a provider that allows commands with "--allowedTools" as "Bash({command} *)"', () =>
        allows(),
      )
      And('whose Default already allows "Bash(pnpm *)"', () => allows({}, ['Bash(pnpm *)']))
      When('the default profile is rendered', () => renderWith('default'))
      Then('"--allowedTools" appears once', appearsOnce('--allowedTools'))
      And('its value carries "Bash(pnpm *)"', () =>
        expect(valueOf('--allowedTools')).toContain('Bash(pnpm *)'),
      )
      And('its value does not carry "Bash(cargo *)"', () =>
        expect(valueOf('--allowedTools')).not.toContain('Bash(cargo *)'),
      )
    })
  })

  Rule('a provider that cannot honour a profile says so', ({ RuleScenario }) => {
    let descriptor: ProviderDescriptor
    let grants: ProfileGrants

    const provider = (extra: Record<string, unknown> = {}): void => {
      const parsed = parseProviderDescriptor({
        id: 'probe',
        displayName: 'Probe',
        command: 'probe',
        promptFlag: '-p',
        models: { strong: 'a', balanced: 'b', fast: 'c' },
        ...extra,
      })
      expect(parsed.error, JSON.stringify(parsed.error?.issues)).toBeUndefined()
      descriptor = parsed.descriptor as ProviderDescriptor
      grants = NO_GRANTS
    }
    const allows = (extra: Record<string, unknown> = {}): void =>
      provider({ commandAllowFlag: '--allowedTools', commandPattern: 'Bash({command} *)', ...extra })
    const grant = (next: Partial<ProfileGrants>): void => {
      grants = { ...NO_GRANTS, ...grants, ...next }
    }
    const reported = (): readonly { what: string; provider: string; message: string }[] =>
      unsupportedBy(descriptor, grants)

    RuleScenario('A provider with no allow-list reports the commands it cannot honour', ({
      Given,
      And,
      Then,
    }) => {
      Given('a provider with no way to allow commands', () => provider())
      And('a profile allowing "cargo" and "make"', () => grant({ commands: ['cargo', 'make'] }))
      Then('it reports that it cannot honour the commands', () => {
        expect(reported().map((r) => r.what)).toContain('commands')
      })
      And('what it reports names the provider', () => {
        expect(reported()[0]?.message).toContain('probe')
      })
    })

    RuleScenario('A provider with no deny-list reports that too', ({ Given, And, Then }) => {
      Given('a provider that allows commands with "--allowedTools" as "Bash({command} *)"', () =>
        allows(),
      )
      And('a profile allowing "git" and denying "git push"', () =>
        grant({ commands: ['git'], denyCommands: ['git push'] }),
      )
      Then('it reports that it cannot honour the denied commands', () => {
        expect(reported().map((r) => r.what)).toContain('deny_commands')
      })
    })

    RuleScenario('A provider that can honour everything reports nothing', ({
      Given,
      And,
      Then,
    }) => {
      Given('a provider that allows commands with "--allowedTools" as "Bash({command} *)"', () =>
        allows(),
      )
      And('that denies commands with "--disallowedTools"', () =>
        allows({ commandDenyFlag: '--disallowedTools' }),
      )
      And('a profile allowing "git" and denying "git push"', () =>
        grant({ commands: ['git'], denyCommands: ['git push'] }),
      )
      Then('it reports nothing it cannot honour', () => expect(reported()).toEqual([]))
    })

    RuleScenario('A profile with only provider arguments is honoured by anyone', ({
      Given,
      And,
      Then,
    }) => {
      Given('a provider with no way to allow commands', () => provider())
      And('a profile passing "--disallow-temp-dir" to that provider', () =>
        grant({ args: ['--disallow-temp-dir'] }),
      )
      Then('it reports nothing it cannot honour', () => expect(reported()).toEqual([]))
    })
  })
})

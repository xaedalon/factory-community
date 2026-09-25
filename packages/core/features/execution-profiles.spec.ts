import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import {
  parseProviderDescriptor,
  distinguishesProfiles,
  permissionArgsFor,
  profileWideningArgs,
} from '../src/providers/descriptor.js'
import claudePlugin from '@factory/provider-claude'
import { CapabilityHost } from '../src/host.js'
import { PROVIDER_KIND, type ProviderCapability } from '../src/providers/capability.js'
import {
  EXECUTION_PROFILE_LABELS,
  EXECUTION_PROFILES,
  isConfined,
  isExecutionProfile,
  resolveProfile,
  type ExecutionProfile,
} from '../src/security/profile.js'

const feature = await loadFeature(
  fileURLToPath(new URL('./execution-profiles.feature', import.meta.url)),
)

describeFeature(feature, ({ Scenario, Rule, BeforeEachScenario }) => {
  let project: ExecutionProfile | undefined
  let installation: ExecutionProfile | undefined
  let resolved: ExecutionProfile | undefined
  let checked: boolean[]
  let labels: string[]

  BeforeEachScenario(() => {
    project = undefined
    installation = undefined
    resolved = undefined
    checked = []
    labels = []
  })

  const projectStatesNothing = (): void => {
    project = undefined
  }
  const installationStatesNothing = (): void => {
    installation = undefined
  }
  const projectChose =
    (profile: ExecutionProfile) =>
    (): void => {
      project = profile
    }
  const installationChose =
    (profile: ExecutionProfile) =>
    (): void => {
      installation = profile
    }
  const ask = (): void => {
    resolved = resolveProfile({ project, installation })
  }
  const profileIs = (expected: string) => (): void => {
    expect(resolved).toBe(expected)
  }
  const confined = (yes: boolean) => (): void => {
    expect(isConfined(resolved as ExecutionProfile)).toBe(yes)
  }

  Scenario('An installation that has said nothing is confined', ({ Given, And, When, Then }) => {
    Given('a project that states no profile', projectStatesNothing)
    And('an installation that states no profile', installationStatesNothing)
    When('I ask which profile applies', ask)
    Then('the profile is "default"', profileIs('default'))
    And('the agent is confined', confined(true))
  })

  Scenario("The installation's choice applies to a project that states none", ({
    Given,
    And,
    When,
    Then,
  }) => {
    Given('a project that states no profile', projectStatesNothing)
    And('the installation chose "full-access"', installationChose('full-access'))
    When('I ask which profile applies', ask)
    Then('the profile is "full-access"', profileIs('full-access'))
    And('the agent is not confined', confined(false))
  })

  Scenario('A project overrides the installation', ({ Given, And, When, Then }) => {
    Given('the project chose "default"', projectChose('default'))
    And('the installation chose "full-access"', installationChose('full-access'))
    When('I ask which profile applies', ask)
    Then('the profile is "default"', profileIs('default'))
  })

  Scenario('A project can be less confined than its installation', ({ Given, And, When, Then }) => {
    Given('the project chose "full-access"', projectChose('full-access'))
    And('the installation chose "default"', installationChose('default'))
    When('I ask which profile applies', ask)
    Then('the profile is "full-access"', profileIs('full-access'))
  })

  Rule('absence means "not stated", never a third answer', ({ RuleScenario }) => {
    RuleScenario('A project that states nothing follows the installation later', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('a project that states no profile', projectStatesNothing)
      And('the installation chose "full-access"', installationChose('full-access'))
      When('I ask which profile applies', ask)
      Then('the profile is "full-access"', profileIs('full-access'))
    })

    RuleScenario('Stating the same thing as the installation is still a decision', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('the project chose "full-access"', projectChose('full-access'))
      And('the installation chose "full-access"', installationChose('full-access'))
      When('I ask which profile applies', ask)
      Then('the profile is "full-access"', profileIs('full-access'))
    })
  })

  Rule('a profile arriving from outside is checked before it is stored', ({ RuleScenario }) => {
    RuleScenario('The two profiles are recognised', ({ When, Then }) => {
      When('I check "default" and "full-access"', () => {
        checked = [isExecutionProfile('default'), isExecutionProfile('full-access')]
      })
      Then('both are profiles', () => {
        expect(checked).toEqual([true, true])
      })
    })

    RuleScenario('Anything else is not a profile', ({ When, Then }) => {
      When('I check "Default", "full access", "none", "" and nothing at all', () => {
        checked = [
          isExecutionProfile('Default'),
          isExecutionProfile('full access'),
          isExecutionProfile('none'),
          isExecutionProfile(''),
          isExecutionProfile(undefined),
        ]
      })
      Then('none of them is a profile', () => {
        expect(checked).toEqual([false, false, false, false, false])
      })
    })
  })

  Rule('each profile has one name for a person', ({ RuleScenario }) => {
    RuleScenario('Both profiles have a label', ({ When, Then, And }) => {
      When('I ask what to call each profile', () => {
        // Every profile, not the two named below: a third one added without a
        // label would reach the board as `undefined`.
        labels = EXECUTION_PROFILES.map((profile) => EXECUTION_PROFILE_LABELS[profile])
      })
      Then('"default" is called "Default"', () => {
        expect(labels[EXECUTION_PROFILES.indexOf('default')]).toBe('Default')
      })
      And('"full-access" is called "Full Access"', () => {
        expect(labels[EXECUTION_PROFILES.indexOf('full-access')]).toBe('Full Access')
        expect(labels.every((label) => typeof label === 'string' && label.length > 0)).toBe(true)
      })
    })
  })

  Rule('a descriptor written before profiles existed still works', ({ RuleScenario }) => {
    /** The smallest descriptor that parses, plus whatever the scenario is about. */
    const descriptorWith = (permissionArgs: unknown) => {
      const parsed = parseProviderDescriptor({
        kind: 'factory.provider/v1',
        id: 'probe',
        displayName: 'Probe',
        command: 'probe',
        models: { strong: 'big', balanced: 'mid', fast: 'small' },
        permissionArgs,
      })
      expect(parsed.error, JSON.stringify(parsed.error?.issues)).toBeUndefined()
      return parsed.descriptor as NonNullable<typeof parsed.descriptor>
    }
    let descriptor: ReturnType<typeof descriptorWith>
    let answers: readonly string[][]

    const oneList = (): void => {
      descriptor = descriptorWith(['--yolo'])
    }
    const perProfile = (): void => {
      descriptor = descriptorWith({ default: ['--safe'], 'full-access': ['--yolo'] })
    }
    const onlyFullAccess = (): void => {
      descriptor = descriptorWith({ 'full-access': ['--yolo'] })
    }
    const askBoth = (): void => {
      answers = [
        [...permissionArgsFor(descriptor, 'default')],
        [...permissionArgsFor(descriptor, 'full-access')],
      ]
    }

    RuleScenario('A bare list is used under both profiles', ({ Given, When, Then }) => {
      Given('a descriptor whose permission arguments are one list', oneList)
      When('I ask for its arguments under "default" and under "full-access"', askBoth)
      Then('both answers are that list', () => {
        expect(answers).toEqual([['--yolo'], ['--yolo']])
      })
    })

    RuleScenario('A bare list is reported as not telling the profiles apart', ({
      Given,
      Then,
    }) => {
      Given('a descriptor whose permission arguments are one list', oneList)
      Then('it does not distinguish the profiles', () => {
        expect(distinguishesProfiles(descriptor)).toBe(false)
      })
    })

    RuleScenario('A profile map answers each profile separately', ({ Given, When, Then }) => {
      Given('a descriptor with different arguments per profile', perProfile)
      When('I ask for its arguments under "default" and under "full-access"', askBoth)
      Then("each answer is that profile's own list", () => {
        expect(answers).toEqual([['--safe'], ['--yolo']])
      })
    })

    RuleScenario('A profile map is reported as telling them apart', ({ Given, Then }) => {
      Given('a descriptor with different arguments per profile', perProfile)
      Then('it distinguishes the profiles', () => {
        expect(distinguishesProfiles(descriptor)).toBe(true)
      })
    })

    RuleScenario('A profile map that names one profile is completed with an empty list', ({
      Given,
      Then,
      And,
    }) => {
      Given('a descriptor that names only "full-access"', onlyFullAccess)
      Then('its "default" list is empty', () => {
        // Off the parsed descriptor, not through the lookup: the schema is what
        // makes this true, so the schema is what the scenario has to watch.
        const declared = descriptor.permissionArgs as Record<string, readonly string[]>
        expect(declared['default']).toEqual([])
      })
      And('its "full-access" list is what it named', () => {
        const declared = descriptor.permissionArgs as Record<string, readonly string[]>
        expect(declared['full-access']).toEqual(['--yolo'])
      })
    })
  })

  Rule('a step cannot argue its way out of the profile it runs under', ({ RuleScenario }) => {
    const parse = (fields: Record<string, unknown>) => {
      const parsed = parseProviderDescriptor({
        kind: 'factory.provider/v1',
        id: 'probe',
        displayName: 'Probe',
        command: 'probe',
        models: { strong: 'big', balanced: 'mid', fast: 'small' },
        ...fields,
      })
      expect(parsed.error, JSON.stringify(parsed.error?.issues)).toBeUndefined()
      return parsed.descriptor as NonNullable<typeof parsed.descriptor>
    }
    let subject: ReturnType<typeof parse>
    let refused: readonly string[] = []

    const fullAccessYolo = (): void => {
      subject = parse({ permissionArgs: { default: ['--safe'], 'full-access': ['--yolo'] } })
    }
    const passes = (profile: ExecutionProfile, ...args: string[]) => (): void => {
      refused = profileWideningArgs(subject, profile, args)
    }
    const nothingRefused = (): void => expect(refused).toEqual([])

    RuleScenario("An argument from the provider's Full Access list is refused", ({
      Given,
      When,
      Then,
    }) => {
      Given('a descriptor whose Full Access arguments are "--yolo"', fullAccessYolo)
      When('a step under "default" passes "--yolo"', passes('default', '--yolo'))
      Then('that argument is refused', () => expect(refused).toEqual(['--yolo']))
    })

    RuleScenario('The same argument under Full Access is not refused', ({ Given, When, Then }) => {
      Given('a descriptor whose Full Access arguments are "--yolo"', fullAccessYolo)
      When('a step under "full-access" passes "--yolo"', passes('full-access', '--yolo'))
      Then('nothing is refused', nothingRefused)
    })

    RuleScenario('An ordinary argument is left alone', ({ Given, When, Then }) => {
      Given('a descriptor whose Full Access arguments are "--yolo"', fullAccessYolo)
      When('a step under "default" passes "--verbose"', passes('default', '--verbose'))
      Then('nothing is refused', nothingRefused)
    })

    RuleScenario('An argument the confined profile already passes is not refused', ({
      Given,
      When,
      Then,
    }) => {
      Given('a descriptor that passes "--mode" under both profiles', () => {
        subject = parse({
          permissionArgs: { default: ['--mode', 'safe'], 'full-access': ['--mode', 'yolo'] },
        })
      })
      When('a step under "default" passes "--mode"', passes('default', '--mode'))
      Then('nothing is refused', nothingRefused)
    })

    RuleScenario('A flag written with "=" is the same flag', ({ Given, When, Then }) => {
      Given('a descriptor whose Full Access arguments are "--yolo"', fullAccessYolo)
      When('a step under "default" passes "--yolo=true"', passes('default', '--yolo=true'))
      Then('that argument is refused', () => expect(refused).toEqual(['--yolo=true']))
    })

    RuleScenario('A descriptor may forbid more than derivation can see', ({
      Given,
      When,
      Then,
    }) => {
      Given('a descriptor that forbids "--allowedTools"', () => {
        subject = parse({ forbiddenArgs: ['--allowedTools'] })
      })
      When('a step under "default" passes "--allowedTools"', passes('default', '--allowedTools'))
      Then('that argument is refused', () => expect(refused).toEqual(['--allowedTools']))
    })

    RuleScenario('A provider that has measured nothing forbids nothing', ({
      Given,
      When,
      Then,
    }) => {
      Given('a descriptor with no permission arguments at all', () => {
        subject = parse({})
      })
      When('a step under "default" passes "--yolo"', passes('default', '--yolo'))
      Then('nothing is refused', nothingRefused)
    })

    RuleScenario('The provider Factory ships refuses the flag that started this', ({
      Given,
      When,
      Then,
    }) => {
      // The real descriptor, not a copy of it. A copy would keep passing after
      // somebody edited the shipped one.
      Given('the descriptor Factory ships for Claude', async () => {
        const host = new CapabilityHost()
        await host.load(claudePlugin)
        subject = (host.get<ProviderCapability>(PROVIDER_KIND, 'claude') as ProviderCapability)
          .descriptor
      })
      When(
        'a step under "default" passes "--permission-mode bypassPermissions"',
        passes('default', '--permission-mode', 'bypassPermissions'),
      )
      Then('that argument is refused', () =>
        expect(refused).toContain('bypassPermissions'),
      )
    })
  })
})

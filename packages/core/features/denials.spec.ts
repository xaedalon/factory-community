import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import {
  DenialScanner,
  denialMessage,
  refusalDenial,
  type Denial,
  type DenialPattern,
} from '../src/security/denials.js'
import claudePlugin from '@factory/provider-claude'
import { CapabilityHost, PROVIDER_KIND, type ProviderCapability } from '../src/index.js'

const feature = await loadFeature(fileURLToPath(new URL('./denials.feature', import.meta.url)))

/**
 * The patterns Factory actually ships, read off the descriptor rather than
 * copied here. A copy would keep passing after somebody edited the real one.
 */
const shippedPatterns = async (): Promise<readonly DenialPattern[]> => {
  const host = new CapabilityHost()
  await host.load(claudePlugin)
  const provider = host.get<ProviderCapability>(PROVIDER_KIND, 'claude') as ProviderCapability
  return provider.descriptor.denialPatterns
}

describeFeature(feature, ({ Scenario, Rule, BeforeEachScenario }) => {
  let scanner: DenialScanner
  let found: readonly Denial[]
  let message: string
  let elapsed = 0

  BeforeEachScenario(() => {
    scanner = new DenialScanner()
    found = []
    message = ''
    elapsed = 0
  })

  const shipped = async (): Promise<void> => {
    scanner = new DenialScanner(await shippedPatterns())
  }
  const withPatterns = (patterns: DenialPattern[]) => (): void => {
    scanner = new DenialScanner(patterns)
  }
  const output = (text: string) => (): void => {
    scanner.push(text)
    found = scanner.denials()
  }
  const oneFound = (): void => expect(found).toHaveLength(1)
  const noneFound = (): void => expect(found).toEqual([])

  Scenario('Nothing is found when nothing was refused', ({ Given, When, Then }) => {
    Given('the patterns Factory ships for Claude', shipped)
    When('the agent\'s output is "Wrote inside.txt. All done."', output('Wrote inside.txt. All done.'))
    Then('no refusal was found', noneFound)
  })

  Scenario('A refusal naming the path it refused is found, with the path', ({
    Given,
    When,
    Then,
    And,
  }) => {
    Given('the patterns Factory ships for Claude', shipped)
    When(
      'the agent\'s output is "/tmp/probe.txt is outside the configured working directories"',
      output('/tmp/probe.txt is outside the configured working directories'),
    )
    Then('one refusal was found', oneFound)
    And('it is a "path-outside-workspace"', () =>
      expect(found[0]?.id).toBe('path-outside-workspace'),
    )
    And('the path it names is "/tmp/probe.txt"', () =>
      expect(found[0]?.path).toBe('/tmp/probe.txt'),
    )
    And('it carries the line it was found in', () =>
      expect(found[0]?.evidence).toContain('outside the configured working director'),
    )
  })

  Scenario('The other observed wording is recognised without a path', ({
    Given,
    When,
    Then,
    And,
  }) => {
    Given('the patterns Factory ships for Claude', shipped)
    When(
      'the agent\'s output is "outside /repos/app; --restricted confines the file tools to the working directory."',
      output('outside /repos/app; --restricted confines the file tools to the working directory.'),
    )
    Then('one refusal was found', oneFound)
    And('it is a "file-tools-confined"', () => expect(found[0]?.id).toBe('file-tools-confined'))
    And('it names no path', () => expect(found[0]?.path).toBeUndefined())
  })

  Scenario('The same refusal twice is one refusal', ({ Given, When, Then }) => {
    Given('the patterns Factory ships for Claude', shipped)
    When("the agent's output refuses the same path twice", () => {
      scanner.push('/tmp/probe.txt is outside the working directory\n')
      scanner.push('/tmp/probe.txt is outside the working directory\n')
      found = scanner.denials()
    })
    Then('one refusal was found', oneFound)
  })

  Rule('a pattern split across two chunks of output is still found', ({ RuleScenario }) => {
    RuleScenario('A refusal broken in half is found', ({ Given, When, Then, And }) => {
      Given('the patterns Factory ships for Claude', shipped)
      When(
        'the output arrives as "/tmp/probe.txt is outsi" then "de the working directory"',
        () => {
          scanner.push('/tmp/probe.txt is outsi')
          scanner.push('de the working directory')
          found = scanner.denials()
        },
      )
      Then('one refusal was found', oneFound)
      And('the path it names is "/tmp/probe.txt"', () =>
        expect(found[0]?.path).toBe('/tmp/probe.txt'),
      )
    })

    RuleScenario('Output far larger than the scan window still finds a late refusal', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given('the patterns Factory ships for Claude', shipped)
      When('200 kilobytes of chatter arrive, then a refusal', () => {
        // Deliberately without whitespace: that is what defeats an unbounded
        // capture group, and what an agent printing data looks like.
        const started = performance.now()
        for (let i = 0; i < 200; i += 1) scanner.push('x'.repeat(1024))
        scanner.push('/tmp/probe.txt is outside the working directory')
        elapsed = performance.now() - started
        found = scanner.denials()
      })
      Then('one refusal was found', oneFound)
      And('the scan took well under a second', () => {
        // Correct: a handful of milliseconds. Quadratic: seconds, or — with the
        // 64 KiB tail the first version kept — longer than anyone will wait.
        expect(elapsed).toBeLessThan(500)
      })
    })

    RuleScenario('A refusal older than the scan window is still remembered', ({
      Given,
      When,
      Then,
    }) => {
      Given('the patterns Factory ships for Claude', shipped)
      When('a refusal arrives, then 200 kilobytes of chatter', () => {
        scanner.push('/tmp/probe.txt is outside the working directory')
        for (let i = 0; i < 200; i += 1) scanner.push('x'.repeat(1024))
        found = scanner.denials()
      })
      Then('one refusal was found', oneFound)
    })
  })

  Rule('a provider that says nothing detects nothing', ({ RuleScenario }) => {
    RuleScenario('No patterns means no work and no findings', ({ Given, When, Then, And }) => {
      Given('a provider with no patterns', withPatterns([]))
      When(
        'the agent\'s output is "/tmp/probe.txt is outside the configured working directories"',
        output('/tmp/probe.txt is outside the configured working directories'),
      )
      Then('no refusal was found', noneFound)
      And('the scanner reports itself as idle', () => expect(scanner.idle).toBe(true))
    })
  })

  Rule('a broken pattern does not break the run', ({ RuleScenario }) => {
    const broken: DenialPattern = {
      id: 'broken',
      contains: 'is outside the',
      match: '([',
      describe: 'nonsense',
    }
    const working: DenialPattern = {
      id: 'works',
      contains: 'is outside the',
      match: '(\\S+) is outside the (?:configured )?working director',
      describe: 'a path outside the workspace',
    }

    RuleScenario('A pattern that will not compile is skipped', ({ Given, When, Then }) => {
      Given('a provider whose pattern is not a valid expression', withPatterns([broken]))
      When(
        'the agent\'s output is "/tmp/probe.txt is outside the configured working directories"',
        output('/tmp/probe.txt is outside the configured working directories'),
      )
      Then('no refusal was found', noneFound)
    })

    RuleScenario('A broken pattern does not stop a good one beside it', ({
      Given,
      When,
      Then,
    }) => {
      Given(
        'a provider with one broken pattern and one that works',
        withPatterns([broken, working]),
      )
      When(
        'the agent\'s output is "/tmp/probe.txt is outside the configured working directories"',
        output('/tmp/probe.txt is outside the configured working directories'),
      )
      Then('one refusal was found', oneFound)
    })
  })

  Rule('a refusal a provider stated outright names the command', ({ RuleScenario }) => {
    /** The CLI's own sentence, abbreviated. Not the agent's summary of it. */
    const words = 'Permission for this tool use was denied.'
    const reports = (command: string) => (): void => {
      found = [...found, refusalDenial({ tool: 'Bash', command, evidence: words })]
    }

    RuleScenario('A refused command is carried through to the refusal', ({ When, Then, And }) => {
      When('the provider reports that "pnpm install" was refused', reports('pnpm install'))
      Then('the refusal names the command "pnpm install"', () =>
        expect(found[0]?.command).toBe('pnpm install'),
      )
      And("it carries the provider's own words", () => expect(found[0]?.evidence).toBe(words))
    })

    RuleScenario('Two refusals of the same executable are one problem', ({ When, And, Then }) => {
      When('the provider reports that "pnpm install" was refused', reports('pnpm install'))
      And('the provider reports that "pnpm test" was refused', reports('pnpm test'))
      Then('both refusals have the same id', () => expect(found[0]?.id).toBe(found[1]?.id))
    })

    RuleScenario('Two different executables are two problems', ({ When, And, Then }) => {
      When('the provider reports that "pnpm install" was refused', reports('pnpm install'))
      And('the provider reports that "docker compose up" was refused', reports('docker compose up'))
      Then('the refusals have different ids', () => expect(found[0]?.id).not.toBe(found[1]?.id))
    })

    RuleScenario('A refused tool that ran no command still says what it was', ({ When, Then, And }) => {
      When('the provider reports that the "WebFetch" tool was refused', () => {
        found = [refusalDenial({ tool: 'WebFetch', evidence: words })]
      })
      Then('the refusal names no command', () => expect(found[0]?.command).toBeUndefined())
      And('its description names "WebFetch"', () => expect(found[0]?.describe).toContain('WebFetch'))
    })

    RuleScenario('The message for a command says the work did not happen', ({
      When,
      And,
      Then,
    }) => {
      When('the provider reports that "pnpm install" was refused', reports('pnpm install'))
      And('I ask what to tell the reader', () => {
        message = denialMessage(found[0] as Denial)
      })
      Then('the message names "pnpm install"', () => expect(message).toContain('pnpm install'))
      And('the message says that command did not run', () =>
        expect(message).toContain('did not run'),
      )
      And('the message mentions "Full Access"', () => expect(message).toContain('Full Access'))
    })
  })

  Rule('the message says what to do about it', ({ RuleScenario }) => {
    const ask = (): void => {
      message = denialMessage(found[0] as Denial)
    }

    RuleScenario('A refusal with a path offers to allow that path', ({
      Given,
      When,
      And,
      Then,
    }) => {
      Given('the patterns Factory ships for Claude', shipped)
      When(
        'the agent\'s output is "/tmp/probe.txt is outside the configured working directories"',
        output('/tmp/probe.txt is outside the configured working directories'),
      )
      And('I ask what to tell the reader', ask)
      Then('the message names "/tmp/probe.txt"', () => expect(message).toContain('/tmp/probe.txt'))
      And('the message offers to allow it for this project', () =>
        expect(message).toContain('for this project'),
      )
      And('the message mentions "Full Access"', () => expect(message).toContain('Full Access'))
    })

    RuleScenario('A refusal without a path still offers a way forward', ({
      Given,
      When,
      And,
      Then,
    }) => {
      Given('the patterns Factory ships for Claude', shipped)
      When(
        'the agent\'s output is "outside /repos/app; --restricted confines the file tools to the working directory."',
        output('outside /repos/app; --restricted confines the file tools to the working directory.'),
      )
      And('I ask what to tell the reader', ask)
      Then('the message offers to allow it for this project', () =>
        expect(message).toContain('for this project'),
      )
    })
  })
})

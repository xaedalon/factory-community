import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import {
  agentEnvironment,
  withheldMessage,
  type FilteredEnvironment,
} from '../src/security/environment.js'

const feature = await loadFeature(
  fileURLToPath(new URL('./agent-environment.feature', import.meta.url)),
)

/** Every value is a recognisable secret, so "no value leaked" is checkable. */
const VALUE = 'sensitive-value'

describeFeature(feature, ({ Scenario, Rule, BeforeEachScenario }) => {
  let env: Record<string, string | undefined>
  let names: string[]
  let keep: string[]
  let built: FilteredEnvironment | undefined
  let report: string

  BeforeEachScenario(() => {
    env = {}
    names = []
    keep = []
    built = undefined
    report = ''
  })

  const holding =
    (...given: string[]) =>
    (): void => {
      names = given
      for (const name of given) env[name] = VALUE
    }
  const holdingUnset = (name: string) => (): void => {
    names = [name]
    env[name] = undefined
  }
  const declares = (name: string) => (): void => {
    keep = [name]
  }
  const build = (profile: 'default' | 'full-access') => (): void => {
    built = agentEnvironment(env, { profile, ...(keep.length === 0 ? {} : { keep }) })
  }
  const passedThrough = (yes: boolean) => (): void => {
    for (const name of names) {
      expect(Object.hasOwn(built?.env ?? {}, name), `${name} passed through`).toBe(yes)
    }
  }
  const onePassed = (name: string, yes: boolean) => (): void => {
    expect(Object.hasOwn(built?.env ?? {}, name), `${name} passed through`).toBe(yes)
  }
  const withheldCount = (count: number) => (): void => {
    expect(built?.withheld).toHaveLength(count)
  }

  Scenario('Ordinary variables are passed through', ({ Given, When, Then, And }) => {
    Given(
      'the environment holds "PATH", "HOME", "LANG" and "CI"',
      holding('PATH', 'HOME', 'LANG', 'CI'),
    )
    When('the environment is built for a confined step', build('default'))
    Then('all of them are passed through', passedThrough(true))
    And('nothing was withheld', withheldCount(0))
  })

  Scenario('Credentials are withheld', ({ Given, When, Then, And }) => {
    Given(
      'the environment holds "GITHUB_TOKEN", "NPM_TOKEN" and "AWS_SECRET_ACCESS_KEY"',
      holding('GITHUB_TOKEN', 'NPM_TOKEN', 'AWS_SECRET_ACCESS_KEY'),
    )
    When('the environment is built for a confined step', build('default'))
    Then('none of them is passed through', passedThrough(false))
    And('all three were withheld', withheldCount(3))
  })

  Scenario('An unset variable is not passed as the word "undefined"', ({
    Given,
    When,
    Then,
    And,
  }) => {
    Given('the environment holds "EDITOR" with no value', holdingUnset('EDITOR'))
    When('the environment is built for a confined step', build('default'))
    Then('"EDITOR" is not passed through', onePassed('EDITOR', false))
    And('nothing was withheld', withheldCount(0))
  })

  Rule('the shape of the name is what decides', ({ RuleScenario }) => {
    RuleScenario('A name whose segment is a credential word is withheld', ({
      Given,
      When,
      Then,
    }) => {
      Given(
        'the environment holds "SENTRY_TOKEN", "DB_PASSWORD" and "MY_SECRET_THING"',
        holding('SENTRY_TOKEN', 'DB_PASSWORD', 'MY_SECRET_THING'),
      )
      When('the environment is built for a confined step', build('default'))
      Then('none of them is passed through', passedThrough(false))
    })

    RuleScenario('A name that merely contains the letters is kept', ({ Given, When, Then }) => {
      Given(
        'the environment holds "TOKENIZERS_PARALLELISM" and "KEYBOARD_LAYOUT"',
        holding('TOKENIZERS_PARALLELISM', 'KEYBOARD_LAYOUT'),
      )
      When('the environment is built for a confined step', build('default'))
      Then('all of them are passed through', passedThrough(true))
    })

    RuleScenario('A whole family is withheld by prefix', ({ Given, When, Then }) => {
      Given(
        'the environment holds "AWS_REGION" and "AWS_PROFILE"',
        holding('AWS_REGION', 'AWS_PROFILE'),
      )
      When('the environment is built for a confined step', build('default'))
      Then('none of them is passed through', passedThrough(false))
    })

    RuleScenario('A name that is a credential without saying so is withheld', ({
      Given,
      When,
      Then,
    }) => {
      Given(
        'the environment holds "SSH_AUTH_SOCK" and "DATABASE_URL"',
        holding('SSH_AUTH_SOCK', 'DATABASE_URL'),
      )
      When('the environment is built for a confined step', build('default'))
      Then('none of them is passed through', passedThrough(false))
    })

    RuleScenario('An ending that is a credential is withheld whatever precedes it', ({
      Given,
      When,
      Then,
    }) => {
      Given(
        'the environment holds "ANTHROPIC_API_KEY" and "SOMETHING_PRIVATE_KEY"',
        holding('ANTHROPIC_API_KEY', 'SOMETHING_PRIVATE_KEY'),
      )
      When('the environment is built for a confined step', build('default'))
      Then('none of them is passed through', passedThrough(false))
    })
  })

  Rule('a provider keeps what it needs to authenticate', ({ RuleScenario }) => {
    RuleScenario('A declared variable survives the filter', ({ Given, And, When, Then }) => {
      Given(
        'the environment holds "ANTHROPIC_API_KEY" and "GITHUB_TOKEN"',
        holding('ANTHROPIC_API_KEY', 'GITHUB_TOKEN'),
      )
      And(
        'the step\'s provider declares that it needs "ANTHROPIC_API_KEY"',
        declares('ANTHROPIC_API_KEY'),
      )
      When('the environment is built for a confined step', build('default'))
      Then('"ANTHROPIC_API_KEY" is passed through', onePassed('ANTHROPIC_API_KEY', true))
      And('"GITHUB_TOKEN" is not passed through', onePassed('GITHUB_TOKEN', false))
      And('only "GITHUB_TOKEN" was withheld', () => {
        expect(built?.withheld).toEqual(['GITHUB_TOKEN'])
      })
    })

    RuleScenario('A declaration is matched whatever case it is written in', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('the environment holds "ANTHROPIC_API_KEY"', holding('ANTHROPIC_API_KEY'))
      And(
        'the step\'s provider declares that it needs "anthropic_api_key"',
        declares('anthropic_api_key'),
      )
      When('the environment is built for a confined step', build('default'))
      Then('"ANTHROPIC_API_KEY" is passed through', onePassed('ANTHROPIC_API_KEY', true))
    })

    RuleScenario('A step with no provider keeps no credentials', ({ Given, When, Then }) => {
      Given('the environment holds "NPM_TOKEN"', holding('NPM_TOKEN'))
      When('the environment is built for a confined step', build('default'))
      Then('"NPM_TOKEN" is not passed through', onePassed('NPM_TOKEN', false))
    })
  })

  Rule('Full Access withholds nothing', ({ RuleScenario }) => {
    RuleScenario('Nothing is filtered under Full Access', ({ Given, When, Then, And }) => {
      Given(
        'the environment holds "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY" and "PATH"',
        holding('GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'PATH'),
      )
      When('the environment is built for an unconfined step', build('full-access'))
      Then('all of them are passed through', passedThrough(true))
      And('nothing was withheld', withheldCount(0))
    })

    RuleScenario('An unset variable is still dropped under Full Access', ({
      Given,
      When,
      Then,
    }) => {
      Given('the environment holds "EDITOR" with no value', holdingUnset('EDITOR'))
      When('the environment is built for an unconfined step', build('full-access'))
      Then('"EDITOR" is not passed through', onePassed('EDITOR', false))
    })
  })

  Rule('what was withheld is said, and values never are', ({ RuleScenario }) => {
    RuleScenario('The report names the variables, in order, and says how to fix it', ({
      Given,
      When,
      And,
      Then,
    }) => {
      Given(
        'the environment holds "NPM_TOKEN" and "GITHUB_TOKEN"',
        holding('NPM_TOKEN', 'GITHUB_TOKEN'),
      )
      When('the environment is built for a confined step', build('default'))
      And('I ask what to tell the reader', () => {
        report = withheldMessage(built?.withheld ?? [])
      })
      Then('the report names "GITHUB_TOKEN" and "NPM_TOKEN"', () => {
        expect(report).toContain('GITHUB_TOKEN, NPM_TOKEN')
      })
      And('the report counts two variables', () => {
        expect(report).toContain('2 environment variables')
      })
      And('the report mentions "passEnv"', () => expect(report).toContain('passEnv'))
      And('the report mentions "Full Access"', () => expect(report).toContain('Full Access'))
      And('the report contains no value', () => expect(report).not.toContain(VALUE))
    })
  })
  Rule('what the agent is told about its own run survives the filter', ({ RuleScenario }) => {
    RuleScenario('A confined step is told which run and task it is', ({ Given, When, Then, And }) => {
      Given(
        'the environment holds "FACTORY_RUN_ID" and "FACTORY_TASK_ID"',
        holding('FACTORY_RUN_ID', 'FACTORY_TASK_ID'),
      )
      When('the environment is built for a confined step', build('default'))
      Then('all of them are passed through', passedThrough(true))
      And('nothing was withheld', withheldCount(0))
    })

    RuleScenario('And which project, and how deep', ({ Given, When, Then, And }) => {
      Given(
        'the environment holds "FACTORY_PROJECT_ID" and "FACTORY_ORCHESTRATION_DEPTH"',
        holding('FACTORY_PROJECT_ID', 'FACTORY_ORCHESTRATION_DEPTH'),
      )
      When('the environment is built for a confined step', build('default'))
      Then('all of them are passed through', passedThrough(true))
      And('nothing was withheld', withheldCount(0))
    })
  })
})

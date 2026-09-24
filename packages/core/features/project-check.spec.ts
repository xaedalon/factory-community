import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { detectCheckCommand } from '../src/task/check.js'

const feature = await loadFeature(
  fileURLToPath(new URL('./project-check.feature', import.meta.url)),
)

describeFeature(feature, ({ Rule, BeforeEachScenario }) => {
  /** The repository, as the only thing detection can see: files and contents. */
  let files: Record<string, string>

  BeforeEachScenario(() => {
    files = {}
  })

  const detected = (): string | undefined =>
    detectCheckCommand((relative) => files[relative])

  const manifestWith = (...scripts: string[]) => (): void => {
    files['package.json'] = JSON.stringify({
      name: 'probe',
      scripts: Object.fromEntries(scripts.map((name) => [name, `echo ${name}`])),
    })
  }
  const contains = (file: string, body = '') => (): void => {
    files[file] = body
  }
  const is = (command: string) => (): void => expect(detected()).toBe(command)
  const nothing = (): void => expect(detected()).toBeUndefined()

  Rule('a JavaScript project is read from its manifest, not from the machine', ({
    RuleScenario,
  }) => {
    RuleScenario('A declared test script is the check', ({ Given, Then }) => {
      Given('a "package.json" declaring the scripts "build, test"', manifestWith('build', 'test'))
      Then('the check command is "npm test"', is('npm test'))
    })

    RuleScenario('"check" is preferred to "test" where both exist', ({ Given, Then }) => {
      Given('a "package.json" declaring the scripts "test, check"', manifestWith('test', 'check'))
      Then('the check command is "check"\'s, run by the package manager', is('npm check'))
    })

    RuleScenario('A manifest with no script to run says nothing', ({ Given, Then }) => {
      Given('a "package.json" declaring the scripts "build, start"', manifestWith('build', 'start'))
      Then('there is no check command', nothing)
    })

    RuleScenario('A manifest with no scripts at all says nothing', ({ Given, Then }) => {
      Given('a "package.json" with no scripts', contains('package.json', '{"name":"probe"}'))
      Then('there is no check command', nothing)
    })

    RuleScenario('A manifest that will not parse says nothing', ({ Given, Then }) => {
      Given('a "package.json" that is not valid JSON', contains('package.json', '{ oh dear'))
      Then('there is no check command', nothing)
    })
  })

  Rule('the lockfile decides the package manager', ({ RuleScenarioOutline, RuleScenario }) => {
    RuleScenarioOutline('The lockfile names the runner', ({ Given, And, Then }, variables) => {
      Given('a "package.json" declaring the scripts "test"', manifestWith('test'))
      And('the repository also contains "<lockfile>"', () => {
        files[String(variables.lockfile)] = ''
      })
      Then('the check command is "<command>"', () => {
        expect(detected()).toBe(String(variables.command))
      })
    })

    RuleScenario('No lockfile falls back to the one that is always there', ({ Given, Then }) => {
      Given('a "package.json" declaring the scripts "test"', manifestWith('test'))
      Then('the check command is "npm test"', is('npm test'))
    })
  })

  Rule('other ecosystems answer for themselves', ({ RuleScenario }) => {
    RuleScenario('A Cargo manifest means cargo', ({ Given, Then }) => {
      Given('the repository contains "Cargo.toml"', contains('Cargo.toml', '[package]\n'))
      Then('the check command is "cargo test"', is('cargo test'))
    })

    RuleScenario('A Go module means go', ({ Given, Then }) => {
      Given('the repository contains "go.mod"', contains('go.mod', 'module probe\n'))
      Then('the check command is "go test ./..."', is('go test ./...'))
    })

    RuleScenario('A Makefile with a test target means make', ({ Given, Then }) => {
      Given(
        'a "Makefile" with a "test" target',
        contains('Makefile', '.PHONY: test\ntest:\n\techo hello\n'),
      )
      Then('the check command is "make test"', is('make test'))
    })

    RuleScenario('A Makefile without one says nothing', ({ Given, Then }) => {
      Given(
        'a "Makefile" with no "test" target',
        contains('Makefile', 'test = probe\nbuild:\n\techo hello\n'),
      )
      Then('there is no check command', nothing)
    })

    RuleScenario('A JavaScript project with a Makefile is still a JavaScript project', ({
      Given,
      And,
      Then,
    }) => {
      Given('a "package.json" declaring the scripts "test"', manifestWith('test'))
      And('a "Makefile" with a "test" target', contains('Makefile', 'test:\n\techo hello\n'))
      Then('the check command is "npm test"', is('npm test'))
    })

    RuleScenario('An empty repository says nothing', ({ Given, Then }) => {
      Given('a repository with none of those files', () => {
        files = { 'README.md': '# probe' }
      })
      Then('there is no check command', nothing)
    })
  })
})

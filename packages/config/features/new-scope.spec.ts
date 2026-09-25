import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Sandbox } from './support.js'
import { SCOPE_DIR } from '../src/scopes.js'
import { createScope } from '../src/init.js'

const feature = await loadFeature(fileURLToPath(new URL('./new-scope.feature', import.meta.url)))

describeFeature(feature, ({ Scenario, BeforeEachScenario, AfterEachScenario }) => {
  let box: Sandbox
  let repository = ''
  let outcome: ReturnType<typeof createScope>

  BeforeEachScenario(() => {
    box = new Sandbox()
    repository = box.dir('work')
  })
  AfterEachScenario(() => box.cleanup())

  /** Where the file lands: beside `.factory`, inside the family directory. */
  const ignoreFile = () => join(repository, '.xaedalon', '.gitignore')
  const ignoreText = () => readFileSync(ignoreFile(), 'utf8')
  const configText = () => readFileSync(join(repository, SCOPE_DIR, 'config.yaml'), 'utf8')
  const createProjectScope = () => {
    outcome = createScope({ root: join(repository, SCOPE_DIR), kind: 'project' })
  }

  Scenario('A new project scope hides itself from git', ({ Given, When, Then, And }) => {
    Given('a repository with no Factory directory', () => {
      expect(existsSync(join(repository, '.xaedalon'))).toBe(false)
    })
    When('a project scope is created in it', createProjectScope)
    Then('the scope has an ignore file', () => expect(existsSync(ignoreFile())).toBe(true))
    // `*`, on a line of its own. Everything below the family directory, which
    // is the whole point: `git status` after this is what it was before.
    And('it ignores everything in the directory', () =>
      expect(ignoreText().split('\n')).toContain('*'),
    )
    // The same line does it, which is what makes deleting the file the whole
    // opt-in — and is the opposite of the recipe everywhere else.
    And('it ignores itself', () => {
      expect(ignoreText()).not.toContain('!.gitignore')
    })
  })

  Scenario('The file says how to share the directory', ({ Given, When, Then, And }) => {
    Given('a repository with no Factory directory', () => undefined)
    When('a project scope is created in it', createProjectScope)
    // Named literally, not iterated out of the constant that produces them:
    // an assertion that loops over the list under test passes whatever that
    // list happens to say, which is how two of the three went missing once.
    Then('the ignore file names the three directories a run writes into', () => {
      expect(ignoreText()).toContain('.factory/tasks/')
      expect(ignoreText()).toContain('.factory/state/')
      expect(ignoreText()).toContain('.factory/.trash/')
    })
    And('it says that deleting it does the same thing', () =>
      expect(ignoreText()).toContain('Deleting this file'),
    )
  })

  Scenario('The config file points at the ignore file rather than repeating it', ({
    Given,
    When,
    Then,
    And,
  }) => {
    Given('a repository with no Factory directory', () => undefined)
    When('a project scope is created in it', createProjectScope)
    Then('the config says the directory is hidden from git', () =>
      expect(configText()).toContain('hides this whole directory from git'),
    )
    And('the config does not tell anybody to commit it', () =>
      expect(configText()).not.toContain('Commit this directory'),
    )
  })

  Scenario('A user scope gets no ignore file', ({ When, Then }) => {
    When('a user scope is created', () => {
      outcome = createScope({ root: join(box.home, '.xaedalon', '.factory'), kind: 'user' })
    })
    Then('there is no ignore file', () =>
      expect(existsSync(join(box.home, '.xaedalon', '.gitignore'))).toBe(false),
    )
  })

  Scenario('A directory that is already a scope is left alone', ({ Given, When, Then, And }) => {
    Given('a repository whose Factory scope is already there', () => {
      box.file(join('work', SCOPE_DIR, 'config.yaml'), 'kind: factory.scope/v1\nscope: project\n')
    })
    When('a project scope is created in it', createProjectScope)
    Then('nothing was created', () => expect(outcome.created).toBe(false))
    // The case this guard is for: a scope already there may already be
    // committed, and an ignore file beside it would hide that team's next
    // workflow while leaving the ones already committed in plain sight.
    And('there is no ignore file', () => expect(existsSync(ignoreFile())).toBe(false))
  })

  Scenario('An ignore file somebody has already written is never replaced', ({
    Given,
    And,
    When,
    Then,
  }) => {
    Given('a repository with no Factory directory', () => undefined)
    And('an ignore file somebody wrote by hand', () => {
      box.dir('work', '.xaedalon')
      writeFileSync(ignoreFile(), '# mine\n.factory/tasks/\n')
    })
    When('a project scope is created in it', createProjectScope)
    Then('the ignore file still says what they wrote', () =>
      expect(ignoreText()).toBe('# mine\n.factory/tasks/\n'),
    )
  })
})

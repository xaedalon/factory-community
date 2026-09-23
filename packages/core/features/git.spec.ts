import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { systemGitQuery, type GitAnswer, type GitQuery } from '../src/git.js'

const feature = await loadFeature(fileURLToPath(new URL('./git.feature', import.meta.url)))

describeFeature(feature, ({ Scenario, BeforeEachScenario, AfterEachScenario }) => {
  let root = ''
  let where = ''
  let ask: GitQuery
  let answer: GitAnswer | undefined

  BeforeEachScenario(() => {
    root = mkdtempSync(join(tmpdir(), 'factory-git-'))
    // The real PATH, because this scenario is about the real git. `HOME` and
    // the config overrides keep it from reading whoever is running the suite.
    ask = systemGitQuery({
      PATH: process.env.PATH,
      HOME: root,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    })
    answer = undefined
  })
  AfterEachScenario(() => rmSync(root, { recursive: true, force: true }))

  const repository = (at: string): string => {
    mkdirSync(at, { recursive: true })
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: at,
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
      })
    git('init', '--initial-branch=main')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Factory Test')
    writeFileSync(join(at, 'kept.txt'), 'committed\n')
    git('add', '.')
    git('commit', '-m', 'first')
    return at
  }
  const givenRepository = () => {
    where = repository(join(root, 'repo'))
  }
  const asksWhatIsTracked = () => {
    answer = ask(where, ['ls-files', '-z'])
  }

  Scenario('A question with an answer', ({ Given, When, Then, And }) => {
    Given('a repository with a committed file', givenRepository)
    When('git is asked which files it tracks', asksWhatIsTracked)
    Then('the answer is yes', () => expect(answer?.code).toBe(0))
    And('it names the committed file', () =>
      expect(answer?.stdout.split('\0')).toContain('kept.txt'),
    )
  })

  Scenario('A question whose answer is no', ({ Given, When, Then }) => {
    Given('a repository with a committed file', givenRepository)
    When('git is asked whether that file is ignored', () => {
      answer = ask(where, ['check-ignore', '--stdin', '-z', '-v'], 'kept.txt\0')
    })
    Then('the answer is no', () => expect(answer?.code).toBe(1))
  })

  Scenario('A directory that is not a repository', ({ Given, When, Then }) => {
    Given('a directory that is not a repository', () => {
      where = join(root, 'plain')
      mkdirSync(where, { recursive: true })
    })
    When('git is asked which files it tracks', asksWhatIsTracked)
    Then('there is no answer', () => expect(answer).toBeUndefined())
  })

  Scenario('No git on this machine', ({ Given, When, Then }) => {
    Given('a machine with no git', () => {
      givenRepository()
      ask = systemGitQuery({ PATH: join(root, 'nothing-here') })
    })
    When('git is asked which files it tracks', asksWhatIsTracked)
    Then('there is no answer', () => expect(answer).toBeUndefined())
  })

  Scenario('The environment a question is asked in', ({ Given, And, When, Then }) => {
    Given('a repository with a committed file', givenRepository)
    And('the environment points git at another repository', () => {
      const other = repository(join(root, 'other'))
      writeFileSync(join(other, 'theirs.txt'), 'not ours\n')
      execFileSync('git', ['add', '.'], {
        cwd: other,
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
      })
      execFileSync('git', ['commit', '-m', 'theirs'], {
        cwd: other,
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
      })
      ask = systemGitQuery({
        PATH: process.env.PATH,
        HOME: root,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_DIR: join(other, '.git'),
        GIT_WORK_TREE: other,
      })
    })
    When('git is asked which files it tracks', asksWhatIsTracked)
    Then('it answers about the repository it was pointed at by the caller', () => {
      const tracked = answer?.stdout.split('\0') ?? []
      expect(tracked).toContain('kept.txt')
      expect(tracked).not.toContain('theirs.txt')
    })
  })
})

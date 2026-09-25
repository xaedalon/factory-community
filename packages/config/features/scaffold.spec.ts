import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EventBus } from '@factory/events'
import { CapabilityHost, builtinStepsPlugin } from '@factory/core'
import { Sandbox } from './support.js'
import { resolveScopes, type ScopeChain } from '../src/scopes.js'
import { resolveWorkflow } from '../src/store.js'
import { scaffoldProjectDefinitions, type ScaffoldResult } from '../src/scaffold.js'

const feature = await loadFeature(fileURLToPath(new URL('./scaffold.feature', import.meta.url)))

describeFeature(feature, ({ Background, Scenario, AfterEachScenario }) => {
  let box: Sandbox
  let host: CapabilityHost
  let chain: ScopeChain
  let result: ScaffoldResult
  let projectRoot = ''

  AfterEachScenario(() => box.cleanup())

  // Built in Background, not BeforeEachScenario: the runner executes Background
  // steps first, so anything created there would not exist yet.
  Background(({ Given }) => {
    Given('a project scope and a user scope', async () => {
      box = new Sandbox()
      host = new CapabilityHost({ events: new EventBus({ onSubscriberError: () => {} }) })
      await host.load(builtinStepsPlugin)
      box.scope('home', 'user')
      projectRoot = box.scope('work')
      // The built-in scope is left in the chain deliberately: what is being
      // copied *from* is the real shipped definitions, not a fixture.
      chain = resolveScopes({
        cwd: box.dir('work', 'src'),
        env: { FACTORY_HOME: box.scope('home', 'user') },
      })
    })
  })

  const scaffold = async (setting: 'worktrees' | 'environments'): Promise<void> => {
    result = await scaffoldProjectDefinitions({ chain, host, setting })
  }
  const written = (name: string) => result.written.some((file) => file.includes(name))
  const projectFile = (kind: 'workflows' | 'phases', name: string) =>
    join(projectRoot, kind, `${name}.${kind === 'workflows' ? 'workflow' : 'phase'}.yaml`)

  Scenario('Turning worktrees on copies the worktree workflows in', ({ When, Then, And }) => {
    When('the worktree definitions are scaffolded', () => scaffold('worktrees'))
    Then('"worktree-create" is written into the project', () =>
      expect(written('worktree-create')).toBe(true),
    )
    And('"worktree-delete" is written into the project', () =>
      expect(written('worktree-delete')).toBe(true),
    )
  })

  Scenario('The phases they need come with them', ({ When, Then, And }) => {
    // A project copy of the workflow still pointing at the built-in phase is
    // only half overridden, and the half left behind is the half that knows
    // where the directory goes.
    When('the worktree definitions are scaffolded', () => scaffold('worktrees'))
    Then('the phase "worktree-add" is written into the project', () =>
      expect(existsSync(projectFile('phases', 'worktree-add'))).toBe(true),
    )
    And('the phase "worktree-remove" is written into the project', () =>
      expect(existsSync(projectFile('phases', 'worktree-remove'))).toBe(true),
    )
  })

  Scenario('The copy resolves from the project afterwards', ({ When, Then }) => {
    When('the worktree definitions are scaffolded', () => scaffold('worktrees'))
    Then('"worktree-create" resolves from the "project" scope', () => {
      const fresh = resolveScopes({
        cwd: box.dir('work', 'src'),
        env: { FACTORY_HOME: box.scope('home', 'user') },
      })
      expect(resolveWorkflow(fresh, 'worktree-create')?.ref.scope).toBe('project')
    })
  })

  Scenario('Scaffolding twice changes nothing the second time', ({ Given, When, Then, And }) => {
    Given('the worktree definitions have been scaffolded', () => scaffold('worktrees'))
    When('the worktree definitions are scaffolded', () => {
      chain = resolveScopes({
        cwd: box.dir('work', 'src'),
        env: { FACTORY_HOME: box.scope('home', 'user') },
      })
      scaffold('worktrees')
    })
    Then('nothing new is written', () => expect(result.written).toEqual([]))
    And('"worktree-create" is reported as already there', () =>
      expect(result.kept).toContain('worktree-create'),
    )
  })

  Scenario('A copy someone has edited is never overwritten', ({ Given, When, Then, And }) => {
    Given('the project defines its own "worktree-create"', () => {
      box.workflow(
        projectRoot,
        'worktree-create',
        'name: worktree-create\ndescription: ours\nphases: []\n',
      )
      chain = resolveScopes({
        cwd: box.dir('work', 'src'),
        env: { FACTORY_HOME: box.scope('home', 'user') },
      })
    })
    When('the worktree definitions are scaffolded', () => scaffold('worktrees'))
    Then('"worktree-create" is reported as already there', () =>
      expect(result.kept).toContain('worktree-create'),
    )
    // The whole point of the override is that someone edited it. Replacing
    // their file with the built-in would undo exactly the work being asked for.
    And('the project\'s own "worktree-create" is untouched', () =>
      expect(readFileSync(projectFile('workflows', 'worktree-create'), 'utf8')).toContain(
        'description: ours',
      ),
    )
  })

  Scenario('Environments bring their own three', ({ When, Then, And }) => {
    When('the environment definitions are scaffolded', () => scaffold('environments'))
    Then('"environment-create" is written into the project', () =>
      expect(written('environment-create')).toBe(true),
    )
    And('"environment-update" is written into the project', () =>
      expect(written('environment-update')).toBe(true),
    )
    And('"environment-delete" is written into the project', () =>
      expect(written('environment-delete')).toBe(true),
    )
  })
})

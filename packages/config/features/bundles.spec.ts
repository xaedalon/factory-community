import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stringify as stringifyYaml } from 'yaml'
import { EventBus } from '@factory/events'
import { CapabilityHost, builtinStepsPlugin, examplesRoot, type Bundle } from '@factory/core'
import { Sandbox } from './support.js'
import { resolveScopes, type ScopeChain } from '../src/scopes.js'
import {
  exportWorkflow,
  importBundle,
  readBundle,
  readBundleFile,
  type ApplyResult,
  type ExportOutcome,
  type ReadBundleResult,
} from '../src/bundle.js'

const feature = await loadFeature(fileURLToPath(new URL('./bundles.feature', import.meta.url)))

describeFeature(feature, ({ Background, Scenario, AfterEachScenario }) => {
  let box: Sandbox
  let host: CapabilityHost
  let chain: ScopeChain
  let projectScope = ''
  let userScope = ''
  let exported: ExportOutcome
  let applied: ApplyResult
  let read: ReadBundleResult

  AfterEachScenario(() => box.cleanup())

  // Built inside Background, never BeforeEachScenario: the runner executes
  // Background steps first, so anything created there would not exist yet.
  Background(({ Given, And }) => {
    Given('a project scope and a user scope', async () => {
      box = new Sandbox()
      host = new CapabilityHost({ events: new EventBus({ onSubscriberError: () => {} }) })
      await host.load(builtinStepsPlugin)
      projectScope = box.scope('work', 'project')
      userScope = box.scope('home', 'user')
      chain = resolveScopes({
        cwd: box.dir('work', 'src'),
        env: { FACTORY_HOME: userScope },
      })
    })
    And('the project defines "development" with phases "analysis, implement"', () => {
      box.workflow(projectScope, 'development', 'name: development\nphases: [analysis, implement]\n')
      box.phase(projectScope, 'analysis', 'name: analysis\nsteps: [{run: echo analysis}]\n')
      box.phase(projectScope, 'implement', 'name: implement\nsteps: [{run: echo implement}]\n')
    })
  })

  const doExport = (allowMissing = false) => {
    exported = exportWorkflow({ chain, host, name: 'development', allowMissing })
  }
  const doImport = (options: Parameters<typeof importBundle>[0] extends never ? never : {
    scope?: 'project' | 'user'
    policy?: 'fail' | 'skip' | 'overwrite'
    prefix?: string
    dryRun?: boolean
  }) => {
    applied = importBundle({
      chain,
      host,
      bundle: exported.bundle as Bundle,
      ...options,
    })
  }
  const names = (list: readonly { name: string }[]) => list.map((entry) => entry.name).sort().join(', ')
  const userFile = (kind: 'workflows' | 'phases', name: string) =>
    join(userScope, kind, `${name}.${kind === 'workflows' ? 'workflow' : 'phase'}.yaml`)
  const anyMessage = (needle: string) =>
    [...(exported?.problems ?? []), ...(read?.problems ?? []), ...(applied?.problems ?? [])].some(
      (p) => p.message.toLowerCase().includes(needle.toLowerCase()),
    )

  const givenOnFail = () => {
    box.workflow(
      projectScope,
      'development',
      'name: development\non_fail: development-failure\nphases: [analysis, implement]\n',
    )
    box.workflow(projectScope, 'development-failure', 'name: development-failure\nphases: [diagnose]\n')
    box.phase(projectScope, 'diagnose', 'name: diagnose\nsteps: [{run: echo diagnose}]\n')
  }
  const givenNeeds = () => {
    box.workflow(
      projectScope,
      'development',
      'name: development\nneeds: [analysis-first]\nphases: [analysis, implement]\n',
    )
    box.workflow(projectScope, 'analysis-first', 'name: analysis-first\nphases: [analysis]\n')
  }
  const givenUserHasDevelopment = () => {
    box.workflow(userScope, 'development', 'name: development\ndescription: mine\nphases: []\n')
  }

  Scenario('Export analysiss the workflow and its phases', ({ When, Then, And }) => {
    When('I export "development"', () => doExport())
    Then('the export succeeds', () => expect(exported.bundle).toBeDefined())
    And('the bundle entry is "development"', () =>
      expect(exported.bundle?.entry.workflow).toBe('development'),
    )
    And('the bundle contains the workflows "development"', () =>
      expect(names(exported.bundle?.workflows ?? [])).toBe('development'),
    )
    And('the bundle contains the phases "analysis, implement"', () =>
      expect(names(exported.bundle?.phases ?? [])).toBe('analysis, implement'),
    )
  })

  Scenario('Export follows the on_fail chain', ({ Given, When, Then, And }) => {
    Given('"development" fails over to "development-failure" with phase "diagnose"', givenOnFail)
    When('I export "development"', () => doExport())
    Then('the export succeeds', () => expect(exported.bundle).toBeDefined())
    And('the bundle contains the workflows "development, development-failure"', () =>
      expect(names(exported.bundle?.workflows ?? [])).toBe('development, development-failure'),
    )
    And('the bundle contains the phases "analysis, implement, diagnose"', () =>
      expect(names(exported.bundle?.phases ?? [])).toBe('analysis, diagnose, implement'),
    )
  })

  Scenario('Export follows what the workflow needs', ({ Given, When, Then, And }) => {
    Given('"development" needs "analysis-first"', givenNeeds)
    When('I export "development"', () => doExport())
    Then('the export succeeds', () => expect(exported.bundle).toBeDefined())
    And('the bundle contains the workflows "development, analysis-first"', () =>
      expect(names(exported.bundle?.workflows ?? [])).toBe('analysis-first, development'),
    )
  })

  Scenario('A cycle in what workflows need terminates', ({ Given, And, When, Then }) => {
    Given('"development" needs "analysis-first"', givenNeeds)
    And('"analysis-first" needs "development"', () => {
      box.workflow(
        projectScope,
        'analysis-first',
        'name: analysis-first\nneeds: [development]\nphases: [analysis]\n',
      )
    })
    When('I export "development"', () => doExport())
    Then('the export succeeds', () => expect(exported.bundle).toBeDefined())
    And('the bundle contains 2 workflows', () =>
      expect(exported.bundle?.workflows ?? []).toHaveLength(2),
    )
  })

  Scenario('A cycle in the on_fail chain terminates', ({ Given, And, When, Then }) => {
    Given('"development" fails over to "development-failure" with phase "diagnose"', givenOnFail)
    And('"development-failure" fails back to "development"', () => {
      box.workflow(
        projectScope,
        'development-failure',
        'name: development-failure\non_fail: development\nphases: [diagnose]\n',
      )
    })
    When('I export "development"', () => doExport())
    Then('the export succeeds', () => expect(exported.bundle).toBeDefined())
    And('the bundle contains 2 workflows', () => expect(exported.bundle?.workflows).toHaveLength(2))
  })

  Scenario('Export refuses to produce an incomplete bundle', ({ Given, When, Then, And }) => {
    Given('the phase "implement" is deleted', () =>
      rmSync(join(projectScope, 'phases', 'implement.phase.yaml')),
    )
    When('I export "development"', () => doExport())
    Then('the export fails', () => expect(exported.bundle).toBeUndefined())
    And('a problem names the missing phase "implement"', () =>
      expect(anyMessage('"implement" that does not exist')).toBe(true),
    )
  })

  Scenario('Export can be told to accept the gap', ({ Given, When, Then, And }) => {
    Given('the phase "implement" is deleted', () =>
      rmSync(join(projectScope, 'phases', 'implement.phase.yaml')),
    )
    When('I export "development" allowing missing definitions', () => doExport(true))
    Then('the export succeeds', () => expect(exported.bundle).toBeDefined())
    And('the bundle records "implement" as unresolved', () =>
      expect(exported.bundle?.metadata.unresolved).toContain('implement'),
    )
  })

  Scenario('A bundle round-trips through export and import', ({ When, And, Then }) => {
    When('I export "development"', () => doExport())
    And('I import the bundle into the user scope', () => doImport({ scope: 'user' }))
    Then('the import succeeds', () => expect(applied.problems).toEqual([]))
    And('the user scope has the workflow "development"', () =>
      expect(existsSync(userFile('workflows', 'development'))).toBe(true),
    )
    And('the user scope has the phase "analysis"', () =>
      expect(existsSync(userFile('phases', 'analysis'))).toBe(true),
    )
    And('the imported workflow still lists the phase "analysis"', () =>
      expect(readFileSync(userFile('workflows', 'development'), 'utf8')).toContain('analysis'),
    )
  })

  Scenario('Import is previewed without writing anything', ({ When, And, Then }) => {
    When('I export "development"', () => doExport())
    And('I preview importing the bundle into the user scope', () =>
      doImport({ scope: 'user', dryRun: true }),
    )
    Then('the import succeeds', () => expect(applied.problems).toEqual([]))
    And('every item would be created', () =>
      expect(applied.plan.items.every((item) => item.action === 'create')).toBe(true),
    )
    And('the user scope has no workflow "development"', () =>
      expect(existsSync(userFile('workflows', 'development'))).toBe(false),
    )
  })

  Scenario('Import fails atomically when a name is taken', ({ Given, When, And, Then }) => {
    Given('the user scope already defines "development"', givenUserHasDevelopment)
    When('I export "development"', () => doExport())
    And('I import the bundle into the user scope', () => doImport({ scope: 'user' }))
    Then('the import fails', () => expect(applied.problems.length).toBeGreaterThan(0))
    And('the plan marks "development" as a conflict', () =>
      expect(applied.plan.items.find((i) => i.targetName === 'development')?.action).toBe('conflict'),
    )
    And('nothing was written', () => {
      expect(applied.written).toHaveLength(0)
      expect(existsSync(userFile('phases', 'analysis'))).toBe(false)
    })
  })

  Scenario('Skipping leaves what is already there', ({ Given, When, And, Then }) => {
    Given('the user scope already defines "development"', givenUserHasDevelopment)
    When('I export "development"', () => doExport())
    And('I import the bundle into the user scope skipping conflicts', () =>
      doImport({ scope: 'user', policy: 'skip' }),
    )
    Then('the import succeeds', () => expect(applied.problems).toEqual([]))
    And('"development" was skipped', () => {
      expect(applied.plan.items.find((i) => i.targetName === 'development')?.action).toBe('skip')
      expect(readFileSync(userFile('workflows', 'development'), 'utf8')).toContain('mine')
    })
    And('"analysis" was created', () =>
      expect(existsSync(userFile('phases', 'analysis'))).toBe(true),
    )
  })

  Scenario('Overwriting keeps the previous version', ({ Given, When, And, Then }) => {
    Given('the user scope already defines "development"', givenUserHasDevelopment)
    When('I export "development"', () => doExport())
    And('I import the bundle into the user scope overwriting conflicts', () =>
      doImport({ scope: 'user', policy: 'overwrite' }),
    )
    Then('the import succeeds', () => expect(applied.problems).toEqual([]))
    And('the previous version was moved out of the way', () => {
      const trash = join(userScope, '.trash')
      expect(existsSync(trash)).toBe(true)
      const stamps = readdirSync(trash)
      const kept = join(trash, stamps[0] as string, 'workflows', 'development.yaml')
      expect(readFileSync(kept, 'utf8')).toContain('mine')
    })
  })

  Scenario('A prefix renames everything and rewrites internal references', ({ Given, When, And, Then }) => {
    Given('"development" fails over to "development-failure" with phase "diagnose"', givenOnFail)
    When('I export "development"', () => doExport())
    And('I import the bundle into the user scope with the prefix "acme-"', () =>
      doImport({ scope: 'user', prefix: 'acme-' }),
    )
    Then('the import succeeds', () => expect(applied.problems).toEqual([]))
    And('the user scope has the workflow "acme-development"', () =>
      expect(existsSync(userFile('workflows', 'acme-development'))).toBe(true),
    )
    And('"acme-development" lists the phases "acme-analysis, acme-implement"', () => {
      const text = readFileSync(userFile('workflows', 'acme-development'), 'utf8')
      expect(text).toContain('acme-analysis')
      expect(text).toContain('acme-implement')
    })
    And('"acme-development" fails over to "acme-development-failure"', () =>
      expect(readFileSync(userFile('workflows', 'acme-development'), 'utf8')).toContain(
        'on_fail: acme-development-failure',
      ),
    )
  })

  Scenario('Importing where it would hide a lower scope says so', ({ Given, And, When, Then }) => {
    // Shadowing is not conflicting: the target scope has no copy, but a scope
    // below it does, so writing here quietly changes which one wins. Silent
    // unless it is said, which is the whole reason this field exists.
    Given('the user scope already defines "development"', () => {
      box.workflow(userScope, 'development', 'name: development\nphases: [analysis]\n')
      box.phase(userScope, 'analysis', 'name: analysis\nsteps: [{run: echo analysis}]\n')
    })
    And("the project's own copy is removed", () => {
      rmSync(join(projectScope, 'workflows', 'development.workflow.yaml'))
      rmSync(join(projectScope, 'phases', 'analysis.phase.yaml'))
      rmSync(join(projectScope, 'phases', 'implement.phase.yaml'))
    })
    When('I export the bundle from the user scope', () => doExport())
    And('I preview importing the bundle into the project scope', () =>
      doImport({ scope: 'project', dryRun: true }),
    )
    Then('the import succeeds', () => expect(applied.problems).toEqual([]))
    And('the plan says "development" would hide the user copy', () =>
      expect(applied.plan.items.find((i) => i.targetName === 'development')?.shadows).toBe('user'),
    )
  })

  Scenario('A document that is not a bundle is rejected clearly', ({ When, Then, And }) => {
    When('I read a document whose kind is "factory.workflow/v1"', () => {
      read = readBundle(stringifyYaml({ kind: 'factory.workflow/v1', name: 'development' }), host)
    })
    Then('reading fails', () => expect(read.bundle).toBeUndefined())
    And('a problem says it is not a bundle', () =>
      expect(anyMessage('not a Factory bundle')).toBe(true),
    )
  })

  Scenario('A bundle carrying an invalid definition is rejected', ({ When, Then, And }) => {
    When('I read a bundle whose workflow has an invalid mode', () => {
      read = readBundle(
        stringifyYaml({
          kind: 'factory.bundle/v1',
          entry: { workflow: 'development' },
          workflows: [{ name: 'development', mode: 'banana', phases: [] }],
          phases: [],
        }),
        host,
      )
    })
    Then('reading fails', () => expect(read.bundle).toBeUndefined())
    And('a problem names the field', () =>
      expect(read.problems.some((p) => p.field?.includes('mode'))).toBe(true),
    )
  })

  /**
   * The example Factory ships is a file like any other, and it rots like any
   * other unless something loads it. This is that something: it parses, its
   * definitions validate against the real schemas, and it imports.
   */
  Scenario('The example bundle Factory ships imports cleanly', ({ Given, When, Then, And }) => {
    Given('the development example that ships with Factory', () => {
      read = readBundleFile(join(examplesRoot(), 'development.bundle.yaml'), host)
      expect(read.problems).toEqual([])
    })
    // The user scope, because the Background's project already defines a
    // `development` of its own — and a clash is what the import is supposed to
    // refuse, which is a different scenario.
    When('I import it into the user scope', () => {
      applied = importBundle({ chain, host, bundle: read.bundle as Bundle, scope: 'user' })
    })
    Then('the import succeeds', () => expect(applied.problems).toEqual([]))
    And('the user scope has the workflow "development"', () =>
      expect(existsSync(userFile('workflows', 'development'))).toBe(true),
    )
    And('the user scope has the phase "review"', () =>
      expect(existsSync(userFile('phases', 'review'))).toBe(true),
    )
    // A file Factory wrote is a file Factory can load — the same rule the write
    // path enforces, checked here against definitions nobody typed by hand.
    And('nothing it wrote fails to validate', () => {
      const reread = readBundleFile(join(examplesRoot(), 'development.bundle.yaml'), host)
      expect(reread.problems).toEqual([])
    })
  })
})

import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { DISCLAIMER_VERSION, parseWorkflowFile } from '@factory/core'
import type { PluginContext } from '@factory/core'
import { createRuntime } from '@factory/runtime'
import { resolveScopes } from '@factory/config'
import { buildServer } from '../src/server.js'

const feature = await loadFeature(fileURLToPath(new URL('./api.feature', import.meta.url)))

/** Not every response is JSON — the board's own page is HTML. */
const asJson = (body: string): Record<string, unknown> => {
  try {
    return body === '' ? {} : (JSON.parse(body) as Record<string, unknown>)
  } catch {
    return {}
  }
}

interface Response {
  statusCode: number
  body: Record<string, unknown>
}

describeFeature(feature, ({ Background, Rule, Scenario, AfterEachScenario }) => {
  let root = ''
  let projectScope = ''
  let userScope = ''
  let app: FastifyInstance
  let response: Response
  let fetched: Record<string, unknown> = {}
  let bundleText = ''
  let runtimeForRebuild: Awaited<ReturnType<typeof createRuntime>> | undefined
  let host: Awaited<ReturnType<typeof createRuntime>>['host']
  let rawResponse = ''

  AfterEachScenario(async () => {
    await app?.close()
    rmSync(root, { recursive: true, force: true })
  })

  const file = (path: string, contents: string) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, contents)
  }
  const workflowFile = (scope: string, name: string) =>
    join(scope, 'workflows', `${name}.workflow.yaml`)
  const phaseFile = (scope: string, name: string) => join(scope, 'phases', `${name}.phase.yaml`)

  const call = async (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
  ) => {
    const raw = await app.inject({
      method,
      url,
      ...(payload === undefined ? {} : { payload: payload as object }),
    })
    rawResponse = raw.body
    response = { statusCode: raw.statusCode, body: asJson(raw.body) }
  }

  // Everything is built here, not in BeforeEachScenario: the runner executes
  // Background steps first, so a fixture created there would not exist yet.
  Background(({ Given }) => {
    Given('a running daemon with a project scope and a user scope', async () => {
      root = mkdtempSync(join(tmpdir(), 'factory-api-'))
      projectScope = join(root, 'work', '.xaedalon', '.factory')
      userScope = join(root, 'home', '.xaedalon', '.factory')
      mkdirSync(join(root, 'work', '.git'), { recursive: true })
      mkdirSync(join(root, 'work', 'src'), { recursive: true })
      file(join(projectScope, 'config.yaml'), 'kind: factory.scope/v1\nscope: project\n')
      file(join(userScope, 'config.yaml'), 'kind: factory.scope/v1\nscope: user\n')

      const env = { FACTORY_HOME: userScope, PATH: '' }
      const chain = resolveScopes({ cwd: join(root, 'work', 'src'), env })
      const runtime = await createRuntime({ cwd: join(root, 'work'), env, chain })
      // Rebuilt by the "a built board" step when a scenario needs one: the
      // web root is fixed when the server is built.
      runtimeForRebuild = runtime
      // Kept so a scenario can load a plugin into the host afterwards: hooks
      // are read when a write happens, not when the server is built.
      host = runtime.host
      app = buildServer(runtime)
      await app.ready()
    })
  })

  const givenProjectWorkflow = () => {
    file(workflowFile(projectScope, 'development'), 'name: development\nphases: [analysis]\n')
    file(phaseFile(projectScope, 'analysis'), 'name: analysis\nsteps: [{run: echo hi}]\n')
  }
  const givenUserWorkflow = () =>
    file(workflowFile(userScope, 'development'), 'name: development\ndescription: mine\nphases: []\n')

  Scenario('Listing shows what is available and what it shadows', ({ Given, And, When, Then }) => {
    Given('the project defines the workflow "development"', givenProjectWorkflow)
    And('the user also defines the workflow "development"', givenUserWorkflow)
    When('I GET "/api/workflows"', () => call('GET', '/api/workflows'))
    Then('the response is 200', () => expect(response.statusCode).toBe(200))
    And('"development" is listed once', () => {
      const items = response.body.items as { name: string }[]
      expect(items.filter((item) => item.name === 'development')).toHaveLength(1)
    })
    And('"development" resolves from the project scope', () => {
      const items = response.body.items as { name: string; winner: { scope: string } }[]
      expect(items.find((item) => item.name === 'development')?.winner.scope).toBe('project')
    })
  })

  Scenario("Fetching one returns the definition, its bytes and an etag", ({ Given, When, Then, And }) => {
    Given('the project defines the workflow "development"', givenProjectWorkflow)
    When('I GET "/api/workflows/development"', () => call('GET', '/api/workflows/development'))
    Then('the response is 200', () => expect(response.statusCode).toBe(200))
    And('the body has a definition named "development"', () =>
      expect((response.body.definition as { name: string }).name).toBe('development'),
    )
    And("the body has the file's raw text", () =>
      expect(response.body.raw).toContain('name: development'),
    )
    And('the body has an etag', () => expect(response.body.etag).toBeTruthy())
  })

  Scenario('Fetching one that does not exist is a 404', ({ When, Then }) => {
    When('I GET "/api/workflows/nowhere"', () => call('GET', '/api/workflows/nowhere'))
    Then('the response is 404', () => expect(response.statusCode).toBe(404))
  })

  Scenario('Asking why lists every path that was tried', ({ Given, When, Then, And }) => {
    Given('the project defines the workflow "development"', givenProjectWorkflow)
    When('I GET "/api/workflows/development/why"', () =>
      call('GET', '/api/workflows/development/why'),
    )
    Then('the response is 200', () => expect(response.statusCode).toBe(200))
    And('3 candidates are listed', () =>
      expect(response.body.candidates as unknown[]).toHaveLength(3),
    )
  })

  Scenario('Creating writes a new file', ({ When, Then, And }) => {
    When('I POST a workflow named "release"', () =>
      call('POST', '/api/workflows', {
        definition: { name: 'release', mode: 'once', scheduling: 'parallel', description: '', variables: {}, phases: [], extensions: {} },
      }),
    )
    Then('the response is 201', () => expect(response.statusCode).toBe(201))
    And('the workflow "release" now exists', () =>
      expect(existsSync(workflowFile(projectScope, 'release'))).toBe(true),
    )
    And('the response carries an etag', () => expect(response.body.etag).toBeTruthy())
  })

  Scenario('Creating something that already exists is a conflict', ({ Given, When, Then }) => {
    Given('the project defines the workflow "development"', givenProjectWorkflow)
    When('I POST a workflow named "development"', () =>
      call('POST', '/api/workflows', {
        definition: { name: 'development', mode: 'once', scheduling: 'parallel', description: '', variables: {}, phases: [], extensions: {} },
      }),
    )
    Then('the response is 409', () => expect(response.statusCode).toBe(409))
  })

  Scenario('Updating with the etag I read succeeds', ({ Given, And, When, Then }) => {
    Given('the project defines the workflow "development"', givenProjectWorkflow)
    And('I have fetched it', async () => {
      await call('GET', '/api/workflows/development')
      fetched = response.body
    })
    When('I PUT it back with a new description', () =>
      call('PUT', '/api/workflows/development', {
        definition: { ...(fetched.definition as object), description: 'Rewritten.' },
        etag: fetched.etag,
      }),
    )
    Then('the response is 200', () => expect(response.statusCode).toBe(200))
    And('the stored workflow has the new description', () =>
      expect(readFileSync(workflowFile(projectScope, 'development'), 'utf8')).toContain('Rewritten.'),
    )
  })

  Scenario('Updating preserves comments the author wrote', ({ Given, And, When, Then }) => {
    Given('the project defines a commented workflow "development"', () => {
      file(
        workflowFile(projectScope, 'development'),
        '# Our pipeline.\nname: development\ndescription: old\nphases: [analysis]\n',
      )
      file(phaseFile(projectScope, 'analysis'), 'name: analysis\nsteps: [{run: echo hi}]\n')
    })
    And('I have fetched it', async () => {
      await call('GET', '/api/workflows/development')
      fetched = response.body
    })
    When('I PUT it back with a new description', () =>
      call('PUT', '/api/workflows/development', {
        definition: { ...(fetched.definition as object), description: 'Rewritten.' },
        etag: fetched.etag,
      }),
    )
    Then('the response is 200', () => expect(response.statusCode).toBe(200))
    And('the stored file still has its comment', () =>
      expect(readFileSync(workflowFile(projectScope, 'development'), 'utf8')).toContain(
        '# Our pipeline.',
      ),
    )
  })

  Scenario('Updating with a stale etag is refused with the current content', ({ Given, And, When, Then }) => {
    Given('the project defines the workflow "development"', givenProjectWorkflow)
    And('I have fetched it', async () => {
      await call('GET', '/api/workflows/development')
      fetched = response.body
    })
    And('someone else edits the file', () =>
      file(workflowFile(projectScope, 'development'), 'name: development\ndescription: theirs\nphases: []\n'),
    )
    When('I PUT it back with a new description', () =>
      call('PUT', '/api/workflows/development', {
        definition: { ...(fetched.definition as object), description: 'Mine.' },
        etag: fetched.etag,
      }),
    )
    Then('the response is 409', () => expect(response.statusCode).toBe(409))
    And('the response carries the current content', () =>
      expect(response.body.raw).toContain('theirs'),
    )
  })

  Scenario('The body and the URL must agree on the name', ({ Given, When, Then }) => {
    Given('the project defines the workflow "development"', givenProjectWorkflow)
    When('I PUT a workflow named "something-else" to "/api/workflows/development"', () =>
      call('PUT', '/api/workflows/development', {
        definition: { name: 'something-else', mode: 'once', scheduling: 'parallel', description: '', variables: {}, phases: [], extensions: {} },
      }),
    )
    Then('the response is 400', () => expect(response.statusCode).toBe(400))
  })

  Scenario('Deleting says what the name resolves to now', ({ Given, And, When, Then }) => {
    Given('the project defines the workflow "development"', givenProjectWorkflow)
    And('the user also defines the workflow "development"', givenUserWorkflow)
    When('I DELETE "/api/workflows/development"', () =>
      call('DELETE', '/api/workflows/development'),
    )
    Then('the response is 200', () => expect(response.statusCode).toBe(200))
    And('the response says it now resolves from the user scope', () =>
      expect((response.body.nowResolvesFrom as { scope: string }).scope).toBe('user'),
    )
  })

  Scenario('Deleting the last copy says nothing is left', ({ Given, When, Then, And }) => {
    Given('the project defines the workflow "development"', givenProjectWorkflow)
    When('I DELETE "/api/workflows/development"', () =>
      call('DELETE', '/api/workflows/development'),
    )
    Then('the response is 200', () => expect(response.statusCode).toBe(200))
    And('the response says nothing resolves it now', () =>
      expect(response.body.nowResolvesFrom).toBeUndefined(),
    )
  })

  Scenario('Phases have the same routes as workflows', ({ When, Then, And }) => {
    When('I POST a phase named "analysis"', () =>
      call('POST', '/api/phases', {
        definition: {
          name: 'analysis', description: '', approval: 'none', variables: {},
          steps: [{ uses: 'shell', run: 'echo hi' }], extensions: {},
        },
      }),
    )
    Then('the response is 201', () => expect(response.statusCode).toBe(201))
    And('the phase "analysis" now exists', () =>
      expect(existsSync(phaseFile(projectScope, 'analysis'))).toBe(true),
    )
    When('I DELETE "/api/phases/analysis"', () => call('DELETE', '/api/phases/analysis'))
    Then('the response is 200', () => expect(response.statusCode).toBe(200))
  })

  Scenario('Saving into a scope that is not in the chain says so', ({ Given, When, Then, And }) => {
    Given('the project scope has been taken away', async () => {
      // Rebuilt against a directory with no project scope at all, which is
      // what a repository registered before Factory created one looks like.
      rmSync(join(root, 'work', '.xaedalon'), { recursive: true, force: true })
      const env = { FACTORY_HOME: userScope, PATH: '' }
      const chain = resolveScopes({ cwd: join(root, 'work', 'src'), env })
      const runtime = await createRuntime({ cwd: join(root, 'work'), env, chain })
      app = buildServer(runtime)
      await app.ready()
    })
    When('I POST a workflow named "release"', () =>
      call('POST', '/api/workflows', {
        definition: { name: 'release', mode: 'once', scheduling: 'parallel', description: '', variables: {}, phases: [], extensions: {} },
        scope: 'project',
      }),
    )
    Then('the response is 400', () => expect(response.statusCode).toBe(400))
    And('the response names the scope that is missing', () =>
      expect(JSON.stringify(response.body)).toContain('project'),
    )
  })

  Scenario('A definition that does not validate is refused', ({ When, Then, And }) => {
    // The write path re-validates. A client that skipped validation, or a
    // different client entirely, must not be able to put a broken file on disk.
    When('I POST a workflow with an invalid mode', () =>
      call('POST', '/api/workflows', {
        definition: { name: 'broken', mode: 'banana', scheduling: 'parallel', description: '', variables: {}, phases: [], extensions: {} },
      }),
    )
    Then('the response is 400', () => expect(response.statusCode).toBe(400))
    And('the response names the problem field', () =>
      expect(JSON.stringify(response.body)).toContain('mode'),
    )
  })

  Scenario('Previewing renders the canonical form the writer would produce', ({ Given, When, Then, And }) => {
    // Not byte-identical to the file on disk, and it should not be: the file
    // keeps whatever style its author used, while the preview shows the
    // canonical form a *new* file would get. What has to hold is that the
    // preview means the same thing and is stable.
    let previewed = ''
    Given('the project defines the workflow "development"', givenProjectWorkflow)
    When('I preview the workflow that is stored', async () => {
      await call('GET', '/api/workflows/development')
      fetched = response.body
      await call('POST', '/api/definitions/preview', {
        kind: 'workflow',
        definition: fetched.definition,
      })
      previewed = response.body.text as string
    })
    Then('the response is 200', () => expect(response.statusCode).toBe(200))
    And('the preview reads back as the same definition', () => {
      const back = parseWorkflowFile(previewed, 'preview.yaml')
      expect(back.value).toEqual(fetched.definition)
    })
    And('previewing it again gives the same text', async () => {
      await call('POST', '/api/definitions/preview', {
        kind: 'workflow',
        definition: fetched.definition,
      })
      expect(response.body.text).toBe(previewed)
    })
  })

  Scenario('Exporting produces a bundle', ({ Given, When, Then, And }) => {
    Given('the project defines the workflow "development"', givenProjectWorkflow)
    When('I POST "/api/workflows/development/export"', () =>
      call('POST', '/api/workflows/development/export'),
    )
    Then('the response is 200', () => expect(response.statusCode).toBe(200))
    And('the bundle contains the phase "analysis"', () =>
      expect(response.body.text).toContain('name: analysis'),
    )
  })

  Scenario('The bundles Factory ships can be listed', ({ When, Then, And }) => {
    When('I GET "/api/bundles/examples"', () => call('GET', '/api/bundles/examples'))
    Then('the response is 200', () => expect(response.statusCode).toBe(200))
    And('the bundle "reliability" is offered', () => {
      const names = (response.body.items as { name: string }[]).map((item) => item.name)
      expect(names).toContain('reliability')
    })
    And('it says how many workflows it carries', () => {
      const found = (response.body.items as { name: string; workflows: number }[]).find(
        (item) => item.name === 'reliability',
      )
      expect(found?.workflows).toBeGreaterThan(0)
    })
  })

  Scenario('A shipped bundle can be read', ({ When, Then, And }) => {
    When('I GET "/api/bundles/examples/reliability"', () =>
      call('GET', '/api/bundles/examples/reliability'),
    )
    Then('the response is 200', () => expect(response.statusCode).toBe(200))
    And('the text is a bundle carrying the workflow "analysis"', () => {
      expect(response.body.text as string).toContain('name: analysis')
    })
  })

  Scenario('A bundle Factory does not ship is a 404', ({ When, Then }) => {
    When('I GET "/api/bundles/examples/nonesuch"', () =>
      call('GET', '/api/bundles/examples/nonesuch'),
    )
    Then('the response is 404', () => expect(response.statusCode).toBe(404))
  })

  Scenario('A name that is a path is refused rather than resolved', ({ When, Then }) => {
    When('I GET a shipped bundle named "../../../etc/passwd"', () =>
      call('GET', `/api/bundles/examples/${encodeURIComponent('../../../etc/passwd')}`),
    )
    Then('the response is 400', () => expect(response.statusCode).toBe(400))
  })

  Scenario('The shipped bundle goes in through the same door a person\'s file does', ({
    When,
    Then,
    And,
  }) => {
    When('I import the shipped bundle "reliability" into the user scope', async () => {
      await call('GET', '/api/bundles/examples/reliability')
      await call('POST', '/api/bundles/import', {
        text: response.body.text as string,
        scope: 'user',
      })
    })
    Then('the response is 200', () => expect(response.statusCode).toBe(200))
    And('the workflow "analysis" is in the user scope', () => {
      expect(existsSync(workflowFile(userScope, 'analysis'))).toBe(true)
    })
  })

  Scenario('Importing is previewed without writing', ({ Given, And, When, Then }) => {
    Given('the project defines the workflow "development"', givenProjectWorkflow)
    And('I have exported it', async () => {
      await call('POST', '/api/workflows/development/export')
      bundleText = response.body.text as string
    })
    When('I import it into the user scope as a dry run', () =>
      call('POST', '/api/bundles/import?dryRun=true', { text: bundleText, scope: 'user' }),
    )
    Then('the response is 200', () => expect(response.statusCode).toBe(200))
    And('nothing was written', () => {
      expect(response.body.written as unknown[]).toHaveLength(0)
      expect(existsSync(workflowFile(userScope, 'development'))).toBe(false)
    })
  })

  Scenario('Importing a clashing name is a conflict', ({ Given, And, When, Then }) => {
    Given('the project defines the workflow "development"', givenProjectWorkflow)
    And('the user also defines the workflow "development"', givenUserWorkflow)
    And('I have exported it', async () => {
      await call('POST', '/api/workflows/development/export')
      bundleText = response.body.text as string
    })
    When('I import it into the user scope', () =>
      call('POST', '/api/bundles/import', { text: bundleText, scope: 'user' }),
    )
    Then('the response is 409', () => expect(response.statusCode).toBe(409))
  })

  Scenario('The scopes endpoint reports the chain', ({ When, Then, And }) => {
    When('I GET "/api/scopes"', () => call('GET', '/api/scopes'))
    Then('the response is 200', () => expect(response.statusCode).toBe(200))
    And('the chain is "project, user, builtin"', () =>
      expect((response.body.scopes as { kind: string }[]).map((s) => s.kind).join(', ')).toBe(
        'project, user, builtin',
      ),
    )
  })

  Scenario('The step-kind registry tells the builder which editors to offer', ({ When, Then, And }) => {
    When('I GET "/api/registries/step-kinds"', () => call('GET', '/api/registries/step-kinds'))
    Then('the response is 200', () => expect(response.statusCode).toBe(200))
    And('"shell" is listed as runnable', () => {
      const items = response.body.items as { id: string; runnable: boolean }[]
      expect(items.find((item) => item.id === 'shell')?.runnable).toBe(true)
    })
  })

  Scenario('The provider registry fills the agent dropdown', ({ When, Then, And }) => {
    When('I GET "/api/registries/providers"', () => call('GET', '/api/registries/providers'))
    Then('the response is 200', () => expect(response.statusCode).toBe(200))
    And('"claude" is listed', () =>
      expect((response.body.items as { id: string }[]).some((item) => item.id === 'claude')).toBe(true),
    )
  })

  Scenario('Doctor reports findings in the body, not the status', ({ Given, When, Then, And }) => {
    Given('the project defines a workflow naming a missing phase', () =>
      file(workflowFile(projectScope, 'dangling'), 'name: dangling\nphases: [nowhere]\n'),
    )
    When('I GET "/api/doctor"', () => call('GET', '/api/doctor'))
    Then('the response is 200', () => expect(response.statusCode).toBe(200))
    And('the findings mention the missing phase', () =>
      expect(JSON.stringify(response.body.problems)).toContain('nowhere'),
    )
  })

  /**
   * A build of the board, small enough to write here.
   *
   * The claim under test is the serving — the path mapping, the app's own
   * routes, and that nothing outside the directory can be reached — not Vite's
   * output, which is the same shape either way.
   */
  const givenBuiltBoard = async (): Promise<void> => {
    const dist = join(root, 'web-dist')
    file(join(dist, 'index.html'), '<!doctype html><title>Factory</title><div id="app"></div>')
    file(join(dist, 'assets', 'app.js'), 'console.log("board")')
    await app.close()
    app = buildServer(runtimeForRebuild as Awaited<ReturnType<typeof createRuntime>>, undefined, {
      webRoot: dist,
    })
    await app.ready()
  }

  Scenario('The board is served from the same process', ({ Given, When, Then, And }) => {
    Given('a built board', givenBuiltBoard)
    When('I GET "/"', () => call('GET', '/'))
    Then('the response is 200', () => expect(response.statusCode).toBe(200))
    And("the board's page is returned", () => expect(rawResponse).toContain('id="app"'))
  })

  Scenario('A page the app routes itself is not a 404', ({ Given, When, Then }) => {
    Given('a built board', givenBuiltBoard)
    // /tasks/abc123 is a page, not a missing file.
    When('I GET "/tasks/abc123"', () => call('GET', '/tasks/abc123'))
    Then("the board's page is returned", () => expect(rawResponse).toContain('id="app"'))
  })

  Scenario('A path climbing out of the build directory cannot escape it', ({
    Given,
    And,
    When,
    Then,
  }) => {
    Given('a built board', givenBuiltBoard)
    And('a file next to the build directory that must not be served', () => {
      file(join(root, 'secret.txt'), 'THE-SECRET')
    })
    // Percent-encoded, because a plain `..` is collapsed before it ever
    // reaches the handler — the encoded form is the one that arrives intact.
    When('I GET "/%2e%2e%2fsecret.txt"', () => call('GET', '/%2e%2e%2fsecret.txt'))
    Then("the file's contents are not in the response", () =>
      expect(rawResponse).not.toContain('THE-SECRET'),
    )
  })

  Scenario('Without a built board the API still serves', ({ When, Then }) => {
    When('I GET "/api/health"', () => call('GET', '/api/health'))
    Then('the response is 200', () => expect(response.statusCode).toBe(200))
  })

  Scenario('Without a built board the root page says how to build it', ({
    When,
    Then,
    And,
  }) => {
    When('I GET "/"', () => call('GET', '/'))
    Then('the response is 200', () => expect(response.statusCode).toBe(200))
    And('the page says the board is not built', () =>
      expect(rawResponse).toContain('The board is not built'),
    )
    And('the page names the command that builds it', () =>
      expect(rawResponse).toContain('pnpm build'),
    )
  })

  Scenario('Without a built board an asset request is still a plain 404', ({ When, Then }) => {
    When('I GET "/assets/index-abc123.js"', () => call('GET', '/assets/index-abc123.js'))
    Then('the response is 404', () => expect(response.statusCode).toBe(404))
  })

  interface PluginEntry {
    id: string
    name?: string
    essential: boolean
    enabled: boolean
    loaded: boolean
    restartRequired: boolean
    provides: { kind: string; id: string }[]
  }

  const plugins = () => (response.body as { plugins?: PluginEntry[] }).plugins ?? []
  const plugin = (id: string) => plugins().find((entry) => entry.id === id)
  const settingsFile = () => join(userScope, 'settings.json')
  const savedSettings = (): Record<string, unknown> =>
    existsSync(settingsFile())
      ? (JSON.parse(readFileSync(settingsFile(), 'utf8')) as Record<string, unknown>)
      : {}
  const switchTo = (id: string, enabled: unknown) => () =>
    call('POST', `/api/plugins/${encodeURIComponent(id)}`, { enabled })

  Rule('plugins can be listed and switched', ({ RuleScenario }) => {
    RuleScenario('The list names every plugin and what it contributes', ({
      When,
      Then,
      And,
    }) => {
      When('I ask for the plugins', () => call('GET', '/api/plugins'))
      Then('the built-in step kinds are listed', () =>
        expect(plugin('@factory/core/builtin-steps')).toBeDefined(),
      )
      And('the list says which capabilities each one provided', () =>
        expect(
          plugin('@factory/core/builtin-steps')?.provides.map((entry) => entry.id).sort(),
        ).toEqual(['agent', 'shell', 'worktree']),
      )
      And('the two core built-ins are marked essential', () =>
        expect(plugins().filter((entry) => entry.essential).map((entry) => entry.id)).toEqual([
          '@factory/core/builtin-steps',
          '@factory/config/builtin-doctor',
        ]),
      )
    })

    RuleScenario('Switching one off writes it to the settings, and nothing else', ({
      When,
      Then,
      And,
    }) => {
      let configBefore = ''
      When('I switch off "@factory/task-diffity"', async () => {
        configBefore = readFileSync(join(userScope, 'config.yaml'), 'utf8')
        await switchTo('@factory/task-diffity', false)()
      })
      Then('the response is 200', () => expect(response.statusCode).toBe(200))
      And('"@factory/task-diffity" is listed as switched off', async () => {
        await call('GET', '/api/plugins')
        expect(plugin('@factory/task-diffity')?.enabled).toBe(false)
      })
      And('the settings file holds it', () =>
        expect(JSON.stringify(savedSettings())).toContain('@factory/task-diffity'),
      )
      // The whole reason settings are not kept in config.yaml.
      And('the scope config is untouched', () =>
        expect(readFileSync(join(userScope, 'config.yaml'), 'utf8')).toBe(configBefore),
      )
    })

    RuleScenario('One still loaded says a restart will unload it', ({ When, Then }) => {
      When('I switch off "@factory/task-diffity"', switchTo('@factory/task-diffity', false))
      Then('it says a restart is required', () =>
        expect((response.body as { restartRequired?: boolean }).restartRequired).toBe(true),
      )
    })

    RuleScenario('Switching it back on removes it again', ({ Given, When, Then, And }) => {
      Given('"@factory/task-diffity" is switched off', switchTo('@factory/task-diffity', false))
      When('I switch on "@factory/task-diffity"', switchTo('@factory/task-diffity', true))
      Then('the response is 200', () => expect(response.statusCode).toBe(200))
      And('nothing is switched off', () =>
        expect((savedSettings().plugins as { disabled: string[] }).disabled).toEqual([]),
      )
    })

    RuleScenario('An essential plugin cannot be switched off', ({ When, Then, And }) => {
      When('I switch off "@factory/core/builtin-steps"', switchTo('@factory/core/builtin-steps', false))
      Then('the response is 409', () => expect(response.statusCode).toBe(409))
      And('the error says it is essential', () =>
        expect((response.body as { essential?: boolean }).essential).toBe(true),
      )
    })

    RuleScenario('Switching off something nothing claims is refused', ({ When, Then }) => {
      When('I switch off "@acme/imaginary"', switchTo('@acme/imaginary', false))
      Then('the response is 404', () => expect(response.statusCode).toBe(404))
    })

    RuleScenario('Switching *on* something nothing claims is allowed', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given('"@acme/long-gone" is switched off', () => {
        writeFileSync(
          settingsFile(),
          JSON.stringify({ plugins: { disabled: ['@acme/long-gone'] } }),
        )
      })
      When('I switch on "@acme/long-gone"', switchTo('@acme/long-gone', true))
      Then('the response is 200', () => expect(response.statusCode).toBe(200))
      And('nothing is switched off', () =>
        expect((savedSettings().plugins as { disabled: string[] }).disabled).toEqual([]),
      )
    })

    RuleScenario('A body that is not a yes or a no is a bad request', ({ When, Then }) => {
      When('I ask to switch "@factory/task-diffity" to "maybe"', switchTo('@factory/task-diffity', 'maybe'))
      Then('the response is 400', () => expect(response.statusCode).toBe(400))
    })
  })

  Rule('the interface size is a setting, not a guess', ({ RuleScenario }) => {
    const scale = () =>
      (response.body as { settings?: { ui: { scale: number } } }).settings?.ui.scale
    const setScale = (value: unknown) => () =>
      call('PATCH', '/api/settings', { ui: { scale: value } })

    RuleScenario('It starts at 1', ({ When, Then, And }) => {
      When('I ask for the settings', () => call('GET', '/api/settings'))
      Then('the interface scale is 1', () => expect(scale()).toBe(1))
      And('the settings name the file they came from', () =>
        expect(String((response.body as { file?: string }).file)).toContain('settings.json'),
      )
    })

    RuleScenario('A new scale is saved and read back', ({ When, Then, And }) => {
      When('I set the interface scale to 2', setScale(2))
      Then('the response is 200', () => expect(response.statusCode).toBe(200))
      And('asking again reports 2', async () => {
        await call('GET', '/api/settings')
        expect(scale()).toBe(2)
      })
    })

    RuleScenario('A scale past what the board supports is refused', ({ When, Then, And }) => {
      When('I set the interface scale to 40', setScale(40))
      Then('the response is 400', () => expect(response.statusCode).toBe(400))
      And('the error says what the range is', () =>
        expect(String(response.body.error)).toContain('between 1 and 3'),
      )
    })

    RuleScenario('A scale that is not a number is refused', ({ When, Then }) => {
      When('I set the interface scale to "big"', setScale('big'))
      Then('the response is 400', () => expect(response.statusCode).toBe(400))
    })

    RuleScenario('A patch naming nothing is refused', ({ When, Then }) => {
      When('I patch the settings with nothing', () => call('PATCH', '/api/settings', {}))
      Then('the response is 400', () => expect(response.statusCode).toBe(400))
    })
  })

  Rule('the appearance theme is a setting too', ({ RuleScenario }) => {
    const theme = () =>
      (response.body as { settings?: { ui: { theme: string } } }).settings?.ui.theme
    const scaleValue = () =>
      (response.body as { settings?: { ui: { scale: number } } }).settings?.ui.scale
    const setTheme = (value: unknown) => () =>
      call('PATCH', '/api/settings', { ui: { theme: value } })
    const setScale = (value: unknown) => () => call('PATCH', '/api/settings', { ui: { scale: value } })

    RuleScenario('It starts at "system"', ({ When, Then }) => {
      When('I ask for the settings', () => call('GET', '/api/settings'))
      Then('the theme is "system"', () => expect(theme()).toBe('system'))
    })

    RuleScenario('A new theme is saved and read back', ({ When, Then, And }) => {
      When('I set the theme to "light"', setTheme('light'))
      Then('the response is 200', () => expect(response.statusCode).toBe(200))
      And('asking again reports the theme "light"', async () => {
        await call('GET', '/api/settings')
        expect(theme()).toBe('light')
      })
    })

    RuleScenario('A theme that is not light, dark or system is refused', ({ When, Then, And }) => {
      When('I set the theme to "sepia"', setTheme('sepia'))
      Then('the response is 400', () => expect(response.statusCode).toBe(400))
      And('the error names the themes', () =>
        expect(String((response.body as { error?: string }).error)).toContain('light, dark, system'),
      )
    })

    RuleScenario('Changing the theme leaves the scale alone', ({ Given, When, Then, And }) => {
      Given('the interface scale is 2', setScale(2))
      When('I set the theme to "light"', setTheme('light'))
      Then('asking again reports the theme "light"', async () => {
        await call('GET', '/api/settings')
        expect(theme()).toBe('light')
      })
      And('the interface scale is still 2', () => expect(scaleValue()).toBe(2))
    })

    RuleScenario('Changing the scale leaves the theme alone', ({ Given, When, Then, And }) => {
      Given('the theme is "light"', setTheme('light'))
      When('I set the interface scale to 2', setScale(2))
      Then('the interface scale is 2', () => expect(scaleValue()).toBe(2))
      And('asking again reports the theme "light"', async () => {
        await call('GET', '/api/settings')
        expect(theme()).toBe('light')
      })
    })
  })

  Rule('the disclaimer is recorded once, and the profile is a setting', ({ RuleScenario }) => {
    const settings = (): Record<string, Record<string, unknown>> =>
      (response.body as { settings?: Record<string, Record<string, unknown>> }).settings ?? {}
    const askSettings = async (): Promise<void> => {
      await call('GET', '/api/settings')
    }
    const accept = async (): Promise<void> => {
      await call('POST', '/api/settings/accept')
    }
    const setProfile = (profile: unknown) => async (): Promise<void> => {
      await call('PATCH', '/api/settings', { security: { profile } })
    }
    const setScale = (scale: number) => async (): Promise<void> => {
      await call('PATCH', '/api/settings', { ui: { scale } })
    }
    const notAccepted = (): void => {
      expect((response.body as { accepted?: boolean }).accepted).toBe(false)
    }
    const profileIs = (expected: string) => async (): Promise<void> => {
      await askSettings()
      expect(settings().security?.profile).toBe(expected)
    }

    RuleScenario('A fresh installation has accepted nothing', ({ When, Then, And }) => {
      When('I ask for the settings', askSettings)
      Then('it says nothing has been accepted', notAccepted)
      And('it carries the disclaimer to show', () => {
        const disclaimer = (response.body as { disclaimer?: { summary?: string } }).disclaimer
        expect(disclaimer?.summary).toContain('inside the workspace')
      })
      And('the disclaimer says which profile removes the boundaries', () => {
        const disclaimer = (response.body as { disclaimer?: { points?: string[] } }).disclaimer
        expect(disclaimer?.points?.join(' ')).toContain('Full Access')
      })
    })

    RuleScenario('Accepting it is recorded', ({ When, Then, And }) => {
      When('I accept the disclaimer', accept)
      Then('the response says it is accepted', () =>
        expect((response.body as { accepted?: boolean }).accepted).toBe(true),
      )
      And('the settings say it is accepted', async () => {
        await askSettings()
        expect((response.body as { accepted?: boolean }).accepted).toBe(true)
      })
      And('the file records the current version', () => {
        const saved = savedSettings() as { security?: { acceptedVersion?: number } }
        expect(saved.security?.acceptedVersion).toBe(DISCLAIMER_VERSION)
      })
    })

    RuleScenario('Accepting it twice is not an error', ({ Given, When, Then }) => {
      Given('the disclaimer has been accepted', accept)
      When('I accept the disclaimer', accept)
      Then('the response says it is accepted', () =>
        expect((response.body as { accepted?: boolean }).accepted).toBe(true),
      )
    })

    RuleScenario('An older acceptance is not enough', ({ Given, When, Then }) => {
      Given('the settings file records an acceptance of version 0', () => {
        writeFileSync(settingsFile(), JSON.stringify({ security: { acceptedVersion: 0 } }))
      })
      When('I ask for the settings', askSettings)
      Then('it says nothing has been accepted', notAccepted)
    })

    RuleScenario('The default profile for new projects can be changed', ({ When, Then }) => {
      When('I set the installation profile to "full-access"', setProfile('full-access'))
      Then(
        'the settings say the installation profile is "full-access"',
        profileIs('full-access'),
      )
    })

    RuleScenario('A profile that is not one is refused', ({ When, Then, And }) => {
      When('I set the installation profile to "sort-of-safe"', setProfile('sort-of-safe'))
      Then('the response is 400', () => expect(response.statusCode).toBe(400))
      And('the response names the profiles', () =>
        expect(String((response.body as { error?: string }).error)).toContain('full-access'),
      )
    })

    RuleScenario('Changing the profile leaves the other settings alone', ({
      Given,
      And,
      When,
      Then,
    }) => {
      Given('the interface scale is 2', setScale(2))
      And('a plugin is switched off', switchTo('@factory/task-diffity', false))
      When('I set the installation profile to "full-access"', setProfile('full-access'))
      Then(
        'the settings say the installation profile is "full-access"',
        profileIs('full-access'),
      )
      And('the interface scale is still 2', () => {
        expect((settings().ui as { scale?: number }).scale).toBe(2)
      })
      And('the plugin is still switched off', () => {
        expect((settings().plugins as { disabled?: string[] }).disabled).toContain(
          '@factory/task-diffity',
        )
      })
    })

    RuleScenario('Changing the scale leaves the profile alone', ({ Given, When, Then, And }) => {
      Given('the installation profile is "full-access"', setProfile('full-access'))
      When('I set the interface scale to 2', setScale(2))
      Then('the interface scale is 2', async () => {
        await askSettings()
        expect((settings().ui as { scale?: number }).scale).toBe(2)
      })
      And(
        'the settings say the installation profile is "full-access"',
        profileIs('full-access'),
      )
    })

    RuleScenario('A patch with nothing in it says what it takes', ({ When, Then, And }) => {
      When('I send an empty settings patch', async () => {
        await call('PATCH', '/api/settings', {})
      })
      Then('the response is 400', () => expect(response.statusCode).toBe(400))
      And('the response mentions the profile', () =>
        expect(String((response.body as { error?: string }).error)).toContain('profile'),
      )
    })
  })
  Rule('a plugin can refuse a definition, or adjust it on its way to disk', ({ RuleScenario }) => {
    const workflow = (name: string) => ({
      definition: {
        name,
        mode: 'once',
        scheduling: 'parallel',
        description: '',
        variables: {},
        phases: [],
        extensions: {},
      },
    })
    const post = (name: string) => () => call('POST', '/api/workflows', workflow(name))
    const notWritten = (name: string) => () =>
      expect(existsSync(workflowFile(projectScope, name))).toBe(false)

    /** A plugin carrying one hook, loaded after the server was built. */
    const loading = (register: (context: PluginContext) => void) => async (): Promise<void> => {
      await host.load({ name: 'stub-hooks', version: '1.0.0', register })
    }

    RuleScenario('A plugin can refuse a definition', ({ Given, When, Then, And }) => {
      Given(
        'a plugin that refuses any workflow called "forbidden"',
        loading((context) => {
          context.hook('validateDefinition', (input) =>
            input.name === 'forbidden'
              ? [{ severity: 'error', message: 'that name is spoken for', rule: 'stub.name' }]
              : [],
          )
        }),
      )
      When('I POST a workflow named "forbidden"', post('forbidden'))
      Then('the response is 400', () => expect(response.statusCode).toBe(400))
      And("the response carries the plugin's reason", () =>
        expect(JSON.stringify(response.body)).toContain('that name is spoken for'),
      )
      And('the workflow "forbidden" was not written', notWritten('forbidden'))
    })

    RuleScenario('A plugin that refuses one name leaves the others alone', ({
      Given,
      When,
      Then,
    }) => {
      Given(
        'a plugin that refuses any workflow called "forbidden"',
        loading((context) => {
          context.hook('validateDefinition', (input) =>
            input.name === 'forbidden'
              ? [{ severity: 'error', message: 'that name is spoken for', rule: 'stub.name' }]
              : [],
          )
        }),
      )
      When('I POST a workflow named "allowed"', post('allowed'))
      Then('the response is 201', () => expect(response.statusCode).toBe(201))
    })

    RuleScenario('A plugin can adjust what is written', ({ Given, When, Then, And }) => {
      Given(
        'a plugin that describes every workflow it is shown',
        loading((context) => {
          context.hook('beforeDefinitionWrite', (value) => ({
            action: 'continue',
            value: {
              ...value,
              definition: { ...(value.definition as object), description: 'set by a plugin' },
            },
          }))
        }),
      )
      When('I POST a workflow named "allowed"', post('allowed'))
      Then('the response is 201', () => expect(response.statusCode).toBe(201))
      And('the stored workflow carries the description the plugin gave it', () =>
        expect(readFileSync(workflowFile(projectScope, 'allowed'), 'utf8')).toContain(
          'set by a plugin',
        ),
      )
    })

    RuleScenario('A plugin can refuse the write itself', ({ Given, When, Then, And }) => {
      Given(
        'a plugin that refuses to write anything',
        loading((context) => {
          context.hook('beforeDefinitionWrite', () => ({
            action: 'reject',
            problems: [{ severity: 'error', message: 'this scope is read-only today', rule: 'stub.write' }],
          }))
        }),
      )
      When('I POST a workflow named "allowed"', post('allowed'))
      Then('the response is 400', () => expect(response.statusCode).toBe(400))
      And('the workflow "allowed" was not written', notWritten('allowed'))
    })

    RuleScenario('A hook that throws refuses rather than writing half of it', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given(
        'a plugin whose write hook throws',
        loading((context) => {
          context.hook('beforeDefinitionWrite', () => {
            throw new Error('the plugin fell over')
          })
        }),
      )
      When('I POST a workflow named "allowed"', post('allowed'))
      Then('the response is 400', () => expect(response.statusCode).toBe(400))
      And('the workflow "allowed" was not written', notWritten('allowed'))
    })
  })
})

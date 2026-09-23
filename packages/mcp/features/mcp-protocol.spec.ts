import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import {
  LATEST_PROTOCOL_VERSION,
  createMcpServer,
  diagnoseTo,
  factoryTools,
  serve,
  type McpServer,
  type McpTool,
} from '../src/index.js'
import { FakeFactory, FakePipe, notification, request } from './support.js'

const feature = await loadFeature(
  fileURLToPath(new URL('./mcp-protocol.feature', import.meta.url)),
)

describeFeature(feature, ({ Background, Rule, Scenario }) => {
  let factory: FakeFactory
  let server: McpServer
  let reply: Record<string, unknown> | undefined
  let pipe: FakePipe
  let extra: McpTool[]

  // Everything per-scenario is built here, not in BeforeEachScenario: the
  // runner executes Background steps first.
  Background(({ Given, And }) => {
    Given('a Factory with one project "factory"', () => {
      reply = undefined
      extra = []
      factory = new FakeFactory().answer('/api/projects', {
        items: [
          {
            id: 'project-1',
            name: 'factory',
            path: '/repos/factory',
            defaultBranch: 'main',
            worktreesRoot: '/repos/.factory-worktrees/factory',
            isRepository: true,
            usesWorktrees: true,
            usesEnvironments: false,
            grantedDirectories: [],
            createdAt: '2026-01-01T00:00:00Z',
          },
        ],
      })
    })
    And('an MCP server over it', () => {
      pipe = new FakePipe()
      server = createMcpServer({
        tools: [...factoryTools, ...extra],
        context: { api: factory, cwd: '/repos/factory', env: {} },
        diagnose: diagnoseTo(pipe),
      })
    })
  })

  /** One frame in, the parsed frame out — or undefined when there is no reply. */
  const send = async (line: string): Promise<void> => {
    const answered = await server.handle(line)
    reply = answered === undefined ? undefined : (JSON.parse(answered) as Record<string, unknown>)
  }
  const result = () => reply?.result as Record<string, unknown> | undefined
  const error = () => reply?.error as { code: number; message: string } | undefined
  const toolResult = () => {
    const body = result() as
      | { content: { text: string }[]; isError?: boolean; structuredContent?: unknown }
      | undefined
    return {
      isError: body?.isError === true,
      text: body?.content?.[0]?.text ?? '',
      structured: body?.structuredContent,
    }
  }
  const initialize = (protocolVersion?: string) =>
    send(
      request(1, 'initialize', {
        ...(protocolVersion === undefined ? {} : { protocolVersion }),
        capabilities: {},
        clientInfo: { name: 'a-client', version: '1.0.0' },
      }),
    )

  Scenario('The handshake says what this server is and what it can do', ({ When, Then, And }) => {
    When('the client initializes', () => initialize())
    Then('the server calls itself "factory"', () =>
      expect((result()?.serverInfo as { name: string }).name).toBe('factory'),
    )
    And('it offers tools', () =>
      expect(result()?.capabilities).toEqual({ tools: { listChanged: false } }),
    )
    And('it says what Factory is for', () =>
      expect(result()?.instructions).toContain('factory_project_current'),
    )
  })

  Scenario('A version the server speaks is the one agreed', ({ When, Then }) => {
    When('the client initializes asking for "2025-06-18"', () => initialize('2025-06-18'))
    Then('the agreed version is "2025-06-18"', () =>
      expect(result()?.protocolVersion).toBe('2025-06-18'),
    )
  })

  Scenario('A version the server does not speak is answered with one it does', ({ When, Then }) => {
    When('the client initializes asking for "1999-01-01"', () => initialize('1999-01-01'))
    Then('the agreed version is the newest this server speaks', () =>
      expect(result()?.protocolVersion).toBe(LATEST_PROTOCOL_VERSION),
    )
  })

  Scenario('Every tool is listed with a schema a client can check against', ({ When, Then, And }) => {
    When('the client lists the tools', () => send(request(2, 'tools/list')))
    Then('every tool has a name, a description and an object schema', () => {
      const tools = result()?.tools as
        | { name: string; description: string; inputSchema: { type?: string } }[]
        | undefined
      expect(tools?.length).toBeGreaterThan(0)
      for (const tool of tools ?? []) {
        expect(tool.name).toMatch(/^factory_[a-z_]+$/)
        expect(tool.description.length).toBeGreaterThan(20)
        expect(tool.inputSchema.type).toBe('object')
      }
    })
    And('the first tool is "factory_project_current"', () =>
      expect((result()?.tools as { name: string }[])[0]?.name).toBe('factory_project_current'),
    )
  })

  Scenario("A tool's answer arrives as text and as structure", ({ When, Then, And }) => {
    When('the client calls "factory_project_list"', () =>
      send(request(3, 'tools/call', { name: 'factory_project_list', arguments: {} })),
    )
    Then('the answer is not an error', () => expect(toolResult().isError).toBe(false))
    And('the text of it parses as JSON', () =>
      expect((JSON.parse(toolResult().text) as { projects: unknown[] }).projects).toHaveLength(1),
    )
    And('the structured copy says the same thing', () =>
      expect(toolResult().structured).toEqual(JSON.parse(toolResult().text)),
    )
  })

  Scenario('A ping is answered', ({ When, Then }) => {
    When('the client pings', () => send(request(9, 'ping')))
    Then('the reply is empty and carries the same id', () => {
      expect(result()).toEqual({})
      expect(reply?.id).toBe(9)
    })
  })

  Rule('a bad frame is answered, never thrown', ({ RuleScenario }) => {
    RuleScenario('A line that is not JSON is a parse error', ({ When, Then, And }) => {
      When('the client sends "not json at all"', () => send('not json at all'))
      Then('the reply is an error with code -32700', () => expect(error()?.code).toBe(-32700))
      And('the reply has no id', () => expect(reply?.id).toBeNull())
    })

    RuleScenario('A frame with the wrong protocol version keeps its id', ({ When, Then, And }) => {
      When('the client sends a frame claiming JSON-RPC "1.0"', () =>
        send(JSON.stringify({ jsonrpc: '1.0', id: 7, method: 'ping' })),
      )
      Then('the reply is an error with code -32600', () => expect(error()?.code).toBe(-32600))
      And('the reply carries the id that was sent', () => expect(reply?.id).toBe(7))
    })

    RuleScenario('A method this server does not have says so', ({ When, Then, And }) => {
      When('the client calls the method "resources/list"', () =>
        send(request(4, 'resources/list')),
      )
      Then('the reply is an error with code -32601', () => expect(error()?.code).toBe(-32601))
      And('the message says this server serves tools', () =>
        expect(error()?.message).toContain('tools'),
      )
    })

    RuleScenario('A notification is answered with nothing at all', ({ When, Then }) => {
      When('the client notifies "notifications/initialized"', () =>
        send(notification('notifications/initialized')),
      )
      Then('there is no reply', () => expect(reply).toBeUndefined())
    })

    RuleScenario('An unknown tool says where the list is', ({ When, Then, And }) => {
      When('the client calls "factory_teleport"', () =>
        send(request(5, 'tools/call', { name: 'factory_teleport' })),
      )
      Then('the reply is an error with code -32602', () => expect(error()?.code).toBe(-32602))
      And('the message says to call tools/list', () =>
        expect(error()?.message).toContain('tools/list'),
      )
    })

    RuleScenario('Arguments that do not fit the schema name the field', ({ When, Then, And }) => {
      When('the client calls "factory_run_logs" with a tail of "lots"', () =>
        send(
          request(6, 'tools/call', {
            name: 'factory_run_logs',
            arguments: { run: 'run-1', tail: 'lots' },
          }),
        ),
      )
      Then('the reply is an error with code -32602', () => expect(error()?.code).toBe(-32602))
      And('the message names "tail"', () => expect(error()?.message).toContain('tail'))
    })

    RuleScenario('A tool Factory refused is a result, not a protocol error', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given('the daemon is not running', () => {
        factory.failure = { status: 0, message: 'Cannot reach the Factory daemon at …' }
      })
      When('the client calls "factory_project_list"', () =>
        send(request(8, 'tools/call', { name: 'factory_project_list', arguments: {} })),
      )
      Then('the answer is an error result', () => {
        expect(error()).toBeUndefined()
        expect(toolResult().isError).toBe(true)
      })
      And('it says the daemon is not running', () =>
        expect(toolResult().text).toContain('DAEMON_UNAVAILABLE'),
      )
      And('it tells the agent to ask a person to start it', () =>
        expect(toolResult().text).toContain('factory-daemon'),
      )
    })
  })

  Rule('stdout carries the protocol and nothing else', ({ RuleScenario }) => {
    const served = async (...chunks: string[]): Promise<void> => {
      pipe.send(...chunks)
      await serve(server, pipe)
    }

    RuleScenario('Frames go to the output stream, one per line', ({ When, Then, And }) => {
      When('the client sends a ping and a tools/list down the pipe', () =>
        served(`${request(1, 'ping')}\n`, `${request(2, 'tools/list')}\n`),
      )
      Then('two frames came back, one per line', () => {
        expect(pipe.frames()).toHaveLength(2)
        expect(pipe.written.every((text) => text.endsWith('\n'))).toBe(true)
      })
      And('nothing was written to the error stream', () => expect(pipe.errors).toEqual([]))
    })

    RuleScenario('Two frames in one chunk are both answered', ({ When, Then }) => {
      When('both frames arrive in a single chunk', () =>
        served(`${request(1, 'ping')}\n${request(2, 'ping')}\n`),
      )
      Then('two frames came back, one per line', () => expect(pipe.frames()).toHaveLength(2))
    })

    RuleScenario('A frame split across two chunks is answered once it is whole', ({
      When,
      Then,
    }) => {
      When('one frame arrives in two pieces', () => {
        const frame = request(1, 'ping')
        return served(frame.slice(0, 10), `${frame.slice(10)}\n`)
      })
      Then('the ping is answered, once', () => {
        expect(pipe.frames()).toHaveLength(1)
        expect(pipe.frames()[0]).toEqual({ jsonrpc: '2.0', id: 1, result: {} })
      })
    })

    RuleScenario('A blank line is ignored', ({ When, Then }) => {
      When('the client sends an empty line', () => served('\n'))
      Then('nothing came back', () => expect(pipe.written).toEqual([]))
    })

    RuleScenario('A tool that breaks unexpectedly is reported on stderr and answered on stdout', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given('a tool that breaks before it can run', () => {
        // Broken where nothing can catch it usefully: validation happens before
        // the tool is entered, so this is the last-resort path — the one that
        // otherwise takes the pipe down with it.
        extra.push({
          name: 'factory_broken',
          title: 'Broken',
          description: 'A tool whose own validation throws, which nothing expects.',
          inputSchema: { type: 'object' },
          parse: () => {
            throw new Error('its schema exploded')
          },
          run: async () => undefined,
        })
        server = createMcpServer({
          tools: [...factoryTools, ...extra],
          context: { api: factory, cwd: '/repos/factory', env: {} },
          diagnose: diagnoseTo(pipe),
        })
      })
      When('the client calls that tool', () =>
        served(`${request(1, 'tools/call', { name: 'factory_broken' })}\n`),
      )
      Then('one frame came back', () => expect(pipe.frames()).toHaveLength(1))
      And('the error stream says what failed', () =>
        expect(pipe.errors.join('')).toContain('its schema exploded'),
      )
    })
  })
  Rule('Factory is told where a request came from, and the client does not say', ({
    RuleScenario,
  }) => {
    const insideARun = (): void => {
      server = createMcpServer({
        tools: factoryTools,
        context: {
          api: factory,
          cwd: '/repos/factory',
          // Exactly what the engine stamps, and nothing else: the point is that
          // this server reads its own position rather than being told it.
          env: { FACTORY_RUN_ID: 'run-7', FACTORY_TASK_ID: 'task-3' },
        },
        diagnose: diagnoseTo(pipe),
      })
    }
    const createATask = async (): Promise<void> => {
      factory.answer(`/api/projects/at?path=${encodeURIComponent('/repos/factory')}`, {
        project: { id: 'project-1', name: 'factory', path: '/repos/factory' },
        matchedBy: 'directory',
      })
      factory.answer('/api/tasks', {
        task: { id: 'task-9', name: 'Add due dates', state: 'draft', projectId: 'project-1', workflows: [] },
        actions: [],
      })
      await send(
        request(10, 'tools/call', {
          name: 'factory_task_create',
          arguments: { name: 'Add due dates' },
        }),
      )
    }
    const sentInitiator = () =>
      (factory.bodies.get('POST /api/tasks') as { initiator?: Record<string, string> } | undefined)
        ?.initiator

    RuleScenario('A server Factory did not start looks like a person', ({ When, Then }) => {
      When('the client creates a task', createATask)
      Then('nothing was said about where the request came from', () =>
        expect(sentInitiator()).toBeUndefined(),
      )
    })

    RuleScenario('A server started inside a run says which run, and which task', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given('Factory started this server inside run "run-7" on task "task-3"', insideARun)
      When('the client creates a task', createATask)
      Then('Factory was told the request came from run "run-7"', () =>
        expect(sentInitiator()?.runId).toBe('run-7'),
      )
      And('Factory was told it came from inside task "task-3"', () =>
        expect(sentInitiator()?.taskId).toBe('task-3'),
      )
    })

    RuleScenario("The client's own name travels as a label", ({ Given, When, Then }) => {
      Given('Factory started this server inside run "run-7" on task "task-3"', insideARun)
      When('the client initializes as "a-client" version "1.0.0" and creates a task', async () => {
        await initialize('2025-06-18')
        await createATask()
      })
      Then('Factory was told the client calls itself "mcp:a-client/1.0.0"', () =>
        expect(sentInitiator()?.label).toBe('mcp:a-client/1.0.0'),
      )
    })

    RuleScenario('No tool lets a client say where it came from', ({ When, Then }) => {
      When('the client lists the tools', () => send(request(11, 'tools/list')))
      Then('no tool takes an initiator', () => {
        const tools = result()?.tools as { inputSchema: { properties?: Record<string, unknown> } }[]
        for (const tool of tools) {
          expect(Object.keys(tool.inputSchema.properties ?? {})).not.toContain('initiator')
        }
      })
    })
  })
})

import {
  INVALID_PARAMS,
  INTERNAL_ERROR,
  METHOD_NOT_FOUND,
  failure,
  parseFrame,
  success,
} from './jsonrpc.js'
import { asToolError } from './errors.js'
import { initiatorFrom } from './initiator.js'
import type { McpTool, ToolContext } from './tool.js'

/**
 * Factory, as an MCP server.
 *
 * A function from one frame to at most one frame. Everything that touches a
 * stream is in `serve`, which is what lets the entire protocol be specified
 * without spawning a process — the same discipline that already makes the CLI
 * testable, for the same reason.
 */

/**
 * Revisions of the protocol this server can speak, newest first.
 *
 * Negotiation, not a constant: the specification says a server that does not
 * support the version it was asked for answers with one it does, and a client
 * then either accepts it or disconnects. Written down so that a new revision is
 * a deliberate edit with a scenario behind it, rather than something that
 * quietly stops working on somebody's machine.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const

export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0]

/**
 * What this server calls itself.
 *
 * Not Factory's version, which already lives in seventeen package files and the
 * health route. This is the version of the *surface* — it moves when the tools
 * change, which is what a client's diagnostics are actually asking about.
 */
export const MCP_SERVER_VERSION = '0.1.0'

/**
 * What the client is told Factory is for, once, at the start.
 *
 * Worth the words: an agent that has just been handed fifteen tools and no
 * context tends to create a task and queue it without looking at what the
 * project can run, which is how somebody ends up with a task pointed at a
 * workflow that does not exist.
 */
export const INSTRUCTIONS = [
  'Factory orchestrates coding agents. It does not write code here: it creates tasks in a',
  'repository, runs workflows against them, keeps what the agents produced, and stops at the',
  'gates a person asked for.',
  '',
  'Start with factory_project_current. Then read factory_workflow_list before creating a task —',
  'a task names workflows, and only the ones that project can run will resolve.',
  '',
  'Queueing a task is what starts work; cancelling it is what stops work. Both are',
  'factory_task_act, and the actions a task will accept come back with the task. Do not guess',
  'them.',
  '',
  'Approvals belong to people. If a task is waiting for one, say so and stop.',
].join('\n')

export interface McpServer {
  /**
   * One line in, at most one line out.
   *
   * A notification is answered with nothing, which is the protocol rather than
   * an optimisation: a reply a client cannot match to a request is a fault.
   */
  handle(line: string): Promise<string | undefined>
  /** What the client said it was, once it has said so. */
  readonly client: { name: string; version?: string } | undefined
}

export interface McpServerOptions {
  readonly tools: readonly McpTool[]
  readonly context: ToolContext
  /**
   * Somewhere for a diagnostic that is not a protocol frame.
   *
   * Defaults to nowhere. stdout carries the protocol and nothing else, and a
   * server that defaulted to printing would corrupt the session on its first
   * surprise.
   */
  readonly diagnose?: (message: string) => void
}

export function createMcpServer(options: McpServerOptions): McpServer {
  const byName = new Map(options.tools.map((tool) => [tool.name, tool]))
  let client: { name: string; version?: string } | undefined

  const listing = options.tools.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }))

  const callTool = async (params: unknown): Promise<{ result: unknown } | { error: { code: number; message: string; data?: unknown } }> => {
    const asked = (params ?? {}) as { name?: unknown; arguments?: unknown }
    if (typeof asked.name !== 'string') {
      return { error: { code: INVALID_PARAMS, message: 'tools/call needs a tool name.' } }
    }
    const tool = byName.get(asked.name)
    if (tool === undefined) {
      return {
        error: {
          code: INVALID_PARAMS,
          message: `Unknown tool "${asked.name}". Call tools/list to see what this server has.`,
        },
      }
    }
    const parsed = tool.parse(asked.arguments)
    if ('problems' in parsed) {
      return {
        error: {
          code: INVALID_PARAMS,
          message: `${asked.name}: ${parsed.problems.join('; ')}`,
          data: { problems: parsed.problems },
        },
      }
    }

    // A tool that could not do its job is a *result*, not a protocol error: the
    // request was well formed and the answer is "Factory refused, and here is
    // what to do about it". A protocol error here would reach the model as a
    // transport fault, which is the one reading that suggests retrying.
    // Rebuilt per call rather than captured: the client's name arrives at
    // `initialize`, which is after the context was made, and the run this
    // server is inside is read from the environment every time so a scenario
    // can change it without rebuilding the server.
    const from = initiatorFrom(options.context.env, client)
    const context: ToolContext = {
      ...options.context,
      ...(from === undefined ? {} : { initiator: from }),
    }
    try {
      const value = await tool.run(parsed.value, context)
      return { result: content(value) }
    } catch (error) {
      const problem = asToolError(error)
      const body = { error: problem.code, message: problem.message, ...problem.details }
      return { result: { ...content(body), isError: true } }
    }
  }

  return {
    get client() {
      return client
    },
    async handle(line) {
      const frame = parseFrame(line)
      if (frame.kind === 'malformed') {
        // Answered with `id: null` when the frame carried none, which is what
        // JSON-RPC says to do with a request nobody can match: silence would
        // leave a client waiting on a pipe for a reply that is never coming.
        return failure(frame.id, frame.error)
      }
      if (frame.kind === 'notification') {
        // `notifications/initialized` and `notifications/cancelled` are the two
        // a tools-only server sees, and neither asks for anything. Anything
        // else is a client feature this server does not have, which the
        // protocol says to ignore rather than fail.
        return undefined
      }

      try {
        switch (frame.method) {
          case 'initialize': {
            const asked = (frame.params ?? {}) as {
              protocolVersion?: unknown
              clientInfo?: { name?: unknown; version?: unknown }
            }
            const name = asked.clientInfo?.name
            if (typeof name === 'string') {
              client = {
                name,
                ...(typeof asked.clientInfo?.version === 'string'
                  ? { version: asked.clientInfo.version }
                  : {}),
              }
            }
            const wanted = asked.protocolVersion
            const version =
              typeof wanted === 'string' &&
              (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(wanted)
                ? wanted
                : LATEST_PROTOCOL_VERSION
            return success(frame.id, {
              protocolVersion: version,
              // Tools and nothing else. Declaring a capability this server does
              // not have is how a client ends up waiting on a reply that never
              // comes.
              capabilities: { tools: { listChanged: false } },
              serverInfo: {
                name: 'factory',
                title: 'Xaedalon Factory',
                version: MCP_SERVER_VERSION,
              },
              instructions: INSTRUCTIONS,
            })
          }

          case 'ping':
            return success(frame.id, {})

          case 'tools/list':
            return success(frame.id, { tools: listing })

          case 'tools/call': {
            const outcome = await callTool(frame.params)
            return 'error' in outcome
              ? failure(frame.id, outcome.error)
              : success(frame.id, outcome.result)
          }

          default:
            return failure(frame.id, {
              code: METHOD_NOT_FOUND,
              message: `This server does not do "${frame.method}". It serves tools.`,
            })
        }
      } catch (error) {
        // Last resort. A server that throws out of `handle` takes the pipe with
        // it, and the client is left waiting on something that will never speak
        // again.
        const said = error instanceof Error ? error.message : String(error)
        options.diagnose?.(`factory mcp: ${frame.method} failed: ${said}`)
        return failure(frame.id, { code: INTERNAL_ERROR, message: said })
      }
    },
  }
}

/**
 * A tool's answer, in the two shapes clients read.
 *
 * `content` is what every client renders and what a model sees; the same value
 * rides along as `structuredContent` for the ones that would rather parse than
 * read. One value, serialized once, so the two can never disagree.
 */
const content = (value: unknown) => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>,
})

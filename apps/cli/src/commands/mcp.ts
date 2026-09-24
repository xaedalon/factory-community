import { createMcpServer, diagnoseTo, factoryTools, serve, type McpStreams } from '@factory/mcp'
import { ok, failed, type CliContext, type CommandResult } from '../context.js'
import type { DaemonClient } from '../daemon.js'

/**
 * Serve Factory to a coding agent, over stdin and stdout.
 *
 * The only command that owns its streams. Every other one is a function of its
 * arguments returning lines, which `bin.ts` prints — and a printed line here
 * would land in the middle of a JSON-RPC stream and end the session. So this
 * one returns no lines at all, writes protocol frames to the output it was
 * given, and puts diagnostics on stderr.
 *
 * It talks to the daemon like the rest of the CLI does. It does not open the
 * database, and it does not start a daemon: nothing in this repository has ever
 * started one on somebody's behalf, and two processes reconciling one database
 * is how a run in flight gets marked failed while its agent keeps working.
 */
export async function mcp(
  context: CliContext,
  daemon: DaemonClient,
  io: { readonly streams?: McpStreams; readonly atATerminal?: boolean } = {},
): Promise<CommandResult> {
  // A terminal on stdin means a person typed this, and no client is coming.
  // Reading it would wait for a frame that will never arrive — a hang, which
  // is what this did until somebody tried it. Nothing is read: the explanation
  // is the whole answer.
  if (io.streams === undefined || io.atATerminal === true) {
    return failed([
      '`factory mcp` speaks the Model Context Protocol over stdin and stdout.',
      'An MCP client starts it; there is nothing to serve when it is run by hand.',
      '',
      'Point a client at it:',
      '  {"mcpServers": {"factory": {"command": "factory", "args": ["mcp"]}}}',
      '',
      'Or ask your agent to do it for you: "add Factory to my MCP servers".',
    ])
  }

  const server = createMcpServer({
    tools: factoryTools,
    context: { api: daemon, cwd: context.cwd, env: context.env },
    diagnose: diagnoseTo(io.streams),
  })

  await serve(server, io.streams)
  return ok([])
}

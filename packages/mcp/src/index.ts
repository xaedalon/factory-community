/**
 * @factory/mcp — Factory as a Model Context Protocol server.
 *
 * The third client of one contract. The board and the CLI already talk to the
 * daemon over HTTP; so does this, and for the same reason — the daemon owns the
 * database and the scheduler, and a second process opening that database
 * finishes every run in flight as failed on the way in.
 *
 * So nothing here plans, schedules, spawns or persists. It resolves which
 * project a directory is in, turns a tool call into a request, and shapes the
 * reply into something a model can act on.
 */
export * from './api.js'
export * from './errors.js'
export * from './jsonrpc.js'
export * from './project.js'
export * from './serve.js'
export * from './server.js'
export * from './tool.js'
export * from './tools/index.js'

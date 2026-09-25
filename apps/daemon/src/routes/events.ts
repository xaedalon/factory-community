import type { FastifyInstance } from 'fastify'
import type { Runtime } from '@factory/runtime'

/**
 * Everything that happens, as it happens.
 *
 * Server-sent events rather than a websocket: the traffic is one-way, SSE
 * survives a proxy and a reconnect without any code of ours, and the browser
 * reconnects on its own. The prototype polled every two seconds, which is both
 * slower to notice and more work when nothing is happening.
 *
 * The stream carries the event bus verbatim. That is deliberate — a plugin that
 * emits its own events gets them delivered to every open board with no route to
 * write, which is the same seam the desktop capability uses.
 */
export function registerEventRoutes(app: FastifyInstance, runtime: Runtime): void {
  /**
   * Every stream currently open, so shutdown can end them.
   *
   * Without this the daemon does not stop. `app.close()` waits for in-flight
   * requests to finish, a hijacked SSE reply never finishes, and the result is
   * the worst of both: the port is released, so the board cannot reconnect and
   * a fresh daemon can take it — while the old process stays alive for ever
   * having never reached `process.exit`. "Factory seems down" with a live
   * `node dist/bin.js` in the process table is exactly this.
   */
  const open = new Set<() => void>()
  app.addHook('onClose', async () => {
    for (const end of [...open]) end()
  })

  app.get('/api/events', (request, reply) => {
    // Taken out of Fastify's hands: the reply is a long-lived stream, not a
    // response with a body to serialise.
    reply.hijack()
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      // Nothing in between should buffer this waiting for more.
      'x-accel-buffering': 'no',
    })
    reply.raw.write(': connected\n\n')

    // No `event:` field, deliberately. A named SSE frame only reaches a client
    // that already knows to listen for that name, so naming them made every
    // consumer keep its own copy of the event vocabulary — and the board's copy
    // had 14 of the 23 names in it. An event missing from such a list is not an
    // error anywhere; the client simply stops updating for it, silently.
    //
    // The name is in the payload, where a client that wants to filter can read
    // it, and where it cannot go out of date.
    const off = runtime.events.onAny((event) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`)
    })

    // A comment line every 15 seconds, so an idle connection is not closed by
    // whatever is between the browser and here. Unrefed: a heartbeat must never
    // be the reason a process will not exit.
    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 15_000)
    heartbeat.unref()

    const stop = (): void => {
      clearInterval(heartbeat)
      off()
      open.delete(end)
    }
    // Ending the response is what lets `close()` return; `stop` alone only
    // tidies up the listeners, and the socket is what the shutdown waits on.
    const end = (): void => {
      stop()
      reply.raw.end()
    }
    open.add(end)
    request.raw.on('close', stop)
    request.raw.on('error', stop)
  })
}

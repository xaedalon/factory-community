import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import type { FastifyInstance } from 'fastify'

/**
 * Serving the board from the daemon.
 *
 * In development Vite serves the app and proxies `/api` here. In use there is
 * no Vite: one process, one address, one thing to start. Local-first has to
 * mean local-first to install as well as to run.
 *
 * Written by hand rather than with a static-file plugin. It is forty lines, and
 * a tool people are asked to install on their own machine should carry as few
 * dependencies as it can honestly manage.
 */

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

/**
 * The API is never the catch-all's to answer.
 *
 * Both routes below exist so a page the app routes itself — `/tasks/abc` —
 * resolves instead of 404ing, and both were catching `/api/…` with it. A client
 * calling a route *this* daemon does not have got a **200** carrying HTML, its
 * JSON parse failed, and the caller died on `undefined` somewhere else entirely,
 * saying nothing about the request that caused it.
 *
 * An older daemon and a newer board is the ordinary way to be in that position,
 * so it has to read as "no such route" rather than as a bug in whatever page
 * happened to be open.
 *
 * The whole segment, not the three characters: `/apiary` is a page the app may
 * hold, and refusing it would break a route for a reason nobody could guess.
 */
function apiMiss(url: string): { error: string } | undefined {
  if (url !== 'api' && !url.startsWith('api/')) return undefined
  return { error: `This daemon does not serve /${url}.` }
}

/**
 * What `/` says when the board was never built.
 *
 * Registered in place of the static routes, because the alternative is what a
 * newcomer used to get: Fastify's own `{"message":"Route GET:/ not found"}`,
 * from a daemon that had already printed the answer to its log where nobody
 * was looking. The build is missing, not broken — the API is useful on its own
 * — so this is a page with the command on it, not an error.
 *
 * 200 rather than 404 or 503: the only visitor to `/` on a daemon without a
 * board is a person who followed the README, and a status code they will never
 * see matters less than the sentence they will.
 */
export function registerMissingBoardRoute(app: FastifyInstance): void {
  app.get('/*', async (request, reply) => {
    const url = (request.params as { '*'?: string })['*'] ?? ''
    const missed = apiMiss(url)
    if (missed !== undefined) return reply.code(404).send(missed)
    // A machine asking for an asset gets an honest 404; only a page request
    // gets the explanation.
    if (extname(url) !== '') return reply.code(404).send({ error: 'Not found.' })
    return reply
      .code(200)
      .type('text/html; charset=utf-8')
      .send(
        [
          '<!doctype html><meta charset="utf-8"><title>Factory — the board is not built</title>',
          '<style>body{font:15px/1.6 ui-sans-serif,system-ui,sans-serif;max-width:46rem;',
          'margin:12vh auto;padding:0 1.5rem;color:#e7e7e7;background:#0b0b0b}',
          'code{background:#1b1b1b;padding:.15rem .4rem;border-radius:.25rem}',
          'a{color:#7dd3fc}</style>',
          '<h1>The board is not built</h1>',
          '<p>The daemon is running and its API is live — this process just has no',
          'web bundle to serve. Build it:</p>',
          '<pre><code>pnpm build</code></pre>',
          '<p>That builds the board as well as the engine. To build only the board:',
          '<code>pnpm --filter @factory/web build</code>. Then reload this page.</p>',
          '<p>Meanwhile the API answers: <a href="/api/health">/api/health</a>.</p>',
        ].join('\n'),
      )
  })
}

export function registerWebRoutes(app: FastifyInstance, root: string): void {
  const base = resolve(root)

  app.get('/*', async (request, reply) => {
    const url = (request.params as { '*'?: string })['*'] ?? ''

    const missed = apiMiss(url)
    if (missed !== undefined) return reply.code(404).send(missed)

    // Never serve anything outside the build directory. `normalize` collapses
    // `..` before the check, so a path that climbs out is caught here rather
    // than by whatever it reaches.
    const candidate = resolve(join(base, normalize(`/${url}`)))
    if (candidate !== base && !candidate.startsWith(base + sep)) {
      return reply.code(404).send({ error: 'Not found.' })
    }

    const file =
      existsSync(candidate) && statSync(candidate).isFile()
        ? candidate
        : // Anything else is a route the app handles itself: /tasks/abc is a
          // page, not a missing file, and the app router resolves it.
          join(base, 'index.html')

    if (!existsSync(file)) return reply.code(404).send({ error: 'Not found.' })

    const type = TYPES[extname(file)] ?? 'application/octet-stream'
    // Hashed asset names may be cached hard; index.html never, or a deploy is
    // invisible until someone clears their cache.
    const cache = file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable'
    return reply.type(type).header('cache-control', cache).send(createReadStream(file))
  })
}

/**
 * Where the built board might be.
 *
 * Checked in order, and a missing build is not an error: the API is useful on
 * its own, and saying so beats refusing to start.
 */
export function findWebRoot(options: {
  env: Readonly<Record<string, string | undefined>>
  /** This module's own location, so the search does not depend on the cwd. */
  here: string
}): string | undefined {
  const candidates = [
    options.env.FACTORY_WEB_ROOT,
    // A published daemon carrying the built app beside its code.
    resolve(options.here, 'web'),
    resolve(options.here, '..', 'web'),
    // The monorepo: apps/daemon/dist -> apps/web/dist.
    resolve(options.here, '..', '..', 'web', 'dist'),
  ]
  return candidates.find(
    (path) => path !== undefined && existsSync(join(path, 'index.html')),
  )
}

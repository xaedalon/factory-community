import Fastify, { type FastifyInstance } from 'fastify'
import type { DetachedLauncher } from '@factory/core'
import type { Runtime } from '@factory/runtime'
import { registerDefinitionRoutes } from './routes/definitions.js'
import { registerBundleRoutes } from './routes/bundles.js'
import { registerInspectionRoutes } from './routes/inspection.js'
import { registerInstallationRoutes } from './routes/installation.js'
import { registerTaskRoutes } from './routes/tasks.js'
import { registerReliabilityRoutes } from './routes/reliability.js'
import { registerProjectRoutes } from './routes/projects.js'
import { registerEventRoutes } from './routes/events.js'
import { registerMissingBoardRoute, registerWebRoutes } from './routes/web.js'
import type { Service } from './service.js'
import { createChains } from './chains.js'

/**
 * The local Factory service.
 *
 * Routes are thin adapters over @factory/core and @factory/config — no logic
 * lives here. That matters more than it sounds: this API is the contract a
 * commercial edition builds on, so anything implemented in a route rather than
 * in a package is something the open core cannot offer.
 *
 * Built separately from listening so the whole surface can be exercised with
 * `app.inject()` — no sockets, no ports, no ordering problems in the tests.
 */
export function buildServer(
  runtime: Runtime,
  service?: Service,
  // `launch` is injected the way Pro injects its terminal launcher, so a
  // scenario can assert what a detached tool would have started.
  options: { webRoot?: string; launch?: DetachedLauncher } = {},
): FastifyInstance {
  // `forceCloseConnections` so a shutdown cannot be held hostage by an open
  // socket. Fastify's default waits for connections to go idle, and a
  // server-sent-events stream never does. The events route ends its own
  // streams; this is the guarantee for the next long-lived response somebody
  // adds without thinking about stopping.
  const app = Fastify({ logger: false, forceCloseConnections: true })

  app.get('/api/health', async () => ({
    ok: true,
    version: '0.1.0',
    // What the boot had to correct. Silence here would hide the one thing a
    // person most wants to know after a crash: what was lost.
    ...(service === undefined
      ? {}
      : {
          recovered: {
            runs: service.reconciliation.closedRuns.length,
            tasks: service.reconciliation.blockedTasks.length,
          },
        }),
  }))

  // A process with no database has no projects to resolve against, so every
  // `?project=` is an unknown id and the daemon's own chain answers the rest.
  const chains =
    service?.chains ?? createChains({ chain: runtime.chain, env: runtime.env })

  registerDefinitionRoutes(app, runtime, chains, service?.projects)
  registerBundleRoutes(app, runtime, chains)
  registerInspectionRoutes(app, runtime, chains)
  registerInstallationRoutes(app, runtime)
  registerEventRoutes(app, runtime)
  // Optional so the definition API can still be served — and tested — by a
  // process with no database, which is what the CLI's `--serve` would want.
  if (service !== undefined) {
    registerTaskRoutes(app, runtime, service, {
      ...(options.launch === undefined ? {} : { launch: options.launch }),
    })
    registerProjectRoutes(app, service, runtime)
    registerReliabilityRoutes(app, service, runtime)
  }

  // Last, so neither catch-all ever shadows an API route.
  if (options.webRoot !== undefined) registerWebRoutes(app, options.webRoot)
  else registerMissingBoardRoute(app)

  return app
}

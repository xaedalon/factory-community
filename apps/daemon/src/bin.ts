#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import { createRuntime } from '@factory/runtime'
import { buildServer } from './server.js'
import { createService } from './service.js'
import { findWebRoot } from './routes/web.js'

/**
 * The only module that touches the process.
 *
 * Bound to 127.0.0.1, never 0.0.0.0: this service reads and writes files with
 * the authority of whoever started it, and Factory is local-first. Exposing it
 * on a network interface should be a deliberate act, not a default.
 *
 * Port 7317 rather than 3000, which collides with every other dev server.
 */
const runtime = await createRuntime({ cwd: process.cwd(), env: process.env })
const service = await createService(runtime)
const webRoot = findWebRoot({
  env: process.env,
  here: fileURLToPath(new URL('.', import.meta.url)),
})
const app = buildServer(runtime, service, webRoot === undefined ? {} : { webRoot })

// What the upgrade did, before what the boot repaired. A migration that
// deletes rows says so through its note, and an upgrade that threw one away
// silently is not something to find out about later — this is the only moment
// anybody is looking.
for (const applied of service.store.migration.applied) {
  if (applied.note !== undefined) console.log(`migration ${applied.version}: ${applied.note}`)
}

if (service.reconciliation.closedRuns.length > 0) {
  console.log(
    `recovered ${service.reconciliation.closedRuns.length} run(s) left running by a previous stop`,
  )
}

/**
 * Stop, and stop even if stopping goes wrong.
 *
 * A signal has to be the end of the process, not a request that something
 * shuts down tidily. Anything that hangs here — an open stream, a store
 * mid-write, a plugin's own cleanup — leaves a process that is neither serving
 * nor gone, which is harder to diagnose than a crash.
 */
const SHUTDOWN_GRACE_MS = 3_000

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    const giveUp = setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS)
    giveUp.unref()
    void (async () => {
      try {
        await app.close()
        await service.close()
      } finally {
        process.exit(0)
      }
    })()
  })
}

const port = Number(process.env.FACTORY_PORT ?? 7317)
await app.listen({ host: '127.0.0.1', port })
console.log(`factory daemon listening on http://127.0.0.1:${port}`)
console.log(
  webRoot === undefined
    ? 'the board is not built — run `pnpm --filter @factory/web build` to serve it from here'
    : `the board is at http://127.0.0.1:${port}`,
)

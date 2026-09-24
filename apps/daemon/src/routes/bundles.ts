import type { FastifyInstance } from 'fastify'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { examplesRoot } from '@factory/core'
import {
  exportWorkflow,
  importBundle,
  readBundle,
  type ConflictPolicy,
  type ScopeKind,
} from '@factory/config'
import type { Runtime } from '@factory/runtime'
import type { Chains } from '../chains.js'

/**
 * Export and import, the sharing half of the definition layer.
 *
 * Both take `?project=`: you export the workflow that project actually runs,
 * and an import lands in that project's scope rather than the daemon's.
 */
export function registerBundleRoutes(
  app: FastifyInstance,
  runtime: Runtime,
  chains: Chains,
): void {
  app.post<{ Params: { name: string }; Querystring: { allowMissing?: string; project?: string } }>(
    '/api/workflows/:name/export',
    async (request, reply) => {
      const chain = chains.for(request.query.project)
      if (chain === undefined) {
        return reply.code(404).send({ error: `No project ${request.query.project}.` })
      }
      const result = exportWorkflow({
        chain,
        host: runtime.host,
        name: request.params.name,
        allowMissing: request.query.allowMissing === 'true',
      })
      if (result.text === undefined) return reply.code(400).send({ problems: result.problems })
      return { text: result.text, bundle: result.bundle, problems: result.problems }
    },
  )

  /**
   * The bundles Factory ships with.
   *
   * Findable at all, which they were not: the only way to import one was to
   * know a path inside `node_modules` and type it at a terminal. They are
   * served rather than imported here, so the existing import route stays the
   * one place a bundle is written — the board reads the text and posts it back
   * through the same door a person's own file goes through, preview and all.
   */
  app.get('/api/bundles/examples', async () => {
    const root = examplesRoot()
    const files = existsSync(root)
      ? readdirSync(root).filter((name) => name.endsWith('.bundle.yaml'))
      : []
    const items = files.map((file) => {
      const text = readFileSync(join(root, file), 'utf8')
      const read = readBundle(text, runtime.host)
      return {
        name: file.replace(/\.bundle\.yaml$/, ''),
        ...(read.bundle?.metadata?.description === undefined
          ? {}
          : { description: read.bundle.metadata.description }),
        workflows: read.bundle?.workflows?.length ?? 0,
        phases: read.bundle?.phases?.length ?? 0,
      }
    })
    return { items }
  })

  app.get<{ Params: { name: string } }>('/api/bundles/examples/:name', async (request, reply) => {
    // A name, never a path: `../../etc` is a filename Factory does not ship.
    if (!/^[a-z][a-z0-9-]*$/.test(request.params.name)) {
      return reply.code(400).send({ error: 'A bundle name is lower case, digits and dashes.' })
    }
    const file = join(examplesRoot(), `${request.params.name}.bundle.yaml`)
    if (!existsSync(file)) {
      return reply.code(404).send({ error: `Factory ships no bundle called "${request.params.name}".` })
    }
    return { name: request.params.name, text: readFileSync(file, 'utf8') }
  })

  app.post<{
    Body: { text?: string; scope?: ScopeKind; policy?: ConflictPolicy; prefix?: string }
    Querystring: { dryRun?: string; project?: string }
  }>('/api/bundles/import', async (request, reply) => {
    const chain = chains.for(request.query.project)
    if (chain === undefined) {
      return reply.code(404).send({ error: `No project ${request.query.project}.` })
    }
    const text = request.body?.text
    if (typeof text !== 'string') {
      return reply.code(400).send({ error: 'A bundle document is required in "text".' })
    }

    const read = readBundle(text, runtime.host)
    if (read.bundle === undefined) return reply.code(400).send({ problems: read.problems })

    // dryRun runs the same planner and skips the writes, so the preview a user
    // approves is the plan that gets applied -- not a second implementation of
    // it that can drift.
    const result = importBundle({
      chain,
      host: runtime.host,
      bundle: read.bundle,
      dryRun: request.query.dryRun === 'true',
      ...(request.body.scope === undefined ? {} : { scope: request.body.scope }),
      ...(request.body.policy === undefined ? {} : { policy: request.body.policy }),
      ...(request.body.prefix === undefined ? {} : { prefix: request.body.prefix }),
    })

    const blocked = result.problems.some((problem) => problem.severity === 'error')
    return reply.code(blocked ? 409 : 200).send(result)
  })
}

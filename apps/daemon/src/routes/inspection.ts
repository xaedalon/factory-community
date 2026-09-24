import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { PROVIDER_KIND, STEP_KIND, type ProviderCapability, type StepKindCapability } from '@factory/core'
import { doctorContext, planWorkflow, runDoctor } from '@factory/config'
import { runSetup, tokenDictionary } from '@factory/core'
import type { Runtime } from '@factory/runtime'
import type { Chains } from '../chains.js'

/** JSON Schema for a step kind's fields, or undefined if it cannot be described. */
function describeFields(kind: StepKindCapability): unknown {
  try {
    return z.toJSONSchema(kind.schema as never)
  } catch {
    // A schema with a transform or a cycle has no JSON Schema form. The builder
    // falls back to a raw editor for that kind rather than showing nothing.
    return undefined
  }
}

/**
 * What is installed, and whether it works.
 *
 * The builder needs these to render itself: the step-kind registry decides
 * which step editors exist, and the provider registry fills the agent
 * dropdown. A plugin's contribution shows up in the UI because it is here, not
 * because the UI was taught about it.
 */
export function registerInspectionRoutes(
  app: FastifyInstance,
  runtime: Runtime,
  chains: Chains,
): void {
  // With `?project=`, the chain that project's definitions resolve through —
  // which is the page's whole job: saying where a name comes from and where a
  // write would land. Without one, the daemon's own.
  app.get<{ Querystring: { project?: string } }>('/api/scopes', async (request, reply) => {
    const chain = chains.for(request.query.project)
    if (chain === undefined) {
      return reply.code(404).send({ error: `No project ${request.query.project}.` })
    }
    return {
      scopes: chain.scopes,
      defaultWriteScope: chain.defaultWriteScope,
      gitRoot: chain.gitRoot,
      startupProblems: runtime.startupProblems,
    }
  })

  app.get('/api/registries/step-kinds', async () => ({
    items: runtime.host.list<StepKindCapability>(STEP_KIND).map((entry) => ({
      id: entry.capability.id,
      summary: entry.capability.summary,
      // The builder greys out a kind it cannot run rather than offering a step
      // that would fail at the last moment.
      runnable: entry.capability.plan !== undefined,
      // The shorthand key, so the preview can elide `uses:` the way the writer
      // does -- `- run: npm test` rather than a two-line step.
      sugarKey: entry.capability.sugarKey,
      // The step's own schema, as JSON Schema.
      //
      // This is what makes "a plugin's step kind gets a form row with no
      // builder change" true rather than aspirational: the builder renders
      // fields from this, so a kind nobody wrote a UI for is still editable
      // with real controls instead of a raw text box.
      fields: describeFields(entry.capability),
      plugin: entry.plugin,
    })),
  }))

  /**
   * What `{{ namespace.key }}` may say.
   *
   * A registry like the other two, and served for the same reason: the builder
   * must not carry its own copy of a vocabulary core owns. The definition-
   * sourced namespaces come back with no keys — a workflow's `variables:` are
   * whatever that workflow declared, and the editor holding it is the only
   * thing that can say.
   */
  app.get('/api/registries/tokens', async () => ({ items: tokenDictionary() }))

  app.get('/api/registries/providers', async () => ({
    items: runtime.host.list<ProviderCapability>(PROVIDER_KIND).map((entry) => ({
      id: entry.capability.id,
      displayName: entry.capability.displayName,
      supports: entry.capability.descriptor.supports,
      models: entry.capability.descriptor.models,
      effortValues: entry.capability.descriptor.effortValues,
      provisional: entry.capability.descriptor.provisional,
      available: entry.capability.availability(runtime.env).available,
      // Whether this CLI can be told that one command is allowed rather than
      // all of them. Absent means a custom profile's command list does not
      // reach it — which the profile editor says out loud, because it is true
      // and invisible in the YAML.
      ...(entry.capability.descriptor.commandAllowFlag === undefined
        ? {}
        : { commandAllowFlag: entry.capability.descriptor.commandAllowFlag }),
    })),
  }))

  // Always 200: the report *is* the answer, and a client that has to branch on
  // the status code before it can render the findings is worse off. Errors are
  // in the payload, where the caller can show them.
  /**
   * What is still missing, as opposed to what is wrong.
   *
   * Served from here rather than worked out by the client, because half the
   * answer is in the database this process owns and the other half is in files
   * only it can see.
   */
  app.get('/api/setup', async () => runSetup({ host: runtime.host, env: runtime.env }))

  app.get('/api/doctor', async () => {
    const report = await runDoctor(
      doctorContext({ chain: runtime.chain, host: runtime.host, env: runtime.env }),
    )
    return {
      // Startup, then what has gone wrong since, then what the rules found.
      // The middle one used to have nowhere to go.
      problems: [...runtime.startupProblems, ...runtime.problems, ...report.problems],
      checked: report.checked,
    }
  })

  app.post<{
    Params: { name: string }
    Body: { workspace?: string }
    Querystring: { project?: string }
  }>(
    '/api/workflows/:name/plan',
    async (request, reply) => {
      const chain = chains.for(request.query.project)
      if (chain === undefined) {
        return reply.code(404).send({ error: `No project ${request.query.project}.` })
      }
      const result = planWorkflow({
        chain,
        host: runtime.host,
        workflow: request.params.name,
        workspace: request.body?.workspace ?? runtime.cwd,
        // A throwaway id, so the preview shows the shape of the real command
        // rather than one with the session flags quietly missing. It changes
        // every time this is asked, which is honest: no session exists yet, and
        // printing a fixed id somebody might copy would be worse.
        session: { id: randomUUID(), started: false },
      })
      return reply.code(result.plan === undefined ? 400 : 200).send(result)
    },
  )
}

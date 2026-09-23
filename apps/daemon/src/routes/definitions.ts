import type { FastifyInstance } from 'fastify'
import {
  parseAgentFile,
  parsePhaseFile,
  parseWorkflowFile,
  writeNewAgent,
  writeNewPhase,
  writeNewWorkflow,
  type Agent,
  type Phase,
  type Problem,
  type Workflow,
  resolveNeeds,
  unavailableFor,
  type ProjectFacilities,
} from '@factory/core'
import {
  DEFINITION_KINDS,
  deleteDefinition,
  isDefinitionKind,
  etagOf,
  explain,
  listDefinitions,
  resolveAgent,
  resolvePhase,
  resolveWorkflow,
  writeDefinition,
  type DefinitionKind,
  type ScopeChain,
  type ScopeKind,
} from '@factory/config'
import type { Runtime } from '@factory/runtime'
import type { Chains } from '../chains.js'

/**
 * Definitions over HTTP.
 *
 * Phases get the same treatment as workflows, including DELETE. In the
 * prototype a phase had no routes of its own, so one shared by two workflows
 * was rewritten wholesale by whichever workflow was saved last.
 *
 * Every route here takes an optional `?project=`, because a definition's name
 * only means something inside a scope chain and a project has its own. Reads
 * and writes both: once the board lists a project's workflows, saving one back
 * has to land in that project rather than forking a copy into whichever
 * directory the daemon was started in.
 */
export function registerDefinitionRoutes(
  app: FastifyInstance,
  runtime: Runtime,
  chains: Chains,
  /**
   * The project a `?project=` names, when this process has a database.
   *
   * Optional because the definition API is also served by a process with no
   * store at all — `factory --serve` — where there are no projects to ask
   * about and every workflow is simply listed.
   */
  projects?: { get: (id: string) => ProjectFacilities | undefined },
): void {
  /**
   * The list, with whatever the chosen workflows need filled in.
   *
   * Resolved here rather than in the browser because the walk — transitive,
   * topological, cycle-aware — is core's, and a second copy in the builder
   * would be a second answer to "what does verify need". The board already
   * asks the daemon to render its YAML preview for the same reason.
   */
  app.post<{ Body: { workflows?: unknown }; Querystring: InProject }>(
    '/api/workflows/resolve',
    async (request, reply) => {
      const chain = chains.for(request.query.project)
      if (chain === undefined) return unknownProject(reply, request.query.project)
      const wanted = request.body?.workflows
      if (!Array.isArray(wanted) || wanted.some((name) => typeof name !== 'string')) {
        return reply.code(400).send({ error: 'Send { workflows: [...] }.' })
      }
      const resolved = resolveNeeds(wanted as string[], (name) => {
        const found = resolveWorkflow(chain, name)
        return found?.value === undefined ? undefined : found.value.needs
      })
      return { order: resolved.order, added: resolved.added, problems: resolved.problems }
    },
  )

  for (const kind of DEFINITION_KINDS) {
    const plural = `${kind}s`

    app.get<{ Querystring: InProject }>(`/api/${plural}`, async (request, reply) => {
      const chain = chains.for(request.query.project)
      if (chain === undefined) return unknownProject(reply, request.query.project)
      const items = listDefinitions(chain, kind, parserFor(kind, runtime))
      if (kind !== 'workflow' || request.query.project === undefined) return { items }

      // Marked, not filtered. The file exists and is still the project's to
      // read, edit and delete — it is only the list of *what to run next* that
      // has no business offering it. Which of those a page wants is the page's
      // decision, and it needs the reason to say anything useful.
      const project = projects?.get(request.query.project)
      if (project === undefined) return { items }
      return {
        items: items.map((item) => {
          const workflow = item.value as Workflow | undefined
          const unavailable = unavailableFor(workflow?.conditions, project)
          return {
            ...item,
            // Lifted out of `value` explicitly. The parsed definition rides
            // along as `unknown` by design, and asking the browser to interpret
            // it would make every client a second parser.
            ...(workflow === undefined || workflow.needs.length === 0
              ? {}
              : { needs: workflow.needs }),
            ...(unavailable === undefined ? {} : { unavailable }),
          }
        }),
      }
    })

    app.get<{ Params: { name: string }; Querystring: InProject }>(
      `/api/${plural}/:name`,
      async (request, reply) => {
      const chain = chains.for(request.query.project)
      if (chain === undefined) return unknownProject(reply, request.query.project)
      const resolved = resolveOne(kind, chain, runtime, request.params.name)
      if (resolved === undefined) {
        return reply.code(404).send({ error: `No ${kind} named "${request.params.name}".` })
      }
      return {
        ref: resolved.ref,
        definition: resolved.value,
        // The bytes and their hash travel together: the client edits the value
        // and hands the etag back, which is what makes a concurrent edit
        // detectable rather than silently overwritten.
        raw: resolved.raw,
        etag: etagOf(resolved.raw),
        shadows: resolved.shadows,
        problems: resolved.problems,
      }
      },
    )

    app.get<{ Params: { name: string }; Querystring: InProject }>(
      `/api/${plural}/:name/why`,
      async (request, reply) => {
        const chain = chains.for(request.query.project)
        if (chain === undefined) return unknownProject(reply, request.query.project)
        return { candidates: explain(chain, kind, request.params.name) }
      },
    )

    app.post<{ Body: WriteBody; Querystring: InProject }>(`/api/${plural}`, async (request, reply) => {
      const chain = chains.for(request.query.project)
      if (chain === undefined) return unknownProject(reply, request.query.project)
      const outcome = await write(kind, request.body, chain, runtime, { create: true })
      if (outcome.status === 'refused') return reply.code(400).send({ problems: outcome.problems })
      if (outcome.status === 'exists') {
        return reply
          .code(409)
          .send({ error: `A ${kind} named "${request.body.definition?.name}" already exists here.` })
      }
      return reply.code(201).send(outcome)
    })

    app.put<{ Params: { name: string }; Body: WriteBody; Querystring: InProject }>(
      `/api/${plural}/:name`,
      async (request, reply) => {
        const chain = chains.for(request.query.project)
        if (chain === undefined) return unknownProject(reply, request.query.project)
        if (request.body?.definition?.name !== request.params.name) {
          return reply.code(400).send({
            error: `The body names "${request.body?.definition?.name}" but the URL says "${request.params.name}".`,
          })
        }
        const outcome = await write(kind, request.body, chain, runtime, { create: false })
        if (outcome.status === 'refused') return reply.code(400).send({ problems: outcome.problems })
        if (outcome.status === 'stale') {
          // 409 with the current content, so the caller can show a diff instead
          // of just being told no.
          return reply.code(409).send({
            error: 'This file changed on disk since you opened it.',
            etag: outcome.etag,
            raw: outcome.raw,
          })
        }
        return outcome
      },
    )

    app.delete<{ Params: { name: string }; Querystring: { scope?: ScopeKind } & InProject }>(
      `/api/${plural}/:name`,
      async (request, reply) => {
        const chain = chains.for(request.query.project)
        if (chain === undefined) return unknownProject(reply, request.query.project)
        const outcome = deleteDefinition({
          chain,
          kind,
          name: request.params.name,
          ...(request.query.scope === undefined ? {} : { scope: request.query.scope }),
        })
        if (!outcome.deleted) {
          return reply.code(404).send({ error: `No ${kind} named "${request.params.name}" there.` })
        }
        return outcome
      },
    )
  }

  /**
   * The canonical rendering of a definition, without writing it.
   *
   * The builder renders its YAML preview in the browser with the same
   * serializer. This endpoint exists so a contract test can assert the two
   * agree — otherwise "what you see" and "what is written" are two
   * implementations that only have to look alike.
   */
  app.post<{ Body: { kind: DefinitionKind; definition: unknown } }>(
    '/api/definitions/preview',
    async (request, reply) => {
      const { kind, definition } = request.body ?? {}
      if (kind === undefined || !isDefinitionKind(kind)) {
        return reply
          .code(400)
          .send({ error: `kind must be one of ${DEFINITION_KINDS.join(', ')}.` })
      }
      try {
        const text = renderOne(kind, definition, runtime)
        return { text }
      } catch (error) {
        return reply.code(400).send({ error: describe(error) })
      }
    },
  )
}

/** Whose definitions this request is about. Absent means the daemon's own. */
interface InProject {
  project?: string
}

const unknownProject = (
  reply: { code: (n: number) => { send: (body: unknown) => unknown } },
  id: string | undefined,
) => reply.code(404).send({ error: `No project ${id}.` })

interface WriteBody {
  definition?: Workflow | Phase | Agent
  scope?: ScopeKind
  etag?: string
}

async function write(
  kind: DefinitionKind,
  body: WriteBody | undefined,
  chain: ScopeChain,
  runtime: Runtime,
  options: { create: boolean },
) {
  const definition = body?.definition
  if (definition === undefined || typeof definition.name !== 'string') {
    return { status: 'refused' as const, problems: [
      { severity: 'error' as const, message: 'A definition with a name is required.', rule: 'api.badRequest' },
    ] }
  }
  // A scope that is not in this chain, or one that is read-only. Both are
  // ordinary — a repository registered before Factory created a scope for one,
  // or a built-in somebody tried to save over — and both threw, which reached
  // the client as a 500 nobody can act on. The sentence the config package
  // wrote already says what to do; this only stops it being called a fault.
  try {
    return await writeDefinition({
      chain,
      host: runtime.host,
      // What makes the two definition hooks real. The host is the only thing
      // that has them, and this is the route every editor's save goes through.
      hooks: runtime.host.hooks,
      kind,
      definition,
      ...(body?.scope === undefined ? {} : { scope: body.scope }),
      // On create there is nothing to be stale about; on update the caller must
      // say which version it edited.
      ...(options.create || body?.etag === undefined ? {} : { expectEtag: body.etag }),
    })
  } catch (error) {
    return {
      status: 'refused' as const,
      problems: [
        {
          severity: 'error' as const,
          message: error instanceof Error ? error.message : String(error),
          rule: 'api.noWritableScope',
        },
      ],
    }
  }
}

/**
 * Reading, resolving and rendering, one entry per kind.
 *
 * Written as `Record<DefinitionKind, …>` rather than as ternaries: a ternary's
 * else branch silently absorbs every kind added later, and that is exactly how
 * a third one would end up being parsed as a phase.
 */
const parserFor = (kind: DefinitionKind, runtime: Runtime) => {
  const parsers: Record<DefinitionKind, (text: string, file: string) => Parsed> = {
    workflow: (text, file) => {
      const r = parseWorkflowFile(text, file)
      return { value: r.value, problems: r.problems }
    },
    phase: (text, file) => {
      const r = parsePhaseFile(text, runtime.host, file)
      return { value: r.value, problems: r.problems }
    },
    agent: (text, file) => {
      const r = parseAgentFile(text, file)
      return { value: r.value, problems: r.problems }
    },
  }
  return parsers[kind]
}

interface Parsed {
  value: unknown
  problems: readonly Problem[]
}

const resolveOne = (kind: DefinitionKind, chain: ScopeChain, runtime: Runtime, name: string) => {
  const lookups: Record<DefinitionKind, () => unknown> = {
    workflow: () => resolveWorkflow(chain, name),
    phase: () => resolvePhase(chain, runtime.host, name),
    agent: () => resolveAgent(chain, name),
  }
  return lookups[kind]() as ReturnType<typeof resolveWorkflow>
}

const renderOne = (kind: DefinitionKind, definition: unknown, runtime: Runtime): string => {
  const writers: Record<DefinitionKind, () => string> = {
    workflow: () => writeNewWorkflow(definition as Workflow),
    phase: () => writeNewPhase(definition as Phase, runtime.host),
    agent: () => writeNewAgent(definition as Agent),
  }
  return writers[kind]()
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

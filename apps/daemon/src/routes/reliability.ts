import type { FastifyInstance } from 'fastify'
import {
  DEFAULT_RELIABILITY_POLICY,
  DRIVER_ACTIONS,
  RELIABILITY_EVALUATOR_KIND,
  capsFor,
  moveDriver,
  nextActions,
  parseInitiator,
  type DriverAction,
  type DriverStatus,
  type Initiator,
  type ReliabilityCap,
  type ReliabilityDriver,
  type ReliabilityEvaluatorCapability,
} from '@factory/core'
import { assessReliability } from '@factory/engine'
import type { Runtime } from '@factory/runtime'
import type { Service } from '../service.js'

/**
 * A task's reliability, over HTTP.
 *
 * Thin, like every route here: the judgement is the engine's and the rules are
 * core's. What this owns is the one thing a route must — establishing who is
 * asking, because the authority rule depends on it and a rule only the client
 * enforces is advice.
 *
 * There is **no route that sets a score**, and there is not going to be one. A
 * scenario asserts it does not exist.
 */
export function registerReliabilityRoutes(
  app: FastifyInstance,
  service: Service,
  runtime: Runtime,
): void {
  const { tasks, reliability } = service
  const policy = DEFAULT_RELIABILITY_POLICY

  const notFound = (reply: { code: (n: number) => { send: (v: unknown) => unknown } }, id: string) =>
    reply.code(404).send({ error: `No task ${id}.` })

  /** The cap rules, bound to the policy, for the estimates that need them. */
  const caps = (drivers: readonly ReliabilityDriver[]): readonly ReliabilityCap[] =>
    capsFor(drivers, policy, [], [])

  // One assembly of "what is this task's reliability right now", in the service
  // — so the task detail payload and these routes cannot describe the same task
  // differently.
  const summaryFor = service.reliabilitySummary

  app.get<{ Params: { id: string } }>('/api/tasks/:id/reliability', async (request, reply) => {
    const task = tasks.get(request.params.id)
    if (task === undefined) return notFound(reply, request.params.id)
    return { reliability: summaryFor(task.id) }
  })

  app.get<{ Params: { id: string } }>(
    '/api/tasks/:id/reliability/history',
    async (request, reply) => {
      const task = tasks.get(request.params.id)
      if (task === undefined) return notFound(reply, request.params.id)
      return { items: reliability.history(task.id) }
    },
  )

  app.get<{ Params: { id: string }; Querystring: { status?: string; owner?: string } }>(
    '/api/tasks/:id/reliability/drivers',
    async (request, reply) => {
      const task = tasks.get(request.params.id)
      if (task === undefined) return notFound(reply, request.params.id)
      const { status, owner } = request.query
      const items = reliability
        .drivers(task.id)
        .filter((driver) => status === undefined || driver.status === status)
        .filter((driver) => owner === undefined || driver.owner === owner)
      return { items }
    },
  )

  app.get<{ Params: { id: string } }>(
    '/api/tasks/:id/reliability/next-actions',
    async (request, reply) => {
      const task = tasks.get(request.params.id)
      if (task === undefined) return notFound(reply, request.params.id)
      const newest = reliability.newest(task.id)
      const actions = nextActions(
        reliability.drivers(task.id),
        newest?.score ?? 0,
        caps,
        service.workflowNames(task.projectId),
      )
      return { currentScore: newest?.score, actions }
    },
  )

  app.post<{ Params: { id: string }; Body: { initiator?: unknown } }>(
    '/api/tasks/:id/reliability/assess',
    async (request, reply) => {
      const task = tasks.get(request.params.id)
      if (task === undefined) return notFound(reply, request.params.id)
      const evaluators = runtime.host
        .list<ReliabilityEvaluatorCapability>(RELIABILITY_EVALUATOR_KIND)
        .map((entry) => entry.capability)
      const outcome = await assessReliability({
        taskId: task.id,
        task: { name: task.name, description: task.description },
        reliability,
        evaluators,
        policy,
        trigger: 'manual',
        workflows: service.workflowNames(task.projectId),
      })
      return {
        reliability: summaryFor(task.id),
        assessed: outcome.assessment !== undefined,
        problems: outcome.problems,
      }
    },
  )

  app.post<{
    Params: { id: string; driverId: string; action: string }
    Body: { reason?: unknown; by?: unknown; initiator?: unknown }
  }>('/api/tasks/:id/reliability/drivers/:driverId/:action', async (request, reply) => {
    const task = tasks.get(request.params.id)
    if (task === undefined) return notFound(reply, request.params.id)
    const driver = reliability.driver(request.params.driverId)
    if (driver === undefined || driver.taskId !== task.id) {
      return reply.code(404).send({ error: `No reliability driver ${request.params.driverId}.` })
    }

    const action = request.params.action
    if (!isDriverAction(action)) {
      return reply.code(400).send({ error: `"${action}" is not something to do to a driver.` })
    }

    let initiator: Initiator | undefined
    try {
      initiator = parseInitiator(request.body?.initiator)
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }

    // The authority fact, and it is not self-reported: `runId` comes from the
    // environment Factory stamped into the agent process it launched. A client
    // may omit it, which makes it look like a person — the direction that loses
    // authority rather than gains it.
    const byAgent = initiator?.runId !== undefined
    const outcome = moveDriver(driver, action, { byAgent })
    if ('code' in outcome) {
      return reply.code(409).send({
        error: outcome.message,
        code: outcome.code,
        status: driver.status,
        actions: outcome.actions,
      })
    }

    const reason = typeof request.body?.reason === 'string' ? request.body.reason : undefined
    const by = typeof request.body?.by === 'string' ? request.body.by : undefined
    reliability.setDriverStatus(driver.id, outcome.status as DriverStatus, {
      ...(outcome.status === 'accepted' ? { acceptedBy: by ?? 'a person' } : {}),
      ...(reason === undefined ? {} : { reason }),
    })

    // Re-judged immediately: a driver that stopped applying has changed the
    // score, and leaving that until the next run would show a number that
    // contradicts the list underneath it.
    const evaluators = runtime.host
      .list<ReliabilityEvaluatorCapability>(RELIABILITY_EVALUATOR_KIND)
      .map((entry) => entry.capability)
    const assessment = await assessReliability({
      taskId: task.id,
      task: { name: task.name, description: task.description },
      reliability,
      evaluators,
      policy,
      trigger: outcome.status === 'accepted' ? 'driver_accepted' : 'driver_resolved',
      workflows: service.workflowNames(task.projectId),
    })

    return {
      driver: reliability.driver(driver.id),
      reliability: summaryFor(task.id),
      problems: assessment.problems,
    }
  })
}

/** Core owns the vocabulary; this only asks whether a string is in it. */
function isDriverAction(value: string): value is DriverAction {
  return (DRIVER_ACTIONS as readonly string[]).includes(value)
}

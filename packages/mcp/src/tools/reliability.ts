import { z } from 'zod'
import { defineTool, type McpTool } from '../tool.js'
import { asToolError } from '../errors.js'
import { resolveProject } from '../project.js'

/**
 * How much to trust a task, for an agent.
 *
 * The most useful surface here is `factory_reliability_next_actions`: an agent
 * that can ask "what is the highest-value thing I can do about this task
 * without a person" is an agent that can keep working, and that question is the
 * whole point of the owner field.
 *
 * Two mutations, and one thing deliberately absent. There is no tool that sets
 * a score — not a refusing one, none at all — and a scenario asserts it. And
 * `factory_reliability_accept_driver` is offered, but the daemon refuses it for
 * a critical or high finding when the caller carries a run Factory stamped:
 * an acceptance an agent can grant itself is not a gate, which is the same
 * argument that keeps `approve` off this surface entirely.
 */

const TASK = z.string().describe('The task id, or the short form the listing prints.')

const PROJECT = z
  .string()
  .optional()
  .describe('Project id, name or path. Defaults to the one this directory is in.')

/** The wire shapes, as the daemon sends them. */
interface Summary {
  state: string
  score?: number
  rawScore?: number
  coverage?: number
  delta?: number
  dimensions?: Record<string, number>
  caps?: { type: string; value: number; reason: string }[]
  staleReason?: string
  attention: {
    agent: number
    developer: number
    either: number
    external: number
    potential: Record<string, number>
  }
}

interface Driver {
  id: string
  title: string
  description: string
  type: string
  severity: string
  status: string
  owner: string
  dimension: string
  scoreImpact: number
  recommendedAction?: { type: string; label: string; workflow?: string }
}

/**
 * The summary, with the empty parts left out.
 *
 * `briefTask` established the rule: a field that says nothing costs a model
 * context and reads as meaningful. An unassessed task returns three words
 * rather than a shape full of nulls.
 */
function brief(summary: Summary): Record<string, unknown> {
  if (summary.state === 'unassessed') {
    return {
      state: 'unassessed',
      next: 'Run a workflow, or call factory_reliability_assess, to create the first judgement.',
    }
  }
  const attention = summary.attention
  const waiting = attention.agent + attention.developer + attention.either + attention.external
  return {
    state: summary.state,
    score: summary.score,
    coverage: summary.coverage,
    ...(summary.delta === undefined || summary.delta === 0 ? {} : { delta: summary.delta }),
    ...(summary.rawScore === summary.score ? {} : { beforeCaps: summary.rawScore }),
    ...(summary.dimensions === undefined ? {} : { dimensions: summary.dimensions }),
    ...(summary.caps === undefined || summary.caps.length === 0 ? {} : { caps: summary.caps }),
    ...(summary.staleReason === undefined ? {} : { stale: summary.staleReason }),
    needsAttention: {
      agent: attention.agent,
      developer: attention.developer,
      either: attention.either,
      external: attention.external,
    },
    next:
      waiting === 0
        ? 'Nothing is outstanding.'
        : attention.agent > 0
          ? 'Call factory_reliability_next_actions for the highest-value thing you can do.'
          : 'Everything outstanding needs a person.',
  }
}

function briefDriver(driver: Driver): Record<string, unknown> {
  return {
    id: driver.id,
    title: driver.title,
    ...(driver.description === '' ? {} : { description: driver.description }),
    type: driver.type,
    severity: driver.severity,
    status: driver.status,
    owner: driver.owner,
    dimension: driver.dimension,
    ...(driver.scoreImpact === 0 ? {} : { scoreImpact: driver.scoreImpact }),
    ...(driver.recommendedAction === undefined
      ? {}
      : { recommendedAction: driver.recommendedAction }),
  }
}

export const reliabilityTools: readonly McpTool[] = [
  defineTool({
    name: 'factory_reliability_get',
    title: "How much to trust a task's current solution",
    description:
      'The reliability score, the evidence coverage behind it, the per-dimension breakdown, ' +
      'any ceilings a known risk has applied, and how much uncertainty is waiting for whom. ' +
      'A task nobody has judged comes back "unassessed" — not zero.',
    schema: z.object({ task: TASK, project: PROJECT }),
    run: async (input, context) => {
      const found = await resolveProject({ api: context.api, cwd: context.cwd, given: input.project })
      try {
        const reply = await context.api.request<{ reliability: Summary }>(
          `/api/tasks/${encodeURIComponent(input.task)}/reliability`,
        )
        return { task: input.task, project: found.project.name, ...brief(reply.reliability) }
      } catch (error) {
        throw asToolError(error)
      }
    },
  }),

  defineTool({
    name: 'factory_reliability_drivers',
    title: 'What is holding a task back',
    description:
      'The findings that are costing trust, each with a severity, an owner and what would ' +
      'resolve it. Filter by status or owner — `owner: "agent"` is the list you can work ' +
      'through without a person.',
    schema: z.object({
      task: TASK,
      project: PROJECT,
      status: z
        .enum(['open', 'investigating', 'resolved', 'accepted', 'invalidated', 'superseded'])
        .optional()
        .describe('Only drivers in this state. Omit for all of them.'),
      owner: z
        .enum(['agent', 'developer', 'either', 'external'])
        .optional()
        .describe('Only drivers this actor should resolve.'),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    run: async (input, context) => {
      await resolveProject({ api: context.api, cwd: context.cwd, given: input.project })
      const query = new URLSearchParams()
      if (input.status !== undefined) query.set('status', input.status)
      if (input.owner !== undefined) query.set('owner', input.owner)
      const suffix = query.toString() === '' ? '' : `?${query.toString()}`
      try {
        const reply = await context.api.request<{ items: Driver[] }>(
          `/api/tasks/${encodeURIComponent(input.task)}/reliability/drivers${suffix}`,
        )
        const items = reply.items.slice(0, input.limit ?? 20)
        return {
          task: input.task,
          count: reply.items.length,
          drivers: items.map(briefDriver),
        }
      } catch (error) {
        throw asToolError(error)
      }
    },
  }),

  defineTool({
    name: 'factory_reliability_history',
    title: 'How a task became as trustworthy as it is',
    description:
      'Every judgement, oldest first, with what moved the score and why. The score may go ' +
      'down: a validation that finds a regression has learned something, and that is the ' +
      'system working rather than failing.',
    schema: z.object({ task: TASK, project: PROJECT }),
    run: async (input, context) => {
      await resolveProject({ api: context.api, cwd: context.cwd, given: input.project })
      try {
        const reply = await context.api.request<{
          items: {
            sequence: number
            workflow?: string
            score: number
            coverage: number
            delta: number
            summary: string
            createdAt: string
            explanation: { causes: { summary: string; amount: number }[] }
          }[]
        }>(`/api/tasks/${encodeURIComponent(input.task)}/reliability/history`)
        return {
          task: input.task,
          assessments: reply.items.map((entry) => ({
            sequence: entry.sequence,
            ...(entry.workflow === undefined ? {} : { workflow: entry.workflow }),
            score: entry.score,
            coverage: entry.coverage,
            ...(entry.delta === 0 ? {} : { delta: entry.delta }),
            summary: entry.summary,
            ...(entry.explanation.causes.length === 0
              ? {}
              : { why: entry.explanation.causes.map((cause) => cause.summary) }),
            at: entry.createdAt,
          })),
        }
      } catch (error) {
        throw asToolError(error)
      }
    },
  }),

  defineTool({
    name: 'factory_reliability_next_actions',
    title: 'The highest-value thing to do about a task next',
    description:
      'Ranked by how far resolving each would move the score, which accounts for ceilings a ' +
      'finding is holding as well as its own cost. `owner: "agent"` means you can do it. ' +
      'The numbers are estimates, not promises.',
    schema: z.object({ task: TASK, project: PROJECT }),
    run: async (input, context) => {
      await resolveProject({ api: context.api, cwd: context.cwd, given: input.project })
      try {
        return await context.api.request(
          `/api/tasks/${encodeURIComponent(input.task)}/reliability/next-actions`,
        )
      } catch (error) {
        throw asToolError(error)
      }
    },
  }),

  defineTool({
    name: 'factory_reliability_resolve_driver',
    title: 'Say a finding is no longer true',
    description:
      'Resolving means the thing has stopped being the case — which is a claim evidence can ' +
      'check, so an agent may make it. It is not the same as accepting the risk, which means ' +
      'the finding is still true and somebody decided to live with it.',
    schema: z.object({
      task: TASK,
      driver: z.string().describe('The driver id.'),
      reason: z.string().optional().describe('What changed, for the record.'),
      project: PROJECT,
    }),
    run: async (input, context) => {
      await resolveProject({ api: context.api, cwd: context.cwd, given: input.project })
      try {
        const reply = await context.api.request<{ driver: Driver; reliability: Summary }>(
          `/api/tasks/${encodeURIComponent(input.task)}/reliability/drivers/` +
            `${encodeURIComponent(input.driver)}/resolve`,
          {
            method: 'POST',
            body: {
              ...(input.reason === undefined ? {} : { reason: input.reason }),
              ...(context.initiator === undefined ? {} : { initiator: context.initiator }),
            },
          },
        )
        return { driver: briefDriver(reply.driver), ...brief(reply.reliability) }
      } catch (error) {
        throw asToolError(error)
      }
    },
  }),

  defineTool({
    name: 'factory_reliability_accept_driver',
    title: 'Record that a risk is being lived with',
    description:
      'Accepting means the finding is still true and somebody decided it does not matter — ' +
      'so **a person has to be the one asking** for anything critical or high, and the daemon ' +
      'refuses it otherwise. Use factory_reliability_resolve_driver when the thing has ' +
      'actually stopped being true.',
    schema: z.object({
      task: TASK,
      driver: z.string().describe('The driver id.'),
      reason: z.string().describe('Why this risk is acceptable. Required — it is the record.'),
      project: PROJECT,
    }),
    run: async (input, context) => {
      await resolveProject({ api: context.api, cwd: context.cwd, given: input.project })
      try {
        const reply = await context.api.request<{ driver: Driver; reliability: Summary }>(
          `/api/tasks/${encodeURIComponent(input.task)}/reliability/drivers/` +
            `${encodeURIComponent(input.driver)}/accept`,
          {
            method: 'POST',
            body: {
              reason: input.reason,
              ...(context.initiator === undefined ? {} : { initiator: context.initiator }),
            },
          },
        )
        return { driver: briefDriver(reply.driver), ...brief(reply.reliability) }
      } catch (error) {
        throw asToolError(error)
      }
    },
  }),
]

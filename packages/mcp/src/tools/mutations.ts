import { z } from 'zod'
import { REQUESTABLE_ACTIONS, type AvailableAction, type Task, type Workflow } from '@factory/core'
import { defineTool, type McpTool, type ToolContext } from '../tool.js'
import { resolveProject } from '../project.js'
import { asToolError } from '../errors.js'
import { briefTask, type TaskListItem } from './tasks.js'

/**
 * The tools that change something.
 *
 * Every one of them is a request to a route the board also uses, which is what
 * makes the guarantees free: the disclaimer gate, the profile the project
 * resolves to, the workspace boundary and the refusal of an illegal transition
 * all apply because there is one door, not because this file remembered them.
 *
 * Two things are deliberately absent. There is no tool to start a run, because
 * queueing a task is what starts work; and none to cancel one, because
 * cancelling a task is what stops work — the engine kills the process group on
 * any transition to `cancelled`, whoever asked for it.
 */

interface TaskReply {
  readonly task: Task
  readonly actions: readonly AvailableAction[]
}

/**
 * What an agent may ask for, which is not everything a person may.
 *
 * `approve` and `reject` are absent, and that is the enforcement rather than a
 * suggestion. Factory can tell an agent it launched from a person's own session
 * — the first carries the run it is inside, the second carries nothing — but it
 * cannot tell a person's session from an agent acting unasked *in* that
 * session, because they are the same process with the same environment. An
 * approval an agent can give is not a gate, so it is not offered here at all.
 *
 * The daemon still refuses an approval from inside the branch that asked for
 * the work: this surface is not the only client, and a rule only one client
 * enforces is advice.
 *
 * Everything else comes from core's published list rather than a copy — the CLI
 * kept one of those, with a comment saying the daemon had the final say, which
 * is right until somebody adds a ninth move.
 */
export const AGENT_ACTIONS: readonly string[] = REQUESTABLE_ACTIONS.filter(
  (action) => action !== 'approve' && action !== 'reject',
)

const PROJECT = z
  .string()
  .optional()
  .describe('A project id, its name, or an absolute path inside it. Defaults to where this server runs.')

const WORKFLOWS = z
  .array(z.string())
  .optional()
  .describe(
    'Workflow names, in the order they should run. Use factory_workflow_list first: a name that ' +
      'is not offered there will not resolve when the task runs.',
  )

/**
 * What to do next with a task, from the actions the daemon just served.
 *
 * Read off the reply rather than off the state, so it can never suggest
 * something the very next request would refuse.
 */
const nextFrom = (actions: readonly AvailableAction[], state: string): string => {
  const offered = new Set(actions.map((action) => action.action))
  if (state === 'awaiting_approval') {
    return 'A person has to approve or reject this. You may not, even if you created it.'
  }
  if (state === 'running') return 'It is running. Read its newest run to follow along.'
  if (offered.has('queue')) {
    return 'Queue it with factory_task_act when the plan is right.'
  }
  return `Nothing further to ask for: it is ${state}.`
}

const shape = (reply: TaskReply) => ({
  task: briefTask({ ...reply.task, actions: reply.actions } as TaskListItem),
  next: nextFrom(reply.actions, reply.task.state),
})

export const mutationTools: readonly McpTool[] = [
  defineTool({
    name: 'factory_task_create',
    title: 'Create a Factory task',
    description:
      'Create a task in a project. A task is a piece of work with an ordered list of workflows; ' +
      'creating one starts nothing. Queue it with factory_task_act when the plan is right.',
    schema: z.object({
      name: z.string().min(1).describe('What the work is, in a few words.'),
      description: z
        .string()
        .optional()
        .describe('What the work is for. Steps read it as {{ task.description }}.'),
      project: PROJECT,
      workflows: WORKFLOWS,
      ticketId: z.string().optional().describe('An id from wherever the work was asked for.'),
      branch: z.string().optional().describe('The branch its work belongs on.'),
    }),
    run: async (input, context) => {
      const found = await resolveProject({
        api: context.api,
        cwd: context.cwd,
        given: input.project,
      })
      const reply = await post<TaskReply>(context, '/api/tasks', {
        name: input.name,
        projectId: found.project.id,
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.ticketId === undefined ? {} : { ticketId: input.ticketId }),
        ...(input.branch === undefined ? {} : { branch: input.branch }),
        ...(input.workflows === undefined ? {} : { workflows: input.workflows }),
      })
      return { ...shape(reply), project: { id: found.project.id, name: found.project.name } }
    },
  }),

  defineTool({
    name: 'factory_task_update',
    title: 'Change a Factory task',
    description:
      'Change a task’s name, what it is for, or which workflows it runs. Factory refuses a ' +
      'change to the plan of a task that is in flight, and refuses to remove a workflow that has ' +
      'already run.',
    schema: z.object({
      task: z.string().describe('The task id.'),
      name: z.string().min(1).optional(),
      description: z.string().optional(),
      workflows: WORKFLOWS,
    }),
    run: async (input, context) => {
      const body = {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.workflows === undefined ? {} : { workflows: input.workflows }),
      }
      if (Object.keys(body).length === 0) {
        throw asToolError(new Error('Say what to change: a name, a description or workflows.'))
      }
      const reply = await request<TaskReply>(
        context,
        `/api/tasks/${encodeURIComponent(input.task)}`,
        'PATCH',
        body,
      )
      return shape(reply)
    },
  }),

  defineTool({
    name: 'factory_task_act',
    title: 'Do something to a Factory task',
    description:
      'Queue a task, cancel it, retry it, archive it. **Queueing is what starts work and ' +
      'cancelling is what stops it** — there is no separate run to start or stop. Ask ' +
      'factory_task_get first: a task carries the actions it will accept, and anything else is ' +
      'refused. Approving and rejecting belong to a person.',
    schema: z.object({
      task: z.string().describe('The task id.'),
      action: z
        .enum(AGENT_ACTIONS as unknown as [string, ...string[]])
        .describe('One of the actions the task currently offers.'),
      reason: z.string().optional().describe('Why, for the task’s history.'),
    }),
    run: async (input, context) => {
      const reply = await post<TaskReply>(
        context,
        `/api/tasks/${encodeURIComponent(input.task)}/actions/${encodeURIComponent(input.action)}`,
        input.reason === undefined ? {} : { reason: input.reason },
      )
      return { did: input.action, ...shape(reply) }
    },
  }),

  defineTool({
    name: 'factory_workflow_create',
    title: 'Write a workflow',
    description:
      'Write a workflow into a project. Give `from` to start from one that already exists — ' +
      'copying a workflow the project already runs is almost always better than assembling one ' +
      'out of phases. Phases must be ones factory_phase_list offers.',
    schema: z.object({
      name: z
        .string()
        .regex(/^[a-z][a-z0-9-]*$/, 'lower case, digits and dashes, starting with a letter')
        .describe('The workflow name. It appears in YAML and in URLs.'),
      description: z.string().optional(),
      phases: z
        .array(z.string())
        .optional()
        .describe('Phase names, in order. Required unless `from` supplies them.'),
      needs: z
        .array(z.string())
        .optional()
        .describe(
          'Workflows that must have finished on the same task before this one runs. This is how ' +
            'a pipeline is chained — without it every task has to list all of them in order, ' +
            'and nothing stops them running in the wrong one.',
        ),
      from: z.string().optional().describe('An existing workflow to copy.'),
      project: PROJECT,
      scope: z
        .enum(['project', 'user'])
        .optional()
        .describe(
          'Where to write it. `project` (the default) puts it in the repository, where it is ' +
            'the person’s to share with their team; `user` keeps it to this machine.',
        ),
    }),
    run: async (input, context) => {
      const found = await resolveProject({
        api: context.api,
        cwd: context.cwd,
        given: input.project,
      })
      const inProject = `?project=${encodeURIComponent(found.project.id)}`

      // Copied server-side rather than made the agent's problem: reading a
      // workflow and writing it back under another name is two round trips and
      // an invitation to drop a field nobody knew about — `needs`, `onFail`,
      // `conditions` and the variables all travel.
      const base =
        input.from === undefined
          ? {}
          : ((
              await get<{ definition: Workflow }>(
                context,
                `/api/workflows/${encodeURIComponent(input.from)}${inProject}`,
              )
            ).definition as Partial<Workflow>)

      const phases = input.phases ?? base.phases
      if (phases === undefined || phases.length === 0) {
        throw asToolError(
          new Error('A workflow needs phases. Pass `phases`, or `from` a workflow that has some.'),
        )
      }

      const definition = {
        ...base,
        kind: 'factory.workflow/v1',
        name: input.name,
        phases,
        ...(input.description === undefined ? {} : { description: input.description }),
        // After `base`, so an agent that copies a workflow *and* says what the
        // copy needs gets what it asked for rather than what the original had.
        ...(input.needs === undefined ? {} : { needs: input.needs }),
      }
      // `WriteOutcome`, which carries the file at the top level. It was read as
      // `written.ref.file` — the shape the *read* route returns — so the path
      // was always undefined and the reply never said where the workflow
      // landed. Nothing caught it: no scenario asserted on the field, and the
      // stub answered in the read route's shape.
      const written = await post<{ status?: string; file?: string; problems?: unknown[] }>(
        context,
        `/api/workflows${inProject}`,
        { definition, scope: input.scope ?? 'project' },
      )
      return {
        workflow: input.name,
        project: { id: found.project.id, name: found.project.name },
        ...(written.file === undefined ? {} : { file: written.file }),
        ...(input.from === undefined ? {} : { copiedFrom: input.from }),
        next: `Name it in a task's workflows to run it.`,
      }
    },
  }),
]

/**
 * A request that changes something, with where it came from attached.
 *
 * The initiator rides on every one of these rather than on a header, because a
 * body is what the daemon already validates and a header is a second door. It
 * is absent for a client Factory did not launch, and the daemon reads that as
 * a person.
 */
const request = async <T>(
  context: ToolContext,
  path: string,
  method: string,
  body?: unknown,
): Promise<T> => {
  const sending =
    method === 'GET' || context.initiator === undefined
      ? body
      : { ...((body ?? {}) as Record<string, unknown>), initiator: context.initiator }
  try {
    return await context.api.request<T>(path, {
      method,
      ...(sending === undefined ? {} : { body: sending }),
    })
  } catch (error) {
    throw asToolError(error)
  }
}
const post = <T>(context: ToolContext, path: string, body?: unknown): Promise<T> =>
  request<T>(context, path, 'POST', body)
const get = <T>(context: ToolContext, path: string): Promise<T> =>
  request<T>(context, path, 'GET')

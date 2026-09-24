import { z } from 'zod'
import { TASK_STATES, type AvailableAction, type Run, type Task, type TaskState } from '@factory/core'
import { defineTool, type McpTool, type ToolContext } from '../tool.js'
import { resolveProject } from '../project.js'
import { asToolError } from '../errors.js'

/**
 * Tasks, over MCP.
 *
 * Two things are served rather than worked out here, and both for the same
 * reason the board does not work them out either: `actions` is what this task
 * can be asked to do *right now*, and the scheduler's skip reason is why a
 * queued task is not running. A client that re-derived either would drift from
 * the rules the first time they changed, and the drift reads as a Factory bug.
 */

export interface TaskListItem extends Task {
  readonly actions?: readonly AvailableAction[]
  readonly progress?: { readonly completed: number; readonly total: number }
  readonly blockers?: readonly { readonly id: string; readonly name: string; readonly status: string }[]
}

interface TaskDetail {
  readonly task: Task
  readonly actions: readonly AvailableAction[]
  readonly runs: readonly Run[]
  readonly progress?: { readonly completed: number; readonly total: number }
  readonly blockers?: readonly { readonly id: string; readonly name: string; readonly status: string }[]
  readonly artifacts?: readonly { readonly name: string; readonly phase: string; readonly bytes: number }[]
  readonly workspace?: { readonly path?: string }
}

export const briefTask = (item: TaskListItem) => ({
  id: item.id,
  name: item.name,
  state: item.state,
  projectId: item.projectId,
  // Omitted while empty rather than sent as '': a model reading
  // `description: ""` treats it as a description that says nothing, which is
  // not the same as nobody having written one.
  ...(item.description === '' ? {} : { description: item.description }),
  ...(item.ticketId === undefined ? {} : { ticketId: item.ticketId }),
  ...(item.branch === undefined ? {} : { branch: item.branch }),
  // Where the work came from, when it was not a person. An agent following a
  // tree it is part of needs to see the edges it cannot infer.
  ...(item.createdBy === undefined ? {} : { createdBy: item.createdBy }),
  ...(item.createdByRunId === undefined ? {} : { createdByRun: item.createdByRunId }),
  workflows: item.workflows.map((entry) => ({
    workflow: entry.workflow,
    enabled: entry.enabled,
    ran: entry.ran,
  })),
  ...(item.progress === undefined ? {} : { progress: item.progress }),
  ...(item.blockers === undefined || item.blockers.length === 0
    ? {}
    : { waitingFor: item.blockers }),
  actions: (item.actions ?? []).map((action) => action.action),
})

export const listTasks = async (context: ToolContext): Promise<TaskListItem[]> => {
  try {
    const reply = await context.api.request<{ items: TaskListItem[] }>('/api/tasks?archived=true')
    return reply.items
  } catch (error) {
    throw asToolError(error)
  }
}

export const getTask = async (context: ToolContext, id: string): Promise<TaskDetail> => {
  try {
    return await context.api.request<TaskDetail>(`/api/tasks/${encodeURIComponent(id)}`)
  } catch (error) {
    throw asToolError(error, 'TASK_NOT_FOUND')
  }
}

const STATE = z
  .enum(TASK_STATES as unknown as [TaskState, ...TaskState[]])
  .describe('Only tasks in this state.')

export const taskReadTools: readonly McpTool[] = [
  defineTool({
    name: 'factory_task_list',
    title: 'Tasks in a Factory project',
    description:
      'The tasks in a project, newest first. Each carries the actions it will accept right now — ' +
      'use those rather than guessing what a task in a given state allows.',
    schema: z.object({
      project: z
        .string()
        .optional()
        .describe('A project id, name, or a path inside it. Defaults to where this server runs.'),
      state: STATE.optional(),
      active: z
        .boolean()
        .optional()
        .describe('Only tasks that have not finished: queued, running or waiting for a person.'),
      limit: z.number().int().min(1).max(200).optional().describe('At most this many. Default 50.'),
    }),
    run: async (input, context) => {
      const found = await resolveProject({ api: context.api, cwd: context.cwd, given: input.project })
      // Filtered here rather than by the route, which takes no project: the
      // board does exactly the same with exactly the same list, and a second
      // filter in the daemon for one client is a second place to keep honest.
      const active: readonly TaskState[] = ['queued', 'running', 'awaiting_approval', 'blocked']
      const items = (await listTasks(context))
        .filter((task) => task.projectId === found.project.id)
        .filter((task) => input.state === undefined || task.state === input.state)
        .filter((task) => input.active !== true || active.includes(task.state))
      return {
        project: { id: found.project.id, name: found.project.name },
        total: items.length,
        tasks: items.slice(0, input.limit ?? 50).map(briefTask),
      }
    },
  }),

  defineTool({
    name: 'factory_task_get',
    title: 'One Factory task',
    description:
      'A task with its runs, how far it has got, what it is waiting for, and what it will accept ' +
      'next. The history and the buttons the board draws are left out; ask for a run to see what ' +
      'happened in it.',
    schema: z.object({ task: z.string().describe('The task id.') }),
    run: async (input, context) => {
      const detail = await getTask(context, input.task)
      // The task itself, with the three things the route computes alongside it
      // — named rather than spread, so what reaches `briefTask` is readable
      // without knowing which half of a spread wins.
      return {
        ...briefTask({
          ...detail.task,
          actions: detail.actions,
          ...(detail.progress === undefined ? {} : { progress: detail.progress }),
          ...(detail.blockers === undefined ? {} : { blockers: detail.blockers }),
        }),
        ...(detail.workspace?.path === undefined ? {} : { workspace: detail.workspace.path }),
        runs: detail.runs.map(briefRun),
        artifacts: (detail.artifacts ?? []).map((artifact) => ({
          name: artifact.name,
          phase: artifact.phase,
          bytes: artifact.bytes,
        })),
        next: nextFor(detail),
      }
    },
  }),

  defineTool({
    name: 'factory_approval_list',
    title: 'What is waiting for a person',
    description:
      'Tasks parked at an approval gate, or stopped because an agent was refused something. ' +
      'These are decisions a person makes. Report them; do not try to answer them.',
    schema: z.object({
      project: z.string().optional().describe('Only this project. Defaults to where this server runs.'),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    run: async (input, context) => {
      const found = await resolveProject({ api: context.api, cwd: context.cwd, given: input.project })
      const waiting = (await listTasks(context))
        .filter((task) => task.projectId === found.project.id)
        .filter((task) => task.state === 'awaiting_approval')
        .slice(0, input.limit ?? 20)

      const approvals = []
      for (const task of waiting) {
        const detail = await getTask(context, task.id)
        // A run parks two ways and Factory does not name them apart: a phase
        // that declares a gate, and a run that failed after its agent was
        // refused something. `detail` is what each one wrote, so it is reported
        // verbatim rather than sorted into a taxonomy that does not exist.
        const paused = detail.runs.find((run) => run.state === 'paused')
        approvals.push({
          task: { id: task.id, name: task.name },
          ...(paused === undefined
            ? {}
            : {
                run: paused.id,
                workflow: paused.workflow,
                continuesFromPhase: paused.resumePhase,
                ...(paused.detail === undefined ? {} : { detail: paused.detail }),
              }),
        })
      }
      return {
        project: { id: found.project.id, name: found.project.name },
        approvals,
        next:
          approvals.length === 0
            ? 'Nothing is waiting for a person in this project.'
            : 'A person has to decide these. Tell them what is waiting and why.',
      }
    },
  }),
]

export const briefRun = (run: Run) => ({
  id: run.id,
  workflow: run.workflow,
  state: run.state,
  attempt: run.attempt,
  startedAt: run.startedAt,
  ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
  ...(run.profile === undefined ? {} : { profile: run.profile }),
  ...(run.detail === undefined ? {} : { detail: run.detail }),
})

/**
 * What to do with this task, in a sentence.
 *
 * Derived from the actions the daemon served rather than from the state, so it
 * cannot offer something the daemon would refuse.
 */
const nextFor = (detail: TaskDetail): string => {
  const actions = new Set(detail.actions.map((action) => action.action))
  if (detail.task.state === 'awaiting_approval') {
    return 'A person has to approve or reject this before it goes any further.'
  }
  if (detail.task.state === 'running') return 'It is running. Read its newest run for progress.'
  if (actions.has('queue')) return 'Queue it when the plan is right.'
  if (actions.has('retry')) return 'It stopped. Read the run, then retry it if the cause is fixed.'
  return `Nothing to do: it is ${detail.task.state}.`
}

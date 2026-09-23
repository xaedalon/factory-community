import { z } from 'zod'
import type { Phase, Problem, Workflow } from '@factory/core'
import { defineTool, type McpTool, type ToolContext } from '../tool.js'
import { resolveProject } from '../project.js'
import { asToolError } from '../errors.js'

/**
 * Workflows and phases, over MCP.
 *
 * Both are read through the project's own scope chain, so a project that ships
 * its definitions in its repository gets those, and a project that does not
 * gets the user's and the built-ins. The resolution is the daemon's; this only
 * says which project to ask about.
 */

interface Listing {
  readonly name: string
  readonly valid: boolean
  readonly problems: readonly Problem[]
  readonly value?: unknown
  readonly needs?: readonly string[]
  readonly unavailable?: { readonly flag: string; readonly setting?: string }
}

interface Detail {
  readonly definition: unknown
  readonly ref: { readonly scope: string; readonly file: string }
  readonly problems: readonly Problem[]
  readonly shadows?: readonly unknown[]
}

const inProject = (project: string | undefined) =>
  project === undefined ? '' : `?project=${encodeURIComponent(project)}`

const listDefinitions = async (
  context: ToolContext,
  plural: 'workflows' | 'phases',
  projectId: string,
): Promise<Listing[]> => {
  try {
    const reply = await context.api.request<{ items: Listing[] }>(
      `/api/${plural}${inProject(projectId)}`,
    )
    return reply.items
  } catch (error) {
    throw asToolError(error)
  }
}

const getDefinition = async (
  context: ToolContext,
  plural: 'workflows' | 'phases',
  name: string,
  projectId: string,
): Promise<Detail> => {
  try {
    return await context.api.request<Detail>(
      `/api/${plural}/${encodeURIComponent(name)}${inProject(projectId)}`,
    )
  } catch (error) {
    throw asToolError(error, 'WORKFLOW_NOT_FOUND')
  }
}

export const definitionTools: readonly McpTool[] = [
  defineTool({
    name: 'factory_workflow_list',
    title: 'Workflows a project can run',
    description:
      'Every workflow available to a project, with what each one needs and whether the project ' +
      'can run it yet. Pick one of these when creating a task: a workflow name that is not here ' +
      'will not resolve.',
    schema: z.object({
      project: z.string().optional().describe('A project id, name, or a path inside it.'),
    }),
    run: async (input, context) => {
      const found = await resolveProject({ api: context.api, cwd: context.cwd, given: input.project })
      const items = await listDefinitions(context, 'workflows', found.project.id)
      return {
        project: { id: found.project.id, name: found.project.name },
        workflows: items.map((item) => {
          const workflow = item.value as Workflow | undefined
          return {
            name: item.name,
            description: workflow?.description ?? '',
            mode: workflow?.mode ?? 'once',
            phases: workflow?.phases ?? [],
            ...(item.needs === undefined ? {} : { needs: item.needs }),
            valid: item.valid,
            // Marked rather than hidden, the way the route marks it: the file
            // is still the project's to read and edit, and only the list of
            // what to run next has no business offering it.
            ...(item.unavailable === undefined
              ? {}
              : { unavailable: `this project does not have ${item.unavailable.flag}` }),
          }
        }),
      }
    },
  }),

  defineTool({
    name: 'factory_workflow_get',
    title: 'One workflow',
    description: 'A workflow as Factory resolved it, and which file it came from.',
    schema: z.object({
      workflow: z.string().describe('The workflow name.'),
      project: z.string().optional(),
    }),
    run: async (input, context) => {
      const found = await resolveProject({ api: context.api, cwd: context.cwd, given: input.project })
      const detail = await getDefinition(context, 'workflows', input.workflow, found.project.id)
      return {
        workflow: detail.definition as Workflow,
        from: detail.ref,
        problems: detail.problems,
      }
    },
  }),

  defineTool({
    name: 'factory_phase_list',
    title: 'Phases a project can use',
    description: 'Every phase available to a project. A workflow is a list of these, in order.',
    schema: z.object({ project: z.string().optional() }),
    run: async (input, context) => {
      const found = await resolveProject({ api: context.api, cwd: context.cwd, given: input.project })
      const items = await listDefinitions(context, 'phases', found.project.id)
      return {
        project: { id: found.project.id, name: found.project.name },
        phases: items.map((item) => {
          const phase = item.value as Phase | undefined
          return {
            name: item.name,
            description: phase?.description ?? '',
            steps: phase?.steps.length ?? 0,
            // The whole of Factory's approval model: a phase says whether a
            // person has to say yes, and whether before or after.
            approval: phase?.approval ?? 'none',
            valid: item.valid,
          }
        }),
      }
    },
  }),

  defineTool({
    name: 'factory_phase_get',
    title: 'One phase',
    description: 'A phase with its steps, as Factory resolved it.',
    schema: z.object({ phase: z.string().describe('The phase name.'), project: z.string().optional() }),
    run: async (input, context) => {
      const found = await resolveProject({ api: context.api, cwd: context.cwd, given: input.project })
      const detail = await getDefinition(context, 'phases', input.phase, found.project.id)
      return {
        phase: detail.definition as Phase,
        from: detail.ref,
        problems: detail.problems,
      }
    },
  }),
]

import { z } from 'zod'
import type { Project, Task } from '@factory/core'
import { defineTool, type McpTool } from '../tool.js'
import { list, resolveProject } from '../project.js'

/**
 * Projects, over MCP.
 *
 * The shape is smaller than the row. A project carries a tone, initials and a
 * worktrees root that exist for the board to draw with; what an agent acts on
 * is where the work happens, whether it is a repository, and whether each task
 * gets a worktree of its own.
 */

export const briefProject = (project: Project) => ({
  id: project.id,
  name: project.name,
  root: project.path,
  defaultBranch: project.defaultBranch,
  isRepository: project.isRepository,
  usesWorktrees: project.usesWorktrees,
  usesEnvironments: project.usesEnvironments,
  // Null means "not stated", which is not the same as `default`: the
  // installation's own setting decides, and it can change without touching the
  // project.
  profile: project.profile ?? null,
})

const briefTask = (task: Task) => ({ id: task.id, name: task.name, state: task.state })

const PROJECT = z
  .string()
  .describe(
    'A project id, its name, or an absolute path inside it. Omit to use the directory this ' +
      'server was started in.',
  )

export const projectTools: readonly McpTool[] = [
  defineTool({
    name: 'factory_project_current',
    title: 'Which Factory project am I in',
    description:
      'Resolve the Factory project for the directory this server was started in, and say how it ' +
      'matched. Start here: every other tool needs a project, and this is the one question you ' +
      'can answer without asking anybody.',
    schema: z.object({}),
    run: async (_input, { api, cwd }) => {
      const found = await resolveProject({ api, cwd })
      return {
        project: briefProject(found.project),
        matchedBy: found.matchedBy,
        // Only when the directory was a worktree: then Factory already knows
        // which task is being worked on, and saying so saves the agent guessing.
        ...(found.task === undefined ? {} : { task: briefTask(found.task) }),
        directory: cwd,
      }
    },
  }),

  defineTool({
    name: 'factory_project_get',
    title: 'One Factory project',
    description: 'A project by id, by name, or by a path inside it.',
    schema: z.object({ project: PROJECT }),
    run: async (input, { api, cwd }) => {
      const found = await resolveProject({ api, cwd, given: input.project })
      return {
        project: briefProject(found.project),
        matchedBy: found.matchedBy,
        ...(found.task === undefined ? {} : { task: briefTask(found.task) }),
      }
    },
  }),

  defineTool({
    name: 'factory_project_list',
    title: 'Every Factory project',
    description:
      'Every repository registered with this Factory installation. Use it when the directory you ' +
      'are in belongs to none of them, or to find the name of one somebody mentioned.',
    schema: z.object({}),
    run: async (_input, { api }) => ({
      projects: (await list(api)).map(briefProject),
    }),
  }),
]

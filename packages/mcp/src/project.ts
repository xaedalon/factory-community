import type { Project, Task } from '@factory/core'
import type { FactoryApi } from './api.js'
import { ToolError, asToolError } from './errors.js'

/**
 * Which project the caller means.
 *
 * The question an agent can always answer is "where am I", and everything else
 * follows from it. What it cannot answer is "which of the twelve repositories
 * on this machine", so a directory that belongs to no project is a refusal that
 * says what to do rather than a guess — the wrong project here queues somebody's
 * work against the wrong repository.
 *
 * The match itself is the daemon's. This asks; it does not decide. The CLI and
 * the board want the same answer, and a second implementation of the rule would
 * disagree with the first one the day the rule changed.
 *
 * Client-declared workspace roots are deliberately not consulted yet. Reading
 * them means the server making a `roots/list` request *of the client*, which is
 * the only thing in this surface that would need server-to-client correlation,
 * and a stdio server is started in the directory the person is working in — so
 * it buys nothing today. `docs/proposals/mcp.md` says so rather than the code
 * implying otherwise.
 */

export interface ResolvedProject {
  readonly project: Project
  /** `given` when the caller named it; otherwise how the directory matched. */
  readonly matchedBy: 'given' | 'directory' | 'ancestor' | 'worktree'
  /** Present when the directory was a task's worktree: which task's. */
  readonly task?: Task
}

interface AtReply {
  readonly project: Project
  readonly matchedBy: 'directory' | 'ancestor' | 'worktree'
  readonly task?: Task
}

export async function resolveProject(options: {
  readonly api: FactoryApi
  readonly cwd: string
  /** An id, a name, or an absolute path — whatever the tool call carried. */
  readonly given?: string | undefined
}): Promise<ResolvedProject> {
  const { api, cwd, given } = options

  if (given !== undefined && given.trim() !== '') {
    const wanted = given.trim()
    // A leading separator is the one unambiguous signal. A project may be named
    // anything, so asking "is this a path?" any other way means guessing about
    // somebody's naming, and guessing is what this function exists to avoid.
    if (wanted.startsWith('/')) return { ...(await at(api, wanted)) }

    const projects = await list(api)
    const found =
      projects.find((project) => project.id === wanted) ??
      projects.find((project) => project.name.toLowerCase() === wanted.toLowerCase())
    if (found === undefined) {
      throw new ToolError('PROJECT_NOT_FOUND', `No Factory project called "${wanted}".`, {
        projects: projects.map((project) => project.name),
      })
    }
    return { project: found, matchedBy: 'given' }
  }

  return at(api, cwd)
}

/** Every project, for the cases that have to say what the alternatives were. */
export async function list(api: FactoryApi): Promise<Project[]> {
  try {
    const reply = await api.request<{ items: Project[] }>('/api/projects')
    return reply.items
  } catch (error) {
    throw asToolError(error)
  }
}

async function at(api: FactoryApi, path: string): Promise<AtReply> {
  try {
    return await api.request<AtReply>(`/api/projects/at?path=${encodeURIComponent(path)}`)
  } catch (error) {
    const problem = asToolError(error)
    if (problem.code === 'FACTORY_ERROR' || problem.code === 'VALIDATION_ERROR') {
      // 404 from that route means the directory is in no project, which is the
      // commonest thing an agent will hit and the one a bare status explains
      // worst.
      throw new ToolError(
        'PROJECT_NOT_FOUND',
        `${path} is not inside any project Factory knows about. ` +
          'Pass `project` with the name of one, or ask the person you are working with to add ' +
          'this repository to Factory.',
        { path },
      )
    }
    throw problem
  }
}

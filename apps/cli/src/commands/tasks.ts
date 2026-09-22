import { columns, type Style } from '../render.js'
import { failed, ok, type CommandResult } from '../context.js'
import { asFailure, type DaemonClient } from '../daemon.js'

/**
 * The shape the daemon sends, declared here rather than imported.
 *
 * The CLI talks HTTP, so nothing type-checks this against core — which means a
 * change to `Task.workflows` compiles perfectly here and renders nonsense. Kept
 * deliberately narrow, and worth a second look whenever the payload moves.
 */
interface TaskWorkflowEntry {
  id: string
  workflow: string
  enabled: boolean
  ran: boolean
}

/**
 * `factory task …` — the board's work, from a terminal.
 *
 * Every command here is a call to the same API the board uses, including the
 * list of actions a task will accept: the CLI renders the buttons the daemon
 * offered rather than deciding for itself which ones exist, for the same reason
 * the board does.
 */

interface TaskSummary {
  id: string
  name: string
  state: string
  description: string
  ticketId?: string
  branch?: string
  directory?: string
  projectId?: string
  workflows: TaskWorkflowEntry[]
  flags: string[]
  blockedReason?: string
  updatedAt: string
  dependsOn?: string[]
  actions?: { action: string; label: string }[]
  progress?: { completed: number; total: number }
  blockers?: { id: string; name: string; status: string }[]
}

interface TaskDetail {
  task: TaskSummary
  actions: { action: string; label: string }[]
  blockers?: { id: string; name: string; status: string }[]
  history: { at: string; action: string; from: string; to: string; detail?: string }[]
  runs: { id: string; workflow: string; state: string; attempt: number; startedAt: string }[]
}

/** How a blocker's verdict reads in a line of prose. */
const WAIT_WORDS: Record<string, string> = {
  met: 'done',
  waiting: 'not yet',
  dead: 'never will be',
}

/** A short id is enough to type, and enough to be unambiguous locally. */
const short = (id: string): string => id.slice(0, 8)

class AmbiguousId extends Error {}

/**
 * Accept the id the listing printed.
 *
 * The listing shows eight characters because nobody types a uuid, so the
 * commands have to accept eight characters back. The resolution happens here
 * rather than in the API: the daemon stays exact — a prefix that matches two
 * tasks must never quietly pick one — and the convenience lives where the
 * abbreviation was invented.
 */
async function resolveId(client: DaemonClient, id: string): Promise<string> {
  if (id.length >= 36) return id
  const known = await client.request<{ items: TaskSummary[] }>('/api/tasks?archived=true')
  const matches = known.items.filter((task) => task.id.startsWith(id))
  if (matches.length === 1) return (matches[0] as TaskSummary).id
  if (matches.length === 0) return id
  throw new AmbiguousId(
    `"${id}" matches ${matches.length} tasks: ${matches.map((task) => short(task.id)).join(', ')}.`,
  )
}

export async function list(
  client: DaemonClient,
  options: { state?: string; archived?: boolean },
  style: Style,
): Promise<CommandResult> {
  try {
    const query = [
      options.state === undefined ? undefined : `state=${encodeURIComponent(options.state)}`,
      options.archived === true ? 'archived=true' : undefined,
    ].filter((part) => part !== undefined)
    const result = await client.request<{ items: TaskSummary[] }>(
      `/api/tasks${query.length > 0 ? `?${query.join('&')}` : ''}`,
    )

    if (result.items.length === 0) {
      return ok([
        'No tasks.',
        style.dim('Make one with "factory task new <name> --workflow <workflow>".'),
      ])
    }

    const rows = result.items.map((task) => [
      style.dim(short(task.id)),
      task.name,
      colourState(task.state, style),
      // The one it will run next, which is nothing once everything is done.
      // Falling back to the first was never honest about a finished task.
      task.workflows.find((entry) => entry.enabled)?.workflow ?? style.dim('—'),
      // Phases, across the whole plan — not steps of whichever run happened to
      // be newest, which never climbed past that one run.
      task.progress === undefined
        ? ''
        : `${task.progress.completed}/${task.progress.total} phases`,
    ])
    return ok(columns(rows), result.items)
  } catch (error) {
    return asFailure(error)
  }
}

export async function show(
  client: DaemonClient,
  id: string,
  style: Style,
): Promise<CommandResult> {
  try {
    const detail = await client.request<TaskDetail>(
      `/api/tasks/${encodeURIComponent(await resolveId(client, id))}`,
    )
    const { task } = detail

    const lines = [
      `${style.bold(task.name)}  ${colourState(task.state, style)}`,
      style.dim(`  ${task.id}`),
    ]
    if (task.description !== '') lines.push(`  about     ${task.description}`)
    if (task.ticketId !== undefined) lines.push(`  ticket    ${task.ticketId}`)
    if (task.branch !== undefined) lines.push(`  branch    ${task.branch}`)
    if (task.workflows.length > 0) {
      // `[x]` still to run, `[ ]` the engine is done with — the same thing the
      // board draws as a tickbox.
      lines.push(
        `  workflows ${task.workflows
          .map((entry) => `${entry.enabled ? '[x]' : '[ ]'} ${entry.workflow}`)
          .join(' → ')}`,
      )
    }
    if (task.flags.length > 0) lines.push(`  flags     ${task.flags.join(', ')}`)
    // The verdict rather than the blocker's state: what matters is whether this
    // task can ever start, and "done" and "archived after finishing" are the
    // same answer.
    if (detail.blockers !== undefined && detail.blockers.length > 0) {
      lines.push(
        `  waits for ${detail.blockers
          .map((blocker) => `${blocker.name} (${WAIT_WORDS[blocker.status] ?? blocker.status})`)
          .join(', ')}`,
      )
    }
    if (task.blockedReason !== undefined) {
      lines.push(`  blocked   ${style.red(task.blockedReason)}`)
    }

    if (detail.runs.length > 0) {
      lines.push('', style.dim('Runs'))
      for (const run of detail.runs) {
        lines.push(`  ${short(run.id)}  ${run.workflow} #${run.attempt}  ${run.state}`)
      }
    }

    // Printed from what the daemon offered, so the CLI can never suggest
    // something the state machine will refuse.
    if (detail.actions.length > 0) {
      lines.push(
        '',
        style.dim(`Next: ${detail.actions.map((entry) => `factory task ${entry.action} ${short(task.id)}`).join('  ')}`),
      )
    }
    return ok(lines, detail)
  } catch (error) {
    if (error instanceof AmbiguousId) return failed([error.message, style.dim('Use more of it.')])
    return asFailure(error)
  }
}

export async function create(
  client: DaemonClient,
  input: {
    name: string
    workflows: string[]
    project?: string
    branch?: string
    ticket?: string
    description?: string
  },
  style: Style,
): Promise<CommandResult> {
  try {
    // Named rather than by id: nobody types a uuid, and the CLI knows how to
    // ask what the names are. Asked for every task, not only a named one: a
    // task needs a project, and the daemon's refusal would arrive after the
    // person had already typed the whole command.
    const projects = await client.request<{ items: { id: string; name: string }[] }>(
      '/api/projects',
    )
    const names = projects.items.map((project) => project.name).join(', ')
    let projectId: string
    if (input.project !== undefined) {
      const found = projects.items.find((project) => project.name === input.project)
      if (found === undefined) {
        return failed([
          `No project called "${input.project}".`,
          style.dim(
            projects.items.length === 0
              ? 'Add one with "factory project add <name> <path>".'
              : `Known: ${names}`,
          ),
        ])
      }
      projectId = found.id
    } else if (projects.items.length === 1) {
      // The common case, and the one worth not making anybody type: with one
      // repository registered there is no ambiguity to resolve.
      projectId = projects.items[0]?.id as string
    } else if (projects.items.length === 0) {
      return failed([
        'A task needs a project, and none have been added.',
        style.dim('Add one with "factory project add <name> <path>".'),
      ])
    } else {
      return failed([
        'More than one project: say which with --project.',
        style.dim(`Known: ${names}`),
      ])
    }

    const created = await client.request<{ task: TaskSummary; actions: { action: string }[] }>(
      '/api/tasks',
      {
        method: 'POST',
        body: {
          name: input.name,
          workflows: input.workflows,
          projectId,
          ...(input.branch === undefined ? {} : { branch: input.branch }),
          ...(input.ticket === undefined ? {} : { ticketId: input.ticket }),
          ...(input.description === undefined ? {} : { description: input.description }),
        },
      },
    )

    const canQueue = created.actions.some((entry) => entry.action === 'queue')
    return ok(
      [
        `Created ${style.bold(created.task.name)} (${short(created.task.id)}).`,
        canQueue
          ? style.dim(`Start it with "factory task queue ${short(created.task.id)}".`)
          : style.yellow('It has no workflows yet, so there is nothing to queue.'),
      ],
      created,
    )
  } catch (error) {
    return asFailure(error)
  }
}

export async function act(
  client: DaemonClient,
  action: string,
  id: string,
  style: Style,
): Promise<CommandResult> {
  try {
    const resolved = await resolveId(client, id)
    const result = await client.request<{ task: TaskSummary; actions: { action: string }[] }>(
      `/api/tasks/${encodeURIComponent(resolved)}/actions/${encodeURIComponent(action)}`,
      { method: 'POST', body: {} },
    )
    return ok(
      [`${result.task.name} is now ${colourState(result.task.state, style)}.`],
      result,
    )
  } catch (error) {
    if (error instanceof AmbiguousId) return failed([error.message, style.dim('Use more of it.')])
    // A refusal carries what the task *can* do, which is more useful than the
    // refusal itself.
    const body = (error as { body?: { actions?: { action: string }[]; error?: string } }).body
    if (body?.actions !== undefined) {
      return failed([
        body.error ?? `Cannot ${action} that task.`,
        style.dim(`Available: ${body.actions.map((entry) => entry.action).join(', ')}`),
      ])
    }
    return asFailure(error)
  }
}

export async function logs(
  client: DaemonClient,
  id: string,
  style: Style,
): Promise<CommandResult> {
  try {
    const detail = await client.request<TaskDetail>(
      `/api/tasks/${encodeURIComponent(await resolveId(client, id))}`,
    )
    const latest = detail.runs[0]
    if (latest === undefined) return ok([`${detail.task.name} has not run yet.`])

    const run = await client.request<{
      steps: { id: number; phase: string; describe: string; state: string; exitCode?: number }[]
      evidence: { phase: string; name: string; path: string; content?: string; missing: boolean }[]
    }>(`/api/runs/${encodeURIComponent(latest.id)}`)

    const lines = [style.bold(`${latest.workflow} #${latest.attempt} — ${latest.state}`), '']

    for (const step of run.steps) {
      lines.push(`${style.dim(step.phase)}  ${step.describe}  ${step.state}`)
      const log = await client.request<{ lines: { text: string }[]; dropped: number }>(
        `/api/runs/${encodeURIComponent(latest.id)}/logs?step=${step.id}`,
      )
      // Indented under the step it came from, because a terminal has no other
      // way to show which of five steps printed a line.
      for (const text of textOf(log.lines)) lines.push(`    ${text}`)
      if (log.dropped > 0) {
        lines.push(style.yellow(`    … ${log.dropped} bytes were dropped from the middle`))
      }
    }

    for (const item of run.evidence) {
      lines.push(
        '',
        style.bold(`Evidence — ${item.name}`),
        style.dim(`  ${item.phase} · ${item.path}`),
      )
      if (item.missing) lines.push(style.yellow('  never produced'))
      for (const text of textOf(item.content === undefined ? [] : [{ text: item.content }])) {
        lines.push(`  ${text}`)
      }
    }

    return ok(lines, run)
  } catch (error) {
    if (error instanceof AmbiguousId) return failed([error.message, style.dim('Use more of it.')])
    return asFailure(error)
  }
}

/** Chunks as they were written, split back into lines for a terminal. */
const textOf = (chunks: readonly { text: string }[]): string[] =>
  chunks
    .map((chunk) => chunk.text)
    .join('')
    .replace(/\n$/, '')
    .split('\n')
    .filter((line, index, all) => !(line === '' && index === all.length - 1))

const colourState = (state: string, style: Style): string => {
  if (state === 'blocked') return style.red(state)
  if (state === 'awaiting_approval') return style.yellow(state)
  if (state === 'done') return style.green(state)
  return state
}

/**
 * `factory task depends <id> <on>` — make one task wait for another.
 *
 * Both ids go through the same prefix resolution the other commands use, so
 * the eight characters the listing printed are enough for either end.
 *
 * `--remove` rather than a second verb: the pair reads as one decision, and
 * `factory task depends x y --remove` says which relation is being undone in
 * the same words that made it.
 */
export async function depends(
  client: DaemonClient,
  id: string,
  blockerId: string,
  options: { remove?: boolean },
  style: Style,
): Promise<CommandResult> {
  try {
    const resolved = await resolveId(client, id)
    const blocker = await resolveId(client, blockerId)
    const path = `/api/tasks/${encodeURIComponent(resolved)}/dependencies`
    const result =
      options.remove === true
        ? await client.request<{ task: TaskSummary; blockers: { name: string }[] }>(
            `${path}/${encodeURIComponent(blocker)}`,
            { method: 'DELETE' },
          )
        : await client.request<{ task: TaskSummary; blockers: { name: string }[] }>(path, {
            method: 'POST',
            body: { dependsOn: blocker },
          })
    const waiting = result.blockers.map((entry) => entry.name)
    return ok(
      [
        waiting.length === 0
          ? `${result.task.name} waits for nothing.`
          : `${result.task.name} waits for ${waiting.join(', ')}.`,
      ],
      result,
    )
  } catch (error) {
    if (error instanceof AmbiguousId) return failed([error.message, style.dim('Use more of it.')])
    return asFailure(error)
  }
}

/**
 * `factory project add <name> <path>` — somewhere to work.
 *
 * Exists because `factory setup` had to print a `curl` at a hardcoded port to
 * answer its own most important step, and a printed port is wrong the moment
 * anybody runs on another one. The CLI already resolves the daemon from
 * `FACTORY_URL` or `FACTORY_PORT` in one place; this lets the hint say a
 * command instead of an address.
 *
 * The path is sent as typed. The repository checks it — a path that does not
 * exist, is not a directory, or is not a git repository comes back as the
 * sentence it wrote, which is better than a second opinion here.
 */
export async function projectAdd(
  client: DaemonClient,
  name: string,
  path: string,
  options: { inPlace?: boolean },
  style: Style,
): Promise<CommandResult> {
  try {
    const result = await client.request<{
      project: ProjectSummary & { path: string; usesWorktrees: boolean }
      scaffolded?: { written: readonly string[]; kept: readonly string[]; error?: string }
    }>('/api/projects', {
      method: 'POST',
      body: {
        name,
        path,
        ...(options.inPlace === true ? { usesWorktrees: false } : {}),
      },
    })
    const lines = [
      `${result.project.name} added at ${result.project.path}.`,
      style.dim(
        result.project.usesWorktrees
          ? '  Each task gets a worktree of its own.'
          : '  Work happens in this checkout, so one task runs at a time.',
      ),
    ]
    // Turning a project setting on copies definitions into the repository. Said
    // out loud, because it wrote files somebody will find in `git status`.
    for (const file of result.scaffolded?.written ?? []) lines.push(style.dim(`  wrote ${file}`))
    if (result.scaffolded?.error !== undefined) {
      lines.push(style.dim(`  could not scaffold: ${result.scaffolded.error}`))
    }
    return ok(lines, result)
  } catch (error) {
    return asFailure(error)
  }
}

/**
 * `factory project queue|stop <name>` — a whole project at once.
 *
 * The same two routes the board's buttons use, so a terminal and a browser
 * cannot differ about what "queue all" means. Named rather than by id: a
 * project has one, it is what the rail shows, and nobody memorises the uuid of
 * a repository.
 */
export async function projectQueue(
  client: DaemonClient,
  name: string,
  style: Style,
): Promise<CommandResult> {
  try {
    const project = await resolveProject(client, name)
    const result = await client.request<{
      queued: TaskSummary[]
      skipped: { task: TaskSummary; reason: string }[]
    }>(`/api/projects/${encodeURIComponent(project.id)}/queue`, { method: 'POST', body: {} })

    const lines =
      result.queued.length === 0
        ? [`Nothing to queue in ${project.name}.`]
        : [
            `Queued ${result.queued.length} ${result.queued.length === 1 ? 'task' : 'tasks'} in ${project.name}:`,
            // In the order they were queued, which is dependency order — the
            // one fact about this command worth printing.
            ...result.queued.map((task) => `  ${task.name}`),
          ]
    for (const entry of result.skipped) {
      lines.push(style.dim(`  ${entry.task.name} — ${entry.reason}`))
    }
    return ok(lines, result)
  } catch (error) {
    if (error instanceof AmbiguousId) return failed([error.message, style.dim('Use more of it.')])
    return asFailure(error)
  }
}

export async function projectStop(
  client: DaemonClient,
  name: string,
  style: Style,
): Promise<CommandResult> {
  try {
    const project = await resolveProject(client, name)
    const result = await client.request<{
      cancelled: TaskSummary[]
      signalled: number
      killed: number
    }>(`/api/projects/${encodeURIComponent(project.id)}/stop`, { method: 'POST', body: {} })

    if (result.cancelled.length === 0) {
      return ok([`Nothing was running in ${project.name}.`], result)
    }
    return ok(
      [
        `Cancelled ${result.cancelled.length} ${result.cancelled.length === 1 ? 'task' : 'tasks'} in ${project.name}.`,
        style.dim(`  ${result.signalled} signalled, ${result.killed} killed`),
      ],
      result,
    )
  } catch (error) {
    if (error instanceof AmbiguousId) return failed([error.message, style.dim('Use more of it.')])
    return asFailure(error)
  }
}

interface ProjectSummary {
  id: string
  name: string
}

/**
 * A project by name, or by enough of one.
 *
 * Case-insensitive and exact first: a project called "web" must not be
 * ambiguous because another is called "webhooks".
 */
async function resolveProject(client: DaemonClient, name: string): Promise<ProjectSummary> {
  const known = await client.request<{ items: ProjectSummary[] }>('/api/projects')
  const wanted = name.toLowerCase()
  const exact = known.items.find((project) => project.name.toLowerCase() === wanted)
  if (exact !== undefined) return exact
  const matches = known.items.filter((project) => project.name.toLowerCase().startsWith(wanted))
  if (matches.length === 1) return matches[0] as ProjectSummary
  if (matches.length === 0) throw new AmbiguousId(`No project called "${name}".`)
  throw new AmbiguousId(
    `"${name}" matches ${matches.length} projects: ${matches.map((p) => p.name).join(', ')}.`,
  )
}

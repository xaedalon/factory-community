import type { DaemonClient } from '../daemon.js'
import { asFailure } from '../daemon.js'
import { ok, type CommandResult } from '../context.js'
import { columns, type Style } from '../render.js'

/**
 * `factory reliability` — how much to trust a task, from a terminal.
 *
 * The same numbers the board draws, through the same API. Nothing here decides
 * anything: the score, the drivers and the next actions all arrive judged, and
 * this arranges them.
 *
 * There is no `factory reliability set`. The score is not something a person
 * types either.
 */

/** The wire shapes, declared locally the way `commands/tasks.ts` declares its own. */
interface Attention {
  agent: number
  developer: number
  either: number
  external: number
  potential: Record<string, number>
}

interface Summary {
  state: 'unassessed' | 'assessed' | 'stale'
  score?: number
  rawScore?: number
  coverage?: number
  delta?: number
  dimensions?: Record<string, number>
  caps?: { type: string; value: number; reason: string }[]
  assessedAt?: string
  staleReason?: string
  attention: Attention
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
  acceptedBy?: string
  acceptanceReason?: string
}

interface Assessment {
  sequence: number
  workflow?: string
  score: number
  coverage: number
  delta: number
  summary: string
  createdAt: string
}

interface NextAction {
  driverId: string
  title: string
  owner: string
  severity: string
  impact: number
  actionType: string
  label: string
  workflow?: string
}

/** The one place a task id is expanded, so every verb accepts the short form. */
async function resolveTask(client: DaemonClient, id: string): Promise<string> {
  if (id.length >= 36) return id
  const listed = await client.request<{ items: { id: string; name: string }[] }>(
    '/api/tasks?archived=true',
  )
  const matches = listed.items.filter((task) => task.id.startsWith(id))
  if (matches.length === 1) return (matches[0] as { id: string }).id
  if (matches.length === 0) throw new Error(`No task starting with "${id}".`)
  throw new Error(
    `"${id}" matches ${String(matches.length)} tasks. Use more of the id: ` +
      matches.map((task) => task.id.slice(0, 12)).join(', '),
  )
}

/** A delta written so it reads without colour: the arrow carries the sign. */
function movement(delta: number | undefined, style: Style): string {
  if (delta === undefined || delta === 0) return style.dim('no change')
  return delta > 0 ? style.green(`↑ +${String(delta)}`) : style.red(`↓ ${String(delta)}`)
}

export async function show(
  client: DaemonClient,
  id: string,
  style: Style,
): Promise<CommandResult> {
  try {
    const taskId = await resolveTask(client, id)
    const { reliability } = await client.request<{ reliability: Summary }>(
      `/api/tasks/${encodeURIComponent(taskId)}/reliability`,
    )

    if (reliability.state === 'unassessed') {
      return ok(
        [
          style.dim('Reliability  not assessed yet'),
          '',
          'Run a workflow, or ask for an assessment:',
          style.dim(`  factory reliability ${id} assess`),
        ],
        reliability,
      )
    }

    const lines = [
      `${style.bold('Reliability')}       ${String(reliability.score)} / 100   ${movement(reliability.delta, style)}`,
      `Evidence coverage  ${String(reliability.coverage)}%`,
    ]
    if (reliability.rawScore !== undefined && reliability.rawScore !== reliability.score) {
      lines.push(style.dim(`Before caps        ${String(reliability.rawScore)}`))
    }
    if (reliability.staleReason !== undefined) {
      lines.push(style.yellow(`Stale — ${reliability.staleReason}`))
    }

    for (const cap of reliability.caps ?? []) {
      lines.push(style.yellow(`Capped at ${String(cap.value)} — ${cap.reason}`))
    }

    if (reliability.dimensions !== undefined) {
      lines.push('', style.dim('Dimensions'))
      lines.push(
        ...columns(
          Object.entries(reliability.dimensions).map(([name, value]) => [
            `  ${label(name)}`,
            String(value),
          ]),
        ),
      )
    }

    const { attention } = reliability
    const waiting = attention.agent + attention.developer + attention.either + attention.external
    lines.push('', style.dim('Needs attention'))
    if (waiting === 0) lines.push('  nothing outstanding')
    else {
      lines.push(
        ...columns([
          ['  agent can resolve', String(attention.agent)],
          ['  developer decision', String(attention.developer)],
          ['  either', String(attention.either)],
          ['  external', String(attention.external)],
        ]),
      )
    }

    return ok(lines, reliability)
  } catch (error) {
    return asFailure(error)
  }
}

export async function drivers(
  client: DaemonClient,
  id: string,
  style: Style,
  filters: { status?: string; owner?: string } = {},
): Promise<CommandResult> {
  try {
    const taskId = await resolveTask(client, id)
    const query = new URLSearchParams()
    if (filters.status !== undefined) query.set('status', filters.status)
    if (filters.owner !== undefined) query.set('owner', filters.owner)
    const suffix = query.toString() === '' ? '' : `?${query.toString()}`
    const { items } = await client.request<{ items: Driver[] }>(
      `/api/tasks/${encodeURIComponent(taskId)}/reliability/drivers${suffix}`,
    )

    if (items.length === 0) return ok([style.dim('Nothing is holding this task back.')], items)

    const lines: string[] = []
    for (const driver of items) {
      const cost = driver.scoreImpact === 0 ? '' : ` ${String(driver.scoreImpact)}`
      lines.push(`${severity(driver.severity, style)} ${driver.title}${style.dim(cost)}`)
      if (driver.description !== '') lines.push(style.dim(`    ${driver.description}`))
      lines.push(style.dim(`    ${driver.status} · ${driver.owner} · ${driver.dimension}`))
      if (driver.recommendedAction !== undefined) {
        lines.push(style.dim(`    suggested: ${driver.recommendedAction.label}`))
      }
      if (driver.acceptedBy !== undefined) {
        const why = driver.acceptanceReason === undefined ? '' : ` — ${driver.acceptanceReason}`
        lines.push(style.dim(`    accepted by ${driver.acceptedBy}${why}`))
      }
      lines.push(style.dim(`    ${driver.id.slice(0, 8)}`))
      lines.push('')
    }
    return ok(lines.slice(0, -1), items)
  } catch (error) {
    return asFailure(error)
  }
}

export async function history(
  client: DaemonClient,
  id: string,
  style: Style,
): Promise<CommandResult> {
  try {
    const taskId = await resolveTask(client, id)
    const { items } = await client.request<{ items: Assessment[] }>(
      `/api/tasks/${encodeURIComponent(taskId)}/reliability/history`,
    )
    if (items.length === 0) return ok([style.dim('Nothing has judged this task yet.')], items)

    const rows = items.map((entry) => [
      `${String(entry.sequence)}.`,
      entry.workflow ?? style.dim('—'),
      String(entry.score),
      `${String(entry.coverage)}%`,
      movement(entry.delta, style),
      entry.summary,
    ])
    return ok(columns(rows), items)
  } catch (error) {
    return asFailure(error)
  }
}

export async function next(
  client: DaemonClient,
  id: string,
  style: Style,
): Promise<CommandResult> {
  try {
    const taskId = await resolveTask(client, id)
    const reply = await client.request<{ currentScore?: number; actions: NextAction[] }>(
      `/api/tasks/${encodeURIComponent(taskId)}/reliability/next-actions`,
    )
    if (reply.actions.length === 0) {
      return ok([style.dim('Nothing to do. No unresolved drivers.')], reply)
    }

    const lines: string[] = []
    if (reply.currentScore !== undefined) {
      lines.push(style.dim(`Currently ${String(reply.currentScore)} / 100`), '')
    }
    for (const action of reply.actions) {
      const gain = action.impact <= 0 ? '' : style.dim(` up to +${String(action.impact)}`)
      lines.push(`${severity(action.severity, style)} ${action.label}${gain}`)
      lines.push(style.dim(`    ${action.owner} · ${action.actionType}`))
      if (action.workflow !== undefined) {
        lines.push(style.dim(`    factory task new … --workflow ${action.workflow}`))
      }
      lines.push('')
    }
    // An estimate, and it says so rather than promising.
    lines.push(style.dim('Estimates. Resolving one usually turns up evidence that moves others.'))
    return ok(lines, reply)
  } catch (error) {
    return asFailure(error)
  }
}

export async function assess(
  client: DaemonClient,
  id: string,
  style: Style,
): Promise<CommandResult> {
  try {
    const taskId = await resolveTask(client, id)
    await client.request(`/api/tasks/${encodeURIComponent(taskId)}/reliability/assess`, {
      method: 'POST',
      body: {},
    })
    return await show(client, taskId, style)
  } catch (error) {
    return asFailure(error)
  }
}

/** A severity mark that reads without colour. */
function severity(value: string, style: Style): string {
  if (value === 'critical') return style.red('!!')
  if (value === 'high') return style.red(' !')
  if (value === 'medium') return style.yellow(' ~')
  if (value === 'low') return style.dim(' ·')
  return style.dim('  ')
}

/** `regressionSafety` reads badly in a column. */
function label(name: string): string {
  return name.replace(/([A-Z])/g, ' $1').toLowerCase()
}

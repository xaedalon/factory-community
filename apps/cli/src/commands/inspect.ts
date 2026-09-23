import {
  PROVIDER_KIND,
  STEP_KIND,
  type ProviderCapability,
  type Problem,
  type StepKindCapability,
} from '@factory/core'
import { DOCTOR_RULE_KIND, doctorContext, runDoctor } from '@factory/config'
import { columns, renderProblem, type Style } from '../render.js'
import { failed, ok, type CliContext, type CommandResult } from '../context.js'
import type { DaemonClient } from '../daemon.js'

/**
 * Every plugin, and whether it is switched on.
 *
 * The escape hatch. The board can switch a plugin off, and the one time you
 * most need to is when a plugin is stopping the daemon from starting — which
 * is exactly when the board cannot help. So the same list and the same switch
 * are here, reading and writing the same file.
 */
export function plugins(context: CliContext, style: Style): CommandResult {
  const lines = columns(
    context.plugins.map((candidate) => [
      '  ' + (candidate.name ?? candidate.id),
      candidate.essential ? style.dim('required') : candidate.enabled ? 'on' : 'off',
      candidate.loaded ? '' : candidate.enabled ? style.dim('did not load') : '',
      style.dim(candidate.source === 'scope' ? (candidate.scope ?? 'scope') : candidate.source),
    ]),
  )
  const restart = context.plugins.some(
    (candidate) => !candidate.enabled && candidate.loaded,
  )
  return ok(
    [
      ...lines,
      ...(restart
        ? ['', style.dim('Something is switched off but still loaded. Restart to unload it.')]
        : []),
    ],
    {
      plugins: context.plugins.map((candidate) => ({
        id: candidate.id,
        enabled: candidate.enabled,
        loaded: candidate.loaded,
      })),
    },
  )
}

/** Switch one on or off, writing the same settings file the board writes. */
export function switchPlugin(
  context: CliContext,
  id: string,
  enabled: boolean,
): CommandResult {
  const known = context.plugins.find((candidate) => candidate.id === id)
  if (!enabled && known === undefined) {
    return failed([`No plugin "${id}". Try "factory plugins" to see what there is.`])
  }
  if (!enabled && known?.essential === true) {
    return failed([
      `"${id}" is what makes workflows parse and run. Switching it off would leave Factory`,
      'unable to do anything.',
    ])
  }

  const disabled = new Set(context.settings.current().plugins.disabled)
  if (enabled) disabled.delete(id)
  else disabled.add(id)

  const saved = context.settings.update({ plugins: { disabled: [...disabled] } })
  if (saved.problems.length > 0) {
    return failed(saved.problems.map((problem) => problem.message))
  }
  return ok([
    `${id} is now ${enabled ? 'on' : 'off'}.`,
    ...(!enabled && known?.loaded === true
      ? ['Restart Factory to unload it.']
      : []),
  ])
}

/** `factory capabilities` — what is installed, and where it came from. */
export function capabilities(context: CliContext, style: Style): CommandResult {
  const lines: string[] = []
  const json: Record<string, unknown> = {}

  for (const kind of context.host.kinds()) {
    const entries = context.host.list(kind)
    lines.push(style.bold(kind))
    lines.push(
      ...columns(
        entries.map((entry) => [
          '  ' + entry.capability.id,
          entry.capability.summary ?? entry.capability.displayName ?? '',
          style.dim(entry.plugin),
        ]),
      ),
    )
    lines.push('')
    json[kind] = entries.map((entry) => ({ id: entry.capability.id, plugin: entry.plugin }))
  }

  if (lines.length === 0) {
    return ok(['Nothing is installed.', style.dim('That should not happen — the built-ins are missing.')])
  }
  return ok(lines, json)
}

/**
 * `factory doctor` — check the installation.
 *
 * Warnings do not fail the command. A shadowed definition or an agent that is
 * not installed on this particular machine is worth saying out loud, but it is
 * not a reason for a CI job to go red.
 *
 * Two halves, because half the answer is in a database this process does not
 * own. The rules about tasks, worktrees, a project's own git state and the
 * runs a restart had to close are registered only where there is a store —
 * so they live in the daemon, and until now **nothing printed them**: this
 * command built its own host without one, and the board declares the endpoint
 * and calls it from nowhere. A rule nobody can see is a rule that does not
 * exist.
 *
 * Merged rather than replaced: the two run over their own scope chains, which
 * can differ — the daemon's is where it was started, this one's is where you
 * are standing. Deduplicated on the rule and the sentence, because a problem
 * both of them find is one problem.
 */
export async function doctor(
  client: DaemonClient,
  context: CliContext,
  style: Style,
): Promise<CommandResult> {
  const report = await runDoctor(
    doctorContext({ chain: context.chain, host: context.host, env: context.env }),
  )

  const running = await askTheDaemon(client)
  const problems = dedupe([
    ...context.startupProblems,
    ...report.problems,
    ...(running?.problems ?? []),
  ])
  const errors = problems.filter((problem) => problem.severity === 'error')
  const warnings = problems.filter((problem) => problem.severity === 'warning')

  const lines = [
    style.dim(
      `Checked ${report.checked.workflows} workflow(s), ${report.checked.phases} phase(s) and ` +
        `${report.checked.agents} agent(s) against ${report.checked.rules} rule(s).`,
    ),
    '',
  ]

  if (problems.length === 0) {
    lines.push(style.green('No problems found.'))
    return ok(lines, { problems: [], checked: report.checked })
  }

  lines.push(...problems.map((problem) => renderProblem(problem, style)))
  lines.push('')
  lines.push(
    `${errors.length} error(s), ${warnings.length} warning(s).` +
      (errors.length === 0 ? ' Nothing here blocks a run.' : ''),
  )

  if (running === undefined) {
    lines.push(
      style.dim(
        'Checks that need a running daemon — tasks, worktrees, what git can see of a project — ' +
          'were not run. Start one and ask again.',
      ),
    )
  }

  const result = { problems, checked: report.checked }
  return errors.length > 0 ? failed(lines, result) : ok(lines, result)
}

/**
 * What the daemon's own rules found, or nothing if there is no daemon.
 *
 * Not reaching one is the ordinary case — plenty of people run `factory
 * doctor` before they have ever started it — so it is reported as a dim line
 * rather than as a failure of the command.
 */
async function askTheDaemon(
  client: DaemonClient,
): Promise<{ problems: Problem[] } | undefined> {
  try {
    return await client.request<{ problems: Problem[] }>('/api/doctor')
  } catch {
    return undefined
  }
}

/** One problem is one problem, however many rules found it. */
const dedupe = (problems: readonly Problem[]): Problem[] => {
  const seen = new Set<string>()
  return problems.filter((problem) => {
    const key = `${problem.rule ?? ''}|${problem.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** `factory provider list` — agents Factory can drive, and whether they are here. */
export function providers(context: CliContext, style: Style): CommandResult {
  const entries = context.host.list<ProviderCapability>(PROVIDER_KIND)
  if (entries.length === 0) {
    return ok(['No agent providers are installed.'])
  }

  const rows = entries.map((entry) => {
    const provider = entry.capability
    const availability = provider.availability(context.env)
    return [
      provider.id,
      availability.available ? style.green('installed') : style.yellow('not installed'),
      provider.descriptor.provisional ? style.yellow('unverified descriptor') : '',
      style.dim(Object.entries(provider.descriptor.models).map(([role, id]) => `${role}=${id}`).join(' ')),
    ]
  })
  return ok(columns(rows), entries.map((e) => e.capability.descriptor))
}

/** `factory step-kind list` — what a phase step may use. */
export function stepKinds(context: CliContext, style: Style): CommandResult {
  const entries = context.host.list<StepKindCapability>(STEP_KIND)
  const rows = entries.map((entry) => [
    entry.capability.id,
    entry.capability.plan === undefined ? style.yellow('not runnable') : style.green('runnable'),
    entry.capability.summary,
    style.dim(entry.plugin),
  ])
  return ok(columns(rows), entries.map((e) => e.capability.id))
}

/** `factory rule list` — the checks doctor will run. */
export function doctorRules(context: CliContext, style: Style): CommandResult {
  const entries = context.host.list(DOCTOR_RULE_KIND)
  const rows = entries.map((entry) => [
    entry.capability.id,
    entry.capability.summary ?? '',
    style.dim(entry.plugin),
  ])
  return ok(columns(rows), entries.map((e) => e.capability.id))
}

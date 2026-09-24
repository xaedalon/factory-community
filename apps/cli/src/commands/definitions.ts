import {
  parseAgentFile,
  parsePhaseFile,
  parseProfileFile,
  parseWorkflowFile,
  type Problem,
} from '@factory/core'
import {
  explain,
  listDefinitions,
  resolveAgent,
  resolvePhase,
  resolveProfileDefinition,
  resolveWorkflow,
  type DefinitionKind,
} from '@factory/config'
import { columns, renderProblem, type Style } from '../render.js'
import { failed, ok, type CliContext, type CommandResult } from '../context.js'

/**
 * One parser per kind, keyed rather than branched. A ternary's else arm
 * silently takes on every kind added afterwards.
 */
const parserFor = (kind: DefinitionKind, context: CliContext) => {
  const parsers: Record<
    DefinitionKind,
    (text: string, file: string) => { value: unknown; problems: readonly Problem[] }
  > = {
    workflow: (text, file) => {
      const r = parseWorkflowFile(text, file)
      return { value: r.value, problems: r.problems }
    },
    phase: (text, file) => {
      const r = parsePhaseFile(text, context.host, file)
      return { value: r.value, problems: r.problems }
    },
    agent: (text, file) => {
      const r = parseAgentFile(text, file)
      return { value: r.value, problems: r.problems }
    },
    profile: (text, file) => {
      const r = parseProfileFile(text, file)
      return { value: r.value, problems: r.problems }
    },
  }
  return parsers[kind]
}

/** `factory workflow list` / `factory phase list`. */
export function list(kind: DefinitionKind, context: CliContext, style: Style): CommandResult {
  const entries = listDefinitions(context.chain, kind, parserFor(kind, context))
  if (entries.length === 0) {
    return ok([
      `No ${kind}s found.`,
      style.dim('Run "factory init" to create a scope, or check "factory config path".'),
    ])
  }

  const rows = entries.map((entry) => [
    entry.valid ? entry.name : style.red(entry.name),
    entry.winner.scope,
    entry.shadowed.length > 0
      ? style.yellow(`shadows ${entry.shadowed.map((ref) => ref.scope).join(', ')}`)
      : '',
  ])

  return ok(columns(rows), entries)
}

/** `factory workflow show <name>` / `factory phase show <name>`. */
export function show(
  kind: DefinitionKind,
  name: string,
  context: CliContext,
  style: Style,
): CommandResult {
  const lookups: Record<DefinitionKind, () => ReturnType<typeof resolveWorkflow>> = {
    workflow: () => resolveWorkflow(context.chain, name),
    phase: () => resolvePhase(context.chain, context.host, name) as ReturnType<typeof resolveWorkflow>,
    agent: () => resolveAgent(context.chain, name) as ReturnType<typeof resolveWorkflow>,
    profile: () =>
      resolveProfileDefinition(context.chain, name) as ReturnType<typeof resolveWorkflow>,
  }
  const resolved = lookups[kind]()

  if (resolved === undefined) {
    return failed([
      `No ${kind} named "${name}" in any scope.`,
      style.dim(`Try "factory ${kind} list", or "factory why ${kind} ${name}" to see where it was looked for.`),
    ])
  }

  const lines = [
    style.bold(resolved.ref.name),
    style.dim(`  ${resolved.ref.scope} scope — ${resolved.ref.file}`),
  ]
  for (const shadow of resolved.shadows) {
    lines.push(style.yellow(`  hides the ${shadow.scope} copy at ${shadow.file}`))
  }
  lines.push('', ...resolved.raw.trimEnd().split('\n').map((line) => '  ' + line))

  if (resolved.problems.length > 0) {
    lines.push('', ...resolved.problems.map((problem) => renderProblem(problem, style)))
  }

  const failedToParse = resolved.problems.some((p: Problem) => p.severity === 'error')
  return failedToParse ? failed(lines, resolved) : ok(lines, resolved)
}

/** `factory why workflow <name>` — every path tried, in order. */
export function why(
  kind: DefinitionKind,
  name: string,
  context: CliContext,
  style: Style,
): CommandResult {
  const candidates = explain(context.chain, kind, name)
  const winner = candidates.find((candidate) => candidate.exists)

  const rows = candidates.map((candidate) => [
    candidate.exists ? (candidate === winner ? style.green('used') : style.dim('hidden')) : style.dim('absent'),
    candidate.scope,
    candidate.file,
  ])

  const lines = [
    winner === undefined
      ? `No ${kind} named "${name}" was found. Looked in:`
      : `"${name}" resolves from the ${style.bold(winner.scope)} scope. Looked in:`,
    ...columns(rows).map((line) => '  ' + line),
  ]
  return winner === undefined ? failed(lines, candidates) : ok(lines, candidates)
}

import { writeFileSync } from 'node:fs'
import { exportWorkflow, importBundle, readBundleFile, type ConflictPolicy } from '@factory/config'
import type { ScopeKind } from '@factory/config'
import { columns, renderProblem, type Style } from '../render.js'
import { failed, ok, type CliContext, type CommandResult } from '../context.js'

/** `factory workflow export <name> [-o file]`. */
export function exportBundle(
  name: string,
  options: { out?: string; allowMissing?: boolean },
  context: CliContext,
  style: Style,
): CommandResult {
  const result = exportWorkflow({
    chain: context.chain,
    host: context.host,
    name,
    ...(options.allowMissing === undefined ? {} : { allowMissing: options.allowMissing }),
  })

  if (result.text === undefined) {
    return failed(result.problems.map((problem) => renderProblem(problem, style)))
  }

  if (options.out === undefined) {
    // No destination: the bundle itself is the output, so it can be piped.
    return { lines: [result.text.trimEnd()], exitCode: 0, json: result.bundle }
  }

  writeFileSync(options.out, result.text)
  const counts =
    `${result.bundle?.workflows.length ?? 0} workflow(s), ${result.bundle?.phases.length ?? 0} phase(s)`
  return ok(
    [
      `${style.green('Exported')} ${name} to ${options.out}`,
      style.dim(`  ${counts}`),
      ...result.problems.map((problem) => renderProblem(problem, style)),
    ],
    result.bundle,
  )
}

/** `factory bundle import <file> [--scope] [--on-conflict] [--prefix] [--dry-run]`. */
export function importFile(
  file: string,
  options: {
    scope?: ScopeKind
    policy?: ConflictPolicy
    prefix?: string
    dryRun?: boolean
  },
  context: CliContext,
  style: Style,
): CommandResult {
  const read = readBundleFile(file, context.host)
  if (read.bundle === undefined) {
    return failed([
      `Could not read ${file}:`,
      ...read.problems.map((problem) => renderProblem(problem, style)),
    ])
  }

  const result = importBundle({
    chain: context.chain,
    host: context.host,
    bundle: read.bundle,
    ...(options.scope === undefined ? {} : { scope: options.scope }),
    ...(options.policy === undefined ? {} : { policy: options.policy }),
    ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
  })

  const rows = result.plan.items.map((item) => [
    item.action === 'create'
      ? style.green('create')
      : item.action === 'overwrite'
        ? style.yellow('overwrite')
        : item.action === 'conflict'
          ? style.red('conflict')
          : style.dim('skip'),
    item.kind,
    item.targetName === item.name ? item.name : `${item.name} -> ${item.targetName}`,
    item.shadows === undefined ? '' : style.yellow(`hides the ${item.shadows} copy`),
  ])

  // A bundle carrying only a profile names no entry workflow, so there is
  // nothing to quote — and quoting `undefined` is how a reader learns to
  // distrust the rest of the line.
  const what = result.plan.entry === undefined ? 'this bundle' : `"${result.plan.entry}"`
  const where = style.bold(options.scope ?? context.chain.defaultWriteScope)
  const lines = [
    options.dryRun === true
      ? `Would import ${what} into the ${where} scope:`
      : `Importing ${what} into the ${where} scope:`,
    ...columns(rows).map((line) => '  ' + line),
  ]

  if (result.problems.length > 0) {
    lines.push('', ...result.problems.map((problem) => renderProblem(problem, style)))
  }
  if (result.problems.some((problem) => problem.severity === 'error')) {
    lines.push('', style.dim('Nothing was written.'))
    return failed(lines, result.plan)
  }
  if (options.dryRun === true) {
    lines.push('', style.dim('Nothing was written — this was a dry run.'))
  } else {
    lines.push('', `${style.green('Wrote')} ${result.written.length} file(s).`)
  }
  return ok(lines, result.plan)
}

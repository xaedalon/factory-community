import { join } from 'node:path'
import { SCOPE_DIR, createScope, type ScopeKind } from '@factory/config'
import { columns, type Style } from '../render.js'
import { failed, ok, type CliContext, type CommandResult } from '../context.js'

/** `factory config path` — where Factory is reading from, in order. */
export function configPath(context: CliContext, style: Style): CommandResult {
  const rows = context.chain.scopes.map((scope) => [
    scope.kind,
    scope.exists ? 'present' : 'absent',
    scope.writable ? 'writable' : 'read-only',
    scope.root,
  ])
  const lines = [
    style.bold('Scopes, highest precedence first:'),
    ...columns(rows).map((line) => '  ' + line),
    '',
    `New definitions are written to the ${style.bold(context.chain.defaultWriteScope)} scope.`,
  ]
  if (context.chain.gitRoot !== undefined) {
    lines.push(style.dim(`Nearest repository: ${context.chain.gitRoot}`))
  }
  return ok(lines, {
    scopes: context.chain.scopes,
    defaultWriteScope: context.chain.defaultWriteScope,
    gitRoot: context.chain.gitRoot,
  })
}

/** `factory init` — create a scope directory that is ready to use. */
export function init(
  context: CliContext,
  options: { scope?: ScopeKind },
  style: Style,
): CommandResult {
  const kind = options.scope ?? (context.chain.gitRoot === undefined ? 'user' : 'project')

  if (kind === 'builtin') {
    return failed(['The built-in scope ships inside the package and cannot be created.'])
  }

  const root =
    kind === 'project'
      ? join(context.chain.gitRoot ?? context.cwd, SCOPE_DIR)
      : (context.chain.scopes.find((scope) => scope.kind === 'user')?.root ?? '')

  const outcome = createScope({ root, kind })
  if (!outcome.created) return ok([`Already initialised: ${root}`])

  return ok([
    `${style.green('Created')} ${kind} scope at ${root}`,
    '',
    'Next:',
    '  factory workflow list      what is available here',
    '  factory doctor             check the installation',
  ])
}

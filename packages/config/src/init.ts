import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { IGNORED_BY_PRODUCT } from '@factory/core'
import { DEFINITION_DIRECTORIES } from './store.js'
import { SCOPE_CONFIG_FILE } from './scopes.js'

/**
 * Create a scope directory that is ready to use.
 *
 * Here rather than in the CLI, which is where it was written, because the
 * daemon needs the same thing and a second copy of "what a scope looks like
 * when it is new" is a second thing to keep in step. A project registered
 * through the board wants its scope for exactly the reason `factory init`
 * wants one: without it, every write asking for the project scope fails, and
 * the setting that copies a project's worktree workflows in has nowhere to
 * put them.
 *
 * Idempotent by the file that defines a scope: if `config.yaml` is there, the
 * directory is somebody's and is left alone.
 */
export function createScope(options: { root: string; kind: 'project' | 'user' }): {
  readonly created: boolean
  readonly root: string
} {
  const { root, kind } = options
  if (existsSync(join(root, SCOPE_CONFIG_FILE))) return { created: false, root }

  // From the kind list rather than a hand-written pair, so a scope created
  // today has a directory for every kind Factory knows about.
  for (const directory of DEFINITION_DIRECTORIES) {
    mkdirSync(join(root, directory), { recursive: true })
  }

  // What a run produces is not what a project committed. Written next to the
  // directory it is about, and only when it is not already there — the moment
  // it exists it is the user's file to edit.
  if (kind === 'project') {
    const ignore = join(root, '..', '.gitignore')
    if (!existsSync(ignore)) writeFileSync(ignore, `${IGNORED_BY_PRODUCT}\n`)
  }

  writeFileSync(join(root, SCOPE_CONFIG_FILE), kind === 'project' ? PROJECT_CONFIG : USER_CONFIG)
  return { created: true, root }
}

const PROJECT_CONFIG = [
  '# Factory definitions for this project.',
  '#',
  '# Commit this directory. Anyone who clones the repository gets these',
  '# workflows, phases and plugins with no separate install step, and they',
  '# take precedence over anything in ~/.xaedalon/.factory.',
  '#',
  '# What runs produce lives beside it, under tasks/, and is ignored.',
  'kind: factory.scope/v1',
  'scope: project',
  '',
  '# plugins:',
  '#   - ./plugins/my-plugin.mjs',
  '',
].join('\n')

const USER_CONFIG = [
  '# Your personal Factory definitions.',
  '#',
  "# These apply everywhere you work, and any project's own",
  '# .xaedalon/.factory directory takes precedence over them.',
  'kind: factory.scope/v1',
  'scope: user',
  '',
].join('\n')

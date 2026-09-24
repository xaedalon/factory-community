/**
 * The one command that says whether a project's work is sound.
 *
 * A supervised run of ten tasks produced a `validate` workflow that passed
 * every time by asking an agent whether the work was good. It said yes. The
 * dependencies were not installed and the tests had never run — an agent's
 * report is a *claim*, and Factory was treating it as a *result*.
 *
 * The gate needed to fix that already exists: a shell step whose non-zero exit
 * fails the phase and blocks the task. What was missing was anything that knew
 * what to run. So a project carries one command, `{{ project.check }}`, and the
 * built-in `project-check` phase is nothing but that command — which means a
 * workflow ending in a real gate is one word in its phase list.
 *
 * Detected rather than asked for, where it can be. Nobody sets up a project by
 * filling in a form they were not expecting, and "npm test" is not a difficult
 * guess for a repository with a `test` script in its `package.json`.
 */

/** Reads a file from the project, relative to its root. Undefined if it is not there. */
export type ProjectFileReader = (relative: string) => string | undefined

/**
 * What runs this project's own checks, guessed from what is in the repository.
 *
 * Deliberately conservative. A wrong guess is worse than none: it is a command
 * a person did not choose, failing for a reason they have to go and find, in a
 * gate they did not know was there. So every branch below needs positive
 * evidence — a declared script, a manifest, a named target — and anything else
 * returns undefined and lets somebody type it.
 *
 * The order is the order a repository answers in. A JavaScript project with a
 * `Makefile` is still a JavaScript project.
 */
export function detectCheckCommand(read: ProjectFileReader): string | undefined {
  const scripts = packageScripts(read('package.json'))
  if (scripts !== undefined) {
    // `check` and `verify` before `test`, because a project that declares one
    // of them alongside `test` means the difference: `test` is the suite,
    // `check` is the whole gate. Nothing invented — each has to be declared.
    const script = ['check', 'verify', 'test'].find((name) => scripts.has(name))
    if (script !== undefined) return `${packageManager(read)} ${script}`
  }

  if (read('Cargo.toml') !== undefined) return 'cargo test'
  if (read('go.mod') !== undefined) return 'go test ./...'

  const makefile = read('Makefile') ?? read('makefile')
  if (makefile !== undefined && hasTarget(makefile, 'test')) return 'make test'

  return undefined
}

/**
 * The scripts a `package.json` declares, or undefined if it declares none.
 *
 * Undefined rather than an empty set for a file that will not parse: a broken
 * `package.json` is not evidence of anything, and guessing `npm test` for a
 * repository whose manifest is unreadable would be a guess about a project
 * nobody can build.
 */
function packageScripts(source: string | undefined): Set<string> | undefined {
  if (source === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const scripts = (parsed as { scripts?: unknown }).scripts
  if (typeof scripts !== 'object' || scripts === null) return undefined
  return new Set(Object.keys(scripts as Record<string, unknown>))
}

/**
 * Which package manager this repository is run with, from its lockfile.
 *
 * The lockfile is the only honest answer: `packageManager` in the manifest is
 * frequently absent, and what is installed on the machine says nothing about
 * what the project expects. `npm` is the fallback because it is the one that
 * is always there.
 */
function packageManager(read: ProjectFileReader): string {
  if (read('pnpm-lock.yaml') !== undefined) return 'pnpm'
  if (read('yarn.lock') !== undefined) return 'yarn'
  if (read('bun.lock') !== undefined || read('bun.lockb') !== undefined) return 'bun'
  return 'npm'
}

/**
 * Whether a Makefile declares a target by this name.
 *
 * A plain scan for `name:` at the start of a line, excluding `name :=` — which
 * is an assignment, and running `make test` against a Makefile whose only
 * `test` is a variable fails with a message about the Makefile rather than
 * about the work. Make's grammar is larger than this: pattern rules, variables
 * standing in for target names, includes. Implementing it would be a second
 * implementation of a specification this project does not own, so the scan
 * finds the ordinary case and misses the exotic one — which is the right way
 * round, because a miss leaves the field empty for somebody to fill in.
 */
function hasTarget(makefile: string, name: string): boolean {
  const declares = new RegExp(`^${name}\\s*:(?!=)`)
  return makefile.split('\n').some((line) => declares.test(line))
}

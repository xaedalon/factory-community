import type { Join } from './project.js'

/**
 * Where Xaedalon products put files that belong to the product, not the project.
 *
 * A repository is the user's. Anything a product writes into one has to be
 * findable, obviously not theirs, and easy to ignore in a single line — so it
 * all goes under one directory named for the family, with a directory per
 * product inside it. Factory is the first; the shape is meant for the others.
 *
 * ```
 * <repo>/.xaedalon/
 *   .gitignore                    "*" — the whole directory, until it is shared
 *   .factory/
 *     workflows/ phases/ agents/  definitions, written by a person
 *     tasks/<task>/artifacts/     what runs produced
 *     state/factory.db            the database, when it lives in this repository
 *     .trash/<stamp>/             what a bundle import replaced
 * ```
 *
 * `join` is a parameter, the way `defaultWorktreesRoot` already takes one, so
 * core needs no import from `node:path`.
 */

/**
 * Join path parts, without importing `node:path`.
 *
 * Here rather than in each caller because there were two: `resolvePlan` had a
 * **binary** one while `Join` is variadic, so `artifactFile(root, name, file)`
 * silently dropped the filename — the prompt named `analysis/analysis.md` and
 * the collector looked at `analysis/`. Two implementations of one idea, and the
 * one that was wrong was the one nobody was reading.
 *
 * An absolute part starts again, the way `path.join` does not but every caller
 * here expects.
 */
export const joinPath: Join = (...parts: string[]): string =>
  parts.reduce((base, part) =>
    part.startsWith('/') ? part : `${base.replace(/\/+$/, '')}/${part}`,
  )

/** The family's directory inside a repository. */
export const PRODUCT_FAMILY_DIR = '.xaedalon'

/** Factory's directory inside it. */
export const PRODUCT_DIR = '.factory'

/**
 * What a run wrote, as opposed to what a person wrote.
 *
 * One list. It is read by the narrow ignore body below, by the instructions
 * inside the wide one, and by the doctor rule that asks git what is tracked —
 * and three copies of "which directories are output" is how a file and a
 * diagnosis come to disagree about the same three names.
 *
 * `state/` is here because a daemon started inside a repository that has its
 * own scope keeps its database there. `.trash/` is here because a bundle
 * import moves what it replaced into it. Neither was ignored before this, so
 * both were sitting untracked in somebody's `git status`.
 */
export const PRODUCT_OUTPUT_DIRS = ['tasks', 'state', '.trash'] as const

/** Those three, as patterns relative to the family directory. */
const OUTPUT_PATTERNS = PRODUCT_OUTPUT_DIRS.map((directory) => `${PRODUCT_DIR}/${directory}/`)

/**
 * The ignore file written when Factory **creates** the family directory.
 *
 * Everything, including this file. A repository is the user's: most of them
 * are not using Factory, somebody trying it out should not have to explain a
 * directory of untracked files to their team, and adding a project has to
 * leave `git status` exactly as it was. Sharing is then a decision they make,
 * and it costs one edit.
 *
 * `*` ignores the file that declares it — git reads a `.gitignore` from the
 * working tree whether or not it is tracked, and nothing exempts it from
 * matching. **This is the opposite of the recipe you will find everywhere
 * else**, which is `*` followed by `!.gitignore` to keep the ignore file in
 * version control. Do not "fix" it: the point is that git sees nothing at all.
 *
 * The three lines are given bare rather than annotated, because `#` only
 * starts a comment at the beginning of a line — `.factory/tasks/ # artifacts`
 * would make the annotation part of the pattern, and we would be handing
 * somebody a paste that does not work.
 */
export const IGNORE_EVERYTHING_HERE = [
  '# Factory keeps its files here: the workflows, phases and agents you write,',
  '# under .factory/, and whatever its runs produce beside them.',
  '#',
  '# The * on the last line hides all of it from git — this file included — so',
  '# Factory has added nothing to your git status. A repository is yours, and a',
  '# tool you are trying out has no business in your next commit.',
  '#',
  '# To share these definitions with everyone who clones the repository,',
  '# replace that * with the three lines below and commit .xaedalon. They',
  '# ignore only what a run produced: a task\'s artifacts, Factory\'s database',
  '# if it lives in this repository, and the backups a bundle import takes.',
  '#',
  `#   ${OUTPUT_PATTERNS.join('\n#   ')}`,
  '#',
  '# Deleting this file does the same thing, and Factory writes the smaller',
  '# version back the next time one of its runs produces an artifact.',
  '#',
  '# None of this untracks anything already committed: git ignores only what it',
  '# is not already tracking. "git status --ignored" lists what is here, and',
  '# "git check-ignore -v <path>" says which line hid a given file.',
  '*',
  '',
].join('\n')

/**
 * The ignore file written when the directory was already there.
 *
 * Output only — never the definitions. This one is written beside a directory
 * Factory did not create, which may already be committed and shared, and
 * ignoring that wholesale would hide a team's new workflows from `git status`
 * without hiding the ones already in it.
 */
export const IGNORE_WHAT_RUNS_PRODUCE = [
  "# What Factory's runs produce, which is not what anybody wrote.",
  '#',
  '# Your definitions under .factory/ are yours to commit or not. These three',
  "# are generated — a task's artifacts, Factory's database when it lives in",
  '# this repository, and what a bundle import replaced — and they belong in',
  "# nobody's diff.",
  ...OUTPUT_PATTERNS,
  '',
].join('\n')

export const familyRoot = (projectPath: string, join: Join): string =>
  join(projectPath, PRODUCT_FAMILY_DIR)

export const productRoot = (projectPath: string, join: Join): string =>
  join(familyRoot(projectPath, join), PRODUCT_DIR)

/**
 * Everything one task produced.
 *
 * Keyed by the task's directory — the slug frozen when the task was created —
 * which is also what its worktree is called, so the two read as the same task.
 */
export const taskRoot = (projectPath: string, taskDirectory: string, join: Join): string =>
  join(productRoot(projectPath, join), 'tasks', taskDirectory)

/**
 * Where a task's artifacts live.
 *
 * Under the project, never under the worktree. A worktree is deleted when the
 * work in it ends, and an artifact that disappears with the work it describes
 * is no better than no artifact.
 */
export const artifactsRoot = (projectPath: string, taskDirectory: string, join: Join): string =>
  join(taskRoot(projectPath, taskDirectory, join), 'artifacts')

/** The current version of one artifact. Always Markdown, so the name is enough. */
export const artifactFile = (artifacts: string, name: string, join: Join): string =>
  join(artifacts, name, `${name}.md`)

/** Where the copies of every run of it are kept. */
export const artifactVersions = (artifacts: string, name: string, join: Join): string =>
  join(artifacts, name, 'versions')

/** One of those copies. */
export const artifactVersion = (
  artifacts: string,
  name: string,
  stamp: string,
  join: Join,
): string => join(artifactVersions(artifacts, name, join), `${name}-${stamp}.md`)

/**
 * A timestamp that is safe in a filename.
 *
 * The same shape the bundle importer already uses for its dated backup
 * directory: ISO-8601 with the characters a filesystem dislikes replaced. Taken
 * as a `Date` so a caller can pass its own clock and a test can be deterministic.
 */
export const fileStamp = (at: Date): string => at.toISOString().replaceAll(/[:.]/g, '-')

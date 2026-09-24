import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import {
  PROJECT_TONES,
  defaultWorktreesRoot,
  lexicalCanonical,
  systemCanonical,
  withinWorkspace,
  type Canonicalise,
  type ExecutionProfile,
  type Project,
} from '@factory/core'
import type { EventBus } from '@factory/events'
import type { Database } from './sqlite.js'

/**
 * Projects, on disk.
 *
 * The path is checked here, on the way in, rather than when something tries to
 * run there. A project pointing at a directory that does not exist is a mistake
 * someone can fix in two seconds at the moment they make it, and a mystery half
 * an hour into a run.
 */

interface ProjectRow {
  id: string
  name: string
  path: string
  default_branch: string
  worktrees_root: string
  is_repository: number
  uses_worktrees: number
  uses_environments: number
  profile: string | null
  granted_directories: string | null
  tone: number | null
  initials: string | null
  check_command: string | null
  reliability_model: string | null
  reliability_enabled: number
  created_at: string
}

export interface AddProject {
  readonly name: string
  readonly path: string
  readonly defaultBranch?: string
  readonly worktreesRoot?: string
  /** Defaults to whether the directory is a git repository. */
  readonly usesWorktrees?: boolean
  /** Defaults to off: Factory cannot build an environment unaided. */
  readonly usesEnvironments?: boolean
  /**
   * The command that says whether this project's work is sound.
   *
   * Supplied by whoever adds the project — the board detects it from the
   * repository where it can. Absent means nobody has said, and the built-in
   * `project-check` phase then refuses to plan rather than running nothing.
   */
  readonly check?: string
}

export interface ProjectRepositoryOptions {
  readonly db: Database
  readonly events?: EventBus
  readonly now?: () => string
  readonly newId?: () => string
}

/**
 * A project still holding tasks.
 *
 * Its own type, like `WorkflowHasRunError`: the route turns this into a 409 and
 * needs to know it is *this* refusal rather than a database error, and the count
 * is what the message is for.
 */
export class ProjectHasTasksError extends Error {
  override readonly name = 'ProjectHasTasksError'
  constructor(
    project: string,
    readonly count: number,
    readonly archived: number,
  ) {
    super(
      `Cannot remove "${project}": ${count} task${count === 1 ? '' : 's'} still in it` +
        (archived > 0 ? ` (${archived} archived)` : '') +
        `. Delete ${count === 1 ? 'it' : 'them'} first.`,
    )
  }
}

/** Which project a directory is in, and how that was decided. */
export interface ProjectAt {
  readonly project: Project
  /**
   * `directory` — the project's own path.
   * `ancestor` — somewhere below it.
   * `worktree` — below where that project's worktrees go.
   */
  readonly matchedBy: 'directory' | 'ancestor' | 'worktree'
  /**
   * For a worktree match, the directory holding it — which is a task's, and is
   * how a caller turns "where am I" into "which task am I working on".
   *
   * The task itself is not looked up here: this repository writes project rows,
   * and reaching into tasks from it would be the second place that knows how a
   * worktree path is built.
   */
  readonly taskDirectory?: string
}

/**
 * Two projects with an equal claim on one directory.
 *
 * Its own type for the reason `ProjectHasTasksError` has one: the route turns
 * this into a 409 and the names are what the message is for. Picking between
 * them would queue somebody's work against the wrong repository, and it would
 * do it silently.
 */
export class AmbiguousProjectError extends Error {
  override readonly name = 'AmbiguousProjectError'
  constructor(
    path: string,
    readonly names: readonly string[],
  ) {
    super(
      `${path} is in more than one project: ${names.join(', ')}. ` +
        `Say which one you mean.`,
    )
  }
}

export class ProjectRepository {
  readonly #db: Database
  readonly #events: EventBus | undefined
  readonly #now: () => string
  readonly #newId: () => string

  constructor(options: ProjectRepositoryOptions) {
    this.#db = options.db
    this.#events = options.events
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#newId = options.newId ?? (() => randomUUID())
  }

  add(input: AddProject): Project {
    const name = input.name.trim()
    if (name === '') throw new Error('A project needs a name.')

    // Resolved rather than required-absolute: a caller passing a relative path
    // means it relative to its own working directory, and it is the only one
    // that knows what that is — so it resolves before calling. Anything still
    // relative here is a bug worth naming.
    if (!isAbsolute(input.path)) {
      throw new Error(`The path for "${name}" must be absolute; got "${input.path}".`)
    }
    const path = resolve(input.path)

    if (!existsSync(path)) {
      throw new Error(`Cannot add "${name}": there is nothing at ${path}.`)
    }
    if (!statSync(path).isDirectory()) {
      throw new Error(`Cannot add "${name}": ${path} is not a directory.`)
    }
    if (this.byName(name) !== undefined) {
      throw new Error(`There is already a project called "${name}".`)
    }

    const check = input.check?.trim() ?? ''
    const id = this.#newId()
    // A worktree needs a repository; a directory without one is still a fine
    // place to run shell steps, so this is recorded rather than refused.
    const isRepository = existsSync(join(path, '.git'))
    const usesWorktrees = input.usesWorktrees ?? isRepository

    // Refused rather than quietly corrected, for the same reason the path is
    // checked here: a mistake someone can fix in two seconds now is a mystery
    // half an hour into a run.
    if (usesWorktrees && !isRepository) {
      throw new Error(
        `Cannot give "${name}" a worktree for each task: ${path} is not a git repository. ` +
          `Leave worktrees off and its work will happen in that directory, one task at a time.`,
      )
    }

    this.#db.run(
      `INSERT INTO projects (id, name, path, default_branch, worktrees_root, is_repository,
                             uses_worktrees, uses_environments, check_command, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      name,
      path,
      input.defaultBranch ?? 'main',
      input.worktreesRoot ?? defaultWorktreesRoot(path, name, join),
      isRepository ? 1 : 0,
      usesWorktrees ? 1 : 0,
      input.usesEnvironments === true ? 1 : 0,
      // Blank is null here too, so "set" and "set to nothing" cannot be
      // confused by anything reading the row later.
      check === '' ? null : check,
      this.#now(),
    )
    const project = this.get(id) as Project
    this.#events?.emit('project.added', { projectId: id, name, path })
    return project
  }

  get(id: string): Project | undefined {
    const row = this.#db.get<ProjectRow>('SELECT * FROM projects WHERE id = ?', id)
    return row === undefined ? undefined : hydrate(row)
  }

  byName(name: string): Project | undefined {
    const row = this.#db.get<ProjectRow>('SELECT * FROM projects WHERE name = ?', name)
    return row === undefined ? undefined : hydrate(row)
  }

  list(): Project[] {
    return this.#db.all<ProjectRow>('SELECT * FROM projects ORDER BY name').map(hydrate)
  }

  /**
   * Which project is this directory in?
   *
   * Every client so far knew a project's id or its name, because a person had
   * picked it from a list. An agent standing in a directory knows neither, and
   * the one question it can answer had nowhere to go — projects were looked up
   * by id and by name, and nothing ever read the path column.
   *
   * Longest match wins, so a project registered inside another resolves to the
   * inner one, which is what somebody working in it means. Two projects with
   * the same claim are refused by name rather than picked between: a wrong
   * answer here queues work against somebody else's repository.
   *
   * A project's worktrees count as its territory, and a worktree names the task
   * whose it is. That is not only a convenience — it is an identity Factory can
   * check against a path, which matters wherever a caller's account of itself
   * cannot be trusted.
   *
   * `canonical` is a parameter for the reason `withinWorkspace` takes one, and
   * it defaults to the real thing here because this repository already reads the
   * filesystem to add a project. It is load-bearing rather than tidy: a macOS
   * temporary directory is a symlink and so is many a home directory, and
   * comparing the written strings answers "no project" for a directory that
   * plainly is one.
   */
  at(path: string, canonical: Canonicalise = systemCanonical): ProjectAt | undefined {
    if (!isAbsolute(path)) {
      throw new Error(
        `Cannot say which project is at "${path}": the path has to be absolute. ` +
          `Whoever asked is the only one that knows what it is relative to.`,
      )
    }
    const here = canonical(path)

    // Both sides are canonical by the time they are compared, so the rule left
    // for `withinWorkspace` is the one worth borrowing rather than rewriting:
    // the workspace itself counts, and a sibling whose name merely starts the
    // same way does not.
    const claims: { readonly at: ProjectAt; readonly length: number }[] = []
    for (const project of this.list()) {
      const root = canonical(project.path)
      if (withinWorkspace(here, root, lexicalCanonical)) {
        claims.push({
          at: { project, matchedBy: here === root ? 'directory' : 'ancestor' },
          length: root.length,
        })
      }

      const worktrees = canonical(project.worktreesRoot)
      if (withinWorkspace(here, worktrees, lexicalCanonical)) {
        const directory = here.slice(worktrees.length + 1).split('/')[0]
        claims.push({
          at: {
            project,
            matchedBy: 'worktree',
            ...(directory === undefined || directory === '' ? {} : { taskDirectory: directory }),
          },
          length: worktrees.length,
        })
      }
    }
    if (claims.length === 0) return undefined

    const longest = Math.max(...claims.map((claim) => claim.length))
    const best = claims.filter((claim) => claim.length === longest)
    const names = [...new Set(best.map((claim) => claim.at.project.name))].sort()
    if (names.length > 1) throw new AmbiguousProjectError(here, names)
    return best[0]?.at
  }

  /**
   * Turn worktrees on or off for a project that already exists.
   *
   * Turning them *on* re-checks the disk rather than trusting `is_repository`:
   * that column is written once when the project is added and never refreshed,
   * so someone who ran `git init` afterwards could otherwise never turn them on.
   * The same UPDATE corrects the column, which also keeps the "not a git
   * repository" badge honest.
   *
   * Deliberately allowed while the project has work in flight. Tasks already
   * running finish where they are, and the new rule applies to what starts
   * next — a refusal nobody can discover is worse than a graceful change.
   */
  setWorktrees(id: string, usesWorktrees: boolean): Project {
    const project = this.get(id)
    if (project === undefined) throw new Error(`No project ${id}.`)

    const isRepository = existsSync(join(project.path, '.git'))
    if (usesWorktrees && !isRepository) {
      throw new Error(
        `Cannot give "${project.name}" a worktree for each task: ${project.path} is not a git ` +
          `repository.`,
      )
    }

    this.#db.run(
      'UPDATE projects SET uses_worktrees = ?, is_repository = ? WHERE id = ?',
      usesWorktrees ? 1 : 0,
      isRepository ? 1 : 0,
      id,
    )
    return this.#changed(id)
  }

  /**
   * Turn environments on or off.
   *
   * No repository check, unlike worktrees: an environment is whatever the
   * project's own workflows build, and there is nothing about a directory that
   * makes one impossible. Turning it on is a statement that this project has
   * environment workflows worth running, and the caller is expected to make
   * sure it has them.
   */
  setEnvironments(id: string, usesEnvironments: boolean): Project {
    if (this.get(id) === undefined) throw new Error(`No project ${id}.`)
    this.#db.run(
      'UPDATE projects SET uses_environments = ? WHERE id = ?',
      usesEnvironments ? 1 : 0,
      id,
    )
    return this.#changed(id)
  }

  /**
   * Call it something else.
   *
   * The alternative was remove-and-add-again, which nulls the `project_id` of
   * every task that ever ran in the project: the record of the work survives,
   * pointing at nothing. A rename is one column and keeps every reference.
   *
   * The unique check skips the project itself, so renaming something to what it
   * is already called is a no-op rather than a collision with its own row.
   */
  rename(id: string, name: string): Project {
    if (this.get(id) === undefined) throw new Error(`No project ${id}.`)
    const trimmed = name.trim()
    if (trimmed === '') throw new Error('A project needs a name.')
    const existing = this.byName(trimmed)
    if (existing !== undefined && existing.id !== id) {
      throw new Error(`A project called "${trimmed}" already exists.`)
    }
    this.#db.run('UPDATE projects SET name = ? WHERE id = ?', trimmed, id)
    return this.#changed(id)
  }

  /**
   * Point the project at a different branch.
   *
   * Worth more than it looks: aiming Factory's merges somewhere other than the
   * repository's published default is how a person keeps `main` clean, and
   * until this existed that cost them every task in the project.
   *
   * Not checked against the repository. A branch that does not exist yet is a
   * perfectly ordinary thing to point at — the workflow that creates it has not
   * run — and the check would have to be redone at run time anyway.
   */
  setDefaultBranch(id: string, branch: string): Project {
    if (this.get(id) === undefined) throw new Error(`No project ${id}.`)
    const trimmed = branch.trim()
    if (trimmed === '') throw new Error('A project needs a branch to start work from.')
    this.#db.run('UPDATE projects SET default_branch = ? WHERE id = ?', trimmed, id)
    return this.#changed(id)
  }

  /**
   * Choose the square, or hand it back to the name.
   *
   * `undefined` for either means derived, which is where every project starts
   * and where it returns to — the same three-position idea `profile` needed,
   * and for the same reason: "hasn't chosen" is a real answer and has to be
   * expressible.
   *
   * Letters are capped at two and upper-cased here rather than at the edge, so
   * a square is the same size whichever side of the app wrote it.
   */
  setAppearance(
    id: string,
    appearance: { tone?: number | undefined; initials?: string | undefined },
  ): Project {
    if (this.get(id) === undefined) throw new Error(`No project ${id}.`)
    if ('tone' in appearance) {
      const tone = appearance.tone
      if (tone !== undefined && (!Number.isInteger(tone) || tone < 1 || tone > PROJECT_TONES)) {
        throw new Error(`A project's colour is 1 to ${PROJECT_TONES}, or nothing to derive it.`)
      }
      this.#db.run('UPDATE projects SET tone = ? WHERE id = ?', tone ?? null, id)
    }
    if ('initials' in appearance) {
      const letters = appearance.initials?.trim().slice(0, 2).toUpperCase()
      this.#db.run(
        'UPDATE projects SET initials = ? WHERE id = ?',
        letters === undefined || letters === '' ? null : letters,
        id,
      )
    }
    return this.#changed(id)
  }

  /**
   * Set, or clear, the command that checks this project's work.
   *
   * Blank clears it, and clearing is a real choice: a project whose gate
   * should not run is better off saying so than carrying a command nobody
   * meant. What it cannot become is an empty string that still looks set —
   * `project-check` would then plan `bash -c ''` and report success.
   */
  setCheck(id: string, check: string | undefined): Project {
    if (this.get(id) === undefined) throw new Error(`No project ${id}.`)
    const trimmed = check?.trim()
    this.#db.run(
      'UPDATE projects SET check_command = ? WHERE id = ?',
      trimmed === undefined || trimmed === '' ? null : trimmed,
      id,
    )
    return this.#changed(id)
  }

  /**
   * Say which model judges this project's work.
   *
   * Blank clears it, and a cleared model is a project with no agent evaluator
   * rather than a project judged by a default nobody chose. The alternative —
   * falling back to some model named in Factory's own source — would spend
   * somebody's tokens on a decision they never made.
   */
  setReliabilityModel(id: string, model: string | undefined): Project {
    if (this.get(id) === undefined) throw new Error(`No project ${id}.`)
    const trimmed = model?.trim()
    this.#db.run(
      'UPDATE projects SET reliability_model = ? WHERE id = ?',
      trimmed === undefined || trimmed === '' ? null : trimmed,
      id,
    )
    return this.#changed(id)
  }

  /**
   * Switch judging on or off, without forgetting the model.
   *
   * Two columns rather than one nullable model precisely so this is possible:
   * "off" and "nobody has chosen" are different positions, and collapsing them
   * would mean switching judging back on always started from nothing.
   */
  setReliabilityEnabled(id: string, enabled: boolean): Project {
    if (this.get(id) === undefined) throw new Error(`No project ${id}.`)
    this.#db.run(
      'UPDATE projects SET reliability_enabled = ? WHERE id = ?',
      enabled ? 1 : 0,
      id,
    )
    return this.#changed(id)
  }

  /** Re-read and announce. Every setter ends the same way. */
  #changed(id: string): Project {
    const updated = this.get(id) as Project
    this.#events?.emit('project.changed', {
      projectId: id,
      name: updated.name,
      usesWorktrees: updated.usesWorktrees,
      usesEnvironments: updated.usesEnvironments,
    })
    return updated
  }

  /**
   * Say how much authority this project's runs get.
   *
   * `undefined` clears it, which is not the same as setting `default`: a
   * project that states nothing follows the installation's choice, and that is
   * a position somebody may want to return to.
   */
  setProfile(id: string, profile: ExecutionProfile | undefined): Project {
    const before = this.get(id)
    if (before === undefined) throw new Error(`No project ${id}.`)
    this.#db.run('UPDATE projects SET profile = ? WHERE id = ?', profile ?? null, id)
    const after = this.get(id) as Project
    // The same event a worktree or environment change emits, in its existing
    // shape. Its own description is already "a setting changed that decides
    // where — and how much of — its work runs", and the profile is exactly the
    // "how much". A second event name, or a wider payload, would mean the
    // browser's allow-list needing to know about it — and that list is already
    // a partial copy of the registry.
    this.#events?.emit('project.changed', {
      projectId: id,
      name: after.name,
      usesWorktrees: after.usesWorktrees,
      usesEnvironments: after.usesEnvironments,
    })
    return after
  }

  /**
   * Allow this project's agents one more directory, for good.
   *
   * Absolute only, and de-duplicated. A relative path would mean a different
   * directory depending on which task was running, which is the opposite of
   * what a persistent grant is for.
   *
   * Returns the project whether or not anything changed: granting a directory
   * twice is what pressing the button twice looks like, and it is not an error.
   */
  grantDirectory(id: string, directory: string): Project {
    const before = this.get(id)
    if (before === undefined) throw new Error(`No project ${id}.`)
    if (!isAbsolute(directory)) {
      throw new Error(`A granted directory has to be absolute: "${directory}".`)
    }
    const next = [...new Set([...before.grantedDirectories, resolve(directory)])].sort()
    this.#db.run('UPDATE projects SET granted_directories = ? WHERE id = ?', JSON.stringify(next), id)
    return this.get(id) as Project
  }

  /** Take a granted directory back. */
  revokeDirectory(id: string, directory: string): Project {
    const before = this.get(id)
    if (before === undefined) throw new Error(`No project ${id}.`)
    const next = before.grantedDirectories.filter((held) => held !== resolve(directory))
    this.#db.run('UPDATE projects SET granted_directories = ? WHERE id = ?', JSON.stringify(next), id)
    return this.get(id) as Project
  }

  /**
   * Forget a project, if nothing is left in it.
   *
   * This used to orphan the tasks instead, on the reasoning that removing a
   * project is bookkeeping and the work still happened. The record was worth
   * keeping and orphaning was the wrong way to keep it: a task with no project
   * ran wherever the daemon was started, could not be queued as a batch or
   * given a worktree, and disappeared from the board the moment any project was
   * selected. Refusing keeps the record by keeping the project, and says what
   * is in the way.
   *
   * Counted rather than listed, and counted with SQL rather than `list()`,
   * which hides archived tasks — the foreign key refuses over those too, so a
   * count that skipped them would contradict the database one line later.
   */
  remove(id: string): boolean {
    const project = this.get(id)
    if (project === undefined) return false

    const counts = this.#db.get<{ total: number; archived: number }>(
      `SELECT count(*) AS total,
              sum(CASE WHEN state = 'archived' THEN 1 ELSE 0 END) AS archived
         FROM tasks WHERE project_id = ?`,
      id,
    )
    if ((counts?.total ?? 0) > 0) {
      throw new ProjectHasTasksError(project.name, counts?.total ?? 0, counts?.archived ?? 0)
    }

    const removed = this.#db.run('DELETE FROM projects WHERE id = ?', id).changes > 0
    if (removed) this.#events?.emit('project.removed', { projectId: id })
    return removed
  }
}

function hydrate(row: ProjectRow): Project {
  // Any non-empty name, kept as written. The store cannot know which profiles
  // are *defined* — that needs a scope chain it does not have — and discarding
  // what it does not recognise used to mean reading it as "not stated", which
  // is inheriting the installation's profile: a project that asked for
  // something particular would quietly run under something else.
  //
  // So the name survives, and the two places that can actually answer do the
  // guarding: the route refuses an unknown name before storing it, and planning
  // refuses to run a profile no scope defines. A row edited by hand into
  // nonsense stops the work loudly rather than loosening it silently.
  //
  // Blank is still absence, which is a real answer and where every project
  // starts.
  const stated = typeof row.profile === 'string' ? row.profile.trim() : ''
  const profile = stated === '' ? undefined : (stated as ExecutionProfile)
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    defaultBranch: row.default_branch,
    worktreesRoot: row.worktrees_root,
    isRepository: row.is_repository === 1,
    usesWorktrees: row.uses_worktrees === 1,
    usesEnvironments: row.uses_environments === 1,
    ...(profile === undefined ? {} : { profile }),
    // Out of range reads as unset rather than as a hue nobody defined, for the
    // same reason `profile` goes through its guard: a column edited by hand
    // should degrade to the derived square, not to no square at all.
    ...(row.tone !== null && row.tone >= 1 && row.tone <= PROJECT_TONES
      ? { tone: row.tone }
      : {}),
    ...(row.initials !== null && row.initials.trim() !== ''
      ? { initials: row.initials }
      : {}),
    // Blank reads as unset, because a column holding "   " is a project whose
    // gate would run an empty command — the one outcome this field exists to
    // prevent.
    ...(row.check_command !== null && row.check_command.trim() !== ''
      ? { check: row.check_command.trim() }
      : {}),
    // Blank reads as unset for the same reason the check command does: a
    // column of spaces is a model nothing could render, and "nobody has said"
    // is the reading that costs nothing.
    ...(row.reliability_model !== null && row.reliability_model.trim() !== ''
      ? { reliabilityModel: row.reliability_model.trim() }
      : {}),
    // Anything that is not an explicit 0 is on. The column defaults to 1, and a
    // hand-edited row degrades towards judging rather than towards silence.
    reliabilityEnabled: row.reliability_enabled !== 0,
    grantedDirectories: readDirectories(row.granted_directories),
    createdAt: row.created_at,
  }
}

/**
 * The granted directories, or none.
 *
 * Text that will not parse, or parses to something other than a list of
 * strings, is read as none. The alternative is a project nobody can load
 * because one row was edited by hand — and "none" is the safe direction for a
 * list whose whole purpose is to widen a boundary.
 */
function readDirectories(raw: string | null): readonly string[] {
  if (raw === null || raw === '') return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((value): value is string => typeof value === 'string' && value !== '')
  } catch {
    return []
  }
}

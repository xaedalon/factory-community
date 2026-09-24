import type { WorkflowConditions } from '../schema/workflow.js'
import type { ExecutionProfile } from '../security/profile.js'
/**
 * A project: the repository a piece of work happens in.
 *
 * Everything before this ran wherever the daemon was started, which is fine for
 * one repository and wrong for two. A task points at a project, a project points
 * at a directory, and the engine runs there.
 *
 * The type lives in core with `Task` so the store, the API and the board all
 * spell it the same way. Nothing here touches the filesystem — that belongs to
 * whoever writes the row.
 */
/**
 * How many hues a project's square can be.
 *
 * The real source of truth is `--color-project-1` to `-6` in the board's
 * `tokens.css`, which neither this package nor the daemon can import — so the
 * number is written here for the sides that validate it, and the board keeps
 * its own copy for the sides that draw it. If a seventh hue is ever added it
 * has to be added in both, and the store will refuse it until it is.
 */
export const PROJECT_TONES = 6

export interface Project {
  readonly id: string
  /** Unique, and what a person types. */
  readonly name: string
  /** Absolute path to the working copy. */
  readonly path: string
  /** Branch work starts from. */
  readonly defaultBranch: string
  /**
   * Where this project's worktrees are created.
   *
   * Never inside the repository: a worktree under the main working copy shows
   * up in `git status` as untracked, and removing one risks touching tracked
   * files. A sibling directory is predictable and easy to find.
   */
  readonly worktreesRoot: string
  /** False for a directory that is not a git repository. Allowed, but said out loud. */
  readonly isRepository: boolean
  /**
   * Whether each task gets a worktree of its own.
   *
   * Off means work happens in the repository itself, and that has a consequence
   * the scheduler enforces: two agents in one working copy overwrite each
   * other, so the project runs one task at a time. A directory that is not a
   * repository cannot have worktrees at all.
   *
   * Named `usesWorktrees` rather than `worktrees` because a template already
   * says `{{ project.worktrees }}`, and that is the *path* they go in. One word
   * meaning two things in adjacent files is a trap.
   */
  readonly usesWorktrees: boolean
  /**
   * Whether each task gets an environment of its own.
   *
   * Off by default, unlike worktrees. A worktree is something Factory can
   * create for any repository; an environment is whatever *this* project needs
   * — a container, a database, seeded data — and only the project knows. So it
   * is opted into, and opting in is what asks the project for the workflows
   * that build one.
   */
  readonly usesEnvironments: boolean
  /**
   * How much authority this project's runs get.
   *
   * Absent means "not stated", which is not the same as `default`: a project
   * that has never been asked follows the installation's choice, so changing
   * that choice changes the projects that never chose. `resolveProfile` is the
   * one place the order is written.
   */
  readonly profile?: ExecutionProfile
  /**
   * The hue this project's square uses, 1 to 6, when it has chosen one.
   *
   * Absent means derived from the name, which is what every project did before
   * this existed and what a new one still does. An index into the closed set of
   * `--color-project-N` hues rather than a colour, so a project cannot sit
   * outside the palette.
   */
  readonly tone?: number
  /** The letters on the square, when chosen. Absent means derived from the name. */
  readonly initials?: string
  /**
   * The one command that says whether this project's work is sound.
   *
   * `npm test`, `make check`, `cargo test` — whatever this repository already
   * runs in CI. It reaches a phase as `{{ project.check }}`, and the built-in
   * `project-check` phase is nothing but that command, so a workflow ending in
   * a real gate is one word in its phase list.
   *
   * Absent means nobody has said, which is not the same as "there is nothing
   * to run": `project-check` then refuses to plan rather than running an empty
   * command and reporting success, which is the failure this whole field
   * exists to stop. `detectCheckCommand` fills it in where a repository says
   * plainly enough what it is.
   */
  readonly check?: string
  /**
   * Directories this project has allowed beyond its workspace, for good.
   *
   * What "allow for this project" leaves behind. Directories rather than
   * permission classes, because a class is not something Factory can honour: it
   * does not mediate the action — the agent's own CLI refuses it — so the only
   * lever is what Factory passes next time, and a directory grant is the one
   * that was measured to work.
   *
   * Absolute, and checked before they are stored: a relative one would mean
   * something different depending on which task was running.
   */
  readonly grantedDirectories: readonly string[]
  /**
   * The model that judges this project's work, when one does.
   *
   * The deterministic evaluator is free and always runs. An agent evaluator
   * costs tokens on every run that produced something, and what that is worth
   * spending differs between a weekend project and a payments service — so the
   * choice is the project's, and a powerful model is usually the right one.
   *
   * Absent means nobody has said, which is why it is not the same as
   * `reliabilityEnabled: false`: one of them starts working the moment a model
   * is named, and the other does not.
   *
   * A role (`strong`, `balanced`, `fast`) or a literal model id, because that
   * is what `RenderRequest.model` already accepts and a second vocabulary for
   * the same field would be one to keep in step.
   */
  readonly reliabilityModel?: string
  /**
   * Whether this project's work is judged at all.
   *
   * On by default: a task that says how much to trust it is the feature, and a
   * project that has to opt in is one where the answer is missing precisely
   * where nobody thought to look. Off keeps the model that was chosen, so
   * turning it back on is one click rather than two decisions.
   */
  readonly reliabilityEnabled: boolean
  readonly createdAt: string
}

/**
 * Where a project's worktrees go unless it says otherwise.
 *
 * Beside the repository, never inside it. Where they live is the user's choice
 * — each project stores its own absolute `worktreesRoot` — but a worktree
 * inside the project is a directory the project's own tooling will walk, index
 * and try to build, and a scope discovery that climbs from it finds the wrong
 * root. The default says so by example.
 *
 * Deliberately not moved under `.xaedalon/`: a worktree is a git checkout, not
 * a file a Xaedalon product wrote, and every project already stores an absolute
 * path — so changing the default would leave two conventions side by side for
 * no gain.
 */
export const defaultWorktreesRoot = (path: string, name: string, join: Join): string =>
  join(path, '..', '.factory-worktrees', name)

/** Passed in so this module needs no import from `node:path`. */
export type Join = (...parts: string[]) => string

/**
 * A directory name for a task, from what a person called it.
 *
 * Every task gets one whether or not it will ever have a worktree, because a
 * workflow that mentions `{{ task.directory }}` should not depend on how the
 * task happened to be created. Uniqueness is the caller's problem — it is the
 * one that can see the other tasks.
 */
export function taskDirectory(name: string): string {
  const slug = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, 48)
    .replaceAll(/-+$/g, '')
  return slug === '' ? 'task' : slug
}

/**
 * What turning a project setting on gives the project to edit.
 *
 * This is the one place a workflow is known by name, and it is worth being
 * clear about why that is allowed here and nowhere else. It decides which
 * *starter files* to copy when a setting is switched on — nothing more. It
 * does not decide what anything means at run time: the flags are still
 * declared by the workflows themselves, so renaming your copy of
 * `worktree-create` breaks nothing, which is precisely the property the
 * prototype lost when the engine switched on workflow names.
 */
export const PROJECT_SETTINGS = {
  worktrees: {
    /**
     * The flag a workflow earns by doing this for a task.
     *
     * Naming a *flag* here is not the thing the comment above forbids. Flags
     * are the vocabulary conditions are written in — every workflow declares
     * its own — so matching on one asks "does this workflow deal in worktrees?"
     * and gets a true answer for a renamed copy, a project's own version, or a
     * plugin's. Matching on the *name* `worktree-create` would only ever be
     * right for the file we shipped.
     */
    flag: 'hasWorktree',
    definitions: ['worktree-create', 'worktree-delete'],
    enabled: (project: ProjectFacilities) => project.usesWorktrees,
  },
  environments: {
    flag: 'hasEnvironment',
    definitions: ['environment-create', 'environment-update', 'environment-delete'],
    enabled: (project: ProjectFacilities) => project.usesEnvironments,
  },
} as const satisfies Record<string, ProjectSettingFacts>

export interface ProjectSettingFacts {
  readonly flag: string
  readonly definitions: readonly string[]
  readonly enabled: (project: ProjectFacilities) => boolean
}

/** Just the two switches, so callers need not hold a whole `Project`. */
export interface ProjectFacilities {
  readonly usesWorktrees: boolean
  readonly usesEnvironments: boolean
}

export type ProjectSetting = keyof typeof PROJECT_SETTINGS

/** Which starter files a setting copies. Derived, so the two cannot disagree. */
export const PROJECT_SETTING_DEFINITIONS = {
  worktrees: PROJECT_SETTINGS.worktrees.definitions,
  environments: PROJECT_SETTINGS.environments.definitions,
} as const satisfies Record<ProjectSetting, readonly string[]>

/** Why a flag can never be held here: the setting that earns it is switched off. */
export interface UnattainableFlag {
  readonly flag: string
  readonly setting: ProjectSetting
}

/**
 * Flags this project can never hold.
 *
 * A project that does not use worktrees has nothing that provides `hasWorktree`
 * — the workflows that would are not run for it — so a workflow gated on one
 * would sit in the queue for ever.
 */
export function unattainableFlags(project: ProjectFacilities): UnattainableFlag[] {
  return (Object.keys(PROJECT_SETTINGS) as ProjectSetting[])
    .filter((setting) => !PROJECT_SETTINGS[setting].enabled(project))
    .map((setting) => ({ flag: PROJECT_SETTINGS[setting].flag, setting }))
}

/**
 * Why this workflow cannot be offered to this project, if it cannot.
 *
 * Any mention counts — `requires`, `provides` or `clears`. A workflow that
 * *provides* `hasEnvironment` is the thing that builds one, and building one
 * where the project has said it has no environments is not a plan; a workflow
 * that *requires* it can never start. Both are noise in a list of what to run.
 */
export function unavailableFor(
  conditions: WorkflowConditions | undefined,
  project: ProjectFacilities,
): UnattainableFlag | undefined {
  const mentioned = new Set([
    ...(conditions?.requires ?? []),
    ...(conditions?.provides ?? []),
    ...(conditions?.clears ?? []),
  ])
  return unattainableFlags(project).find((entry) => mentioned.has(entry.flag))
}

/**
 * Where a task's steps run, and what it is.
 *
 * Its own worktree if it has one, else its project's working copy. A task with
 * no project has no answer here — the caller knows what to do about that, and
 * every caller so far falls back to the directory the daemon was started in,
 * which core has no business knowing.
 *
 * `exists` is a parameter the way `join` already is, so this module still needs
 * no import from `node:fs` and the rule can be exercised without a filesystem.
 *
 * ## Why this is one function
 *
 * It was written twice — once in the daemon, to decide where to run, and once
 * in `doctor.worktreeMissing`, to decide whether to complain — and the two
 * could disagree without anything failing. Now the diagnostic reports the
 * resolver's own answer, so "work for it would run in X instead" cannot name a
 * directory other than the one work would actually run in.
 */
export function workspaceFor(
  task: { readonly directory?: string | undefined },
  project: ProjectFacilities & Pick<Project, 'path' | 'worktreesRoot'>,
  exists: (path: string) => boolean,
  join: Join,
): Workspace {
  // A project that works in place skips the first step entirely. That is not
  // only the setting doing its job: a directory left over under
  // `worktreesRoot` from before the setting changed cannot silently win.
  if (!project.usesWorktrees || task.directory === undefined) {
    return { path: project.path, inWorktree: false }
  }

  // Checked by looking rather than by trusting `hasWorktree`: the flag says a
  // workflow claimed to create one, and a directory someone deleted by hand
  // would send every later step into a path that is not there.
  const worktree = join(project.worktreesRoot, task.directory)
  return exists(worktree)
    ? { path: worktree, inWorktree: true, worktree }
    : { path: project.path, inWorktree: false, worktree }
}

/**
 * A task's workspace, with the project it belongs to.
 *
 * Core answers where the work is; this adds who it belongs to, because
 * everything that draws the path also wants the project's name — and because a
 * plugin contributing a task tool is handed one of these and must not have to
 * go looking for the project itself.
 */
export interface TaskWorkspace extends Workspace {
  readonly project: Project
}

export interface Workspace {
  /** Where steps actually run. */
  readonly path: string
  /** True when `path` is the task's own worktree. Absent from `path` alone. */
  readonly inWorktree: boolean
  /**
   * The worktree this task would use, present or not.
   *
   * Carried so a diagnostic can name the directory it looked for without
   * building the path a second time. Absent when the project works in place or
   * the task has no directory — there is no worktree to be missing.
   */
  readonly worktree?: string
}

import type { Task } from '../task/state.js'
import type { TaskContext } from './resolve.js'

/**
 * What `{{ namespace.key }}` may say, as data rather than as documentation.
 *
 * The vocabulary was spread across four files that had no way to disagree
 * loudly: `TaskContext` declared the shape, `service.ts` filled it, `resolve.ts`
 * assembled the scope, and the README described it. Nothing checked that they
 * matched, and a person writing a phase had nowhere at all to look — the only
 * way to find out `{{ task.directory }}` existed was to read the daemon.
 *
 * So the list lives here, once, and the types make drift a compile error rather
 * than a support question. Adding a field to `TaskContext` without documenting
 * it stops the build; so does documenting one that does not exist.
 *
 * This is the same failure this codebase has now paid for three times — one
 * idea with two implementations, where the wrong one is the one nobody opens.
 */

export interface TokenEntry {
  /** The key within its namespace. `{{ task.name }}` is namespace + key. */
  readonly key: string
  readonly summary: string
}

export interface TokenNamespace {
  readonly namespace: string
  readonly summary: string
  /**
   * Where the keys come from.
   *
   * `factory` means the list is fixed and known here. `definition` means the
   * keys are whatever the workflow or phase declared in its own `variables:`,
   * so the dictionary can only show what is in front of it — an empty one is
   * accurate, not broken.
   */
  readonly source: 'factory' | 'definition'
  readonly tokens: readonly TokenEntry[]
}

/**
 * `{{ task.* }}` — what Factory knows about the work.
 *
 * `satisfies Record<keyof TaskContext, string>` is the guard, in both
 * directions: every key of `TaskContext` must appear, and a key that is not on
 * `TaskContext` is an excess property. Neither half can move alone.
 */
export const TASK_TOKENS = {
  uuid: "The task's id. Stable for its whole life, unlike the name.",
  name: 'What the task is called, as shown on the board.',
  description: 'What the task is for, in the words of whoever asked for it.',
  ticketId: 'The id from wherever the work was asked for. Empty if none.',
  branch: 'The branch this work belongs on. Empty if none.',
  directory: "The task's directory name — also its worktree's, when it has one.",
  artifacts: 'Absolute directory this task’s artifacts go in.',
} as const satisfies Record<keyof TaskContext, string>

/**
 * `{{ project.* }}` — facts about the surroundings.
 *
 * `projectVariables` in the daemon is typed by this, so the two cannot drift.
 */
export const PROJECT_TOKENS = {
  name: 'The project as Factory knows it.',
  path: "Absolute path of the project's repository.",
  branch: 'The branch work starts from.',
  worktrees: 'Directory the project’s worktrees are created under.',
  check: 'The command that says whether this project’s work is sound. Empty if none is set.',
} as const

/**
 * `{{ project.* }}` again, but only during a recovery workflow.
 *
 * In the project namespace because that scope is for facts about the
 * surroundings rather than about the definition, and a failure is one.
 */
export const FAILURE_TOKENS = {
  failedWorkflow: 'Which workflow failed. Only set in an on_fail workflow.',
  failedPhase: 'Which phase it failed in, if it got that far.',
  failureReason: 'Why it failed, as reported.',
} as const

/**
 * A task, as the values its tokens resolve to.
 *
 * **Total by construction**: every key the dictionary documents is present,
 * empty when the task has no value for it. That is what makes the dictionary a
 * promise rather than a hint — a person who reads "ticketId: empty if none"
 * and writes `{{ task.ticketId }}` gets an empty string, not a warning telling
 * them the key does not exist.
 *
 * The return type is the guard. The daemon used to assemble this object inline,
 * where leaving a key out compiled perfectly well because every field of
 * `TaskContext` is optional — a third place for the vocabulary to drift, and
 * the one furthest from anyone checking.
 */
export const taskTokenValues = (
  task: Pick<Task, 'id' | 'name' | 'description' | 'ticketId' | 'branch' | 'directory'>,
  artifacts: string,
): Record<keyof typeof TASK_TOKENS, string> => ({
  uuid: task.id,
  name: task.name,
  description: task.description,
  ticketId: task.ticketId ?? '',
  branch: task.branch ?? '',
  directory: task.directory ?? '',
  artifacts,
})

/**
 * Every documented task token, empty.
 *
 * The floor a caller's values sit on, so the dictionary's promise holds however
 * the plan was reached. `taskTokenValues` does this for the daemon, which has a
 * whole task to read; a foreground `factory run` has a name and maybe a branch
 * and nothing else, and used to be told that `{{ task.ticketId }}` did not
 * exist — a key the dictionary documents.
 */
export const blankTaskTokens = (): Record<keyof typeof TASK_TOKENS, string> =>
  Object.fromEntries(Object.keys(TASK_TOKENS).map((key) => [key, ''])) as Record<
    keyof typeof TASK_TOKENS,
    string
  >

/**
 * Every documented project token, empty. Including the recovery ones.
 *
 * The same floor `blankTaskTokens` provides, for the namespace that did not
 * have one — and the asymmetry cost something concrete. `factory run` has no
 * project, so `{{ project.check }}` did not resolve and was left in the command
 * *literally*: `bash -c '{{ project.check }}'`, which is neither the gate nor a
 * useful failure. Empty is the honest value, and an empty command is refused a
 * line further on.
 *
 * A misspelled key still warns, which is what the warning is for. A documented
 * one with no value here is not a mistake.
 */
export const blankProjectTokens = (): Record<
  keyof typeof PROJECT_TOKENS | keyof typeof FAILURE_TOKENS,
  string
> =>
  Object.fromEntries(
    [...Object.keys(PROJECT_TOKENS), ...Object.keys(FAILURE_TOKENS)].map((key) => [key, '']),
  ) as Record<keyof typeof PROJECT_TOKENS | keyof typeof FAILURE_TOKENS, string>

const entries = (table: Readonly<Record<string, string>>): TokenEntry[] =>
  Object.entries(table).map(([key, summary]) => ({ key, summary }))

/** Keys a definition declared itself, in the order it declared them. */
export interface DeclaredVariables {
  readonly workflow?: Readonly<Record<string, string>>
  readonly phase?: Readonly<Record<string, string>>
}

/**
 * Every namespace a step in this phase may use.
 *
 * Takes the definition's own `variables:` because half the vocabulary is not
 * Factory's to know — a phase that declares `region: eu-west-1` has a
 * `{{ phase.region }}`, and no fixed list could ever contain it.
 */
export function tokenDictionary(declared: DeclaredVariables = {}): readonly TokenNamespace[] {
  const workflow = declared.workflow ?? {}
  const phase = declared.phase ?? {}
  return [
    {
      namespace: 'task',
      summary: 'The work being done.',
      source: 'factory',
      tokens: entries(TASK_TOKENS),
    },
    {
      namespace: 'project',
      summary: 'The repository it happens in.',
      source: 'factory',
      tokens: [...entries(PROJECT_TOKENS), ...entries(FAILURE_TOKENS)],
    },
    {
      namespace: 'workflow',
      summary: 'Values the workflow declared in its own variables.',
      source: 'definition',
      tokens: Object.keys(workflow).map((key) => ({
        key,
        summary: `Declared by the workflow as "${workflow[key] ?? ''}".`,
      })),
    },
    {
      namespace: 'phase',
      summary: 'Values this phase declared in its own variables.',
      source: 'definition',
      tokens: Object.keys(phase).map((key) => ({
        key,
        summary: `Declared by this phase as "${phase[key] ?? ''}".`,
      })),
    },
    {
      // The merged view, which is what most phases actually want to write.
      namespace: 'variables',
      summary: 'project, then workflow, then phase — later wins.',
      source: 'definition',
      tokens: [...new Set([...Object.keys(PROJECT_TOKENS), ...Object.keys(workflow), ...Object.keys(phase)])].map(
        (key) => ({ key, summary: `Whichever of project/workflow/phase set "${key}" last.` }),
      ),
    },
  ]
}

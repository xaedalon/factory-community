import { z } from 'zod'
import { closedWithExtensions } from '../schema/common.js'
import { defineStepKind, type PlannedStep, type Step, type StepKindCapability } from '../schema/step.js'

/**
 * `uses: worktree` — isolation, as a step a workflow asks for.
 *
 * Parallel agents in one working copy is the failure mode Factory exists to
 * avoid: two of them editing the same files, one `git checkout` away from
 * destroying the other's work. A worktree per task is the cheap, boring answer,
 * and git has had it built in for a decade.
 *
 * A step kind rather than a hidden phase of the engine, for two reasons. It is
 * the orchestration premise — Factory runs your tools; it does not become a
 * version control system — and it keeps the decision in the workflow, where a
 * project that does not want worktrees simply does not ask for one.
 *
 * What it adds over writing the git command by hand is correctness in the three
 * cases people get wrong: the directory already exists, the branch already
 * exists, and the worktree has to be removed while something still holds it.
 * The prototype's example workflow shipped an `if [ -d … ]` one-liner that
 * handled only the first.
 */

export const WORKTREE_ACTIONS = ['create', 'remove'] as const
export type WorktreeAction = (typeof WORKTREE_ACTIONS)[number]

export interface WorktreeStep extends Step {
  readonly uses: 'worktree'
  readonly action: WorktreeAction
  /** Where the worktree lives. Usually `{{ project.worktrees }}/{{ task.directory }}`. */
  readonly path: string
  /** Branch to check out. Created if it does not exist. Required for `create`. */
  readonly branch?: string
  /** Commit or branch the new branch starts from. Defaults to the current HEAD. */
  readonly from?: string
}

const worktreeSchema = closedWithExtensions({
  action: z.enum(WORKTREE_ACTIONS),
  path: z.string().min(1, 'path must say where the worktree goes'),
  branch: z.string().min(1).optional(),
  from: z.string().min(1).optional(),
})

export const worktreeStepKind: StepKindCapability = defineStepKind({
  id: 'worktree',
  displayName: 'Git worktree',
  summary: 'Creates or removes a git worktree, so a task has somewhere of its own to work.',
  schema: worktreeSchema,
  plan(step) {
    const worktree = step as WorktreeStep
    return worktree.action === 'create' ? create(worktree) : remove(worktree)
  },
})

function create(step: WorktreeStep): PlannedStep {
  if (step.branch === undefined) {
    // Refusing beats guessing: a worktree on a detached HEAD is not what anyone
    // meant, and the failure would arrive as a confusing git error much later.
    return {
      describe: `create a worktree at ${step.path}`,
      command: 'bash',
      args: ['-c', 'echo "worktree create needs a branch" >&2; exit 1'],
    }
  }

  // Idempotent on purpose. A workflow is re-run after a failure far more often
  // than it is run for the first time, and a step that fails because it already
  // did its job is a step nobody can retry.
  const script = [
    'set -e',
    `dir=${quote(step.path)}`,
    `branch=${quote(step.branch)}`,
    step.from === undefined ? 'from=""' : `from=${quote(step.from)}`,
    'if [ -d "$dir" ]; then',
    '  echo "worktree already at $dir"',
    'elif git show-ref --verify --quiet "refs/heads/$branch"; then',
    '  git worktree add "$dir" "$branch"',
    'else',
    '  if [ -n "$from" ]; then git worktree add -b "$branch" "$dir" "$from";',
    '  else git worktree add -b "$branch" "$dir"; fi',
    'fi',
  ].join('\n')

  return {
    describe: `worktree ${step.path} on ${step.branch}`,
    command: 'bash',
    args: ['-c', script],
  }
}

function remove(step: WorktreeStep): PlannedStep {
  // This step almost always runs *inside* the worktree it is removing: the
  // workspace is resolved when the plan is made, while the worktree is still
  // there, and every step of the phase is spawned in it. Removing the
  // directory a process is sitting in leaves git with no current directory to
  // read — `fatal: Unable to read current working directory` — so the prune
  // never ran and the workflow never completed, which meant `clears:
  // [hasWorktree]` never took effect and the task kept a flag for a worktree
  // that was gone.
  //
  // The step kind is given only a path, so the repository is found from the
  // worktree while it still exists. `--git-common-dir` is the main
  // repository's `.git` however deeply linked the worktree is, and
  // `--path-format=absolute` (git 2.31) makes it an answer that survives the
  // `cd`.
  const script = [
    'set -e',
    `dir=${quote(step.path)}`,
    'if [ ! -d "$dir" ]; then',
    '  echo "no worktree at $dir"',
    '  git worktree prune',
    '  exit 0',
    'fi',
    'main=$(dirname "$(git -C "$dir" rev-parse --path-format=absolute --git-common-dir)")',
    'cd "$main"',
    // --force because an agent leaves changes behind, and a remove that refuses
    // over an untracked file leaves the task unable to finish. The workflow
    // asked for this; anything worth keeping should have been committed.
    'git worktree remove --force "$dir"',
    'git worktree prune',
  ].join('\n')

  return { describe: `remove the worktree at ${step.path}`, command: 'bash', args: ['-c', script] }
}

const SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/
const quote = (value: string): string =>
  SAFE.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`

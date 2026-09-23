import { execFileSync } from 'node:child_process'

/**
 * Asking git a read-only question.
 *
 * Nothing below an entry point spawns a process for itself, and nothing here
 * reads `process.env` — so this is a factory that takes an environment and
 * returns the asker, the way `systemDetachedLauncher` does for terminals. A
 * rule that spawned on its own could not be pinned down by a scenario, and an
 * embedder that must not spawn can leave it out and get silence.
 *
 * Only git can answer what git ignores. The alternative was reading
 * `.gitignore` files and matching them here, which would be a second
 * implementation of a specification we do not own — the shape this codebase
 * keeps paying for.
 */

/** What git said, or nothing when it could not be asked. */
export interface GitAnswer {
  /** 0 when the answer is yes, 1 when it is no. Never a fatal. */
  readonly code: number
  readonly stdout: string
}

export type GitQuery = (
  cwd: string,
  args: readonly string[],
  stdin?: string,
) => GitAnswer | undefined

/** Long enough for a repository of any size, short enough to never hold a page. */
export const GIT_DEADLINE_MS = 2_000

/**
 * The real one.
 *
 * Every way of not getting an answer is classified here, once, so a caller
 * never reads an exit code: git missing, git timing out, and git's own fatal
 * status 128 — which covers "not a git repository", a bad pathspec and a
 * corrupt index — all come back as `undefined`. Only a deliberate 0 or 1 is
 * an answer.
 *
 * `GIT_OPTIONAL_LOCKS=0` promises git this is a look rather than a touch, so
 * it neither refreshes the index nor takes a lock while somebody's own git is
 * working in the same tree. `GIT_DIR`, `GIT_WORK_TREE` and `GIT_INDEX_FILE`
 * are dropped because a daemon started from a git hook inherits them pointing
 * at a different repository — the question would be answered about somebody
 * else's. The user's own config is deliberately left alone: a `core.excludesFile`
 * is a legitimate reason for a file to be ignored, and the answer has to
 * include it.
 */
export const systemGitQuery =
  (env: Readonly<Record<string, string | undefined>>): GitQuery =>
  (cwd, args, stdin) => {
    const { GIT_DIR: _dir, GIT_WORK_TREE: _tree, GIT_INDEX_FILE: _index, ...rest } = env
    try {
      return {
        code: 0,
        stdout: execFileSync('git', [...args], {
          cwd,
          encoding: 'utf8',
          timeout: GIT_DEADLINE_MS,
          env: { ...rest, GIT_OPTIONAL_LOCKS: '0' },
          // Git's own stderr is swallowed: "not a git repository" is an answer
          // here, not a fault, and a diagnostic that printed one into the
          // daemon's log on every run would be noise nobody can act on.
          stdio: ['pipe', 'pipe', 'ignore'],
          ...(stdin === undefined ? {} : { input: stdin }),
        }),
      }
    } catch (error) {
      const failure = error as { status?: number | null; stdout?: string }
      // One classification, because every way of not getting an answer has to
      // look the same to the caller. A spawn failure has no status — that is
      // git missing from PATH. Nor does a process killed at the deadline. And
      // 128 is git's own fatal, which covers "not a git repository", a bad
      // pathspec and a corrupt index.
      //
      // Which leaves 1: git saying no, deliberately, which is an answer.
      if (failure.status !== 1) return undefined
      return { code: 1, stdout: failure.stdout ?? '' }
    }
  }

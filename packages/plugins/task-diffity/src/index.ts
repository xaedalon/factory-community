import {
  TASK_TOOL_KIND,
  commandAvailability,
  type FactoryPlugin,
  type TaskToolCapability,
} from '@factory/plugin-sdk'

/**
 * A task's changes, in Diffity.
 *
 * Diffity is a GitHub-style diff viewer that starts a small server and opens
 * the browser itself — so this asks for a `detached` run and needs nothing
 * installed to perform it. That is the whole reason it works in Community
 * where the two terminal tools degrade to a command you copy.
 *
 * It diffs **the branch against its base**, because a Factory task's agent
 * commits as it goes: `diffity <defaultBranch>` is "everything this task did",
 * where bare `diffity` would show the uncommitted remainder and usually
 * nothing at all. `--new` because pressing the button on a second task must
 * not hand you the first task's diff.
 *
 * Verified against diffity 0.9.5. The flag order is not cosmetic — see the
 * comment on the argv below.
 */
export const DIFFITY_COMMAND = 'diffity'
export const DIFFITY_INSTALL = 'npm install -g diffity'

export const diffityTool: TaskToolCapability = {
  id: 'diffity',
  displayName: 'Diffity',
  summary: "Review this task's changes in a diff viewer.",
  order: 30,
  // Diffity starts a server and opens the browser itself, so nothing needs to
  // be installed to perform it — which is why this tool works in Community.
  run: 'detached',
  offer: (context) => {
    const workspace = context.workspace
    if (workspace === undefined) {
      return {
        unavailable: 'Factory cannot find the project this task belongs to, so there is nothing to diff.',
      }
    }
    // `isRepository` already answers this. Probing the filesystem for a `.git`
    // would be a second implementation of a question the project row settled
    // when it was added.
    if (!workspace.project.isRepository) {
      return {
        unavailable: `"${workspace.project.name}" is not a git repository, and Diffity needs one.`,
      }
    }

    const found = commandAvailability(DIFFITY_COMMAND, context.env, {
      ...(context.extraDirectories === undefined
        ? {}
        : { extraDirectories: context.extraDirectories }),
      label: 'Diffity',
      hint: `Install it with \`${DIFFITY_INSTALL}\`.`,
    })
    if (!found.available) return { unavailable: found.reason ?? `${DIFFITY_COMMAND} is not installed.` }

    return {
      // The resolved path, not the bare name: a detached child inherits this
      // PATH, and a name found only in a version manager's directory would
      // fail with "command not found" on something just reported as available.
      command: {
        command: found.path ?? DIFFITY_COMMAND,
        // Flags **before** the ref. `diffity [options] [refs...]` is the usage,
        // and `diffity main --new` is rejected with "'--new' is not a valid git
        // reference" — the flag is parsed as a second ref. Found by running it,
        // which is the only way this class of thing is ever found.
        args: ['--new', workspace.project.defaultBranch],
      },
    }
  },
}

const plugin: FactoryPlugin = {
  name: '@factory/task-diffity',
  version: '0.1.0',
  register(context) {
    context.provide(TASK_TOOL_KIND, diffityTool)
  },
}

export default plugin

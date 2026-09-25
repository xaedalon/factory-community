import {
  PROVIDER_KIND,
  TASK_TOOL_KIND,
  resumeById,
  type FactoryPlugin,
  type ProviderCapability,
  type TaskToolCapability,
} from '@factory/plugin-sdk'

/**
 * Why a task has no session to open yet.
 *
 * **The one copy of this sentence.** It was written twice — once as a tooltip
 * in the board and once in the daemon's own words for the refusal — and one
 * idea with two implementations means the wrong one is the one nobody opens.
 * Now the tool says it and both the tooltip and the refusal repeat it.
 */
export const NO_SESSION_YET =
  'No agent session yet. One is recorded the first time an agent runs for this task.'

/**
 * The conversation the agent was having.
 *
 * Factory chooses the session id so this can be exact: `claude -c` resumes
 * "the most recent conversation in this directory", which is the wrong one as
 * soon as two tasks share a directory — and which interactive Claude refuses
 * outright for a session `claude -p` created. So the command is
 * `--resume <id>`, and both halves come from data: the id the engine recorded
 * and the flag the provider's own descriptor declares.
 */
export const openSessionTool: TaskToolCapability = {
  id: 'open-session',
  displayName: 'Open session',
  summary: "Carry on the conversation this task's agent was having.",
  order: 20,
  offer: (context) => {
    if (context.workspace === undefined) {
      return {
        unavailable: 'Factory cannot find the project this task belongs to, so there is nowhere to open.',
      }
    }
    const session = context.task.session
    if (session === undefined) return { unavailable: NO_SESSION_YET }

    const provider = context.host.get<ProviderCapability>(PROVIDER_KIND, session.provider)
    if (provider === undefined) {
      // The descriptor can be removed between the run and the asking. The
      // directory is still worth offering; a command naming a CLI that is not
      // here is not.
      return {
        unavailable:
          `This task's session belongs to "${session.provider}", which is no longer installed.`,
      }
    }
    const resume = resumeById(provider.descriptor, session.id)
    return resume === undefined
      ? { unavailable: `"${session.provider}" has no way to resume a session by id.` }
      : { command: resume }
  },
}

const plugin: FactoryPlugin = {
  name: '@factory/task-session',
  version: '0.1.0',
  register(context) {
    context.provide(TASK_TOOL_KIND, openSessionTool)
  },
}

export default plugin

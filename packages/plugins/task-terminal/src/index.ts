import {
  TASK_TOOL_KIND,
  type FactoryPlugin,
  type TaskToolCapability,
} from '@factory/plugin-sdk'

/**
 * A terminal where a task's work is.
 *
 * The simplest possible task tool, and the one that shows the shape: it
 * answers with a directory and no command, and something else decides how to
 * open one. Under the desktop shell that is Pro's terminal capability; with
 * nothing installed the board offers the same line to copy.
 *
 * It was two hard-coded buttons and a route that knew their commands by name.
 * Being a plugin is not decoration — it is what made room for the third.
 */
export const openTerminalTool: TaskToolCapability = {
  id: 'open-terminal',
  displayName: 'Open terminal',
  summary: "A shell where this task's steps run.",
  // First, because "where is this happening" is the question you ask of a task
  // that has never run and of one that finished an hour ago.
  order: 10,
  // A task always belongs to a project, so an unresolved workspace means the
  // project row is not there — a database edited by hand. Said plainly rather
  // than hidden, because the button would otherwise open the wrong directory.
  offer: (context) =>
    context.workspace === undefined
      ? {
          unavailable:
            'Factory cannot find the project this task belongs to, so there is nowhere to open.',
        }
      : {},
}

const plugin: FactoryPlugin = {
  name: '@factory/task-terminal',
  version: '0.1.0',
  register(context) {
    context.provide(TASK_TOOL_KIND, openTerminalTool)
  },
}

export default plugin

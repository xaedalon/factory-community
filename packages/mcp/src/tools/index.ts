import type { McpTool } from '../tool.js'
import { projectTools } from './projects.js'
import { taskReadTools } from './tasks.js'
import { definitionTools } from './definitions.js'
import { runTools } from './runs.js'

/**
 * The whole surface, in the order an agent meets it.
 *
 * Order matters more than it looks: a client lists tools once and shows them to
 * a model in the order given, and the first question anybody has is "which
 * project am I in".
 */
export const factoryTools: readonly McpTool[] = [
  ...projectTools,
  ...definitionTools,
  ...taskReadTools,
  ...runTools,
]

export { projectTools, taskReadTools, definitionTools, runTools }
export { briefProject } from './projects.js'
export { briefTask, briefRun } from './tasks.js'

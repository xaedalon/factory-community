import type { Initiator } from '@factory/core'

/**
 * Where this request is coming from, from what Factory stamped.
 *
 * The honest half of "do not trust what a client says about itself". When
 * Factory launches an agent it puts these four names into that process's
 * environment, so an MCP server started *by that agent* inherits them and can
 * report its own position in the orchestration tree without being asked to be
 * truthful about it.
 *
 * A client outside Factory has none of them, and looks like a person. That is
 * the direction that loses authority rather than gains it, which is what makes
 * omission safe.
 *
 * The label is the one self-reported part and is used for a line in a task's
 * history, never by a rule.
 */
export const FACTORY_RUN = 'FACTORY_RUN_ID'
export const FACTORY_TASK = 'FACTORY_TASK_ID'

export function initiatorFrom(
  env: Readonly<Record<string, string | undefined>>,
  client?: { readonly name: string; readonly version?: string } | undefined,
): Initiator | undefined {
  const runId = value(env[FACTORY_RUN])
  const taskId = value(env[FACTORY_TASK])
  const label =
    client === undefined
      ? undefined
      : `mcp:${client.name}${client.version === undefined ? '' : `/${client.version}`}`

  if (runId === undefined && taskId === undefined && label === undefined) return undefined
  return {
    ...(label === undefined ? {} : { label }),
    ...(runId === undefined ? {} : { runId }),
    ...(taskId === undefined ? {} : { taskId }),
  }
}

const value = (text: string | undefined): string | undefined =>
  text === undefined || text.trim() === '' ? undefined : text.trim()

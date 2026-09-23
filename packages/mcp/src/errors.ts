import { asApiFailure } from './api.js'

/**
 * Why a tool could not do what was asked.
 *
 * A closed list, because the reader is a program deciding what to do next and
 * "500" is not a decision. The sentence beside the code is the one the daemon
 * wrote wherever there is one: two wordings for one refusal is how a client
 * ends up explaining something the server does not actually do.
 */
export const TOOL_ERROR_CODES = [
  'PROJECT_NOT_FOUND',
  'PROJECT_AMBIGUOUS',
  'TASK_NOT_FOUND',
  'WORKFLOW_NOT_FOUND',
  'RUN_NOT_FOUND',
  'VALIDATION_ERROR',
  'NOT_ACCEPTED',
  'ACTION_NOT_AVAILABLE',
  'RECURSION_LIMIT',
  'SELF_ORCHESTRATION_BLOCKED',
  'APPROVAL_SEPARATION',
  'DAEMON_UNAVAILABLE',
  'FACTORY_ERROR',
] as const

export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number]

export class ToolError extends Error {
  override readonly name = 'ToolError'
  constructor(
    readonly code: ToolErrorCode,
    message: string,
    /** Whatever the caller needs to act: candidate names, the disclaimer, the actions on offer. */
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message)
  }
}

/**
 * A failed request, as something an agent can act on.
 *
 * The daemon-unreachable case is worded for an agent rather than borrowed from
 * the CLI, and that is not duplication: the CLI is talking to somebody with a
 * terminal open who can type the command, and this is talking to a program that
 * has to ask a person to. Same fact, different reader, different sentence.
 */
export function asToolError(error: unknown, fallback: ToolErrorCode = 'FACTORY_ERROR'): ToolError {
  if (error instanceof ToolError) return error

  const failed = asApiFailure(error)
  if (failed === undefined) {
    return new ToolError(fallback, error instanceof Error ? error.message : String(error))
  }

  const said = failed.message ?? 'The Factory daemon refused that.'
  const body = (failed.body ?? {}) as Record<string, unknown>

  if (failed.status === 0) {
    return new ToolError(
      'DAEMON_UNAVAILABLE',
      `${said} Factory's daemon is not running, so nothing can be read or started. ` +
        'Ask the person you are working with to start it with `factory-daemon`.',
    )
  }
  // The disclaimer travels with the refusal because the agent cannot accept it:
  // somebody has to read what an agent run can reach and agree to it, and the
  // text is what they are agreeing to.
  if (typeof body.disclaimer === 'string') {
    return new ToolError('NOT_ACCEPTED', said, {
      disclaimer: body.disclaimer,
      accept: 'A person has to run `factory accept` once, after reading it.',
    })
  }
  if (Array.isArray(body.projects)) {
    return new ToolError('PROJECT_AMBIGUOUS', said, { projects: body.projects })
  }
  if (Array.isArray(body.actions)) {
    return new ToolError('ACTION_NOT_AVAILABLE', said, {
      state: body.state,
      actions: body.actions,
    })
  }
  if (typeof body.code === 'string' && (TOOL_ERROR_CODES as readonly string[]).includes(body.code)) {
    return new ToolError(body.code as ToolErrorCode, said, body)
  }
  if (failed.status === 400) return new ToolError('VALIDATION_ERROR', said)
  return new ToolError(fallback, said)
}

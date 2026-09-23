/**
 * JSON-RPC 2.0, newline-delimited, over a stream somebody else owns.
 *
 * Hand-written rather than taken from the official SDK, and the reason is the
 * one this project applies to every dependency: `@modelcontextprotocol/sdk`
 * brings express, hono, jose, ajv, cors and a dozen more into every install of
 * a local-first tool, to speak a line-based protocol over a pipe. This
 * repository writes a forty-line web route rather than take a static-file
 * dependency, and the same judgement applies here.
 *
 * The cost is named rather than hidden: **we own protocol conformance.** The
 * negotiated version is asserted in a scenario, so a spec revision is a
 * deliberate, visible change rather than something that quietly stops working.
 */

export const JSONRPC_VERSION = '2.0'

/** The codes JSON-RPC reserves. A tool that fails at its job uses none of them. */
export const PARSE_ERROR = -32700
export const INVALID_REQUEST = -32600
export const METHOD_NOT_FOUND = -32601
export const INVALID_PARAMS = -32602
export const INTERNAL_ERROR = -32603

export type JsonRpcId = string | number

export interface JsonRpcMessage {
  readonly jsonrpc: string
  readonly id?: JsonRpcId | null
  readonly method?: string
  readonly params?: unknown
}

export interface JsonRpcFailureBody {
  readonly code: number
  readonly message: string
  readonly data?: unknown
}

/**
 * What a frame turned out to be.
 *
 * A notification has no id and is answered with nothing at all — which is not
 * an optimisation, it is the protocol: a reply to a notification is a frame the
 * client has no way to match and will report as a fault.
 */
export type Incoming =
  | { readonly kind: 'request'; readonly id: JsonRpcId; readonly method: string; readonly params: unknown }
  | { readonly kind: 'notification'; readonly method: string; readonly params: unknown }
  | { readonly kind: 'malformed'; readonly id: JsonRpcId | null; readonly error: JsonRpcFailureBody }

/**
 * Read one line.
 *
 * Everything that is not a well-formed request or notification comes back as
 * `malformed` carrying the frame the client should be sent, rather than being
 * thrown: a server that dies on a bad line takes the session with it, and the
 * client is left waiting on a pipe that will never speak again.
 */
export function parseFrame(line: string): Incoming {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return { kind: 'malformed', id: null, error: { code: PARSE_ERROR, message: 'Not JSON.' } }
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      kind: 'malformed',
      id: null,
      error: { code: INVALID_REQUEST, message: 'A JSON-RPC message is an object.' },
    }
  }

  const message = value as JsonRpcMessage
  // The id is read before the version is checked, so a client that sends a
  // slightly wrong frame still gets an answer it can match to what it sent.
  const id =
    typeof message.id === 'string' || typeof message.id === 'number' ? message.id : null

  if (message.jsonrpc !== JSONRPC_VERSION) {
    return {
      kind: 'malformed',
      id,
      error: { code: INVALID_REQUEST, message: `Expected jsonrpc "${JSONRPC_VERSION}".` },
    }
  }
  if (typeof message.method !== 'string' || message.method === '') {
    return {
      kind: 'malformed',
      id,
      error: { code: INVALID_REQUEST, message: 'A JSON-RPC message needs a method.' },
    }
  }

  if (id === null) return { kind: 'notification', method: message.method, params: message.params }
  return { kind: 'request', id, method: message.method, params: message.params }
}

export const success = (id: JsonRpcId, result: unknown): string =>
  JSON.stringify({ jsonrpc: JSONRPC_VERSION, id, result })

export const failure = (id: JsonRpcId | null, error: JsonRpcFailureBody): string =>
  JSON.stringify({ jsonrpc: JSONRPC_VERSION, id, error })

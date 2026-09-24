/**
 * What this package needs from a running Factory, and nothing more.
 *
 * The shape is the CLI's `DaemonClient`, repeated deliberately. The client
 * lives in `apps/cli` because that is where it was first needed, and a package
 * may not import from an app — so rather than move a working thing to satisfy a
 * diagram, the shape is named here and the CLI's client satisfies it
 * structurally. A drift between the two is a compile error at the single place
 * that passes one to the other, which is `factory mcp`.
 *
 * Note what is *not* here: no database, no engine, no scheduler. An MCP server
 * that opened the store would be a second process reconciling and migrating one
 * database, and `createService` finishes every running run as failed on the way
 * in. Everything stateful goes over the same HTTP API the board uses.
 */
export interface FactoryApi {
  request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T>
  /** Where the daemon is, for a message that has to say. */
  readonly url: string
}

/**
 * What a failed request looks like without importing the class that threw it.
 *
 * `status` is 0 when nothing answered at all — the CLI's client says so, and it
 * is the likeliest failure by a wide margin.
 */
export interface ApiFailure {
  readonly status?: number
  readonly message?: string
  readonly body?: unknown
}

export const asApiFailure = (error: unknown): ApiFailure | undefined =>
  typeof error === 'object' && error !== null && typeof (error as ApiFailure).status === 'number'
    ? (error as ApiFailure)
    : undefined

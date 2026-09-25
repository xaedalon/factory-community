import { failed, type CommandResult } from './context.js'

/**
 * Talking to the daemon.
 *
 * Tasks are not files, and the CLI does not open the database: the daemon owns
 * it, and the scheduler that decides what runs lives there too. A task queued
 * by writing a row directly would sit there until the daemon happened to look.
 * So the CLI is a client of the same API the board uses — and everything it can
 * do, the board can do, because there is one contract rather than two.
 */

export interface DaemonClient {
  request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T>
  readonly url: string
}

export class DaemonError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown = undefined,
  ) {
    super(message)
    this.name = 'DaemonError'
  }
}

/** Where the daemon is. Same defaults as the daemon's own. */
export function daemonUrl(env: Readonly<Record<string, string | undefined>>): string {
  return env.FACTORY_URL ?? `http://127.0.0.1:${env.FACTORY_PORT ?? 7317}`
}

export function createDaemonClient(env: Readonly<Record<string, string | undefined>>): DaemonClient {
  const url = daemonUrl(env)
  return {
    url,
    async request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
      let response: Response
      try {
        response = await fetch(`${url}${path}`, {
          method: init.method ?? 'GET',
          // Only declare a body when there is one: a bodyless request carrying
          // `content-type: application/json` is rejected as an empty document.
          ...(init.body === undefined
            ? {}
            : {
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(init.body),
              }),
        })
      } catch {
        throw new DaemonError(0, `Cannot reach the Factory daemon at ${url}.`)
      }

      const text = await response.text()
      let body: unknown
      let parsed = true
      try {
        body = text === '' ? undefined : JSON.parse(text)
      } catch {
        body = undefined
        parsed = false
      }
      if (!response.ok) {
        const payload = (body ?? {}) as { error?: string }
        throw new DaemonError(
          response.status,
          payload.error ?? `The daemon answered ${response.status}.`,
          body,
        )
      }
      // A success that is not JSON is not a success. Returning `undefined` here
      // made every caller fail on a property of it, somewhere else entirely,
      // with a message naming neither the request nor the cause — which is what
      // a daemon older than this CLI produces when its catch-all answers a
      // route it does not know with the board's own HTML and a 200.
      if (!parsed) {
        throw new DaemonError(
          response.status,
          `The daemon's answer to ${path} was not JSON. It may be an older version ` +
            `than this CLI, or something else is answering on ${url}.`,
        )
      }
      return body as T
    },
  }
}

/**
 * Turn a failure into the same shape every command returns.
 *
 * A daemon that is not running is the likeliest failure by a wide margin, and
 * it is the one a bare error message explains worst.
 */
export function asFailure(error: unknown): CommandResult {
  if (error instanceof DaemonError && error.status === 0) {
    return failed([error.message, 'Start it with "factory-daemon", then try again.'])
  }
  return failed([error instanceof Error ? error.message : String(error)])
}

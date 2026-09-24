import type { FactoryApi } from '../src/api.js'
import type { McpStreams } from '../src/serve.js'

/**
 * A Factory that answers from a table instead of over a socket.
 *
 * These scenarios are about the protocol and the shape of what comes back, and
 * a real daemon would make them about a daemon. The daemon's own surface is
 * specified in `apps/daemon/features`; what is checked here is that this server
 * asks for the right thing and says something useful about the answer.
 */
export class FakeFactory implements FactoryApi {
  readonly url = 'http://127.0.0.1:7317'
  readonly asked: string[] = []
  /** What was sent with each request, so a scenario can check the ask. */
  readonly bodies = new Map<string, unknown>()
  readonly replies = new Map<string, unknown>()
  /** When set, every request fails this way — how "no daemon" is spelled. */
  failure: { status: number; message: string; body?: unknown } | undefined

  answer(path: string, value: unknown): this {
    this.replies.set(path, value)
    return this
  }

  async request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const key = `${init.method ?? 'GET'} ${path}`
    this.asked.push(key)
    if (init.body !== undefined) this.bodies.set(key, init.body)
    if (this.failure !== undefined) throw this.failure
    const reply = this.replies.get(path)
    if (reply === undefined) {
      throw { status: 404, message: `Nothing answers ${path}.`, body: {} }
    }
    // A stubbed *failure* is `{ status, message }`, which is the shape the api
    // client throws. `status` alone is not enough to mean one: `WriteOutcome`
    // carries a `status` of its own — `created`, `updated`, `exists` — so a
    // stub answering the way the write route really answers was being thrown
    // instead of returned, and the only way to make a write scenario pass was
    // to stub a shape the daemon never sends. Which is how a reply reading the
    // wrong field went unnoticed.
    if (
      typeof reply === 'object' &&
      reply !== null &&
      'status' in reply &&
      'message' in reply
    ) {
      throw reply
    }
    return reply as T
  }
}

/** A pipe made of strings, so a scenario can read what was written where. */
export class FakePipe implements McpStreams {
  readonly written: string[] = []
  readonly errors: string[] = []
  #chunks: string[] = []

  constructor(chunks: readonly string[] = []) {
    this.#chunks = [...chunks]
  }

  send(...chunks: string[]): this {
    this.#chunks.push(...chunks)
    return this
  }

  get input(): AsyncIterable<string> {
    const chunks = this.#chunks
    return {
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) yield chunk
      },
    }
  }

  readonly output = { write: (text: string) => void this.written.push(text) }
  readonly error = { write: (text: string) => void this.errors.push(text) }

  /** Every frame that reached stdout, parsed. One per line is the contract. */
  frames(): Record<string, unknown>[] {
    return this.written
      .join('')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  }
}

export const request = (id: number, method: string, params?: unknown): string =>
  JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })

export const notification = (method: string, params?: unknown): string =>
  JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })

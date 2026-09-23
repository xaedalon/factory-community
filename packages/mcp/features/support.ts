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
  readonly replies = new Map<string, unknown>()
  /** When set, every request fails this way — how "no daemon" is spelled. */
  failure: { status: number; message: string; body?: unknown } | undefined

  answer(path: string, value: unknown): this {
    this.replies.set(path, value)
    return this
  }

  async request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    this.asked.push(`${init.method ?? 'GET'} ${path}`)
    if (this.failure !== undefined) throw this.failure
    const reply = this.replies.get(path)
    if (reply === undefined) {
      throw { status: 404, message: `Nothing answers ${path}.`, body: {} }
    }
    if (typeof reply === 'object' && reply !== null && 'status' in reply) throw reply
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

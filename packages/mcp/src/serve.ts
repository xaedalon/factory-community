import type { McpServer } from './server.js'

/**
 * The server, over a pair of streams somebody else owns.
 *
 * The one piece of this package that knows what a stream is, kept separate for
 * the reason `systemGitQuery` and `systemDetachedLauncher` are separate: the
 * protocol above it is a function of its input, so it can be specified without
 * a process, and the part that cannot be is small enough to read in one go.
 *
 * **stdout carries protocol frames and nothing else.** That is the whole
 * contract of stdio transport: a banner, a warning or a stray `console.log`
 * lands in the middle of a JSON-RPC stream and the session is over. Diagnostics
 * go to `error`, which is stderr, which every client either shows or ignores.
 */

export interface McpStreams {
  /**
   * Whatever the client sends, in whatever sized pieces it arrives.
   *
   * Chunks rather than lines, because that is what a pipe gives you: a frame
   * can be split across two reads and two frames can arrive in one. Bytes are
   * accepted as well as text so the caller does not have to set an encoding on
   * a stream first — and they are decoded in streaming mode, because a
   * multi-byte character split across two reads is a corrupted frame otherwise.
   */
  readonly input: AsyncIterable<string | Uint8Array>
  readonly output: { write(text: string): void }
  readonly error: { write(text: string): void }
}

export async function serve(server: McpServer, streams: McpStreams): Promise<void> {
  const decoder = new TextDecoder()
  let buffer = ''

  for await (const chunk of streams.input) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
    for (;;) {
      const cut = buffer.indexOf('\n')
      if (cut === -1) break
      // `\r` trimmed because a client on Windows, or one piping through
      // something that thinks it is being helpful, sends CRLF — and a frame
      // with a trailing carriage return is not JSON.
      const line = buffer.slice(0, cut).replace(/\r$/, '')
      buffer = buffer.slice(cut + 1)
      if (line.trim() === '') continue

      const reply = await server.handle(line)
      if (reply !== undefined) streams.output.write(`${reply}\n`)
    }
  }

  // Nothing is written on the way out. The client closed the pipe, which is how
  // every one of them says goodbye, and a farewell frame at that point is a
  // write to a closed stream.
}

/** A last line to stderr, for the one thing that cannot be reported in a frame. */
export const diagnoseTo = (streams: McpStreams) => (message: string) => {
  streams.error.write(`${message}\n`)
}

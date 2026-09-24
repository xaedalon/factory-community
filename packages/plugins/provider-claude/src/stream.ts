import { LineBuffer, type StreamEvent, type StreamReader } from '@factory/plugin-sdk'

/**
 * Reading Claude Code's `--output-format stream-json`.
 *
 * One JSON object per line. Everything below was read off a real run on
 * 2026-09-24 against 2.1.281, in a workspace with the Default profile's flags
 * and one command deliberately left off the allow-list:
 *
 * ```text
 * {"type":"system","subtype":"init", …}
 * {"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_…","name":"Bash",
 *                                            "input":{"command":"git --version"}}]}}
 * {"type":"system","subtype":"permission_denied","tool_use_id":"toolu_…","message":"Permission
 *   for this tool use was denied. … The action was NOT performed …"}
 * {"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_…",
 *                                        "content":"Permission … denied …","is_error":true}]}}
 * {"type":"assistant","message":{"content":[{"type":"text","text":"I couldn't run …"}]}}
 * {"type":"result","subtype":"success","is_error":false}
 * ```
 *
 * The last line is the whole reason this file exists: **`is_error` is false and
 * the process exits 0** on a run where a command was refused. Nothing outside
 * could tell.
 *
 * `permission_denied` is a *kind of event*, not a sentence, and that is what is
 * matched on. The alternative — matching the refusal's wording — was tried and
 * measured against the run that produced this work: the CLI said "no approval
 * **surface**" and the agent's own report said "no approval **interface**", so a
 * wording pattern would have missed it. The `is_error` on a `tool_result` is
 * deliberately *not* treated as a refusal either: an ordinary command exiting 1
 * sets the same flag, and a test suite that fails is not a permissions problem.
 *
 * What a person sees is unchanged by design. The agent's prose goes to the log
 * as it always did; the commands it ran go to stderr as a trace, which is where
 * the withheld-environment notice already goes; the tool *results* go only to
 * the denial scanner, which is a strict improvement — those carry the CLI's own
 * wording, where before the patterns had to make do with the agent's summary.
 */

/** The fields this reader depends on. Everything else in the event is ignored. */
interface ContentBlock {
  readonly type?: unknown
  readonly text?: unknown
  readonly id?: unknown
  readonly name?: unknown
  readonly input?: { readonly command?: unknown } | null
  readonly tool_use_id?: unknown
  readonly content?: unknown
  readonly is_error?: unknown
}

interface StreamLine {
  readonly type?: unknown
  readonly subtype?: unknown
  readonly tool_use_id?: unknown
  readonly message?: unknown
}

/** How many tool-use ids are remembered, so a long run cannot grow without bound. */
const REMEMBERED_TOOL_USES = 256

class ClaudeStreamReader implements StreamReader {
  readonly #lines = new LineBuffer()
  /** Tool-use id to what that call was, so a later denial can name it. */
  readonly #calls = new Map<string, { tool: string; command?: string }>()

  push(chunk: string): readonly StreamEvent[] {
    return this.#read(this.#lines.push(chunk))
  }

  end(): readonly StreamEvent[] {
    return this.#read(this.#lines.end())
  }

  #read(lines: readonly string[]): readonly StreamEvent[] {
    const events: StreamEvent[] = []
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed === '') continue

      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        // Not our format. A descriptor edited to drop the flags, a wrapper
        // script, a warning on stderr — all of them are output a person should
        // still see, so it passes through untouched rather than disappearing.
        events.push({ log: { text: `${line}\n`, stream: 'stdout' }, scan: line })
        continue
      }
      if (typeof parsed !== 'object' || parsed === null) continue
      this.#event(parsed as StreamLine, events)
    }
    return events
  }

  #event(line: StreamLine, events: StreamEvent[]): void {
    if (line.type === 'system' && line.subtype === 'permission_denied') {
      const call =
        typeof line.tool_use_id === 'string' ? this.#calls.get(line.tool_use_id) : undefined
      const evidence = typeof line.message === 'string' ? line.message : 'permission denied'
      const tool = call?.tool ?? 'a tool'
      events.push({
        refused: {
          tool,
          ...(call?.command === undefined ? {} : { command: call.command }),
          evidence,
        },
        // Against the step, on the stream Factory's own notices use. The whole
        // failure mode is that this was invisible; a line in the log is the
        // cheapest possible cure.
        log: {
          text: `factory: refused — ${call?.command ?? tool}\n`,
          stream: 'stderr',
        },
      })
      return
    }

    const content = blocks(line.message)
    if (content === undefined) return

    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        // One newline per block. Text mode ends its single paragraph with one,
        // and a stream can carry several — without this they run together into
        // a wall, which is the sort of regression a log makes nobody notice.
        events.push({ log: { text: `${block.text}\n`, stream: 'stdout' }, scan: block.text })
        continue
      }

      if (block.type === 'tool_use' && typeof block.id === 'string') {
        const tool = typeof block.name === 'string' ? block.name : 'tool'
        const command =
          typeof block.input?.command === 'string' ? block.input.command : undefined
        this.#remember(block.id, { tool, ...(command === undefined ? {} : { command }) })
        // A trace, not a transcript: one line per call, so a run that is
        // thinking for six minutes still shows what it is doing. Liveness came
        // out of the same report as the silent success, and this is the half of
        // it that costs nothing.
        events.push({
          log: {
            text: `factory: ${tool}${command === undefined ? '' : `: ${command}`}\n`,
            stream: 'stderr',
          },
        })
        continue
      }

      if (block.type === 'tool_result') {
        // Scanned, never logged. This is where the CLI's own refusal wording
        // lives, which is what the descriptor's patterns were written against —
        // and it is also where a `cat` of a large file would live, which is why
        // it stays out of the log.
        const text = resultText(block.content)
        if (text !== '') events.push({ scan: text })
      }
    }
  }

  #remember(id: string, call: { tool: string; command?: string }): void {
    // A run with thousands of tool calls should not keep every id alive. The
    // denial arrives immediately after its call, so a small window is plenty.
    if (this.#calls.size >= REMEMBERED_TOOL_USES) {
      const oldest = this.#calls.keys().next()
      if (!(oldest.done ?? false)) this.#calls.delete(oldest.value)
    }
    this.#calls.set(id, call)
  }
}

/** The content blocks of an `assistant` or `user` event, if it has any. */
function blocks(message: unknown): readonly ContentBlock[] | undefined {
  if (typeof message !== 'object' || message === null) return undefined
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return undefined
  return content.filter(
    (block): block is ContentBlock => typeof block === 'object' && block !== null,
  )
}

/** A tool result is a string, or the same blocks again. Both shapes are sent. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) =>
      typeof part === 'object' && part !== null && typeof (part as ContentBlock).text === 'string'
        ? ((part as ContentBlock).text as string)
        : '',
    )
    .join('')
}

export const claudeStream = (): StreamReader => new ClaudeStreamReader()

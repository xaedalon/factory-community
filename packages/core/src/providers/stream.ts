/**
 * Reading a provider's structured output.
 *
 * `denialPatterns` exist because the Default profile moves a refusal *inside*
 * the agent, where the only trace of it is prose. A supervised run showed what
 * that costs: asked to install dependencies, the agent was refused, carried on,
 * exited 0, and wrote a report of ticks for work it had not done — and it
 * described the refusal in its own words ("there's no approval **interface**")
 * rather than the CLI's ("no approval **surface**"). A pattern on the CLI's
 * wording would have missed the very run that found the bug.
 *
 * Several CLIs will emit their transcript as machine-readable events instead,
 * and that gives the same facts structurally: the tool, the exact command, and
 * a flag saying it was refused. Claude Code's `--output-format stream-json`
 * even has an event *kind* for a denial, which is as unambiguous as this gets.
 *
 * Core cannot parse those shapes itself — they are each CLI's business, and a
 * `switch` on provider id in core is the coupling the plugin seam exists to
 * prevent. So a provider may supply a reader, and core consumes what it emits.
 * A provider that supplies none is read exactly as before: this degrades by
 * absence, like every other capability here.
 */

/** What a provider's reader turns its output into. */
export interface StreamEvent {
  /**
   * Text for the run's log.
   *
   * What a person reads afterwards, and what the board shows while it runs. A
   * reader is expected to put the agent's own prose on `stdout` — so the log
   * stays what it was before the format changed — and anything Factory adds,
   * such as a trace of the commands that ran, on `stderr`.
   */
  readonly log?: { readonly text: string; readonly stream: 'stdout' | 'stderr' }
  /**
   * Text for the denial scanner that the log does not carry.
   *
   * A tool's *result* is where the CLI says, in its own words, that it refused
   * something — and with a structured format that result never reaches the log
   * at all. Passing it here is what keeps the existing wording patterns working,
   * and makes them better than they were: they now read the CLI rather than the
   * agent's summary of it.
   */
  readonly scan?: string
  /** A refusal the provider reported as a fact rather than as a sentence. */
  readonly refused?: RefusedAction
}

/** Something the agent tried to do and was not allowed to. */
export interface RefusedAction {
  /** The tool it was refused, as that CLI names it. */
  readonly tool: string
  /**
   * The shell command it was refused, when the tool ran one.
   *
   * This is the distinction the whole feature turns on. A refused *path* may
   * leave the real work done — the agent writes somewhere else and carries on.
   * A refused *command* means an install, a build or a test did not run, and
   * anything reported afterwards was reported without it.
   */
  readonly command?: string
  /** The provider's own words, so nobody has to trust this reading of them. */
  readonly evidence: string
}

/**
 * Stateful, because the interesting facts span events.
 *
 * A denial names a tool-use id and nothing else; the command it refused was in
 * an event that has already gone past. So a reader remembers what it has seen,
 * which also means one reader per step and never a shared one.
 */
export interface StreamReader {
  /** Called with output as it arrives, in whatever pieces the pipe delivers. */
  push(chunk: string): readonly StreamEvent[]
  /** Called once when the process has closed, for anything still buffered. */
  end(): readonly StreamEvent[]
}

/** How the runner gets a reader of its own for each step. */
export type StreamReaderFactory = () => StreamReader

/**
 * Split a chunk into whole lines, keeping the remainder for next time.
 *
 * Shared because every line-delimited format needs exactly this and getting it
 * wrong is invisible until a chunk boundary lands mid-object — which happens
 * when the output is large, which is when nobody is watching. Offered to
 * providers through the SDK rather than copied into each one.
 */
export class LineBuffer {
  #rest = ''

  push(chunk: string): readonly string[] {
    const lines = (this.#rest + chunk).split('\n')
    // The last piece has no newline after it yet, so it may be half a line.
    this.#rest = lines.pop() ?? ''
    return lines
  }

  /** Whatever never got its newline. A process can close without one. */
  end(): readonly string[] {
    const rest = this.#rest
    this.#rest = ''
    return rest === '' ? [] : [rest]
  }
}

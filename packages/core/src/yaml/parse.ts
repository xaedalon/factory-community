import { LineCounter, parseDocument, type Document } from 'yaml'
import type { CapabilityLookup } from '../host.js'
import type { Problem } from '../problems.js'
import { parseWorkflow, type Workflow } from '../schema/workflow.js'
import { parsePhase, type Phase } from '../schema/phase.js'
import { parseAgent, type Agent } from '../schema/agent.js'
import { parseProfile, type Profile } from '../schema/profile.js'

/**
 * The file layer: YAML text in, a definition and located problems out.
 *
 * Everything below this reports problems by field path. This module is what
 * turns a path into a line and column, so an error reads
 * `development.workflow.yaml:4:9 mode: ...` rather than naming a field the
 * author then has to go hunting for. `factory doctor` and the builder's inline
 * diagnostics are both this function plus a renderer.
 */

export interface FileParseResult<T> {
  readonly value?: T
  readonly problems: readonly Problem[]
  /** The parsed document, kept so an edit can patch it rather than rewrite it. */
  readonly document?: Document
}

export function parseWorkflowFile(text: string, file?: string): FileParseResult<Workflow> {
  return parseFile(text, file, (data) => {
    const result = parseWorkflow(data, file === undefined ? {} : { file })
    return { value: result.workflow, problems: result.problems }
  })
}

export function parsePhaseFile(
  text: string,
  host: CapabilityLookup,
  file?: string,
): FileParseResult<Phase> {
  return parseFile(text, file, (data) => {
    const result = parsePhase(data, host, file === undefined ? {} : { file })
    return { value: result.phase, problems: result.problems }
  })
}

export function parseAgentFile(text: string, file?: string): FileParseResult<Agent> {
  return parseFile(text, file, (data) => {
    const result = parseAgent(data, file === undefined ? {} : { file })
    return { value: result.agent, problems: result.problems }
  })
}

/** A profile, from a file. */
export function parseProfileFile(text: string, file?: string): FileParseResult<Profile> {
  return parseFile(text, file, (data) => {
    const result = parseProfile(data, file === undefined ? {} : { file })
    return { value: result.profile, problems: result.problems }
  })
}

function parseFile<T>(
  text: string,
  file: string | undefined,
  validate: (data: unknown) => { value: T | undefined; problems: readonly Problem[] },
): FileParseResult<T> {
  const lineCounter = new LineCounter()
  const document = parseDocument(text, { lineCounter, keepSourceTokens: false })

  // A YAML syntax error is terminal: there is no data to validate, and guessing
  // at a partial parse would report a cascade of misleading field errors.
  if (document.errors.length > 0) {
    return {
      problems: document.errors.map((error) => ({
        severity: 'error' as const,
        // yaml appends "at line N, column M" plus a source snippet. Both are
        // already carried structurally, and a Problem message has to render on
        // one line, so keep only the sentence.
        message: error.message.split(' at line ')[0] ?? error.message,
        ...(file === undefined ? {} : { file }),
        ...(error.linePos?.[0] === undefined
          ? {}
          : { at: { line: error.linePos[0].line, column: error.linePos[0].col } }),
        rule: 'yaml.syntax',
      })),
      document,
    }
  }

  const data = document.toJS()
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return {
      problems: [
        {
          severity: 'error',
          message: 'A definition file must contain a mapping of fields',
          ...(file === undefined ? {} : { file }),
          rule: 'yaml.notAMapping',
        },
      ],
      document,
    }
  }

  const result = validate(data)
  const problems = result.problems.map((problem) => locate(problem, document, lineCounter))

  return {
    ...(result.value === undefined ? {} : { value: result.value }),
    problems,
    document,
  }
}

/** Attach a line and column by finding the problem's node in the document. */
function locate(problem: Problem, document: Document, lineCounter: LineCounter): Problem {
  if (problem.at !== undefined || problem.path === undefined || problem.path.length === 0) {
    return problem
  }

  // Walk from the most specific path towards the root: a missing key has no
  // node of its own, so the useful location is its nearest present ancestor --
  // pointing at the map the key should have been in.
  for (let depth = problem.path.length; depth > 0; depth--) {
    const offset = offsetAt(document, problem.path.slice(0, depth))
    if (offset === undefined) continue
    const position = lineCounter.linePos(offset)
    return { ...problem, at: { line: position.line, column: position.col } }
  }
  return problem
}

function offsetAt(document: Document, path: readonly (string | number)[]): number | undefined {
  try {
    const node = document.getIn(path as (string | number)[], true) as
      | { range?: [number, number, number] }
      | undefined
    return node?.range?.[0]
  } catch {
    return undefined
  }
}

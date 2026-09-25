import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type {
  Agent,
  CapabilityLookup,
  Phase,
  Problem,
  Profile,
  Workflow,
} from '@factory/core'
import {
  parseAgentFile,
  parsePhaseFile,
  parseProfileFile,
  parseWorkflowFile,
} from '@factory/core'
import type { Scope, ScopeChain, ScopeKind } from './scopes.js'

/**
 * Layered definition lookup: project, then user, then builtin. First match per
 * name wins.
 *
 * Choosing "layered" over "one active scope" costs exactly one thing -- a user
 * can no longer tell which file won by looking at a single directory. That cost
 * is paid here rather than left to them: every result carries what it shadows,
 * and `explain` lists every path that was tried. It is the debugging tool the
 * prototype never had, and it is roughly fifteen lines.
 */

export type DefinitionKind = 'workflow' | 'phase' | 'agent' | 'profile'

/**
 * Where each kind's files live. The one table that decides it — adding a kind
 * is a row here, not a search for hard-coded directory names.
 *
 * `@factory/events` declares this union a second time for its definition
 * events; the two are structurally independent and nothing checks them against
 * each other, so a new kind has to be added in both.
 */
const LAYOUT: Record<DefinitionKind, { directory: string; suffix: string }> = {
  workflow: { directory: 'workflows', suffix: '.workflow.yaml' },
  phase: { directory: 'phases', suffix: '.phase.yaml' },
  agent: { directory: 'agents', suffix: '.agent.yaml' },
  profile: { directory: 'profiles', suffix: '.profile.yaml' },
}

/** Every kind, for the callers that have to enumerate them. */
export const DEFINITION_KINDS = Object.keys(LAYOUT) as readonly DefinitionKind[]

/** The directory each kind lives in, for anything creating a scope. */
export const DEFINITION_DIRECTORIES = Object.values(LAYOUT).map((entry) => entry.directory)

/** Whether a string names a kind. A guard, so callers narrow rather than cast. */
export const isDefinitionKind = (value: string): value is DefinitionKind =>
  (DEFINITION_KINDS as readonly string[]).includes(value)

export interface DefinitionRef {
  readonly kind: DefinitionKind
  readonly name: string
  readonly scope: ScopeKind
  readonly file: string
}

export interface ResolvedDefinition<T> {
  readonly ref: DefinitionRef
  readonly value: T
  /** The original bytes, so an edit can patch them rather than rewrite them. */
  readonly raw: string
  readonly problems: readonly Problem[]
  /** Same-name copies in lower-precedence scopes. Empty when the name is unique. */
  readonly shadows: readonly DefinitionRef[]
}

export interface DefinitionListing {
  readonly name: string
  readonly winner: DefinitionRef
  readonly shadowed: readonly DefinitionRef[]
  /** False when the winning file fails to parse or validate. */
  readonly valid: boolean
  readonly problems: readonly Problem[]
  /**
   * The parsed definition, when it parsed.
   *
   * Carried rather than discarded because it has already been read and parsed
   * to work out `valid`, and a caller that needs one field of it — which
   * conditions a workflow declares, say — would otherwise read and parse the
   * same file a second time to get an answer this function already had.
   * `unknown`, so a caller has to say what it expects.
   */
  readonly value?: unknown
}

export interface Candidate {
  readonly scope: ScopeKind
  readonly file: string
  readonly exists: boolean
}

export function definitionPath(scope: Scope, kind: DefinitionKind, name: string): string {
  const layout = LAYOUT[kind]
  return join(scope.root, layout.directory, `${name}${layout.suffix}`)
}

/**
 * Every path that would be tried for a name, in order, whether or not it
 * exists. Powers `factory why` and the builder's resolution popover.
 */
export function explain(chain: ScopeChain, kind: DefinitionKind, name: string): Candidate[] {
  return chain.scopes.map((scope) => {
    const file = definitionPath(scope, kind, name)
    return { scope: scope.kind, file, exists: existsSync(file) }
  })
}

export function resolveWorkflow(
  chain: ScopeChain,
  name: string,
): ResolvedDefinition<Workflow> | undefined {
  return resolve(chain, 'workflow', name, (text, file) => {
    const result = parseWorkflowFile(text, file)
    return { value: result.value, problems: result.problems }
  })
}

export function resolvePhase(
  chain: ScopeChain,
  host: CapabilityLookup,
  name: string,
): ResolvedDefinition<Phase> | undefined {
  return resolve(chain, 'phase', name, (text, file) => {
    const result = parsePhaseFile(text, host, file)
    return { value: result.value, problems: result.problems }
  })
}

export function resolveAgent(
  chain: ScopeChain,
  name: string,
): ResolvedDefinition<Agent> | undefined {
  return resolve(chain, 'agent', name, (text, file) => {
    const result = parseAgentFile(text, file)
    return { value: result.value, problems: result.problems }
  })
}

/**
 * A profile, through the chain.
 *
 * Named `resolveProfileDefinition` because `resolveProfile` is taken: that one
 * decides *which* profile applies — project, then installation, then default —
 * and this one finds the file. Two functions, two questions, and one of them
 * having the obvious name is better than both having confusing ones.
 */
export function resolveProfileDefinition(
  chain: ScopeChain,
  name: string,
): ResolvedDefinition<Profile> | undefined {
  return resolve(chain, 'profile', name, (text, file) => {
    const result = parseProfileFile(text, file)
    return { value: result.value, problems: result.problems }
  })
}

function resolve<T>(
  chain: ScopeChain,
  kind: DefinitionKind,
  name: string,
  parse: (text: string, file: string) => { value: T | undefined; problems: readonly Problem[] },
): ResolvedDefinition<T> | undefined {
  const present = explain(chain, kind, name).filter((candidate) => candidate.exists)
  const winner = present[0]
  if (winner === undefined) return undefined

  const raw = readFileSync(winner.file, 'utf8')
  const parsed = parse(raw, winner.file)

  // A file that fails to parse still *wins*. Falling through to the shadowed
  // copy would silently run something other than what the author edited, and
  // "it worked but used the wrong file" is far worse than a clear error.
  return {
    ref: { kind, name, scope: winner.scope, file: winner.file },
    value: parsed.value as T,
    raw,
    problems: parsed.problems,
    shadows: present.slice(1).map((candidate) => ({
      kind,
      name,
      scope: candidate.scope,
      file: candidate.file,
    })),
  }
}

/** Every definition of a kind across the chain, deduplicated, shadowing marked. */
export function listDefinitions(
  chain: ScopeChain,
  kind: DefinitionKind,
  parse: (text: string, file: string) => { value: unknown; problems: readonly Problem[] },
): DefinitionListing[] {
  const byName = new Map<string, DefinitionRef[]>()

  for (const scope of chain.scopes) {
    for (const name of namesIn(scope, kind)) {
      const refs = byName.get(name) ?? []
      refs.push({ kind, name, scope: scope.kind, file: definitionPath(scope, kind, name) })
      byName.set(name, refs)
    }
  }

  return [...byName.entries()]
    .map(([name, refs]) => {
      const [winner, ...shadowed] = refs as [DefinitionRef, ...DefinitionRef[]]
      const parsed = parse(readFileSync(winner.file, 'utf8'), winner.file)
      return {
        name,
        winner,
        shadowed,
        valid: parsed.value !== undefined,
        problems: parsed.problems,
        ...(parsed.value === undefined ? {} : { value: parsed.value }),
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Definition names present in one scope, in no particular order. */
export function namesIn(scope: Scope, kind: DefinitionKind): string[] {
  const layout = LAYOUT[kind]
  const directory = join(scope.root, layout.directory)
  try {
    return readdirSync(directory)
      .filter((entry) => entry.endsWith(layout.suffix))
      .map((entry) => entry.slice(0, -layout.suffix.length))
      .filter((name) => name.length > 0)
  } catch {
    return []
  }
}

/** The scope a write should target, honouring an explicit request. */
export function writeTarget(chain: ScopeChain, requested?: ScopeKind): Scope {
  const wanted = requested ?? chain.defaultWriteScope
  const scope = chain.scopes.find((candidate) => candidate.kind === wanted)
  if (scope === undefined) {
    throw new Error(
      `No ${wanted} scope in this chain. Available: ${chain.scopes.map((s) => s.kind).join(', ')}`,
    )
  }
  if (!scope.writable) {
    throw new Error(
      `The ${wanted} scope is read-only — it ships inside the installed package. ` +
        `Save a copy to your project or user scope instead; it will shadow the built-in one.`,
    )
  }
  return scope
}

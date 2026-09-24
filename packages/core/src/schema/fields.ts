import type { Workflow } from './workflow.js'
import type { Phase } from './phase.js'
import type { Agent } from './agent.js'

/**
 * The field tables.
 *
 * The prototype's serializer was a hand-typed object literal, so every field added
 * to the reader afterwards was permanently missing from the writer: saving a
 * workflow silently stripped its `conditions` and `on_fail`. Diligence cannot
 * fix a shape like that -- nothing connects the two halves, so nothing can
 * notice when they drift.
 *
 * Here the writer is generated from these tables, and an exhaustiveness test
 * asserts a table covers exactly the keys its schema accepts. Adding a field to
 * a schema fails the build until you say how to write it -- including saying
 * "deliberately not written", which is still a decision someone made on purpose.
 */

export type Emission =
  /** Always written, even when empty. Identity fields. */
  | 'always'
  /** Written when not undefined. */
  | 'ifPresent'
  /** Written when it differs from the schema default. */
  | 'ifNotDefault'
  /** Written when a list or map has entries. */
  | 'ifNonEmpty'
  /** Never written by the canonical writer, for a stated reason. */
  | 'omit'

export interface FieldSpec<D> {
  /** The key as it appears in the YAML file. */
  readonly yaml: string
  /** The property on the domain object. Null when the field is not stored. */
  readonly from: keyof D | null
  readonly emit: Emission
  /** Compared against for `ifNotDefault`. */
  readonly fallback?: unknown
  /** Required when `emit` is 'omit', so the choice is recorded rather than assumed. */
  readonly why?: string
}

/**
 * Order here is the order keys are written, chosen so a generated file reads
 * top-down: what it is, how it runs, what it needs, what it does.
 */
export const WORKFLOW_FIELDS: readonly FieldSpec<Workflow>[] = [
  { yaml: 'kind', from: 'kind', emit: 'ifPresent' },
  { yaml: 'name', from: 'name', emit: 'always' },
  { yaml: 'description', from: 'description', emit: 'ifNotDefault', fallback: '' },
  { yaml: 'mode', from: 'mode', emit: 'ifNotDefault', fallback: 'once' },
  { yaml: 'interval', from: 'interval', emit: 'ifPresent' },
  { yaml: 'repeat', from: 'repeat', emit: 'ifPresent' },
  { yaml: 'scheduling', from: 'scheduling', emit: 'ifNotDefault', fallback: 'parallel' },
  { yaml: 'variables', from: 'variables', emit: 'ifNonEmpty' },
  { yaml: 'needs', from: 'needs', emit: 'ifNonEmpty' },
  { yaml: 'conditions', from: 'conditions', emit: 'ifPresent' },
  { yaml: 'on_fail', from: 'onFail', emit: 'ifPresent' },
  { yaml: 'override', from: 'override', emit: 'ifPresent' },
  { yaml: 'reliability', from: 'reliability', emit: 'ifPresent' },
  { yaml: 'phases', from: 'phases', emit: 'always' },
]

export const AGENT_FIELDS: readonly FieldSpec<Agent>[] = [
  { yaml: 'kind', from: 'kind', emit: 'ifPresent' },
  { yaml: 'name', from: 'name', emit: 'always' },
  { yaml: 'description', from: 'description', emit: 'ifNotDefault', fallback: '' },
  { yaml: 'provider', from: 'provider', emit: 'ifPresent' },
  { yaml: 'model', from: 'model', emit: 'ifPresent' },
  { yaml: 'effort', from: 'effort', emit: 'ifPresent' },
  { yaml: 'subagent', from: 'subagent', emit: 'ifPresent' },
  { yaml: 'session', from: 'session', emit: 'ifPresent' },
  { yaml: 'args', from: 'args', emit: 'ifNonEmpty' },
]

export const PHASE_FIELDS: readonly FieldSpec<Phase>[] = [
  { yaml: 'kind', from: 'kind', emit: 'ifPresent' },
  { yaml: 'name', from: 'name', emit: 'always' },
  { yaml: 'description', from: 'description', emit: 'ifNotDefault', fallback: '' },
  { yaml: 'approval', from: 'approval', emit: 'ifNotDefault', fallback: 'none' },
  { yaml: 'working_dir', from: 'workingDir', emit: 'ifPresent' },
  { yaml: 'variables', from: 'variables', emit: 'ifNonEmpty' },
  { yaml: 'steps', from: 'steps', emit: 'always' },
]

/** Should this field be written, given its value? */
export function shouldEmit(spec: FieldSpec<never>, value: unknown): boolean {
  switch (spec.emit) {
    case 'omit':
      return false
    case 'always':
      return true
    case 'ifPresent':
      return value !== undefined
    case 'ifNotDefault':
      return value !== undefined && value !== spec.fallback
    case 'ifNonEmpty':
      if (value === undefined) return false
      if (Array.isArray(value)) return value.length > 0
      if (typeof value === 'object' && value !== null) return Object.keys(value).length > 0
      return true
  }
}

/**
 * Every field table, by the kind it belongs to.
 *
 * The exhaustiveness feature walks this rather than naming tables one by one.
 * That closes the last gap in the guard: the tables were checked against their
 * schemas, but nothing checked that every table was being checked — so a new
 * definition kind could arrive with an unverified writer and the suite would
 * stay green.
 */
export const FIELD_TABLES = {
  workflow: WORKFLOW_FIELDS,
  phase: PHASE_FIELDS,
  agent: AGENT_FIELDS,
} as const satisfies Record<string, readonly FieldSpec<never>[]>

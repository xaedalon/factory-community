import { Document, Scalar, isMap, parse, parseDocument, type YAMLMap } from 'yaml'
import {
  AGENT_FIELDS,
  PROFILE_FIELDS,
  PHASE_FIELDS,
  WORKFLOW_FIELDS,
  shouldEmit,
  type FieldSpec,
} from '../schema/fields.js'
import type { CapabilityLookup } from '../host.js'
import { STEP_KIND, type Step, type StepKindCapability } from '../schema/step.js'
import type { Workflow } from '../schema/workflow.js'
import type { Phase } from '../schema/phase.js'
import type { Agent } from '../schema/agent.js'
import type { Profile } from '../schema/profile.js'

/**
 * Two write paths, and the distinction is the whole point.
 *
 *   writeNew        canonical output, generated from the field table. For a
 *                   file that does not exist yet, and for bundle import.
 *
 *   updateExisting  parses the file the author wrote and applies only the keys
 *                   that actually changed. Comments, key order, blank lines and
 *                   quoting style survive, because the document is never
 *                   rebuilt -- it is edited.
 *
 * Every edit in Factory goes through the second one. That is what makes "the
 * save stripped my conditions" structurally impossible rather than merely
 * tested against: there is no code path that reconstructs a file from scratch
 * over the top of an existing one.
 */

const yamlOptions = {
  // A long shell command must not be folded across lines. The fold is legal and
  // round-trips, but these files are read and diffed far more than written.
  lineWidth: 0,
} as const

export function writeNewWorkflow(workflow: Workflow): string {
  return writeNew(workflow, WORKFLOW_FIELDS, identity)
}

export function updateExistingWorkflow(raw: string, workflow: Workflow): string {
  return updateExisting(raw, workflow, WORKFLOW_FIELDS, identity)
}

/**
 * Phases need the capability host, because writing a step is the mirror of
 * reading one: the reader infers `uses: shell` from a bare `run:`, so the
 * writer has to leave it out again. Without that symmetry a no-op save would
 * rewrite `- run: npm test` as `- uses: shell` plus `run: npm test` -- true,
 * equivalent, and a diff nobody asked for.
 */
export function writeNewPhase(phase: Phase, host: CapabilityLookup): string {
  return writeNew(phase, PHASE_FIELDS, stepProjection(host))
}

export function updateExistingPhase(raw: string, phase: Phase, host: CapabilityLookup): string {
  return updateExisting(raw, phase, PHASE_FIELDS, stepProjection(host))
}

/**
 * An agent has no steps, so it needs no host and no projection. It is the one
 * definition kind whose writer is the generic one with nothing added.
 */
export function writeNewAgent(agent: Agent): string {
  return writeNew(agent, AGENT_FIELDS, identity)
}

export function updateExistingAgent(raw: string, agent: Agent): string {
  return updateExisting(raw, agent, AGENT_FIELDS, identity)
}

/**
 * A profile, written the same way.
 *
 * The second kind whose writer is the generic one with nothing added — a
 * profile is data all the way down, and `providers` is a plain map that
 * `toPlain` handles like any other.
 */
export function writeNewProfile(profile: Profile): string {
  return writeNew(profile, PROFILE_FIELDS, identity)
}

export function updateExistingProfile(raw: string, profile: Profile): string {
  return updateExisting(raw, profile, PROFILE_FIELDS, identity)
}

/** How a domain value is projected into the shape that appears in the file. */
type Projection = (yamlKey: string, value: unknown) => unknown

const identity: Projection = (_key, value) => value

function stepProjection(host: CapabilityLookup): Projection {
  const kinds = host.list<StepKindCapability>(STEP_KIND).map((entry) => entry.capability)
  return (yamlKey, value) => {
    if (yamlKey !== 'steps' || !Array.isArray(value)) return value
    return (value as Step[]).map((step) => stepToYaml(step, kinds))
  }
}

function stepToYaml(step: Step, kinds: readonly StepKindCapability[]): Record<string, unknown> {
  const { uses, ...rest } = step
  const kind = kinds.find((candidate) => candidate.id === uses)
  if (kind?.sugarKey !== undefined && kind.sugarKey in rest) {
    // Only elide when the shorthand alone is unambiguous -- exactly the
    // condition the reader uses to infer it.
    const claimants = kinds.filter(
      (candidate) => candidate.sugarKey !== undefined && candidate.sugarKey in rest,
    )
    if (claimants.length === 1) return rest
  }
  return { uses, ...rest }
}

function writeNew<D extends { extensions: Readonly<Record<string, unknown>> }>(
  value: D,
  fields: readonly FieldSpec<D>[],
  project: Projection,
): string {
  const doc = new Document({})
  const map = doc.contents as YAMLMap
  const expected: Record<string, unknown> = {}

  for (const spec of fields) {
    if (spec.from === null) continue
    const current = value[spec.from]
    if (!shouldEmit(spec as FieldSpec<never>, current)) continue
    const projected = project(spec.yaml, current)
    expected[spec.yaml] = plainValue(projected)
    map.set(spec.yaml, toPlain(projected))
  }

  // Extensions last, so Factory's own fields stay together at the top.
  //
  // Defaulted because a caller building a definition by hand — the API, a
  // script — has no reason to include an empty `extensions`, and crashing on
  // its absence turned a valid request into a 500. A parsed definition always
  // has one.
  for (const [key, extension] of Object.entries(value.extensions ?? {})) {
    expected[key] = plainValue(extension)
    map.set(key, toPlain(extension))
  }

  const text = doc.toString(yamlOptions)

  // Read back what we just wrote. This is the guarantee the whole module
  // exists to provide, so it is checked rather than assumed -- and it is cheap,
  // because definition files are small. If it ever fires, the alternative was
  // writing a file that quietly means something else.
  if (!deepEqual(parse(text), expected)) {
    throw new Error(
      'Refusing to write a file that does not read back identically. This is a bug in the ' +
        'serializer; please report the definition that triggered it.',
    )
  }

  return text
}

function updateExisting<D extends { extensions: Readonly<Record<string, unknown>> }>(
  raw: string,
  value: D,
  fields: readonly FieldSpec<D>[],
  project: Projection,
): string {
  const doc = parseDocument(raw)

  // An unparseable or non-mapping file cannot be patched, and falling back to a
  // rewrite would discard content we failed to understand -- the one outcome
  // this module exists to prevent.
  if (doc.errors.length > 0) {
    throw new Error(
      `Refusing to update a file that does not parse: ${doc.errors[0]?.message ?? 'unknown error'}`,
    )
  }
  if (!isMap(doc.contents)) {
    throw new Error('Refusing to update a file whose top level is not a mapping')
  }

  // Compare against the document's *values*, not its nodes. Comparing nodes
  // makes every structured field look changed, so it gets replaced wholesale
  // and takes its comments with it.
  const onDisk = doc.toJS() as Record<string, unknown>
  let touched = false

  for (const spec of fields) {
    if (spec.from === null) continue
    const next = value[spec.from]
    const wanted = shouldEmit(spec as FieldSpec<never>, next)

    if (!wanted) {
      // A field the writer will not emit has to stop being on disk — but only
      // when it actually *changed*. The two cases look identical from the value
      // alone and mean opposite things:
      //
      //   the author wrote `mode: once`, which equals the default   keep it
      //   the author cleared `args` to []                           delete it
      //
      // So the question is not "is it worth emitting" but "does the file still
      // say what the value says". Unchanged means the author wrote it on purpose
      // and a round-trip must not quietly take it away; changed means they
      // cleared it, and leaving the old line is how clearing a field on the
      // board silently did nothing at all.
      //
      // `undefined` falls out of the same comparison: absent here, present on
      // disk, therefore changed, therefore deleted — which is what it already
      // did. `omit` is the exception, because a field the table says never to
      // write is not one to delete either; it is somebody else's key.
      const unchanged = deepEqual(onDisk[spec.yaml], project(spec.yaml, next))
      if (spec.emit !== 'omit' && !unchanged && doc.has(spec.yaml)) {
        doc.delete(spec.yaml)
        touched = true
      }
      continue
    }
    const projected = project(spec.yaml, next)
    if (!deepEqual(onDisk[spec.yaml], projected)) {
      doc.set(spec.yaml, toPlain(projected))
      touched = true
    }
  }

  const extensions = value.extensions ?? {}
  for (const [key, extension] of Object.entries(extensions)) {
    if (!deepEqual(onDisk[key], extension)) {
      doc.set(key, toPlain(extension))
      touched = true
    }
  }
  for (const item of [...doc.contents.items]) {
    const key = String((item.key as { value?: unknown })?.value ?? '')
    if (key.startsWith('x-') && !(key in extensions)) {
      doc.delete(key)
      touched = true
    }
  }

  // Nothing actually changed, so hand back the author's bytes rather than a
  // re-rendering of them. Stringifying is not perfectly identity-preserving --
  // the library keeps a trailing comment's text but not the padding that
  // aligned it, so `region: eu-west-1        # note` comes back with a single
  // space. Skipping the render entirely makes a no-op save lossless by
  // construction instead of by luck, and it is the common case: the builder
  // saves whether or not the user changed anything.
  if (!touched) return raw

  return doc.toString(yamlOptions)
}

/**
 * Drop readonly wrappers and undefined-valued keys before the YAML writer sees
 * them, and pin the quoting style for strings the writer would otherwise
 * mangle.
 *
 * The hazard: a multi-line string whose first line begins with a space is
 * emitted as a block scalar without the explicit indentation indicator it
 * needs, so the leading space is read back as part of the block's own indent
 * and silently disappears. Forcing a double-quoted scalar for just those values
 * keeps every other string in its natural, readable form.
 */
function toPlain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toPlain)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, toPlain(entry)]),
    )
  }
  if (typeof value === 'string' && needsExplicitQuoting(value)) {
    const scalar = new Scalar(value)
    scalar.type = Scalar.QUOTE_DOUBLE
    return scalar
  }
  return value
}

function needsExplicitQuoting(value: string): boolean {
  if (!value.includes('\n')) return false
  return value.split('\n').some((line) => /^[ \t]/.test(line))
}

/** The same shape as toPlain, but always plain JS -- used for the read-back check. */
function plainValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plainValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, plainValue(entry)]),
    )
  }
  return value
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((entry, index) => deepEqual(entry, b[index]))
  }
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const leftKeys = Object.keys(left).filter((key) => left[key] !== undefined)
  const rightKeys = Object.keys(right).filter((key) => right[key] !== undefined)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every((key) => deepEqual(left[key], right[key]))
}

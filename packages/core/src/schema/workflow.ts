import { z } from 'zod'
import { RELIABILITY_DIMENSIONS, type ReliabilityDimension } from '../reliability/model.js'
import type { Problem } from '../problems.js'
import { closedWithExtensions, extensionsOf, problemsFromZod, slug, variables } from './common.js'

/**
 * A workflow: an ordered list of phases, how it is scheduled, and what happens
 * when it fails.
 */

export const WORKFLOW_KIND = 'factory.workflow/v1'

/** How many times a workflow runs. */
export const WORKFLOW_MODES = ['once', 'loop'] as const
export type WorkflowMode = (typeof WORKFLOW_MODES)[number]

/**
 * How this workflow is scheduled against *other tasks* -- not against its own
 * phases, which are always sequential.
 *
 * Renamed from the prototype's `concurrency`, which was the single most misread
 * field in the schema: it reads as "can these phases run in parallel", and the
 * answer to that question is always no.
 */
/**
 * What a workflow says about being overridden.
 *
 * Only one value today, and it is still an enum: `override: required` reads as
 * a statement with room for others — `suggested`, say — where a boolean would
 * have to be renamed to grow.
 */
export const OVERRIDE = ['required'] as const
export type Override = (typeof OVERRIDE)[number]

export const SCHEDULING = ['sequential', 'parallel'] as const
export type Scheduling = (typeof SCHEDULING)[number]

const workflowShape = {
  // Optional: files written before versioning are assumed v1, so adding the
  // key later is not a breaking change. When present it must be recognised, so
  // a v2 file fails loudly on an old Factory instead of half-loading.
  kind: z.literal(WORKFLOW_KIND).optional(),
  name: slug('name'),
  mode: z.enum(WORKFLOW_MODES).default('once'),
  interval: z.number().int().positive().optional(),
  /**
   * How many times a loop runs before it is done.
   *
   * A loop with no bound runs until somebody notices, which is a poor default
   * for something that spawns agents. Capped at 100 because a workflow that
   * wants a thousand iterations wants a different design, and an unbounded
   * number in a box is an invitation to typo one.
   */
  repeat: z.number().int().min(1).max(100).optional(),
  scheduling: z.enum(SCHEDULING).default('parallel'),
  description: z.string().default(''),
  variables: variables.default({}),
  conditions: z
    .object({
      requires: z.array(z.string().min(1)).default([]),
      // Optional with no default on purpose: a default would add empty keys to
      // every file that mentions `conditions`, and a save would then write them
      // back. Absent stays absent.
      provides: z.array(z.string().min(1)).optional(),
      clears: z.array(z.string().min(1)).optional(),
    })
    .optional(),
  /**
   * Workflows that must come before this one.
   *
   * Only the *immediate* predecessor, not the whole chain: `verify` needs
   * `validate`, which needs `implement`, and Factory walks it. Listing the
   * chain on every workflow means writing it once per stage and repairing all
   * of them the day a stage is inserted — the copies drift, and the one nobody
   * opens is the one that is wrong.
   *
   * This is about *assembling* a task's list, not gating a run. `conditions`
   * answers "may this start yet"; `needs` answers "what else belongs in the
   * plan". A workflow can have both and they do not overlap.
   */
  needs: z.array(slug('needs')).default([]),
  on_fail: slug('on_fail').optional(),
  /**
   * Whether a project must provide its own copy before this runs.
   *
   * Declared by the workflow about itself, never recognised by name. The
   * prototype kept a `switch` on workflow names in the engine, so only four
   * blessed names could mean anything and renaming one broke it silently. A
   * built-in that cannot know your setup — where a worktree goes, how an
   * environment is built — says so here, and doctor reports any task about to
   * run the built-in copy.
   */
  override: z.enum(OVERRIDE).optional(),
  /**
   * What this workflow contributes to the task's reliability.
   *
   * Optional with no default, for the reason `conditions` is: a default would
   * add empty keys to every workflow anybody saves.
   *
   * Absent does **not** mean invisible. Every run is judged, because any
   * workflow can change the project — including one somebody wrote this
   * morning and told Factory nothing about. What this block buys is *precision*:
   * a workflow that names the evidence it collects earns coverage for it, and
   * a workflow that names the dimensions it touches has its failures attributed
   * to them instead of spread. Without it Factory still sees the exit codes,
   * the refusals and the artifacts, which is most of the value.
   */
  reliability: z
    .object({
      contributes: z.array(z.enum(RELIABILITY_DIMENSIONS)).default([]),
      expected_evidence: z.array(z.string().min(1)).default([]),
      evaluate_after_run: z.boolean().optional(),
    })
    .optional(),
  phases: z.array(slug('phase name')).default([]),
}

const workflowYaml = closedWithExtensions(workflowShape)

/**
 * The keys this schema accepts, derived rather than listed.
 *
 * The serializer's field table is checked against this, so adding a field above
 * fails the build until the writer is taught about it. See schema/fields.ts.
 */
export const workflowSchemaKeys: readonly string[] = Object.keys(workflowShape)

/**
 * A workflow's own account of what it adds to a judgement.
 *
 * `evaluate_after_run` is the one switch: false means this workflow's runs are
 * not judged at all, which is for the handful that change nothing worth judging
 * — a worktree being created, an environment torn down.
 */
export interface WorkflowReliability {
  readonly contributes: readonly ReliabilityDimension[]
  readonly expected_evidence: readonly string[]
  readonly evaluate_after_run?: boolean
}

export interface WorkflowConditions {
  /** Flags that must be set on the task before this workflow may run. */
  readonly requires: readonly string[]
  /**
   * Flags this workflow sets once it completes.
   *
   * Declared, not inferred. The prototype kept a `switch` on workflow names —
   * `worktree-create` sets `hasWorktree` — so only four blessed names could
   * ever earn a flag, and renaming one silently broke every gate that depended
   * on it.
   */
  readonly provides?: readonly string[] | undefined
  /** Flags this workflow clears once it completes, e.g. a worktree being removed. */
  readonly clears?: readonly string[] | undefined
}

export interface Workflow {
  /**
   * Present only when the file declared it. Carried so a save does not drop a
   * key the author wrote -- the same losslessness rule as every other field.
   */
  readonly kind?: typeof WORKFLOW_KIND
  readonly name: string
  readonly mode: WorkflowMode
  /** Seconds between iterations. Only meaningful when mode is "loop". */
  readonly interval?: number
  /** Iterations before the loop is finished. Absent means until stopped. */
  readonly repeat?: number
  readonly scheduling: Scheduling
  readonly description: string
  readonly variables: Readonly<Record<string, string>>
  readonly conditions?: WorkflowConditions
  /** Workflows that must come before this one. Immediate predecessors only. */
  readonly needs: readonly string[]
  /** Workflow to queue when a step fails. */
  readonly onFail?: string
  /** Set when a project must supply its own copy before this may be used. */
  readonly override?: Override
  /** What this workflow says it contributes to reliability. Absent is not invisible. */
  readonly reliability?: WorkflowReliability
  readonly phases: readonly string[]
  /** `x-` fields, carried through untouched. */
  readonly extensions: Readonly<Record<string, unknown>>
}

export interface WorkflowParseResult {
  readonly workflow?: Workflow
  readonly problems: readonly Problem[]
}

export function parseWorkflow(
  input: unknown,
  options: { file?: string } = {},
): WorkflowParseResult {
  const parsed = workflowYaml.safeParse(input)
  if (!parsed.success) {
    return {
      problems: problemsFromZod(parsed.error, {
        ...(options.file === undefined ? {} : { file: options.file }),
      }),
    }
  }

  const value = parsed.data as z.infer<typeof workflowYaml> & Record<string, unknown>
  const problems: Problem[] = []

  // Cross-field rules zod cannot express as a single field constraint. Stated
  // here rather than left to documentation, which is how the prototype ended up
  // with `interval` that only applied sometimes and `working_dir` that never
  // applied at all.
  if (value.repeat !== undefined && value.mode !== 'loop') {
    problems.push({
      severity: 'error',
      message: 'repeat only applies to a loop workflow — set "mode: loop" or remove it',
      ...(options.file === undefined ? {} : { file: options.file }),
      field: 'repeat',
      rule: 'workflow.repeatWithoutLoop',
    })
  }

  if (value.interval !== undefined && value.mode !== 'loop') {
    problems.push({
      severity: 'error',
      message: 'interval only applies to a loop workflow — set "mode: loop" or remove it',
      ...(options.file === undefined ? {} : { file: options.file }),
      field: 'interval',
      rule: 'workflow.intervalWithoutLoop',
    })
  }

  // A warning rather than an error, deliberately. The builder writes a workflow
  // before its phases are chosen, so refusing the file would make it impossible
  // to create one in the browser at all. What must not happen is *running* it,
  // and `resolvePlan` refuses that — this is the earlier, gentler notice, at the
  // point somebody can still see it in the editor.
  if (value.phases.length === 0) {
    problems.push({
      severity: 'warning',
      message: 'Workflow lists no phases, so it will do nothing',
      ...(options.file === undefined ? {} : { file: options.file }),
      field: 'phases',
      rule: 'workflow.noPhases',
    })
  }

  const duplicates = value.phases.filter((name, index) => value.phases.indexOf(name) !== index)
  for (const name of new Set(duplicates)) {
    problems.push({
      severity: 'warning',
      message: `Phase "${name}" is listed more than once; it will run more than once`,
      ...(options.file === undefined ? {} : { file: options.file }),
      field: 'phases',
      rule: 'workflow.duplicatePhase',
    })
  }

  if (value.needs.includes(value.name)) {
    problems.push({
      severity: 'error',
      message: `needs names this workflow, which can never come before itself`,
      ...(options.file === undefined ? {} : { file: options.file }),
      field: 'needs',
      rule: 'workflow.selfNeeds',
    })
  }

  if (value.on_fail === value.name) {
    problems.push({
      severity: 'warning',
      message: `on_fail points at this workflow, so a failure retries it immediately`,
      ...(options.file === undefined ? {} : { file: options.file }),
      field: 'on_fail',
      rule: 'workflow.selfOnFail',
    })
  }

  const workflow: Workflow = {
    ...(value.kind === undefined ? {} : { kind: value.kind }),
    name: value.name,
    mode: value.mode,
    ...(value.interval === undefined ? {} : { interval: value.interval }),
    ...(value.repeat === undefined ? {} : { repeat: value.repeat }),
    scheduling: value.scheduling,
    description: value.description,
    variables: value.variables,
    ...(value.conditions === undefined ? {} : { conditions: value.conditions }),
    needs: value.needs,
    ...(value.on_fail === undefined ? {} : { onFail: value.on_fail }),
    ...(value.override === undefined ? {} : { override: value.override }),
    ...(value.reliability === undefined
      ? {}
      : { reliability: value.reliability as WorkflowReliability }),
    phases: value.phases,
    extensions: extensionsOf(value),
  }

  return { workflow, problems }
}

import { z } from 'zod'
import type { Capability } from '../capabilities.js'
import type { CapabilityLookup } from '../host.js'
import type { Problem } from '../problems.js'
import type { ExecutionProfile } from '../security/profile.js'
import type { DenialPattern } from '../security/denials.js'
import type { StreamReaderFactory } from '../providers/stream.js'
import { closedWithExtensions, problemsFromZod, slug } from './common.js'

/**
 * A step kind: what `uses:` names.
 *
 * This is why the phase schema cannot be a fixed discriminated union. If core
 * hard-coded `shell | agent`, a plugin adding `uses: http` would need a core
 * change -- and the whole point is that it must not. So the step schema is
 * assembled at validation time from whatever kinds are registered, and the
 * two built-ins go through the same registry a third party would use.
 *
 * A consequence worth stating: validity depends on what is installed. A
 * workflow using `uses: http` is valid with that plugin present and invalid
 * without it -- and the error says so, rather than silently ignoring the step.
 */
export interface StepKindCapability extends Capability {
  /** The `uses:` value. Same as the capability id. */
  readonly id: string
  readonly summary: string
  /** Validates the step's fields, `uses` aside. */
  readonly schema: z.ZodType
  /**
   * Optional shorthand key. `shell` declares `run`, so `- run: npm test` is
   * accepted with no `uses:`. Data-driven, so a plugin can have shorthand too.
   */
  readonly sugarKey?: string
  /**
   * Turn a validated step into work that can actually be run.
   *
   * Parsing already goes through this registry; planning has to as well, or a
   * plugin could contribute a step kind that validates cleanly and then cannot
   * execute -- half a seam, and the half that fails later. A kind without a
   * planner is reported by name rather than silently skipped.
   */
  readonly plan?: (step: Step, context: PlanStepContext) => PlannedStep | PlanFailure
}

/**
 * What a named agent contributes to a step.
 *
 * Structural rather than importing `Agent`, because `schema/step.ts` is below
 * `schema/agent.ts` in the dependency order and a cycle here would be a real
 * one — an agent has no steps, and a step should not need the agent schema to
 * describe what it borrows.
 */
export interface AgentSettings {
  readonly provider?: string
  readonly model?: string
  readonly effort?: string
  readonly subagent?: string
  readonly session?: string
  readonly args?: readonly string[]
}

/** What a planner is given. Variables are already substituted. */
export interface PlanStepContext {
  readonly host: CapabilityLookup
  /**
   * How much authority this run gets.
   *
   * A step kind that renders a command for something else — which is what the
   * `agent` kind does — needs it, because the profile is the difference between
   * an unrestricted invocation and a confined one. A kind that runs its own
   * command can ignore it.
   */
  readonly profile?: ExecutionProfile
  /**
   * Directories outside `cwd` this step may reach, as the project granted them.
   *
   * A planner that renders a command for something else passes these on. One
   * that runs its own command can ignore them: it is already confined to `cwd`
   * by the runner, and nothing it does is mediated by a flag.
   */
  readonly allowedDirectories?: readonly string[]
  /**
   * Absolute directory the step will run in.
   *
   * Told to the planner rather than decided by it: where work happens is the
   * phase's and the project's business, not a step's. None of the built-in
   * kinds needs it, but a plugin's might — rendering a path into an argument,
   * say — and it is cheaper to pass than to ask for later.
   *
   * It is not a way to change the directory. A planner returns a command; the
   * runner spawns it in `phase.cwd` and nowhere else.
   */
  readonly cwd: string
  /**
   * Absolute directory this task's artifacts go in.
   *
   * Optional like everything else here: a planner given none falls back to a
   * `local` directory beside the workspace, which is what `factory run` and the
   * builder's plan preview get. Both plan without a task.
   */
  readonly artifacts?: string
  /** Provider to use when an agent step does not name one. */
  readonly defaultProvider?: string
  /**
   * Named agents, resolved from the same scope chain as phases.
   *
   * Optional, like everything else a kind may want: a planner given no lookup
   * simply cannot resolve `agent:`, and says so. That keeps `resolvePlan`
   * usable without a scope chain, which is what the unit tests rely on.
   */
  readonly lookupAgent?: (name: string) => AgentSettings | undefined
  /** Identity for the step's session scope, when it has one. */
  readonly sessionId?: string
  /**
   * Whether that session already exists.
   *
   * Decided by the planner, not by the step: the first agent step of a task
   * starts the session and every later one continues it, and which is which
   * depends on the order of the whole plan. A kind that renders a command just
   * passes this through.
   */
  readonly resumeSession?: boolean
}

/** A step reduced to a process to run. */
export interface PlannedStep {
  /** One line for --dry-run, logs and the run timeline. */
  readonly describe: string
  readonly command: string
  readonly args: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  /** A file redirected into stdin. */
  readonly stdin?: string
  /**
   * Environment variables this step needs even under a confined profile.
   *
   * The Default profile withholds anything shaped like a credential, and a
   * coding agent's own credential is shaped exactly like one. A provider
   * declares the exception in its descriptor and it travels here, so the runner
   * builds the environment without ever knowing that providers exist.
   *
   * Absent on a shell step, deliberately. A project's own test command has no
   * business needing a registry token under this profile, and if it does, the
   * withheld names are reported against the step rather than left to be
   * guessed.
   */
  readonly passEnv?: readonly string[]
  /**
   * What a refusal from this step's command looks like.
   *
   * Travels with the step for the reason `passEnv` does: the runner is what
   * reads the output, and it has no business knowing that providers exist.
   */
  readonly denialPatterns?: readonly DenialPattern[]
  /**
   * How to read this command's output, when it emits a structured transcript.
   *
   * Travels with the step for the same reason `denialPatterns` does: the runner
   * is what reads the pipe, and it has no business knowing that providers
   * exist. Absent means the output is text and is passed through as it always
   * was — a shell step, a provider with no reader, a `--dry-run`.
   */
  readonly stream?: StreamReaderFactory
  /**
   * argv for a second and later attempt, when the first attempt changed the
   * world in a way that makes running it again wrong.
   *
   * The case that needed it: a step that *starts* an agent session cannot
   * start it twice — the CLI refuses the id — so a retry has to resume
   * instead. Rendered here rather than worked out by the runner, because
   * rendering a command is a provider's job and `resolvePlan` is the only
   * place that has one.
   *
   * Absent means "the same argv again", which is every other step.
   */
  readonly retryArgs?: readonly string[]
  /**
   * The agent session this command starts or continues.
   *
   * Present only when a session flag was actually emitted, so a step with
   * `session: none` carries nothing and a provider with no session support
   * carries nothing. `creates` marks the one step that brings the session into
   * existence — the engine records the id once that step's process has
   * actually started, and not before: a spawn that fails (no CLI on PATH)
   * creates no session, and a recorded id for a session that does not exist is
   * a task that can never run again.
   */
  readonly session?: {
    readonly id: string
    /** Which provider owns it, so it can be resumed with that CLI's flag. */
    readonly provider: string
    readonly creates: boolean
  }
}

export interface PlanFailure {
  readonly problems: readonly Problem[]
}

export const isPlanFailure = (value: PlannedStep | PlanFailure): value is PlanFailure =>
  'problems' in value

export const STEP_KIND = 'step-kind'

/** A validated step. Flat, exactly as it appears in YAML, so it round-trips. */
export type Step = { readonly uses: string } & Record<string, unknown>

export interface StepParseResult {
  readonly step?: Step
  readonly problems: readonly Problem[]
}

const stepEnvelope = z.looseObject({ uses: slug('uses').optional() })

/**
 * Fields every step has, whatever kind it is.
 *
 * Handled here rather than in each kind's schema for the obvious reason — no
 * plugin should have to reimplement retrying to be retryable — and because a
 * kind's schema is closed: a field it has never heard of is an error, which is
 * exactly the behaviour that catches typos.
 *
 * `retries` is *extra* attempts: `retries: 2` means up to three runs in all.
 * Agent CLIs fail transiently — a rate limit, a dropped connection, a model
 * that returns nothing — and re-running the step is usually all that is needed.
 */
const COMMON_FIELDS = {
  retries: z.number().int().min(0).max(10).optional(),
  retry_delay: z.number().int().min(0).max(3600).optional(),
}

const commonSchema = z.object(COMMON_FIELDS)

/** The keys core takes out of a step before the kind ever sees it. */
export const COMMON_STEP_KEYS: readonly string[] = Object.keys(COMMON_FIELDS)

/**
 * Parse one step against the registered kinds.
 *
 * `index` and `file` only shape the error location; they do not change what is
 * considered valid.
 */
export function parseStep(
  input: unknown,
  host: CapabilityLookup,
  where: { index: number; file?: string; prefix?: readonly (string | number)[] } = { index: 0 },
): StepParseResult {
  const prefix = where.prefix ?? ['steps', where.index]
  const problem = (message: string, field?: string, rule = 'step.invalid'): Problem => ({
    severity: 'error',
    message,
    ...(where.file === undefined ? {} : { file: where.file }),
    field: [...prefix, ...(field === undefined ? [] : [field])].join('.'),
    rule,
  })

  const envelope = stepEnvelope.safeParse(input)
  if (!envelope.success) {
    return { problems: [problem('A step must be a mapping of fields')] }
  }

  const raw = envelope.data as Record<string, unknown>
  const kinds = host.list<StepKindCapability>(STEP_KIND).map((entry) => entry.capability)

  const resolved = resolveKind(raw, kinds)
  if ('error' in resolved) return { problems: [problem(resolved.error, undefined, resolved.rule)] }

  const { kind } = resolved

  const common = commonSchema.safeParse(
    Object.fromEntries(Object.entries(raw).filter(([key]) => COMMON_STEP_KEYS.includes(key))),
  )
  if (!common.success) {
    return {
      problems: problemsFromZod(common.error, {
        ...(where.file === undefined ? {} : { file: where.file }),
        prefix,
      }),
    }
  }

  const fields = Object.fromEntries(
    Object.entries(raw).filter(([key]) => key !== 'uses' && !COMMON_STEP_KEYS.includes(key)),
  )
  const parsed = kind.schema.safeParse(fields)
  if (!parsed.success) {
    return {
      problems: problemsFromZod(parsed.error, {
        ...(where.file === undefined ? {} : { file: where.file }),
        prefix,
      }),
    }
  }

  return {
    // The common fields go back in, so a step round-trips exactly as written.
    step: { ...(parsed.data as Record<string, unknown>), ...common.data, uses: kind.id },
    problems: [],
  }
}

/** How many times this step may run, and how long to wait in between. */
export const retryPolicy = (step: Step): { attempts: number; delaySeconds: number } => ({
  attempts: 1 + (typeof step.retries === 'number' ? step.retries : 0),
  delaySeconds: typeof step.retry_delay === 'number' ? step.retry_delay : 0,
})

function resolveKind(
  raw: Record<string, unknown>,
  kinds: readonly StepKindCapability[],
): { kind: StepKindCapability } | { error: string; rule: string } {
  const named = typeof raw.uses === 'string' ? raw.uses : undefined

  if (named !== undefined) {
    const kind = kinds.find((candidate) => candidate.id === named)
    if (kind) return { kind }
    const known = kinds.map((candidate) => candidate.id).sort()
    return {
      error:
        `Unknown step kind "${named}". ` +
        (known.length > 0
          ? `Installed kinds: ${known.join(', ')}. Is a plugin missing?`
          : `No step kinds are installed.`),
      rule: 'step.unknownKind',
    }
  }

  // No `uses:` -- fall back to shorthand, e.g. `- run: npm test`.
  const matches = kinds.filter(
    (candidate) => candidate.sugarKey !== undefined && candidate.sugarKey in raw,
  )
  if (matches.length === 1) return { kind: matches[0] as StepKindCapability }
  if (matches.length > 1) {
    return {
      error:
        `Ambiguous step: fields ${matches.map((k) => `"${k.sugarKey}"`).join(' and ')} are ` +
        `shorthand for different kinds (${matches.map((k) => k.id).join(', ')}). Name one with "uses:".`,
      rule: 'step.ambiguousShorthand',
    }
  }

  const shorthands = kinds
    .filter((candidate) => candidate.sugarKey !== undefined)
    .map((candidate) => `"${candidate.sugarKey}:" for ${candidate.id}`)
  return {
    error:
      `A step must name its kind with "uses:"` +
      (shorthands.length > 0 ? `, or use a shorthand (${shorthands.join(', ')})` : '') +
      '.',
    rule: 'step.missingKind',
  }
}

/** Parse a list of steps, collecting every problem rather than stopping at the first. */
export function parseSteps(
  input: unknown,
  host: CapabilityLookup,
  where: { file?: string; prefix?: readonly (string | number)[] } = {},
): { steps: Step[]; problems: Problem[] } {
  const base = where.prefix ?? ['steps']
  if (!Array.isArray(input)) {
    return {
      steps: [],
      problems: [
        {
          severity: 'error',
          message: 'steps must be a list',
          ...(where.file === undefined ? {} : { file: where.file }),
          field: base.join('.'),
          rule: 'step.notAList',
        },
      ],
    }
  }

  const steps: Step[] = []
  const problems: Problem[] = []
  input.forEach((entry, index) => {
    const result = parseStep(entry, host, {
      index,
      ...(where.file === undefined ? {} : { file: where.file }),
      prefix: [...base, index],
    })
    if (result.step) steps.push(result.step)
    problems.push(...result.problems)
  })
  return { steps, problems }
}

/** Build a step-kind capability. Used by the built-ins and by plugins alike. */
export function defineStepKind(kind: StepKindCapability): StepKindCapability {
  return kind
}

export { closedWithExtensions }

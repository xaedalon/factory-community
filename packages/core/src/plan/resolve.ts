import type { CapabilityLookup } from '../host.js'
import type { Problem } from '../problems.js'
import { isClean } from '../problems.js'
import {
  STEP_KIND,
  isPlanFailure,
  type AgentSettings,
  type PlannedStep,
  type Step,
  type StepKindCapability,
} from '../schema/step.js'
import { PROVIDER_KIND, checkAgentStep, type ProviderCapability } from '../providers/capability.js'
import { isAgentStep, type AgentStep } from '../builtins/steps.js'
import type { Approval, Phase } from '../schema/phase.js'
import type { Profile } from '../schema/profile.js'
import { artifactFile, artifactsRoot, joinPath } from '../task/paths.js'
import type {
  Scheduling,
  Workflow,
  WorkflowMode,
  WorkflowReliability,
} from '../schema/workflow.js'
import { substituteDeep, type VariableScope } from './variables.js'
import {
  lexicalCanonical,
  outsideWorkspaceMessage,
  withinWorkspace,
  type Canonicalise,
} from '../security/boundary.js'
import { DEFAULT_PROFILE, isConfined, type ExecutionProfile } from '../security/profile.js'
import { blankProjectTokens, blankTaskTokens } from './tokens.js'

/**
 * Turn definitions into something that could actually be run.
 *
 * Resolution only -- nothing is executed here. That separation is what makes
 * the plan checkable: `factory doctor` and `--dry-run` produce exactly what a
 * run would, without side effects.
 *
 * It also keeps the schema honest. A field nothing can consume is a field that
 * does not work, however cleanly it validates -- which is precisely how the
 * prototype ended up with a documented `working_dir` that no code ever read.
 * Every field in the schema has to survive the trip to here.
 */

export interface TaskContext {
  readonly uuid?: string
  readonly name?: string
  /** What the task is for, as `{{ task.description }}`. Empty when unwritten. */
  readonly description?: string
  readonly ticketId?: string
  readonly branch?: string
  readonly directory?: string
  /**
   * Absolute directory this task's artifacts go in, as `{{ task.artifacts }}`.
   *
   * A step that *writes* an artifact is told the path by Factory. A step that
   * *reads* one written earlier has to say it, and this is how — the token
   * grammar is two segments, so it is one flat key rather than a namespace.
   */
  readonly artifacts?: string
}

export interface PlanRequest {
  readonly workflow: Workflow
  /** Looks a phase up through whatever chain the caller has. */
  readonly lookupPhase: (name: string) => Phase | undefined
  /** Named agents. Absent means `agent:` on a step cannot be resolved. */
  readonly lookupAgent?: (name: string) => AgentSettings | undefined
  /** Absolute directory this task's artifacts go in. Defaults beside the workspace. */
  readonly artifacts?: string
  readonly host: CapabilityLookup
  /** Absolute directory steps run in unless a phase overrides it. */
  readonly workspace: string
  readonly task?: TaskContext
  readonly project?: Readonly<Record<string, string>>
  /** Provider for agent steps that do not name one. */
  readonly defaultProvider?: string
  /**
   * The agent session this plan's steps share.
   *
   * `started` is what decides whether the first agent step *starts* the session
   * or *continues* one that is already there — the two are different commands
   * for a CLI that refuses to create an id twice. Absent means plan without a
   * session at all, which is what a preview and an in-memory plan get.
   */
  readonly session?: { readonly id: string; readonly started: boolean }
  /**
   * How much authority this run gets. Defaults to `default`.
   *
   * Read here for one reason: a phase may name a working directory, and whether
   * a directory outside the workspace is a refusal or a warning is the profile's
   * decision. Everything else the profile affects is decided at render time.
   */
  readonly profile?: ExecutionProfile
  /**
   * The profile's definition, when it is a custom one.
   *
   * Resolved by whoever has a scope chain — core cannot read one. Absent under a
   * built-in profile, which is every run that has not chosen otherwise.
   */
  readonly profileDefinition?: Profile
  /**
   * How to resolve a path before comparing it to the workspace.
   *
   * Defaults to the lexical one, so planning still needs no filesystem —
   * `--dry-run`, a preview and an in-memory plan all get the `..` check. A
   * caller that has a filesystem passes `systemCanonical` and also gets
   * symlinks.
   */
  readonly canonical?: Canonicalise
  /**
   * Directories outside the workspace this task's agents may reach.
   *
   * The project's standing grants — what "allow for this project" left behind.
   * Threaded to each step's planner, which adds whatever it needs of its own:
   * the agent kind adds the artifacts root, which lives under the project
   * rather than the worktree and would otherwise be refused.
   */
  readonly allowedDirectories?: readonly string[]
}

export interface ResolvedStep {
  readonly index: number
  readonly uses: string
  readonly planned: PlannedStep
  /**
   * The document this step promised, and where it goes.
   *
   * Worked out here, where the artifacts root and the step are both in scope,
   * and carried so the engine does not have to derive it a second time — two
   * derivations of one path is how the agent gets told one thing and the
   * collector looks somewhere else.
   */
  readonly artifact?: { readonly name: string; readonly path: string }
  /**
   * The step as written, after variables were substituted.
   *
   * Carried because the fields core owns — `retries`, `retry_delay` — are read
   * by the runner, and re-deriving them from the planned command is impossible.
   */
  readonly raw: Step
}

export interface ResolvedPhase {
  readonly name: string
  readonly approval: Approval
  readonly cwd: string
  readonly steps: readonly ResolvedStep[]
}

export interface ResolvedPlan {
  readonly workflow: string
  /**
   * How much authority this plan's steps get.
   *
   * Carried on the plan rather than passed separately to the runner, because a
   * plan and the profile it was resolved under belong together: the phase
   * boundary check above already used it, the runner filters the environment
   * with it, and the run records it. One value, one source, three readers.
   */
  readonly profile: ExecutionProfile
  readonly mode: WorkflowMode
  readonly interval?: number
  /** Iterations before a loop is finished. Absent means until stopped. */
  readonly repeat?: number
  readonly scheduling: Scheduling
  /** Flags that must hold before this runs. Checked by the scheduler. */
  readonly requires: readonly string[]
  /** Flags set on the task when this run completes. */
  readonly provides: readonly string[]
  /** Flags cleared from the task when this run completes. */
  readonly clears: readonly string[]
  readonly onFail?: string
  /**
   * What the workflow said it contributes to reliability, carried through.
   *
   * A schema field nothing consumes is a defect here, and this is where it is
   * consumed: the engine hands it to whoever judges the run.
   */
  readonly reliability?: WorkflowReliability
  readonly phases: readonly ResolvedPhase[]
}

export interface PlanResult {
  /** Absent when anything blocked planning. Warnings alone do not block. */
  readonly plan?: ResolvedPlan
  readonly problems: readonly Problem[]
}

export function resolvePlan(request: PlanRequest): PlanResult {
  const { workflow, lookupPhase, lookupAgent, host, workspace } = request
  const profile = request.profile ?? DEFAULT_PROFILE
  const canonical = request.canonical ?? lexicalCanonical
  // One answer for the whole plan, so every step agrees about where artifacts
  // go — including the fallback, which two separate derivations could disagree
  // on the moment one of them forgot it existed.
  const artifacts = request.artifacts ?? artifactsRoot(workspace, 'local', join)
  const problems: Problem[] = []
  const phases: ResolvedPhase[] = []

  const kinds = new Map(
    host.list<StepKindCapability>(STEP_KIND).map((entry) => [entry.capability.id, entry.capability]),
  )

  /**
   * Whether the session is there to be continued by the time this step runs.
   *
   * Starts as whatever the caller said and turns true after the first step
   * that emits a starting flag. It has to be decided at plan time rather than
   * as the run goes: a plan is resolved once, up front, so by the time the
   * second phase starts there is nothing left to ask.
   *
   * Which makes the ordering a promise this function is keeping — the first
   * agent step of the plan is the one that starts the session, and a run that
   * never reaches it never records one, because a failed spawn stops the run
   * before any later step.
   */
  let sessionExists = request.session?.started ?? false

  for (const phaseName of workflow.phases) {
    const phase = lookupPhase(phaseName)
    if (phase === undefined) {
      problems.push({
        severity: 'error',
        message: `Workflow "${workflow.name}" lists a phase "${phaseName}" that does not exist.`,
        field: 'phases',
        rule: 'plan.missingPhase',
      })
      continue
    }

    const scope: VariableScope = {
      // Every documented key, then whatever the caller knows, then the one
      // value this function derives.
      //
      // `artifacts` comes last deliberately: it is the same string the wrapper
      // tells the agent to write to, and a second source for it is how the
      // prompt and the collector came to name different files once already.
      // There is one derivation, and both halves read it.
      task: asStrings({ ...blankTaskTokens(), ...(request.task ?? {}), artifacts }),
      // The same floor the task namespace has had since it was needed. Without
      // it a foreground run left `{{ project.check }}` in the command as
      // literal text, which is neither the project's gate nor a failure worth
      // reading.
      project: { ...blankProjectTokens(), ...(request.project ?? {}) },
      workflow: workflow.variables,
      phase: phase.variables,
      // Phase values win over workflow values, which win over project values.
      variables: {
        ...blankProjectTokens(),
        ...request.project,
        ...workflow.variables,
        ...phase.variables,
      },
    }

    const cwd = phase.workingDir === undefined ? workspace : join(workspace, phase.workingDir)

    // A phase may say where its steps run, and until now nothing checked where
    // that was. `joinPath` lets an absolute part restart the path — so
    // `working_dir: /tmp` ran in `/tmp`, with the workspace discarded — and a
    // `..` climb was never normalised. The schema is `z.string().min(1)`, so
    // neither was caught anywhere.
    //
    // An error rather than a clamp: silently rewriting somebody's `working_dir`
    // to somewhere they did not name would run their steps in the wrong
    // directory, and a workflow that meant it should hear so. Under Full
    // Access it is their stated choice, so it is a warning and it runs.
    if (phase.workingDir !== undefined && !withinWorkspace(cwd, workspace, canonical)) {
      problems.push({
        severity: isConfined(profile) ? 'error' : 'warning',
        message: outsideWorkspaceMessage(
          `The working directory of phase "${phaseName}"`,
          canonical(cwd),
          canonical(workspace),
        ),
        field: `${phaseName}.working_dir`,
        rule: 'plan.outsideWorkspace',
      })
    }
    const steps: ResolvedStep[] = []

    phase.steps.forEach((step, index) => {
      const field = `${phaseName}.steps.${index}`
      const substituted = substituteDeep(step, scope, { field })
      problems.push(...substituted.problems)

      const kind = kinds.get(step.uses)
      if (kind === undefined) {
        problems.push({
          severity: 'error',
          message: `Step kind "${step.uses}" is not installed, so this step cannot run.`,
          field,
          rule: 'plan.unknownKind',
        })
        return
      }
      if (kind.plan === undefined) {
        problems.push({
          severity: 'error',
          message:
            `Step kind "${step.uses}" can be written but not run — the plugin that provides ` +
            `it does not implement a planner.`,
          field,
          rule: 'plan.notRunnable',
        })
        return
      }

      // Warn about settings the chosen agent will silently ignore, before the
      // run rather than during it.
      if (isAgentStep(substituted.value)) {
        problems.push(...providerWarnings(substituted.value, host, request, field))
      }

      const planned = kind.plan(substituted.value as Step, {
        host,
        cwd,
        artifacts,
        profile,
        ...(request.profileDefinition === undefined
          ? {}
          : { profileDefinition: request.profileDefinition }),
        ...(request.allowedDirectories === undefined
          ? {}
          : { allowedDirectories: request.allowedDirectories }),
        ...(lookupAgent === undefined ? {} : { lookupAgent }),
        ...(request.defaultProvider === undefined ? {} : { defaultProvider: request.defaultProvider }),
        ...(request.session === undefined
          ? {}
          : { sessionId: request.session.id, resumeSession: sessionExists }),
      })

      if (isPlanFailure(planned)) {
        problems.push(...planned.problems.map((problem) => ({ ...problem, field })))
        return
      }
      // Read off what the provider reported rather than assumed from the step
      // kind: a shell step never starts one, and an agent step whose provider
      // has no session support does not either.
      if (planned.session?.creates === true) sessionExists = true

      const named = (substituted.value as { artifact?: unknown }).artifact
      steps.push({
        index,
        uses: step.uses,
        planned,
        raw: substituted.value as Step,
        ...(typeof named === 'string' && named !== ''
          ? { artifact: { name: named, path: artifactFile(artifacts, named, join) } }
          : {}),
      })
    })

    phases.push({ name: phase.name, approval: phase.approval, cwd, steps })
  }

  // A plan that would run nothing is refused rather than executed.
  //
  // It used to be executed, and it looked exactly like success: `runPlan` walks
  // zero phases, returns `completed`, and the run lands in the database three
  // milliseconds later with no steps and no artifact. A supervised run of ten
  // tasks had a `design` workflow shaped like this on every one of them —
  // `phases: []`, which the schema accepts — and the board showed a tick beside
  // work that had not happened.
  //
  // Counted in steps rather than phases, so a workflow listing only phases that
  // are themselves empty is caught by the same check. Both are the same claim:
  // there is nothing here to run, and saying so is the only honest outcome.
  //
  // An error, so it takes the path a missing phase already takes — no plan, a
  // run recorded `refused`, and the task blocked with a reason somebody can act
  // on.
  if (phases.every((phase) => phase.steps.length === 0)) {
    problems.push({
      severity: 'error',
      message:
        `Workflow "${workflow.name}" has nothing to run: ` +
        (workflow.phases.length === 0
          ? 'it lists no phases.'
          : `every phase it lists (${workflow.phases.join(', ')}) has no steps.`),
      field: 'phases',
      rule: 'plan.nothingToRun',
    })
  }

  if (!isClean(problems)) return { problems }

  return {
    plan: {
      workflow: workflow.name,
      profile,
      mode: workflow.mode,
      ...(workflow.interval === undefined ? {} : { interval: workflow.interval }),
      ...(workflow.repeat === undefined ? {} : { repeat: workflow.repeat }),
      scheduling: workflow.scheduling,
      requires: workflow.conditions?.requires ?? [],
      provides: workflow.conditions?.provides ?? [],
      clears: workflow.conditions?.clears ?? [],
      ...(workflow.onFail === undefined ? {} : { onFail: workflow.onFail }),
      ...(workflow.reliability === undefined ? {} : { reliability: workflow.reliability }),
      phases,
    },
    problems,
  }
}

function providerWarnings(
  step: AgentStep,
  host: CapabilityLookup,
  request: PlanRequest,
  field: string,
): Problem[] {
  const wanted = step.provider ?? request.defaultProvider
  const installed = host.list<ProviderCapability>(PROVIDER_KIND).map((entry) => entry.capability)
  const provider =
    wanted !== undefined
      ? installed.find((candidate) => candidate.id === wanted)
      : installed.length === 1
        ? installed[0]
        : undefined

  if (provider === undefined) return []
  return checkAgentStep(provider, step).map((problem) => ({
    ...problem,
    field: problem.field === undefined ? field : `${field}.${problem.field}`,
  }))
}

const asStrings = (value: Readonly<Record<string, unknown>>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined && entry !== null)
      .map(([key, entry]) => [key, String(entry)]),
  )

/** The shared one, so this module cannot disagree with the path helpers. */
const join = joinPath

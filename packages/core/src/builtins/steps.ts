import { z } from 'zod'
import type { FactoryPlugin } from '../host.js'
import { closedWithExtensions, slug, variables } from '../schema/common.js'
import {
  defineStepKind,
  STEP_KIND,
  type PlanFailure,
  type PlanStepContext,
  type PlannedStep,
  type Step,
  type StepKindCapability,
} from '../schema/step.js'
import {
  PROVIDER_KIND,
  type ProviderCapability,
  type RenderRequest,
} from '../providers/capability.js'
import {
  permissionArgsFor,
  profileWideningArgs,
  type ProviderDescriptor,
} from '../providers/descriptor.js'
import { DEFAULT_PROFILE, type ExecutionProfile } from '../security/profile.js'
import { worktreeStepKind } from './worktree.js'
import type { Problem } from '../problems.js'
import { MODEL_ROLES, type ModelRole } from '../model-roles.js'
import { artifactFile, artifactsRoot, joinPath } from '../task/paths.js'

/**
 * The two step kinds Factory ships with, registered through the same plugin
 * contract a third party uses.
 *
 * This is the dogfooding rule in practice: if `shell` and `agent` could not be
 * expressed as ordinary registered capabilities, the extension API would be
 * wrong, and we would find out now rather than when someone tries to add
 * `uses: http`.
 */

// ---------------------------------------------------------------- shell

export interface ShellStep extends Step {
  readonly uses: 'shell'
  /** A command line, run through bash. */
  readonly run: string
}

/**
 * No per-step working directory, deliberately.
 *
 * There used to be a `working_dir` here, documented as overriding the phase's
 * directory for one step. It was parsed, round-tripped into the file and given
 * a control in the builder, and it did nothing at all: `plan()` never read it,
 * `PlannedStep` has no cwd, and the runner always spawns in `phase.cwd`. That
 * is the exact failure this codebase keeps warning about — a field that
 * validates and lies.
 *
 * Deleted rather than implemented, because where a step runs is not a step's
 * decision to make. The daemon already answers it: a worktree when the project
 * uses them, the project's own directory when it does not. A phase may still
 * set `working_dir` to move all of its steps somewhere relative to that.
 */
const shellSchema = closedWithExtensions({
  run: z.string().min(1, 'run must be a non-empty command'),
})

export const shellStepKind: StepKindCapability = defineStepKind({
  id: 'shell',
  displayName: 'Shell command',
  summary: 'Runs a command with bash.',
  schema: shellSchema,
  // Lets `- run: npm test` stand on its own, which is most steps.
  sugarKey: 'run',
  plan(step): PlannedStep | PlanFailure {
    const shell = step as ShellStep
    // `bash -c ''` exits 0. A step that resolved to nothing would therefore be
    // a tick beside work that never happened — the exact shape of every defect
    // on this branch. The schema cannot catch it: `run` is non-empty in the
    // file and becomes empty during substitution, which is what
    // `{{ project.check }}` does on a project that has never set one.
    if (shell.run.trim() === '') {
      return {
        problems: [
          {
            severity: 'error',
            message:
              'This step has no command to run. A `{{ … }}` in it resolved to nothing — most ' +
              'often `{{ project.check }}` on a project that has not been given a check command.',
            field: 'run',
            rule: 'plan.emptyCommand',
          } satisfies Problem,
        ],
      }
    }
    // A shell step genuinely wants a shell -- pipes, globs and && are the point.
    return { describe: shell.run, command: 'bash', args: ['-c', shell.run] }
  },
})

export const isShellStep = (step: Step): step is ShellStep => step.uses === 'shell'

// ---------------------------------------------------------------- agent

/** How much context an agent carries between steps. */
export const SESSION_SCOPES = ['task', 'workflow', 'phase', 'none'] as const
export type SessionScope = (typeof SESSION_SCOPES)[number]

export interface AgentStep extends Step {
  readonly uses: 'agent'
  /** Required, and non-empty. */
  readonly prompt: string
  /**
   * A named agent definition supplying the settings below.
   *
   * `- agent: developer` is the shorthand, the same way `- run: …` is shorthand
   * for a shell step. Anything the step also states wins over what the agent
   * says, so one phase can borrow an agent and raise its effort without a
   * second agent existing for the purpose.
   */
  readonly agent?: string
  /**
   * A document this step produces, by name.
   *
   * Always Markdown and always in the task's own artifacts directory, so a
   * name is the whole of it — `analysis` becomes `analysis.md`. Factory works
   * out the path and tells the agent, which is the only way the promise can be
   * kept: the path is derived, so nobody could have written it into the prompt
   * themselves.
   */
  readonly artifact?: string
  /** Omit to use the provider resolved from configuration. */
  readonly provider?: string
  readonly model?: ModelRole | string
  readonly effort?: string
  /** A named sub-agent or persona, mapped per provider. */
  readonly subagent?: string
  readonly session?: SessionScope
  /** Extra arguments appended verbatim to the rendered command. */
  readonly args?: readonly string[]
}

/**
 * A field an agent can answer for, optionally drawing on a named catalogue.
 *
 * Written once rather than repeated six times, so the two pieces of metadata
 * cannot drift apart field by field.
 */
const superseded = <T extends z.ZodType>(schema: T, options?: string): T =>
  schema.meta({
    'x-supersededBy': 'agent',
    ...(options === undefined ? {} : { 'x-options': options }),
  }) as T

const agentSchema = closedWithExtensions({
  // The single most important line in this file. The prototype dropped an agent
  // block whose prompt was missing or blank, so the phase ran nothing at all
  // and reported success. Here it is an error that names the field.
  prompt: z
    .string()
    .min(1, 'prompt is required — an agent step with no prompt would do nothing'),
  // `x-options` names a catalogue the builder fills at render time. A static
  // enum cannot express these: which agents exist depends on the scope chain,
  // and which providers exist depends on what is installed.
  agent: slug('agent').optional().meta({ 'x-options': 'agents' }),
  // A name, not a path. `analysis.md` and `../escape` are both errors that say
  // so, rather than a file somewhere nobody meant.
  artifact: slug('artifact').optional(),
  // `x-supersededBy` says who else can answer for this field. Naming an agent
  // answers all six, so a form has no business asking for them again — the
  // whole point of an agent is that the step needs only a prompt. They stay
  // valid in the file: a step may still override one deliberately, and a value
  // that is set is never hidden from the person who set it.
  provider: superseded(slug('provider').optional(), 'providers'),
  model: superseded(z.string().min(1).optional(), 'models'),
  effort: superseded(z.string().min(1).optional(), 'effort'),
  subagent: superseded(z.string().min(1).optional()),
  session: superseded(z.enum(SESSION_SCOPES).optional()),
  args: superseded(z.array(z.string()).optional()),
})

export const agentStepKind: StepKindCapability = defineStepKind({
  id: 'agent',
  displayName: 'AI agent',
  summary: 'Runs a prompt through a coding agent such as Claude Code, Codex or Copilot.',
  schema: agentSchema,
  // `- agent: developer` stands on its own, the way `- run: …` does.
  sugarKey: 'agent',
  plan(step, context): PlannedStep | PlanFailure {
    const settings = withNamedAgent(step as AgentStep, context)
    if ('problems' in settings) return settings
    const agent = settings.step
    const chosen = chooseProvider(agent, context)
    if ('problems' in chosen) return chosen

    // Before the command is rendered, because the whole point is that this
    // argv is never built. `args` is appended *after* `permissionArgs`, so an
    // agent file saying `args: ['--permission-mode', 'bypassPermissions']`
    // used to get Full Access under the Default profile by editing a file in
    // the repository the agent can write to — no setting changed, nothing
    // said. Refusing at plan time means the run is recorded `refused` and the
    // task blocked with a reason, which is the loud path a bad definition
    // already takes.
    const widening = profileWideningArgs(
      chosen.provider.descriptor,
      context.profile ?? DEFAULT_PROFILE,
      agent.args ?? [],
    )
    if (widening.length > 0) {
      const profile = context.profile ?? DEFAULT_PROFILE
      return {
        problems: [
          {
            severity: 'error',
            message:
              `This step passes ${widening.map((argument) => `"${argument}"`).join(', ')} to ` +
              `${chosen.provider.id}, which decides authority rather than asking for it: ` +
              `arguments are appended after the flags that confine the agent, so the ` +
              `${profile} profile refuses them. ` +
              alreadyPassed(chosen.provider.descriptor, profile, widening) +
              `Run the command in a \`shell\` step, which an agent's allow-list does not govern, ` +
              `or run this project under Full Access if the agent itself needs it.`,
            field: 'args',
            rule: 'plan.argsWidenProfile',
          } satisfies Problem,
        ],
      }
    }

    const request: RenderRequest = {
      prompt: withArtifactInstruction(agent, context),
      ...(agent.model === undefined ? {} : { model: agent.model }),
      ...(agent.effort === undefined ? {} : { effort: agent.effort }),
      ...(agent.subagent === undefined ? {} : { subagent: agent.subagent }),
      ...(agent.session === undefined ? {} : { session: agent.session }),
      ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
      ...(context.resumeSession === undefined ? {} : { resumeSession: context.resumeSession }),
      ...(agent.args === undefined ? {} : { args: agent.args }),
      ...(context.profile === undefined ? {} : { profile: context.profile }),
      // The artifacts root, because it is deliberately *not* inside the
      // workspace: it lives under the project so that an artifact outlives the
      // worktree that produced it. A confined agent told to write there needs
      // to be given the directory, or the first thing the Default profile does
      // is refuse the document it just asked for.
      // The artifacts root first, because it is the one this kind knows it
      // needs; then whatever the project granted. De-duplicated, so a project
      // that granted its own artifacts directory does not produce the flag
      // twice.
      allowedDirectories: [
        ...new Set([artifactsRootFor(context), ...(context.allowedDirectories ?? [])]),
      ],
    }
    const rendered = chosen.provider.render(request)

    // `rendered.session` is the provider saying it put a session flag in — and
    // whether that flag starts one or continues one. A step with
    // `session: none`, or a provider with no session support, reports nothing,
    // which is what keeps the engine from recording an id nothing created.
    const starts = rendered.session !== undefined && !rendered.session.resumed

    // Rendered a second time, as the *resuming* command, for the retry: a
    // command that starts a session cannot be run twice — the CLI refuses the
    // id — so a second attempt has to continue it instead. Only the starting
    // step needs this, and only the provider knows which of its flags means
    // what.
    const resuming = starts ? chosen.provider.render({ ...request, resumeSession: true }) : undefined

    // From the prompt as written, never the wrapped one. This is what the run
    // timeline, the step row and `--dry-run` all show, and Factory's own
    // sentence appearing in every one of them would be its own small lie.
    const summary = agent.prompt.split('\n')[0] ?? agent.prompt
    return {
      describe: `${chosen.provider.id}: ${summary.slice(0, 72)}`,
      command: rendered.command,
      args: rendered.args,
      env: rendered.env,
      ...(rendered.passEnv === undefined ? {} : { passEnv: rendered.passEnv }),
      ...(rendered.denialPatterns === undefined
        ? {}
        : { denialPatterns: rendered.denialPatterns }),
      // Off the capability rather than the rendered command: a reader belongs
      // to the CLI, not to one invocation of it. The provider that has none
      // contributes nothing and its output is read as text, which is what every
      // provider did before this existed.
      ...(chosen.provider.stream === undefined ? {} : { stream: chosen.provider.stream }),
      ...(rendered.stdin === undefined ? {} : { stdin: rendered.stdin }),
      ...(resuming === undefined ? {} : { retryArgs: resuming.args }),
      ...(rendered.session === undefined
        ? {}
        : {
            session: {
              id: rendered.session.id,
              provider: chosen.provider.id,
              creates: starts,
            },
          }),
    }
  },
})

/**
 * Tell the agent where its artifact goes.
 *
 * Appended rather than prepended, and after a rule, so the author's prompt is
 * still the first thing read — by the agent and by anyone looking at the
 * rendered command. The prompt is a single argv element with no shell anywhere
 * in the path, so a multi-line append needs no quoting and no provider has to
 * know this happened.
 */
function withArtifactInstruction(step: AgentStep, context: PlanStepContext): string {
  if (step.artifact === undefined) return step.prompt

  const path = artifactFile(artifactsRootFor(context), step.artifact, joinPath)
  return [
    step.prompt,
    '',
    '---',
    `Write your output to ${path}`,
    'It must be Markdown. Create it if it does not exist, and replace its contents rather than',
    'appending to them. Write nothing else into that directory.',
  ].join('\n')
}

/**
 * Where this step's artifacts go.
 *
 * A task's own directory when there is a task, and a shared `local` one when
 * there is not — `factory run` and the builder's plan preview both plan without
 * one, and a preview that quietly differs from the real command is worse than a
 * predictable fallback.
 */
const artifactsRootFor = (context: PlanStepContext): string =>
  context.artifacts ?? artifactsRoot(context.cwd, 'local', joinPath)

/**
 * Fold a named agent's settings into the step.
 *
 * The step wins wherever it says something, which is the same precedence the
 * provider already follows — step, then configuration, then the only one
 * installed — so there is one rule to learn rather than two. A step naming an
 * agent nobody defined is an error here rather than a silent fallback: it
 * asked for something specific and did not get it.
 */
function withNamedAgent(
  step: AgentStep,
  context: PlanStepContext,
): { step: AgentStep } | PlanFailure {
  if (step.agent === undefined) return { step }

  const found = context.lookupAgent?.(step.agent)
  if (found === undefined) {
    return {
      problems: [
        {
          severity: 'error',
          message:
            `Unknown agent "${step.agent}". Define it as agents/${step.agent}.agent.yaml in a ` +
            `scope this project can see, or set the provider on the step instead.`,
          field: 'agent',
          rule: 'plan.unknownAgent',
        } satisfies Problem,
      ],
    }
  }

  // Merged field by field rather than by spreading. `{...found, ...step}` would
  // let the step's *absent* keys — which are present and undefined once it has
  // been through the parser — overwrite the agent's values with nothing.
  return {
    step: {
      ...step,
      ...pick('provider', step.provider, found.provider),
      ...pick('model', step.model, found.model),
      ...pick('effort', step.effort, found.effort),
      ...pick('subagent', step.subagent, found.subagent),
      ...pick('session', step.session, found.session),
      ...pick('args', step.args, found.args),
    } as AgentStep,
  }
}

/** The step's value if it has one, else the agent's, else nothing at all. */
const pick = <T>(key: string, fromStep: T | undefined, fromAgent: T | undefined) => {
  const value = fromStep ?? fromAgent
  return value === undefined ? {} : { [key]: value }
}

/**
 * Which agent runs this step.
 *
 * Precedence is step, then configuration, then "the only one installed". That
 * last fallback is what makes a single-agent setup need no configuration at
 * all, and naming a provider on the step is what lets one phase pin a specific
 * agent without pinning the whole factory -- both halves of bring-your-own-AI.
 */
function chooseProvider(
  agent: AgentStep,
  context: PlanStepContext,
): { provider: ProviderCapability } | PlanFailure {
  const installed = context.host
    .list<ProviderCapability>(PROVIDER_KIND)
    .map((entry) => entry.capability)

  const problem = (message: string, rule: string): PlanFailure => ({
    problems: [{ severity: 'error', message, field: 'provider', rule } satisfies Problem],
  })

  if (installed.length === 0) {
    return problem(
      'No agent providers are installed, so an agent step cannot run. Add one — for example ' +
        '@factory/provider-claude — to a scope\'s plugins list.',
      'plan.noProviders',
    )
  }

  const wanted = agent.provider ?? context.defaultProvider
  if (wanted !== undefined) {
    const provider = installed.find((candidate) => candidate.id === wanted)
    if (provider === undefined) {
      return problem(
        `Unknown agent provider "${wanted}". Installed: ${installed.map((p) => p.id).sort().join(', ')}.`,
        'plan.unknownProvider',
      )
    }
    return { provider }
  }

  if (installed.length === 1) return { provider: installed[0] as ProviderCapability }

  return problem(
    `This step does not say which agent to use, and ${installed.length} are installed ` +
      `(${installed.map((p) => p.id).sort().join(', ')}). Set "provider:" on the step, or a ` +
      `default in the scope configuration.`,
    'plan.ambiguousProvider',
  )
}

/**
 * What the profile already passes for the flags a step tried to pass itself.
 *
 * Reported because the common case is not somebody reaching for authority: it
 * is somebody told — by a stale note, or by an agent that read a measurement
 * table as an instruction — that a step needs `--allowedTools 'Bash(pnpm *)'`
 * to run pnpm. The Default profile has passed exactly that since the package
 * managers were measured, and `--allowedTools` is variadic, so the step's copy
 * would have *replaced* the list rather than added to it.
 *
 * A refusal that only says "more authority" and points at Full Access sends
 * that person at the most dangerous lever in the building, when the answer is
 * to delete the line. So: show what is granted, and let them see their own
 * entry in it.
 *
 * Empty when the profile passes nothing for that flag — `--permission-mode` is
 * not in the Default profile's arguments at all, and inventing a line for it
 * would be worse than saying nothing.
 */
function alreadyPassed(
  descriptor: ProviderDescriptor,
  profile: ExecutionProfile,
  widening: readonly string[],
): string {
  const passed = permissionArgsFor(descriptor, profile)
  const shown: string[] = []
  for (const flag of widening) {
    const at = passed.indexOf(flag)
    if (at === -1) continue
    const value = passed[at + 1]
    shown.push(value === undefined || value.startsWith('--') ? flag : `${flag} '${value}'`)
  }
  if (shown.length === 0) return ''
  return (
    `The ${profile} profile already passes ${shown.join(', ')} — ` +
    `if that covers what this step needs, remove the argument. `
  )
}

export const isAgentStep = (step: Step): step is AgentStep => step.uses === 'agent'

export const isModelRole = (model: string): model is ModelRole =>
  (MODEL_ROLES as readonly string[]).includes(model)

// ---------------------------------------------------------------- plugin

export const builtinStepsPlugin: FactoryPlugin = {
  name: '@factory/core/builtin-steps',
  version: '0.1.0',
  register(context) {
    context.provide(STEP_KIND, shellStepKind)
    context.provide(STEP_KIND, agentStepKind)
    context.provide(STEP_KIND, worktreeStepKind)
  },
}

export { variables }

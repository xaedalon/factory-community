import { commandAvailability, type Availability } from './discover.js'
import type { Capability } from '../capabilities.js'
import type { Problem } from '../problems.js'
import type { AgentStep, SessionScope } from '../builtins/steps.js'
import { MODEL_ROLES } from '../model-roles.js'
import {
  NO_GRANTS,
  commandArgsFor,
  permissionArgsFor,
  type ProfileGrants,
  type ProviderDescriptor,
  type ProviderFeature,
} from './descriptor.js'
import { DEFAULT_PROFILE, isConfined, type ExecutionProfile } from '../security/profile.js'
import type { DenialPattern } from '../security/denials.js'
import type { StreamReaderFactory } from './stream.js'

export const PROVIDER_KIND = 'provider'

/**
 * A rendered command, as argv rather than a shell string.
 *
 * The prototype built a command line by concatenating strings and then handed it to
 * `bash -c`, which means every prompt containing a quote is a latent quoting
 * bug. An agent step has no reason to involve a shell at all — the arguments
 * are known, so pass them directly.
 */
export interface RenderedCommand {
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  /** A file to redirect into stdin; several CLIs hang headless without it. */
  readonly stdin?: string
  /**
   * Environment variables this CLI needs even under a confined profile.
   *
   * Straight off the descriptor. Carried on the rendered command so it travels
   * with the step to the runner, which is the thing that builds the
   * environment — the alternative is the runner looking a provider up by name,
   * and the runner has no business knowing that providers exist.
   */
  readonly passEnv?: readonly string[]
  /** What a refusal from this CLI looks like. Straight off the descriptor. */
  readonly denialPatterns?: readonly DenialPattern[]
  /**
   * The session this command deals in, when it actually put a flag in for one.
   *
   * Reported rather than inferred. Whether a session flag went into the argv
   * depends on the step's scope, on whether an id was supplied, and on what
   * this provider's descriptor says — and the only thing that knows all three
   * is the code that just decided. A caller working it out for itself would be
   * a second implementation of `sessionArgs`, and the wrong one would be the
   * one nobody reads.
   */
  readonly session?: { readonly id: string; readonly resumed: boolean }
}

export interface RenderRequest {
  readonly prompt: string
  /** A role (strong/balanced/fast) or a literal model id. */
  readonly model?: string
  readonly effort?: string
  readonly subagent?: string
  readonly session?: SessionScope
  /** Identity for the session scope, supplied by whoever planned the step. */
  readonly sessionId?: string
  /**
   * Whether the session named by `sessionId` already exists.
   *
   * False — the default — renders the command that *starts* it. The two are
   * different commands for a CLI that refuses to create an id twice, so this
   * is not a detail a caller can leave to chance: guess wrong and the run
   * fails with "already in use" or "no conversation found with session ID".
   * Both are loud, which is the one mercy.
   */
  readonly resumeSession?: boolean
  readonly args?: readonly string[]
  /**
   * How much authority this invocation gets. Defaults to `default`.
   *
   * Selects which `permissionArgs` the descriptor contributes, and nothing
   * else. A provider never learns why the profile is what it is.
   */
  readonly profile?: ExecutionProfile
  /**
   * Directories outside the working directory this agent legitimately needs.
   *
   * In practice: the task's artifacts root, which lives under the *project*
   * rather than the worktree by design. A confined agent told to write there is
   * being told to write outside its own working directory, so unless the CLI is
   * given the directory explicitly, the Default profile refuses every artifact
   * a worktree project ever promised.
   *
   * Emitted with the descriptor's `directoryFlag`, and only under a confined
   * profile — under Full Access there is nothing to grant.
   */
  readonly allowedDirectories?: readonly string[]
  /**
   * What a custom profile adds, already resolved for this provider.
   *
   * Absent under a built-in profile, which is every run that has not chosen
   * one. Resolved by whoever planned the step, because that is what knows which
   * provider is about to run and therefore which share of the profile's
   * `providers:` map applies.
   */
  readonly grants?: ProfileGrants
}

export interface ProviderCapability extends Capability {
  readonly descriptor: ProviderDescriptor
  readonly supports: (feature: ProviderFeature) => boolean
  readonly resolveModel: (model: string | undefined) => string | undefined
  readonly render: (request: RenderRequest) => RenderedCommand
  /** Is the executable actually here? Takes the environment explicitly. */
  readonly availability: (
    env: Readonly<Record<string, string | undefined>>,
    options?: { extraDirectories?: readonly string[]; configFile?: string },
  ) => Availability
  /**
   * How to read this CLI's structured output, if it emits any.
   *
   * Code rather than data, and on the capability rather than the descriptor,
   * because a transcript format is a parser and a parser is not expressible in
   * YAML. It sits here rather than in its own capability kind for one reason: a
   * reader without the provider whose output it reads is meaningless, and a
   * separate kind would make that pairing something to get wrong.
   *
   * Absent means "read the output as text", which is every provider that has
   * not been measured. Degrading by absence, as everywhere else here.
   */
  readonly stream?: StreamReaderFactory
}

/**
 * How a person opens a recorded session again, by hand.
 *
 * The same `resumeFlag` a run uses, out of the same descriptor, so the command
 * offered on a task page cannot drift from the one the engine would render. It
 * is the reason Factory chooses session ids at all: `--continue` resumes "the
 * most recent conversation here", which interactive Claude will not do for a
 * session `claude -p` created, and which is the wrong conversation anyway once
 * two tasks share a directory.
 *
 * Undefined when this provider has no way to resume by id — which cannot
 * happen for a session it recorded, but a descriptor can be edited between the
 * run and the asking.
 */
export function resumeById(
  descriptor: ProviderDescriptor,
  sessionId: string,
): { command: string; args: readonly string[] } | undefined {
  const { mode, idFlag, resumeFlag } = descriptor.session
  if (mode !== 'id') return undefined
  const flag = resumeFlag ?? idFlag
  if (flag === undefined) return undefined
  return { command: descriptor.command, args: [flag, sessionId] }
}

export function providerFromDescriptor(descriptor: ProviderDescriptor): ProviderCapability {
  const supported = new Set(descriptor.supports)
  return {
    id: descriptor.id,
    displayName: descriptor.displayName,
    summary: descriptor.summary,
    descriptor,
    supports: (feature) => supported.has(feature),
    resolveModel: (model) => resolveModel(descriptor, model),
    render: (request) => render(descriptor, request),
    availability: (env, options) => availability(descriptor, env, options),
  }
}

/** A role maps through the descriptor; anything else is a literal id. */
export function resolveModel(
  descriptor: ProviderDescriptor,
  model: string | undefined,
): string | undefined {
  if (model === undefined) return undefined
  if ((MODEL_ROLES as readonly string[]).includes(model)) {
    return descriptor.models[model as (typeof MODEL_ROLES)[number]]
  }
  return model
}

/**
 * The confined list with the flags a profile is about to re-issue taken out.
 *
 * `commandArgsFor` folds what the profile allows *into* what the profile
 * already allowed and emits one flag. Leaving the original in place would emit
 * two, and for a variadic option the second replaces the first — so the merge
 * would silently drop exactly the entries it was written to preserve.
 */
function withoutFlagsRewritten(
  args: readonly string[],
  descriptor: ProviderDescriptor,
  grants: ProfileGrants,
): readonly string[] {
  const rewritten = new Set<string>()
  if (grants.commands.length > 0 && descriptor.commandAllowFlag !== undefined) {
    rewritten.add(descriptor.commandAllowFlag)
  }
  if (grants.denyCommands.length > 0 && descriptor.commandDenyFlag !== undefined) {
    rewritten.add(descriptor.commandDenyFlag)
  }
  if (rewritten.size === 0) return args

  const kept: string[] = []
  for (let at = 0; at < args.length; at++) {
    const argument = args[at] as string
    if (rewritten.has(argument)) {
      at++ // its value goes with it
      continue
    }
    kept.push(argument)
  }
  return kept
}

export function render(descriptor: ProviderDescriptor, request: RenderRequest): RenderedCommand {
  const profile = request.profile ?? DEFAULT_PROFILE
  const confined = permissionArgsFor(descriptor, profile)

  // A custom profile's grants are merged **here**, against the confined list
  // that has just been read, because the allow flag may already be in it — and
  // a second copy of a variadic flag replaces the first rather than extending
  // it. This is the only place that holds both halves, so it is the only place
  // that can join them without one silently winning.
  const granted = commandArgsFor(descriptor, request.grants ?? NO_GRANTS, confined)
  const args: string[] = [
    ...withoutFlagsRewritten(confined, descriptor, request.grants ?? NO_GRANTS),
    ...granted,
    ...descriptor.extraArgs,
  ]

  // Before the model and the prompt, so the grant is adjacent to the rest of
  // the authority this argv carries and reads as one decision.
  if (isConfined(profile) && descriptor.directoryFlag !== undefined) {
    for (const directory of request.allowedDirectories ?? []) {
      args.push(descriptor.directoryFlag, directory)
    }
  }

  const model = resolveModel(descriptor, request.model)
  if (model !== undefined && descriptor.modelFlag !== undefined) {
    args.push(descriptor.modelFlag, model)
  }
  if (request.effort !== undefined && descriptor.effortFlag !== undefined) {
    args.push(descriptor.effortFlag, request.effort)
  }
  if (request.subagent !== undefined && descriptor.subagentFlag !== undefined) {
    args.push(descriptor.subagentFlag, request.subagent)
  }
  const session = sessionArgs(descriptor, request)
  args.push(...session.args)

  // The caller's own arguments go before the prompt, because for a CLI that
  // takes the prompt positionally anything after it would be a second operand.
  if (request.args !== undefined) args.push(...request.args)

  if (descriptor.promptFlag !== undefined) args.push(descriptor.promptFlag)
  args.push(request.prompt)

  return {
    command: descriptor.command,
    args,
    env: descriptor.env,
    ...(descriptor.passEnv.length === 0 ? {} : { passEnv: descriptor.passEnv }),
    ...(descriptor.denialPatterns.length === 0
      ? {}
      : { denialPatterns: descriptor.denialPatterns }),
    ...(descriptor.stdin === undefined ? {} : { stdin: descriptor.stdin }),
    ...(session.emitted === undefined ? {} : { session: session.emitted }),
  }
}

/**
 * The session flags, and what they amount to.
 *
 * `emitted` is set exactly when an id-carrying flag went in, so the planner can
 * tell "this command starts a session" from "this command mentions none" without
 * re-deriving any of the conditions above.
 */
function sessionArgs(
  descriptor: ProviderDescriptor,
  request: RenderRequest,
): { args: string[]; emitted?: { id: string; resumed: boolean } } {
  const scope = request.session ?? 'none'
  if (scope === 'none') return { args: [] }

  const { mode, continueArgs, idFlag, resumeFlag } = descriptor.session
  if (mode === 'id') {
    // No id to work with: the caller planned without one — a plugin planning
    // in memory, a preview — and a flag with nothing after it would be worse
    // than no session at all.
    if (request.sessionId === undefined) return { args: [] }
    // `resumeFlag` falls back to `idFlag` for a CLI whose single flag both
    // sets and resumes, which is how Copilot's `--session-id` behaves.
    const resumed = request.resumeSession === true
    const flag = resumed ? (resumeFlag ?? idFlag) : idFlag
    if (flag === undefined) return { args: [] }
    return { args: [flag, request.sessionId], emitted: { id: request.sessionId, resumed } }
  }
  if (mode === 'continue') return { args: [...continueArgs] }
  return { args: [] }
}

/**
 * Check an agent step against the provider that will run it.
 *
 * This is what makes workflows capability-aware. A phase asking to carry a
 * session across steps under an agent that cannot resume one should be caught
 * by `doctor`, not discovered when the second step arrives with no memory of
 * the first.
 */
export function checkAgentStep(provider: ProviderCapability, step: AgentStep): Problem[] {
  const problems: Problem[] = []
  const { descriptor } = provider

  if (step.session !== undefined && step.session !== 'none' && !provider.supports('session_resume')) {
    problems.push({
      severity: 'warning',
      message:
        `"${provider.id}" does not support resuming sessions, so "session: ${step.session}" ` +
        `will have no effect — each step starts fresh.`,
      field: 'session',
      rule: 'provider.sessionUnsupported',
    })
  }

  if (step.effort !== undefined && descriptor.effortFlag === undefined) {
    problems.push({
      severity: 'warning',
      message: `"${provider.id}" has no effort setting, so "effort: ${step.effort}" is ignored.`,
      field: 'effort',
      rule: 'provider.effortUnsupported',
    })
  }

  if (step.subagent !== undefined && descriptor.subagentFlag === undefined) {
    problems.push({
      severity: 'warning',
      message: `"${provider.id}" has no sub-agent setting, so "subagent: ${step.subagent}" is ignored.`,
      field: 'subagent',
      rule: 'provider.subagentUnsupported',
    })
  }

  const model = step.model
  if (model !== undefined && descriptor.modelFlag === undefined) {
    problems.push({
      severity: 'warning',
      message: `"${provider.id}" has no model setting, so "model: ${model}" is ignored.`,
      field: 'model',
      rule: 'provider.modelUnsupported',
    })
  }

  if (descriptor.provisional) {
    problems.push({
      severity: 'warning',
      message:
        `The "${provider.id}" descriptor has not been verified against the real CLI. ` +
        (descriptor.provisionalNote ?? 'Check its flags before relying on it.'),
      rule: 'provider.provisional',
    })
  }

  return problems
}

/**
 * Is this provider's CLI actually installed?
 *
 * The search itself is `commandAvailability`, which is not provider-shaped
 * because a plugin wanted to ask the same question about its own binary. What
 * this adds is the provider's wording: whose command it is, and the one thing
 * that fixes it on any machine — the config key to set.
 */
export function availability(
  descriptor: ProviderDescriptor,
  env: Readonly<Record<string, string | undefined>>,
  options: { extraDirectories?: readonly string[]; configFile?: string } = {},
): Availability {
  return commandAvailability(descriptor.command, env, {
    ...(options.extraDirectories === undefined
      ? {}
      : { extraDirectories: options.extraDirectories }),
    label: descriptor.id,
    hint:
      `If it is installed elsewhere, set providers.${descriptor.id}.command ` +
      `in ${options.configFile ?? 'your Factory config.yaml'} to its full path.`,
  })
}

/**
 * Render argv as a copy-pasteable command line.
 *
 * It began as a printer for `--dry-run` and logs. It is now also how the one
 * unavoidable shell string is built — the line handed to a terminal
 * application, which runs a shell — so the quoting below is load-bearing
 * rather than cosmetic: a workspace path may contain a space or a quote.
 * See `terminalCommand`.
 *
 * Takes only the fields it reads rather than a whole RenderedCommand, so a
 * PlannedStep — which carries the same three — can be passed straight in.
 */
export function toShellString(rendered: {
  readonly command: string
  readonly args: readonly string[]
  readonly stdin?: string | undefined
}): string {
  const parts = [rendered.command, ...rendered.args].map(quote)
  if (rendered.stdin !== undefined) parts.push('<', rendered.stdin)
  return parts.join(' ')
}

const SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/
const quote = (value: string): string =>
  SAFE.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`

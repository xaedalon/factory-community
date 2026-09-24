import { z } from 'zod'
import { closedWithExtensions, slug } from '../schema/common.js'
import {
  DEFAULT_PROFILE,
  isBuiltInProfile,
  isConfined,
  type ExecutionProfile,
} from '../security/profile.js'
import { MODEL_ROLES } from '../model-roles.js'

/**
 * A provider is a descriptor, not a class.
 *
 * Adding support for a new coding agent should be a YAML file, not a code
 * change — which is what provider independence has to mean, and what makes
 * the `generic-cli` story real rather than aspirational. All three
 * built-in providers are descriptors handed to one renderer.
 *
 * It also puts model ids where they belong: in data. They move faster than
 * releases — GitHub retired a set of Copilot ids mid-2026 and the CLI hard-errors
 * on a stale one — so a fix has to be a one-line edit to a file, not a rebuild.
 */

/**
 * What a provider can do. A workflow can then be checked against it before it
 * runs, so "this phase needs to resume a session and this agent cannot" is a
 * `doctor` warning rather than a confusing failure halfway through a run.
 */
export const PROVIDER_FEATURES = [
  'non_interactive',
  'session_resume',
  'streaming',
  'tool_use',
  'file_access',
  'mcp',
  'structured_output',
] as const
export type ProviderFeature = (typeof PROVIDER_FEATURES)[number]

/** How a provider is told to carry context between steps. */
export const SESSION_MODES = ['continue', 'id', 'none'] as const
export type SessionMode = (typeof SESSION_MODES)[number]

const descriptorShape = {
  kind: z.literal('factory.provider/v1').optional(),
  id: slug('id'),
  displayName: z.string().min(1),
  summary: z.string().default(''),
  /** The executable. Looked up on PATH unless it is an absolute path. */
  command: z.string().min(1),
  /**
   * How a person installs this agent, and where its documentation is.
   *
   * Data, like the flags, and for the same reason: an install command changes
   * when a vendor renames a package, and that should be an edit to a YAML file
   * rather than a release. Both are optional — a descriptor that does not know
   * is better than one that guesses.
   */
  install: z.string().min(1).optional(),
  docs: z.string().min(1).optional(),
  supports: z.array(z.enum(PROVIDER_FEATURES)).default([]),
  /** Role to concrete model id. Roles keep a phase portable across a rename. */
  models: z.record(z.enum(MODEL_ROLES), z.string().min(1)),

  /** Omit to pass the prompt positionally. */
  promptFlag: z.string().min(1).optional(),
  modelFlag: z.string().min(1).optional(),
  effortFlag: z.string().min(1).optional(),
  /**
   * The values `effortFlag` accepts.
   *
   * Declared by the provider rather than assumed by Factory, because they are
   * that CLI's vocabulary and nobody else's. Empty — the default — means the
   * builder offers no list, which is also the honest answer for a provider
   * with no effort flag at all.
   */
  effortValues: z.array(z.string().min(1)).default([]),
  subagentFlag: z.string().min(1).optional(),

  session: z
    .object({
      mode: z.enum(SESSION_MODES).default('none'),
      /** Used when mode is "continue": resume the most recent session here. */
      continueArgs: z.array(z.string()).default([]),
      /**
       * Used when mode is "id": start a session with an id Factory chose.
       *
       * Factory minting the id is what lets it be resumed exactly — by a later
       * phase, by a re-run, and by a person opening a terminal — rather than
       * by "the most recent conversation here", which is wrong the moment two
       * tasks share a directory.
       */
      idFlag: z.string().min(1).optional(),
      /**
       * Used when mode is "id": resume the session with that id.
       *
       * Defaults to `idFlag`, which is right for a CLI whose one flag both
       * sets and resumes. Claude Code needs both: `--session-id` refuses an id
       * that already exists ("Session ID … is already in use") and `--resume`
       * refuses one that does not, so the two are genuinely different verbs and
       * a descriptor that could only say one of them could not resume at all.
       */
      resumeFlag: z.string().min(1).optional(),
    })
    .default({ mode: 'none', continueArgs: [] }),

  /**
   * Whatever the CLI needs to run unattended, per execution profile.
   *
   * This one field is where a profile becomes real. It is read in exactly one
   * place — as the first elements of the rendered argv — which is why it is the
   * only correct home for the decision: a profile resolved anywhere else would
   * mean two things deciding what an agent may touch, and the wrong one would
   * be the one nobody reads.
   *
   * ```yaml
   * permissionArgs:
   *   default: ['--restricted', '--permission-prompts', 'none']
   *   full-access: ['--permission-mode', 'bypassPermissions']
   * ```
   *
   * **A bare array still parses** and means the same arguments whatever the
   * profile — so every descriptor written before profiles existed, including a
   * third party's, keeps working. It is not silently accepted, though: doctor
   * says the provider cannot tell the profiles apart, which is the
   * degrade-by-absence rule with the absence said out loud.
   */
  permissionArgs: z
    .union([
      z.array(z.string()),
      closedWithExtensions({
        default: z.array(z.string()).default([]),
        'full-access': z.array(z.string()).default([]),
      }),
    ])
    .default([]),

  /**
   * How this CLI is told that one more command is allowed, if it can be.
   *
   * The seam a **custom profile** is rendered through. Declared here rather
   * than decided in core, so a third party's provider gets it by writing YAML —
   * the same rule that makes adding a provider a file rather than a patch.
   *
   * ```yaml
   * commandAllowFlag: '--allowedTools'
   * commandDenyFlag: '--disallowedTools'
   * commandPattern: 'Bash({command} *)'
   * commandSeparator: ','
   * ```
   *
   * **Absent means this CLI cannot express it**, and that is a real answer
   * rather than a gap: Copilot has four coarse switches and Codex has nothing,
   * so a profile's commands mean nothing to either. What must not happen is the
   * absence being *silent* — `unsupportedBy` below is how it is reported, and
   * the planner turns that into a warning on the run.
   *
   * One flag with a separated value, never repeated: `--allowedTools` is
   * variadic and a repeated variadic option **replaces** rather than appends,
   * so four flags would leave only the last in force. That has cost this
   * project time twice and is why the pattern and the separator are declared
   * rather than assumed.
   */
  commandAllowFlag: z.string().min(1).optional(),
  commandDenyFlag: z.string().min(1).optional(),
  /** How one command becomes a rule. `{command}` is replaced; anything else is literal. */
  commandPattern: z.string().min(1).default('{command}'),
  /** What joins the rules into one value. */
  commandSeparator: z.string().default(','),

  /**
   * The flag that grants access to one more directory, if this CLI has one.
   *
   * Needed because a task's **artifacts do not live in its workspace**.
   * `artifactsRoot` is deliberately under the project rather than the worktree
   * — "a worktree is deleted when the work in it ends, and an artifact that
   * disappears with the work it describes is no better than no artifact" — so a
   * confined agent told to write `<project>/.xaedalon/...` is being told to
   * write outside its own working directory. Without this, the Default profile
   * would refuse every artifact a worktree project ever promised.
   *
   * Only emitted under a confined profile: under Full Access there is nothing
   * to grant.
   */
  directoryFlag: z.string().min(1).optional(),
  extraArgs: z.array(z.string()).default([]),
  /** Redirected into stdin. Several CLIs hang without this when headless. */
  stdin: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).default({}),
  /**
   * Environment variables this CLI needs even under a confined profile.
   *
   * The Default profile withholds anything shaped like a credential, and a
   * coding agent's own credential is shaped exactly like one — filter
   * `ANTHROPIC_API_KEY` and every Claude run fails at once. Declared here,
   * beside the flags, so a new provider brings its own answer instead of
   * editing a list inside core.
   *
   * Names only. Factory never reads the values; it decides whether to pass them
   * through. And a subscription login keeps its credential in a keychain rather
   * than the environment, so a short list here is not evidence of a problem.
   */
  passEnv: z.array(z.string().min(1)).default([]),

  /**
   * What a refusal looks like, as this CLI words it.
   *
   * Needed because the Default profile works by handing the CLI the flags that
   * confine it, which moves the refusal *inside* the agent where Factory cannot
   * see it. Measured against Claude Code: a refused write leaves the process
   * exiting **0** with the refusal in its output, so there is nothing to detect
   * except the words.
   *
   * Data, not code, so a third-party provider can say how its own refusals read
   * without touching core. A first capture group is taken to be the path that
   * was refused, which is the one part Factory can act on — a directory is
   * exactly what it can grant.
   */
  denialPatterns: z
    .array(
      closedWithExtensions({
        id: slug('id'),
        /**
         * A plain substring that gates the expression.
         *
         * Required, and long enough to be selective, because it is what keeps
         * the scan cheap: the expression only runs on a window around a hit.
         * Without it a pattern with an unbounded capture group backtracks
         * catastrophically against a long run of non-whitespace, which is what
         * an agent printing data looks like.
         */
        contains: z.string().min(4),
        match: z.string().min(1),
        describe: z.string().min(1),
      }),
    )
    .default([]),

  /**
   * Arguments a step may never pass under a confined profile.
   *
   * The derivation below catches the obvious case — an argument out of this
   * provider's own `full-access` list — and it is not enough on its own. Two
   * shapes it cannot see:
   *
   * - a flag that grants authority without appearing in either list, such as
   *   `--dangerously-skip-permissions`;
   * - a flag Factory already passes whose *repetition replaces* what Factory
   *   said. `--allowedTools` is declared `<tools...>`, so a step passing it
   *   again does not add to the allow-list, it becomes the allow-list.
   *
   * Names only, and a bare flag matches `--flag=value` too. Additive: the
   * derived set is always in force as well, so a descriptor cannot widen a
   * profile by leaving this empty.
   */
  forbiddenArgs: z.array(z.string().min(1)).default([]),

  /**
   * True when this descriptor has not been checked against the real CLI.
   * `doctor` says so out loud rather than letting someone discover it when a
   * run fails with an unrecognised flag.
   */
  provisional: z.boolean().default(false),
  /** Why it is provisional, and how to verify it. */
  provisionalNote: z.string().optional(),
}

const descriptorSchema = closedWithExtensions(descriptorShape)

export type ProviderDescriptor = z.infer<typeof descriptorSchema>

export const providerDescriptorKeys: readonly string[] = Object.keys(descriptorShape)

export function parseProviderDescriptor(
  input: unknown,
): { descriptor?: ProviderDescriptor; error?: z.ZodError } {
  const parsed = descriptorSchema.safeParse(input)
  return parsed.success ? { descriptor: parsed.data } : { error: parsed.error }
}

/**
 * The arguments that grant this CLI its authority under one profile.
 *
 * A bare array means the descriptor predates profiles, or its author decided
 * one answer covers both. Either way it is used as written, so nothing that
 * worked before stops working — and `distinguishesProfiles` below is how doctor
 * finds out and says so.
 */
export function permissionArgsFor(
  descriptor: ProviderDescriptor,
  profile: ExecutionProfile,
): readonly string[] {
  const declared = descriptor.permissionArgs
  if (Array.isArray(declared)) return declared

  // A built-in is indexed straight, with no `?? []`, and that is deliberate
  // rather than an oversight: both keys carry `.default([])` in the schema, so
  // a map naming one profile parses with the other one present and empty. A
  // fallback would be unreachable — and worse, the obvious fallback is "use the
  // other profile's list", which for `default` would quietly mean Full Access.
  if (isBuiltInProfile(profile)) return declared[profile]

  // A custom profile is somebody's definition, and no descriptor will ever name
  // it. It gets the **confined** list, because a custom profile extends Default
  // and is confined by construction: whatever it adds is added on top of this,
  // by the renderer, never instead of it. Falling back the other way — or to
  // nothing — would be a profile that quietly ran unconfined or with no flags
  // at all, and both are the failure this function's comment already warns of.
  return declared[DEFAULT_PROFILE]
}

/**
 * What a custom profile adds, resolved for one provider.
 *
 * Handed in already narrowed: `args` is *this* provider's share of the
 * profile's `providers:` map, picked by whoever knows which provider is about
 * to run. The renderer stays dumb, which is what keeps one profile from being
 * interpreted two ways.
 */
export interface ProfileGrants {
  readonly commands: readonly string[]
  readonly denyCommands: readonly string[]
  readonly args: readonly string[]
}

/** Nothing added. What a built-in profile grants. */
export const NO_GRANTS: ProfileGrants = { commands: [], denyCommands: [], args: [] }

/** One command as this CLI's rule. `git push` with `Bash({command} *)` is `Bash(git push *)`. */
const asRule = (descriptor: ProviderDescriptor, command: string): string =>
  descriptor.commandPattern.replace('{command}', command)

/**
 * The flags that carry a profile's commands, if this CLI can carry them.
 *
 * Returned as whole flag-and-value pairs rather than merged into
 * `permissionArgs`, because the merging has to happen *before* the argv is
 * built: the allow flag may already be in the confined list, and a second one
 * would replace the first rather than extend it. `render` is the one place that
 * knows both halves, so it is the one place that joins them.
 */
export function commandArgsFor(
  descriptor: ProviderDescriptor,
  grants: ProfileGrants,
  existing: readonly string[] = [],
): readonly string[] {
  const args: string[] = []

  if (descriptor.commandAllowFlag !== undefined && grants.commands.length > 0) {
    const at = existing.indexOf(descriptor.commandAllowFlag)
    // What the confined profile already allows, kept: a profile that wanted
    // `cargo` must not cost the project its package managers.
    const already = at === -1 ? '' : (existing[at + 1] ?? '')
    const rules = grants.commands.map((command) => asRule(descriptor, command))
    const joined = [already, ...rules].filter((part) => part !== '').join(descriptor.commandSeparator)
    args.push(descriptor.commandAllowFlag, joined)
  }

  if (descriptor.commandDenyFlag !== undefined && grants.denyCommands.length > 0) {
    const at = existing.indexOf(descriptor.commandDenyFlag)
    const already = at === -1 ? '' : (existing[at + 1] ?? '')
    const rules = grants.denyCommands.map((command) => asRule(descriptor, command))
    const joined = [already, ...rules].filter((part) => part !== '').join(descriptor.commandSeparator)
    args.push(descriptor.commandDenyFlag, joined)
  }

  return [...args, ...grants.args]
}

/** One thing a provider was asked for and cannot do. */
export interface UnsupportedGrant {
  readonly provider: string
  readonly what: 'commands' | 'deny_commands'
  readonly entries: readonly string[]
  readonly message: string
}

/**
 * What this provider cannot honour, said out loud.
 *
 * A profile is portable and the three CLIs are not: Claude has an allow-list,
 * Copilot has coarse switches, Codex has nothing. Silence about that is the
 * failure — an agent running under a profile that means nothing to its CLI,
 * with everybody believing otherwise. Raw `args` are never unsupported, because
 * there is nothing to translate.
 */
export function unsupportedBy(
  descriptor: ProviderDescriptor,
  grants: ProfileGrants,
): readonly UnsupportedGrant[] {
  const found: UnsupportedGrant[] = []
  if (grants.commands.length > 0 && descriptor.commandAllowFlag === undefined) {
    found.push({
      provider: descriptor.id,
      what: 'commands',
      entries: grants.commands,
      message:
        `${descriptor.id} has no way to allow one command rather than all of them, so this ` +
        `profile's commands (${grants.commands.join(', ')}) do not reach it. Its runs behave as ` +
        `they do under the Default profile.`,
    })
  }
  if (grants.denyCommands.length > 0 && descriptor.commandDenyFlag === undefined) {
    found.push({
      provider: descriptor.id,
      what: 'deny_commands',
      entries: grants.denyCommands,
      message:
        `${descriptor.id} has no deny-list, so this profile's denied commands ` +
        `(${grants.denyCommands.join(', ')}) do not reach it.`,
    })
  }
  return found
}

/**
 * Arguments this step is not allowed to pass, given the profile it runs under.
 *
 * `Agent.args` and `AgentStep.args` are appended to the argv *after*
 * `permissionArgs`, and for a long time nothing checked them — so a project's
 * own agent file containing `args: ['--permission-mode', 'bypassPermissions']`
 * got Full Access under the Default profile, silently, by editing a file in
 * the repository the agent itself can write to.
 *
 * Derived rather than listed. What widens a profile is whatever that CLI's own
 * `full-access` arguments are, minus whatever the confined profile already
 * passes — so it stays correct when a descriptor is edited, and a third-party
 * provider gets the same protection without naming anything. `forbiddenArgs`
 * adds the cases derivation cannot see.
 *
 * Nothing is forbidden under Full Access: there is no boundary left to widen.
 * A provider whose `full-access` list is empty derives nothing, which is the
 * honest answer for a descriptor that has never been measured — `doctor`
 * already says that provider distinguishes no profiles.
 */
export function forbiddenArgsFor(
  descriptor: ProviderDescriptor,
  profile: ExecutionProfile,
): readonly string[] {
  if (!isConfined(profile)) return []
  const confined = new Set(permissionArgsFor(descriptor, profile))
  const widening = permissionArgsFor(descriptor, 'full-access').filter(
    (argument) => !confined.has(argument),
  )
  return [...new Set([...widening, ...descriptor.forbiddenArgs])]
}

/**
 * Which of a step's arguments would widen the profile it runs under.
 *
 * `--flag=value` is compared on the flag, because a CLI that accepts one
 * accepts the other and a guard that could tell them apart is a guard with a
 * hole in it.
 */
export function profileWideningArgs(
  descriptor: ProviderDescriptor,
  profile: ExecutionProfile,
  args: readonly string[],
): readonly string[] {
  const forbidden = new Set(forbiddenArgsFor(descriptor, profile))
  if (forbidden.size === 0) return []
  return args.filter((argument) => {
    if (forbidden.has(argument)) return true
    const equals = argument.indexOf('=')
    return equals > 0 && forbidden.has(argument.slice(0, equals))
  })
}

/**
 * Whether this descriptor gives different answers for different profiles.
 *
 * False for a bare array. Worth asking rather than assuming, because a provider
 * that cannot tell the profiles apart is one whose Default profile is only as
 * confined as Factory's own boundary makes it — a true and useful thing to be
 * told, and not a reason to refuse to run.
 */
export function distinguishesProfiles(descriptor: ProviderDescriptor): boolean {
  return !Array.isArray(descriptor.permissionArgs)
}

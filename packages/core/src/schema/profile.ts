import { z } from 'zod'
import type { Problem } from '../problems.js'
import { closedWithExtensions, extensionsOf, problemsFromZod, slug } from './common.js'
import { BUILT_IN_PROFILES, DEFAULT_PROFILE } from '../security/profile.js'
import {
  NO_GRANTS,
  reachesFullAccess,
  unsupportedBy,
  type ProfileGrants,
  type ProviderDescriptor,
} from '../providers/descriptor.js'

/**
 * A profile somebody wrote: which commands an agent may run here, and nothing else.
 *
 * Factory ships two profiles and both stay exactly what they are. This is the
 * third position — *yes to this one command, in this repository, because I know
 * what it costs* — written down where it is true rather than chosen from a list
 * of two that cannot express it.
 *
 * **It widens commands, never the boundary.** A profile is always confined: the
 * workspace boundary, the credential filter and the directory grants apply to
 * it exactly as under Default, because `isConfined` answers by exception. What
 * a profile changes is the allow-list the agent's own CLI is launched with.
 *
 * `extends: default` is required and is the only base. Extending Full Access
 * would be Full Access with a friendlier name and no warning banner, and the
 * whole reason Full Access is marked on screen the entire time it is on is that
 * nobody should be able to reach it without noticing.
 *
 * Deliberately not a set of permissions. `docs/proposals/execution-profiles.md`
 * §26 imagines `network:`, `git:` and `database:` keys, and Factory mediates
 * none of those — the agent's CLI does. A key Factory cannot enforce is a flag
 * that reads correctly and does nothing, which this codebase has been bitten by
 * once already. What is here is what can be rendered and therefore honoured.
 */

export const PROFILE_KIND = 'factory.profile/v1'

/**
 * One provider's share of a profile: raw arguments, for what the vocabulary cannot say.
 *
 * A plain closed object rather than `closedWithExtensions`, and deliberately:
 * extensions are a *definition*-level idea that the writer preserves as `x-`
 * keys at the top of the file. Carried on a nested entry they would be written
 * back into the map — `extensions: {}` on every provider — and dropped on the
 * next save, which is both ugly and a lie about what round-trips. `conditions`
 * on a workflow is shaped the same way for the same reason.
 */
const providerShape = z.object({
  /**
   * Appended verbatim when this provider runs under this profile.
   *
   * The escape hatch, and per-provider because the three CLIs share no
   * vocabulary: Claude has an allow-list, Copilot has four coarse switches and
   * Codex expresses nothing at all. Portable intent goes in `commands`; this is
   * for what only one CLI can say.
   */
  args: z.array(z.string()).default([]),
})

const profileShape = {
  kind: z.literal(PROFILE_KIND).optional(),
  name: slug('name'),
  description: z.string().default(''),
  /**
   * The profile this one starts from. Only `default`, and checked here.
   *
   * A literal rather than an enum of both built-ins, so the refusal names the
   * one permitted value instead of listing a second the author may not use.
   */
  extends: z.literal(DEFAULT_PROFILE).default(DEFAULT_PROFILE),
  /**
   * Commands an agent may run under this profile, beyond what Default allows.
   *
   * A command name — `cargo` — or a name and a sub-command — `git push`.
   * Rendered by each provider its own way, and reported as unenforced by any
   * provider with no allow-list rather than silently dropped.
   */
  commands: z.array(z.string().min(1)).default([]),
  /** Commands to take back out, where a provider has a deny-list to express it. */
  deny_commands: z.array(z.string().min(1)).default([]),
  /** Per provider, for what `commands` cannot express. Keyed by provider id. */
  providers: z.record(slug('provider id'), providerShape).default({}),
}

const profileYaml = closedWithExtensions(profileShape)

/** The keys this schema accepts, derived. Checked against PROFILE_FIELDS. */
export const profileSchemaKeys: readonly string[] = Object.keys(profileShape)

export interface ProfileProviderSettings {
  readonly args: readonly string[]
}

export interface Profile {
  /** Present only when the file declared it; carried so a save cannot drop it. */
  readonly kind?: typeof PROFILE_KIND
  readonly name: string
  readonly description: string
  readonly extends: typeof DEFAULT_PROFILE
  readonly commands: readonly string[]
  readonly denyCommands: readonly string[]
  readonly providers: Readonly<Record<string, ProfileProviderSettings>>
  readonly extensions: Readonly<Record<string, unknown>>
}

export interface ProfileParseResult {
  readonly profile?: Profile
  readonly problems: readonly Problem[]
}

/**
 * Parse a profile.
 *
 * No host, like an agent: a profile names providers but none of them has to be
 * installed for it to be written down. Whether this installation can honour a
 * given part of it is a question for the moment it is rendered, where the
 * answer can say which provider and why.
 */
/**
 * Names a profile may not take.
 *
 * The two Factory ships, because the name is what a project stores and what
 * resolution returns — a custom `default` would be a definition shadowing a
 * concept, and which one won would depend on a lookup order nobody wrote down.
 *
 * And the two verbs `factory profile` takes, because that one command both sets
 * the installation's profile and lists the defined ones: a profile called
 * `list` could never be selected from the terminal.
 */
const RESERVED_NAMES: readonly string[] = [...BUILT_IN_PROFILES, 'list', 'show']

export function parseProfile(input: unknown, options: { file?: string } = {}): ProfileParseResult {
  const parsed = profileYaml.safeParse(input)
  if (!parsed.success) {
    return {
      problems: problemsFromZod(parsed.error, {
        ...(options.file === undefined ? {} : { file: options.file }),
      }),
    }
  }

  const value = parsed.data as z.infer<typeof profileYaml> & Record<string, unknown>
  const problems: Problem[] = []
  const at = options.file === undefined ? {} : { file: options.file }

  // A profile cannot be called what a built-in is called. The name is what a
  // project stores and what `resolveProfile` returns, so a custom `default`
  // would be a definition shadowing a concept — and which one won would depend
  // on lookup order nobody wrote down.
  if (RESERVED_NAMES.includes(value.name)) {
    problems.push({
      severity: 'error',
      message:
        `"${value.name}" is reserved, so a profile here cannot be called that. ` +
        `Choose another name.`,
      field: 'name',
      ...at,
      rule: 'profile.reservedName',
    })
  }

  // A profile that widens nothing is a profile that does nothing, and the
  // likeliest reason is a half-written file rather than a deliberate one.
  if (
    value.commands.length === 0 &&
    value.deny_commands.length === 0 &&
    Object.keys(value.providers).length === 0
  ) {
    problems.push({
      severity: 'warning',
      message:
        `Profile "${value.name}" allows nothing beyond the Default profile, so a project ` +
        `choosing it behaves exactly as one that did not. Give it a command or two.`,
      ...at,
      rule: 'profile.allowsNothing',
    })
  }

  const providers: Record<string, ProfileProviderSettings> = {}
  for (const [id, settings] of Object.entries(value.providers)) {
    providers[id] = { args: (settings as z.infer<typeof providerShape>).args }
  }

  const profile: Profile = {
    ...(value.kind === undefined ? {} : { kind: value.kind }),
    name: value.name,
    description: value.description,
    extends: value.extends,
    commands: value.commands,
    denyCommands: value.deny_commands,
    providers,
    extensions: extensionsOf(value),
  }

  return { profile, problems }
}

/**
 * What this profile grants one provider.
 *
 * The portable half is the same for everyone; `args` is that provider's own
 * share of the `providers:` map, and absent means it contributes none.
 */
export function grantsFor(profile: Profile, provider: string): ProfileGrants {
  return {
    commands: profile.commands,
    denyCommands: profile.denyCommands,
    args: profile.providers[provider]?.args ?? NO_GRANTS.args,
  }
}

/**
 * Commands that run whatever they are given.
 *
 * `--restricted` confines Factory's own file tools and the shell's redirection.
 * It cannot confine what a *child process* does with its own syscalls, so an
 * entry that ends in an interpreter hands that entry the whole filesystem —
 * `Bash(node *)` was measured writing outside the workspace on the first
 * attempt, and is why the shipped Default list is package managers only.
 *
 * Warned about rather than refused, deliberately. A profile exists so the
 * person who owns the repository can take a risk they understand; refusing
 * would decide for them. What it must not be is a risk taken without noticing.
 */
const INTERPRETERS = [
  'sh',
  'bash',
  'zsh',
  'fish',
  'env',
  'node',
  'deno',
  'python',
  'python3',
  'ruby',
  'perl',
  'php',
  'osascript',
  'xargs',
  'eval',
] as const

/** The tool a command line starts with, which is the part an allow-list matches. */
const leadingTool = (command: string): string => (command.trim().split(/\s+/)[0] ?? '').trim()

/**
 * Everything about a profile that needs a provider to know.
 *
 * Separate from `parseProfile` because that has no host on purpose — a profile
 * names providers and none of them has to be installed for it to be written
 * down. This is asked where the installed set is known, which is the write path.
 */
export function profileProblems(
  profile: Profile,
  providers: readonly ProviderDescriptor[],
  options: { file?: string } = {},
): readonly Problem[] {
  const problems: Problem[] = []
  const at = options.file === undefined ? {} : { file: options.file }

  for (const descriptor of providers) {
    const grants = grantsFor(profile, descriptor.id)

    // The upper bound. Only the profile's *own* arguments are checked: the
    // flags it emits for `commands` are the ones a step may not pass, and a
    // profile setting them is the whole point.
    const reaching = reachesFullAccess(descriptor, grants.args)
    if (reaching.length > 0) {
      problems.push({
        severity: 'error',
        message:
          `This profile passes ${reaching.map((a) => `"${a}"`).join(', ')} to ${descriptor.id}, ` +
          `which is what Full Access grants. Choose Full Access on the project instead, where it ` +
          `is marked on screen the whole time it is on.`,
        field: 'providers',
        ...at,
        rule: 'profile.reachesFullAccess',
      })
    }

    // What this provider cannot honour. A warning rather than an error: the
    // profile is still correct, and the other providers still get it.
    for (const gap of unsupportedBy(descriptor, grants)) {
      problems.push({
        severity: 'warning',
        message: gap.message,
        ...at,
        rule: 'profile.unsupportedByProvider',
      })
    }
  }

  for (const command of profile.commands) {
    const tool = leadingTool(command)
    if (!(INTERPRETERS as readonly string[]).includes(tool)) continue
    problems.push({
      severity: 'warning',
      message:
        `"${command}" runs whatever it is given. Confinement stops Factory's own file tools ` +
        `leaving the workspace; it cannot stop a child process doing it with its own syscalls, ` +
        `and \`Bash(node *)\` was measured writing outside the workspace on the first attempt. ` +
        `Allow it if that is the trade you mean to make.`,
      field: 'commands',
      ...at,
      rule: 'profile.interpreterAllowed',
    })
  }

  return problems
}

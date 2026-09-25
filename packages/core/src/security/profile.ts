/**
 * How much authority an agent gets.
 *
 * Factory runs other people's coding agents, and until now it ran all of them
 * the same way: `provider-claude` passed `--permission-mode bypassPermissions`
 * and `provider-copilot` passed `--allow-all-paths`, which switches off that
 * CLI's own path checking. Every run was unrestricted and nothing said so.
 *
 * Two profiles *ship*, because two is the number of genuinely different answers
 * to "may this agent touch things outside the project?" — no, and yes. Both are
 * still exactly what they were.
 *
 * A third position is a **custom profile**: a definition somebody writes, in
 * the repository it is true of, widening which commands an agent may run and
 * nothing else. It is always confined — `isConfined` answers by exception, so
 * every name that is not Full Access gets the workspace boundary, the filtered
 * environment and the directory grants. A custom profile that could decide its
 * own confinement would be Full Access under a friendlier name.
 *
 * A profile is data, not a capability. What *enforces* it is partly the
 * provider (see `permissionArgs`) and partly Factory (the workspace boundary,
 * the filtered environment, the process group), and a future sandbox
 * capability can add to it without core learning a new concept.
 */
export const BUILT_IN_PROFILES = ['default', 'full-access'] as const

/**
 * Kept under its old name as well, because it is what everything that offers a
 * *choice* between the shipped two still means, and because renaming a constant
 * across fifteen files buys nothing.
 */
export const EXECUTION_PROFILES = BUILT_IN_PROFILES

export type BuiltInProfile = (typeof BUILT_IN_PROFILES)[number]

/**
 * A built-in name, or one a scope defines.
 *
 * `(string & {})` rather than a bare `string`: the union keeps the two shipped
 * names in autocomplete and in a `switch`, while accepting the names nobody has
 * written yet. `ObservationKind` is spelled the same way for the same reason.
 */
export type ExecutionProfile = BuiltInProfile | (string & {})

/**
 * What an installation does when nobody has said otherwise.
 *
 * Named rather than repeated, because "the default is default" is written in
 * four places — the settings schema, the project column, the resolver and the
 * renderer — and a literal in each is four chances to disagree.
 */
export const DEFAULT_PROFILE: BuiltInProfile = 'default'

/**
 * What to call each one to a person.
 *
 * Here rather than in the board, because the CLI, the web app and the docs all
 * name these, and a profile that reads "Full Access" in one place and
 * "full-access" in another is a profile somebody will think is two.
 */
export const EXECUTION_PROFILE_LABELS: Record<BuiltInProfile, string> = {
  default: 'Default',
  'full-access': 'Full Access',
}

/**
 * The profiles an installation knows about, asked rather than reached for.
 *
 * Core cannot read a scope — that is `@factory/config`'s job — so whoever *can*
 * hands the answer in. `describe` is how a custom profile gets a name for a
 * person without core learning what a profile definition looks like.
 */
export interface ProfileNames {
  readonly names: readonly string[]
  readonly describe: (profile: string) => string | undefined
}

/** Nothing defined. What core assumes when nobody says otherwise. */
export const NO_PROFILES: ProfileNames = { names: [], describe: () => undefined }

/** Whether this is one of the two Factory ships. */
export function isBuiltInProfile(value: unknown): value is BuiltInProfile {
  return typeof value === 'string' && (BUILT_IN_PROFILES as readonly string[]).includes(value)
}

/**
 * Whether a string off the wire is a profile at all.
 *
 * Kept as the built-in check, because that is what it has always meant and what
 * the surfaces offering a choice between the shipped two still ask.
 */
export function isExecutionProfile(value: unknown): value is BuiltInProfile {
  return isBuiltInProfile(value)
}

/**
 * Whether this installation would recognise the name.
 *
 * The guard a route or a row needs: a built-in, or something a scope defines.
 * An unknown name is refused rather than stored, for the reason the original
 * check existed — a name nobody defined, read back later as "not stated", would
 * silently loosen a project that had asked to be confined.
 */
export function isKnownProfile(value: unknown, known: ProfileNames = NO_PROFILES): boolean {
  if (typeof value !== 'string') return false
  return isBuiltInProfile(value) || known.names.includes(value)
}

/**
 * What to call this profile to a person.
 *
 * A built-in has a name Factory chose. A custom one is called whatever it says
 * it is, falling back to its own name — never to a label invented here, because
 * the profile is the author's and so is what it is called.
 */
export function profileLabel(profile: string, known: ProfileNames = NO_PROFILES): string {
  if (isBuiltInProfile(profile)) return EXECUTION_PROFILE_LABELS[profile]
  return known.describe(profile) ?? profile
}

/**
 * Which profile applies, in one place.
 *
 * Project, then installation, then `default`. The order matters and is the only
 * thing this function is for: the alternative is every caller writing
 * `project.profile ?? settings.security.profile ?? 'default'`, and the fourth
 * one writing it in a different order.
 *
 * Absence means "not stated", never "restricted" or "unrestricted" — which is
 * why a project with no profile inherits rather than defaulting separately.
 */
export function resolveProfile(sources: {
  readonly project?: ExecutionProfile | undefined
  readonly installation?: ExecutionProfile | undefined
}): ExecutionProfile {
  return sources.project ?? sources.installation ?? DEFAULT_PROFILE
}

/** Whether this profile confines the agent at all. */
export const isConfined = (profile: ExecutionProfile): boolean => profile !== 'full-access'

import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import {
  closedWithExtensions,
  DEFAULT_ORCHESTRATION_LIMITS,
  DEFAULT_PROFILE,
  EXECUTION_PROFILES,
  problemsFromZod,
  type Problem,
} from '@factory/core'
import type { ExecutionProfile } from '@factory/core'
import type { ScopeChain } from './scopes.js'

/**
 * Factory's own settings, in the user scope, beside `config.yaml`.
 *
 * Three stores were possible and two were wrong. `config.yaml` is hand-written
 * and carries the author's comments, and a slider that saves on every drag has
 * no business rewriting it. The database sits in the *default write scope*, so
 * it is per-repository rather than per-person — a "global" preference kept
 * there would silently differ depending on which directory the daemon started
 * in. What is left is a small file Factory owns, which is the pattern Pro
 * already follows with `pro-licence`.
 *
 * Because Factory owns it, unlike `config.yaml` it gets a schema — so an
 * unknown key is a diagnostic rather than silence.
 *
 * Read before any plugin loads, which is what lets `plugins.disabled` mean
 * "never imported" rather than "imported and ignored".
 */
export const SETTINGS_FILE = 'settings.json'
export const SETTINGS_KIND = 'factory.settings/v1'

/** The largest interface scale, so 3× is a promise rather than a slider's end. */
export const MAX_UI_SCALE = 3

/** Light, dark, or the OS's own preference — the board never sees a fourth. */
export const UI_THEMES = ['light', 'dark', 'system'] as const

export type UiTheme = (typeof UI_THEMES)[number]

/** What a fresh installation follows until somebody chooses otherwise. */
export const DEFAULT_UI_THEME: UiTheme = 'system'

/** Whether a string off the wire is a theme. Routes need this before storing one. */
export const isUiTheme = (value: unknown): value is UiTheme =>
  typeof value === 'string' && (UI_THEMES as readonly string[]).includes(value)

const shape = {
  kind: z.literal(SETTINGS_KIND).optional(),
  ui: closedWithExtensions({
    /**
     * Interface scale, applied the way Cmd+ applies it.
     *
     * 1 is the size the board was designed at. Bounded because a stored 40
     * would render a window nobody can click out of, and the file is editable
     * by hand.
     */
    scale: z.number().min(1).max(MAX_UI_SCALE).default(1),
    /**
     * Light, dark, or the OS's own preference.
     *
     * `system` by default so a fresh installation follows whatever the browser
     * already reports, the same way the browser's own chrome does, rather than
     * forcing a choice on first run.
     */
    theme: z.enum(UI_THEMES).default(DEFAULT_UI_THEME),
  }).default({ scale: 1, theme: DEFAULT_UI_THEME }),
  security: closedWithExtensions({
    /**
     * Which disclaimer this installation has accepted, if any.
     *
     * A number rather than a boolean so that a material change in what an agent
     * may reach can ask again. Absent means never accepted, which is what a
     * fresh installation is — and the daemon refuses to start a run until it
     * is not absent.
     */
    acceptedVersion: z.number().int().min(1).optional(),
    /**
     * What new projects get, and what a project that states nothing follows.
     *
     * Here rather than on each project because it is a per-person preference:
     * "on this machine, agents are confined unless I say otherwise". A project
     * overrides it, and `resolveProfile` is the one place the order is written.
     */
    profile: z.enum(EXECUTION_PROFILES).default(DEFAULT_PROFILE),
  }).default({ profile: DEFAULT_PROFILE }),
  orchestration: closedWithExtensions({
    /**
     * How far work may start work.
     *
     * An agent Factory launched can reach the daemon, so it can ask for a task,
     * whose agent can ask for a task. Three is deep enough for the shape this
     * is for — delegate, verify, stop — and shallow enough that a runaway is
     * over in seconds rather than after an afternoon of agents. Zero means only
     * a person may start work, which is a legitimate thing to want.
     */
    maxDepth: z.number().int().min(0).max(10).default(DEFAULT_ORCHESTRATION_LIMITS.maxDepth),
    /**
     * How many tasks one run's agent may ask for.
     *
     * The other half of the same bound: depth alone leaves a single run free to
     * queue a thousand.
     */
    maxTasksPerRun: z
      .number()
      .int()
      .min(0)
      .max(1000)
      .default(DEFAULT_ORCHESTRATION_LIMITS.maxTasksPerRun),
  }).default({
    maxDepth: DEFAULT_ORCHESTRATION_LIMITS.maxDepth,
    maxTasksPerRun: DEFAULT_ORCHESTRATION_LIMITS.maxTasksPerRun,
  }),
  plugins: closedWithExtensions({
    /**
     * Plugins the installation has switched off.
     *
     * Identified by how each got here: a built-in by its manifest name, a
     * declared one by the specifier written in `config.yaml`. The second is
     * the only handle that exists *before* the module is imported, and not
     * importing it is the whole point.
     */
    disabled: z.array(z.string().min(1)).default([]),
  }).default({ disabled: [] }),
}

const settingsSchema = closedWithExtensions(shape)

export type FactorySettings = z.infer<typeof settingsSchema>

export interface SettingsPatch {
  readonly ui?: { readonly scale?: number; readonly theme?: UiTheme }
  readonly plugins?: { readonly disabled?: readonly string[] }
  readonly security?: {
    readonly acceptedVersion?: number
    readonly profile?: ExecutionProfile
  }
  readonly orchestration?: {
    readonly maxDepth?: number
    readonly maxTasksPerRun?: number
  }
}

/** What an installation with no settings file behaves as. */
export const DEFAULT_SETTINGS: FactorySettings = settingsSchema.parse({})

/**
 * Where the file lives.
 *
 * Off the resolved chain's user scope, never by asking the OS a second time:
 * `userScopeRoot` already answered that question at discovery, and a second
 * call can disagree with the first — the user scope here is the legacy
 * `~/.factory` on a machine that never moved, and `resolveScopes` is the one
 * place allowed to know.
 *
 * Undefined when the chain has no user scope at all, which is what an explicit
 * `FACTORY_SCOPES` override can produce.
 */
export function settingsPath(chain: ScopeChain): string | undefined {
  const user = chain.scopes.find((scope) => scope.kind === 'user')
  return user === undefined ? undefined : join(user.root, SETTINGS_FILE)
}

/**
 * The settings, and anything wrong with the file.
 *
 * Nothing throws. A file that will not parse is a Problem and the defaults
 * apply, for the reason `loadDeclaredPlugins` gives about a broken plugin: the
 * only way to diagnose it is a tool that still starts.
 */
export function readSettings(chain: ScopeChain): {
  settings: FactorySettings
  file?: string
  problems: readonly Problem[]
} {
  const file = settingsPath(chain)
  if (file === undefined) return { settings: DEFAULT_SETTINGS, problems: [] }

  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    // No file is the ordinary case, not an error, and creates nothing.
    return { settings: DEFAULT_SETTINGS, file, problems: [] }
  }
  return { ...parse(raw, file), file }
}

/**
 * Change some of it, and leave the rest alone.
 *
 * Merged one level down rather than replaced, so writing a scale cannot drop
 * the disabled list — the two halves of this file are owned by different parts
 * of the board and will be written from different pages.
 *
 * Written to a temporary file and renamed, so an interrupted write cannot
 * leave a half-file where settings used to be. And **read back through the
 * schema before the rename**: a file Factory wrote is a file Factory can load,
 * and the cheapest place to keep that promise is here.
 */
export function writeSettings(
  chain: ScopeChain,
  patch: SettingsPatch,
): { settings: FactorySettings; file?: string; problems: readonly Problem[] } {
  const file = settingsPath(chain)
  if (file === undefined) {
    return {
      settings: DEFAULT_SETTINGS,
      problems: [
        {
          severity: 'error',
          message: 'There is no user scope to save settings in.',
          rule: 'settings.noUserScope',
        },
      ],
    }
  }

  const current = readSettings(chain).settings

  /**
   * Merged one level down, so saving the interface scale does not discard the
   * execution profile.
   *
   * Over the patch's own keys rather than a list of groups kept here. The list
   * was the cost: a new top-level group added to `SettingsPatch` and not added
   * to it was written nowhere, and *silently* — the call succeeded, the file
   * was rewritten, and the value was gone. There is nothing left to forget.
   *
   * `undefined` inside a group means "not mentioned", never "clear it": a
   * caller that spreads an optional field in under `exactOptionalPropertyTypes`
   * would otherwise erase what is already there.
   *
   * The result is parsed against the schema below before anything is written,
   * which is what makes the indexing here safe to do dynamically.
   */
  const groups = current as unknown as Record<string, Record<string, unknown>>
  const merged: Record<string, unknown> = { ...current, kind: SETTINGS_KIND }
  for (const [name, values] of Object.entries(patch)) {
    if (values === undefined) continue
    const stated = Object.fromEntries(
      Object.entries(values as Record<string, unknown>).filter(([, value]) => value !== undefined),
    )
    merged[name] = { ...groups[name], ...stated }
  }

  const text = `${JSON.stringify(merged, undefined, 2)}\n`
  const checked = parse(text, file)
  if (checked.problems.length > 0) return { settings: current, file, problems: checked.problems }

  const temporary = `${file}.tmp`
  try {
    writeFileSync(temporary, text)
    renameSync(temporary, file)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // It may never have been created. Nothing to clean up, nothing to say.
    }
    return {
      settings: current,
      file,
      problems: [
        {
          severity: 'error',
          message: `Could not save settings to ${file}: ${describe(error)}`,
          file,
          rule: 'settings.writeFailed',
        },
      ],
    }
  }
  return { settings: checked.settings, file, problems: [] }
}

/**
 * One live copy of the settings.
 *
 * The increment's sharpest risk is two meanings of "disabled": the loader
 * consults the list at startup and the task tools consult it per request, and
 * a second copy anywhere drifts into "the button is gone but the code still
 * runs", or the reverse. So there is one holder, and both read it.
 */
export interface SettingsHolder {
  current(): FactorySettings
  /** The file, when there is a user scope to hold one. */
  readonly file?: string
  /** Problems from reading it at startup. Reported by doctor. */
  readonly problems: readonly Problem[]
  update(patch: SettingsPatch): { settings: FactorySettings; problems: readonly Problem[] }
}

export function settingsHolder(chain: ScopeChain): SettingsHolder {
  const initial = readSettings(chain)
  let settings = initial.settings

  return {
    current: () => settings,
    ...(initial.file === undefined ? {} : { file: initial.file }),
    problems: initial.problems,
    update: (patch) => {
      const written = writeSettings(chain, patch)
      if (written.problems.length === 0) settings = written.settings
      return { settings, problems: written.problems }
    },
  }
}

function parse(
  raw: string,
  file: string,
): { settings: FactorySettings; problems: readonly Problem[] } {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    return {
      settings: DEFAULT_SETTINGS,
      problems: [
        {
          severity: 'error',
          message: `${file} is not valid JSON: ${describe(error)}. Using defaults.`,
          file,
          rule: 'settings.unparseable',
        },
      ],
    }
  }

  const parsed = settingsSchema.safeParse(value)
  if (!parsed.success) {
    return {
      settings: DEFAULT_SETTINGS,
      problems: problemsFromZod(parsed.error, { file }),
    }
  }
  return { settings: parsed.data, problems: [] }
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

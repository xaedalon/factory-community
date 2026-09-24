import {
  CapabilityHost,
  builtinStepsPlugin,
  reliabilityEvaluatorPlugin,
  type FactoryPlugin,
  type Problem,
} from '@factory/core'
import { EventBus } from '@factory/events'
import {
  builtinDoctorPlugin,
  builtinSetupPlugin,
  loadCatalogue,
  pluginCatalogue,
  providerSettings,
  resolveScopes,
  settingsHolder,
  type PluginCandidate,
  type ScopeChain,
  type SettingsHolder,
} from '@factory/config'
import claudeProvider from '@factory/provider-claude'
import codexProvider from '@factory/provider-codex'
import copilotProvider from '@factory/provider-copilot'
import reliabilityAgentPlugin from '@factory/reliability-agent'
import diffityPlugin from '@factory/task-diffity'
import openSessionPlugin from '@factory/task-session'
import openTerminalPlugin from '@factory/task-terminal'

/**
 * Assembling a working Factory: the scope chain, the capability host, and the
 * plugins that ship with it.
 *
 * Shared by the CLI and the daemon so there is one answer to "what is
 * installed by default" rather than two that drift. It is also the list a
 * distribution would edit to ship a different set.
 */
export interface Runtime {
  readonly chain: ScopeChain
  readonly host: CapabilityHost
  readonly events: EventBus
  readonly env: Readonly<Record<string, string | undefined>>
  readonly cwd: string
  /** Non-fatal problems from startup, e.g. a plugin that would not load. */
  readonly startupProblems: readonly Problem[]
  /**
   * Problems noticed while running, rather than while starting.
   *
   * There has to be somewhere for one to go. The scheduler used to drop a
   * failure it could not attribute to a task — which is exactly how "cancel
   * does not cancel" stayed invisible for sixteen increments: the engine's
   * next transition threw, the task had already settled, and nothing was
   * written down anywhere at all.
   *
   * Served beside `startupProblems` by `GET /api/doctor`, so the place a person
   * already looks is the place it appears. Bounded, because an unbounded list
   * of problems in a long-running process is its own problem.
   */
  readonly problems: readonly Problem[]
  /** Write one down. */
  recordProblem(problem: Problem): void
  /**
   * Everything Factory knows how to load, with what is switched off marked
   * rather than missing.
   *
   * A superset of `host.plugins()`, which only ever knows what loaded. The
   * board reads this one, because the plugin you just switched off is exactly
   * the one it has to be able to draw.
   */
  readonly plugins: readonly PluginCandidate[]
  /**
   * The one live copy of the settings.
   *
   * One holder, two readers: the loader consulted it at startup and the task
   * tools consult it per request. A second copy anywhere drifts into "the
   * button is gone but the code still runs", or the reverse.
   */
  readonly settings: SettingsHolder
  /**
   * Load one more plugin through the same gate.
   *
   * The daemon adds a plugin of its own after the runtime exists — the rules
   * that need a database. Without one gate it would bypass the switches and
   * turn up in the host but not the catalogue, and a plugins page that omits a
   * loaded plugin is a page that lies.
   */
  readonly load: (plugin: FactoryPlugin) => Promise<void>
  /**
   * Record that a switch was flipped.
   *
   * What loaded cannot change without a restart, so this updates the
   * catalogue's `enabled` flags rather than reloading anything — which is
   * precisely the distinction the plugins page draws when it says a restart
   * will unload something.
   */
  readonly replacePlugins: (plugins: readonly PluginCandidate[]) => void
}

/** The plugins Factory ships with, in load order. */
export const BUILTIN_PLUGINS = [
  builtinStepsPlugin,
  builtinDoctorPlugin,
  reliabilityEvaluatorPlugin,
  claudeProvider,
  codexProvider,
  copilotProvider,
  openTerminalPlugin,
  openSessionPlugin,
  diffityPlugin,
  reliabilityAgentPlugin,
] as const

/**
 * The two nothing works without.
 *
 * Switch off the step kinds and no workflow parses; switch off the built-in
 * doctor rules and nothing can tell you why. Everything else — every provider,
 * every task tool, Pro — is somebody's choice to make, including the choice to
 * make Factory less useful.
 */
export const ESSENTIAL_PLUGINS: readonly string[] = [
  builtinStepsPlugin.name,
  builtinDoctorPlugin.name,
]

export async function createRuntime(options: {
  cwd: string
  env: Readonly<Record<string, string | undefined>>
  chain?: ScopeChain
  events?: EventBus
}): Promise<Runtime> {
  const chain = options.chain ?? resolveScopes({ cwd: options.cwd, env: options.env })
  const events = options.events ?? new EventBus()

  // Settings before plugins: a provider plugin reads where its binary is while
  // it registers, so the answer has to be in the host before it loads.
  const host = new CapabilityHost({
    events,
    env: options.env,
    settings: providerSettings(chain),
  })

  // Read before anything is imported, which is what lets a switched-off plugin
  // mean "never loaded" rather than "loaded and ignored".
  const settings = settingsHolder(chain)

  // The setup steps need the chain, so they are built here rather than listed.
  const builtins = [...BUILTIN_PLUGINS, builtinSetupPlugin(chain)]
  // Built-ins first, so a project plugin claiming the same capability id is
  // reported as conflicting with core rather than the other way round.
  const catalogue = pluginCatalogue({
    chain,
    builtins,
    essential: ESSENTIAL_PLUGINS,
    disabled: settings.current().plugins.disabled,
  })

  // A declared plugin that will not load is a problem to report, never a
  // crash: doctor has to keep working precisely when something is
  // misconfigured.
  const loaded = await loadCatalogue({
    catalogue,
    host,
    chain,
    builtins: new Map(builtins.map((plugin) => [plugin.name, plugin])),
  })

  let plugins = [...loaded.catalogue]
  /** Most recent last, oldest dropped. A daemon runs for weeks. */
  const recorded: Problem[] = []
  const PROBLEM_LIMIT = 100

  return {
    chain,
    host,
    events,
    env: options.env,
    cwd: options.cwd,
    startupProblems: [...settings.problems, ...loaded.problems],
    get problems() {
      return recorded
    },
    recordProblem: (problem) => {
      recorded.push(problem)
      if (recorded.length > PROBLEM_LIMIT) recorded.splice(0, recorded.length - PROBLEM_LIMIT)
    },
    get plugins() {
      return plugins
    },
    settings,
    replacePlugins: (next) => {
      plugins = [...next]
    },
    load: async (plugin) => {
      if (settings.current().plugins.disabled.includes(plugin.name)) {
        plugins.push({
          id: plugin.name,
          source: 'builtin',
          essential: false,
          enabled: false,
          name: plugin.name,
          version: plugin.version,
          loaded: false,
        })
        return
      }
      await host.load(plugin)
      plugins.push({
        id: plugin.name,
        source: 'builtin',
        essential: false,
        enabled: true,
        name: plugin.name,
        version: plugin.version,
        loaded: true,
      })
    },
  }
}

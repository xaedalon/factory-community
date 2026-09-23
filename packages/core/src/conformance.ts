import { EventBus } from '@factory/events'
import { CapabilityHost, type FactoryPlugin } from './host.js'
import { CAPABILITY_ID_PATTERN } from './capabilities.js'
import { HOOK_NAMES } from './hooks.js'

/**
 * The plugin conformance suite.
 *
 * This is how "commercial repositories add capabilities, they never modify the
 * meaning of the open core" stops being a principle and becomes a test. Pro's
 * capability package runs exactly this suite, and so does a third-party
 * provider plugin. If Pro ever needed a check relaxed, that would be the signal
 * that the plugin contract is too narrow -- the fix is to widen the SDK, not to
 * exempt Pro.
 *
 * It lives in the open core, and factory-pro imports it through
 * @factory/plugin-sdk like anyone else.
 */

export interface ConformanceCheck {
  readonly name: string
  readonly passed: boolean
  readonly detail?: string
}

export interface ConformanceReport {
  readonly plugin: string
  readonly passed: boolean
  readonly checks: readonly ConformanceCheck[]
  /** Every (kind, id) the plugin contributed, sorted. Useful in a snapshot test. */
  readonly provides: readonly string[]
  readonly hooks: readonly string[]
}

export async function checkPluginConformance(plugin: FactoryPlugin): Promise<ConformanceReport> {
  const checks: ConformanceCheck[] = []
  const record = (name: string, passed: boolean, detail?: string): boolean => {
    checks.push(detail === undefined ? { name, passed } : { name, passed, detail })
    return passed
  }

  const named =
    typeof plugin?.name === 'string' && plugin.name.trim() !== '' ? plugin.name : '<unnamed>'

  record('has a name', named !== '<unnamed>')
  record(
    'has a version',
    typeof plugin?.version === 'string' && plugin.version.trim() !== '',
    'so a compatibility matrix can be built later',
  )
  const registrable = record('register is a function', typeof plugin?.register === 'function')

  if (!registrable) {
    return { plugin: named, passed: false, checks, provides: [], hooks: [] }
  }

  // First load: does it register at all, and cleanly?
  const first = new CapabilityHost({ events: new EventBus({ onSubscriberError: () => {} }) })
  let loadError: unknown
  try {
    await first.load(plugin)
  } catch (error) {
    loadError = error
  }
  if (!record('registers without throwing', loadError === undefined, describe(loadError))) {
    return { plugin: named, passed: false, checks, provides: [], hooks: [] }
  }

  const provides = first
    .kinds()
    .flatMap((kind) => first.list(kind).map((entry) => `${entry.kind}:${entry.capability.id}`))
    .sort()

  const hookNames = HOOK_NAMES.filter((name) => first.hooks.count(name) > 0)

  record(
    'contributes something',
    provides.length > 0 || hookNames.length > 0,
    'a plugin that provides no capability and no hook cannot affect anything',
  )

  record(
    'every capability id is a slug',
    first
      .kinds()
      .every((kind) => first.list(kind).every((e) => CAPABILITY_ID_PATTERN.test(e.capability.id))),
    'ids appear in YAML and in URLs',
  )

  // Second load into a *fresh* host. A plugin holding module-level mutable
  // state -- a cache, a "registered already" flag, a singleton built at import
  // -- will differ here. That bug is invisible in a single-host test and then
  // breaks the daemon on reload, which is exactly how the prototype's hot-reload
  // path grew its edge cases.
  const second = new CapabilityHost({ events: new EventBus({ onSubscriberError: () => {} }) })
  let repeatError: unknown
  try {
    await second.load(plugin)
  } catch (error) {
    repeatError = error
  }
  const repeatProvides = repeatError
    ? []
    : second
        .kinds()
        .flatMap((kind) => second.list(kind).map((e) => `${e.kind}:${e.capability.id}`))
        .sort()

  record(
    'registers identically into a fresh host',
    repeatError === undefined && sameList(provides, repeatProvides),
    repeatError
      ? describe(repeatError)
      : sameList(provides, repeatProvides)
        ? undefined
        : `first load gave [${provides.join(', ')}], second gave [${repeatProvides.join(', ')}] ` +
          `-- the plugin is probably holding module-level state`,
  )

  return {
    plugin: named,
    passed: checks.every((check) => check.passed),
    checks,
    provides,
    hooks: hookNames,
  }
}

/** Throwing form, for use directly in a test. */
export async function assertPluginConformance(plugin: FactoryPlugin): Promise<ConformanceReport> {
  const report = await checkPluginConformance(plugin)
  if (!report.passed) {
    const failed = report.checks
      .filter((check) => !check.passed)
      .map((check) => `  - ${check.name}${check.detail ? `: ${check.detail}` : ''}`)
      .join('\n')
    throw new Error(`Plugin "${report.plugin}" failed conformance:\n${failed}`)
  }
  return report
}

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index])

const describe = (error: unknown): string | undefined =>
  error === undefined ? undefined : error instanceof Error ? error.message : String(error)

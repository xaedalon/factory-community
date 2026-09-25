import type { Problem } from './problems.js'

/**
 * Hooks: the places a plugin may *influence* what core does.
 *
 * The line against events is worth stating, because getting it wrong produces
 * two half-mechanisms. An event is a fact about something that already
 * happened -- a subscriber cannot change or stop it. A hook runs *during* the
 * operation and can add problems or adjust the value.
 *
 * So `afterBundleImport` from the original sketch is not here: nothing can act
 * on it, so it is the `bundle.imported` event instead.
 *
 * Two shapes, because they are the only two that come up:
 *
 *   collect   -- every hook runs, results are concatenated. Nothing is skipped
 *                because an earlier hook found a problem: a user fixing their
 *                YAML wants every error at once, not one per save.
 *   transform -- hooks are chained, each receiving the previous output, and any
 *                one of them may reject. A rejection stops the chain, because
 *                later hooks would be operating on a value that will not exist.
 */

export interface CollectHook<Input, Item> {
  readonly mode: 'collect'
  readonly input: Input
  readonly item: Item
}

export interface TransformHook<Value> {
  readonly mode: 'transform'
  readonly value: Value
}

/** What a transform hook returns: the value to carry forward, or a rejection. */
export type TransformOutcome<T> =
  | { readonly action: 'continue'; readonly value: T }
  | { readonly action: 'reject'; readonly problems: Problem[] }

export const keep = <T>(value: T): TransformOutcome<T> => ({ action: 'continue', value })
export const reject = <T>(...problems: Problem[]): TransformOutcome<T> => ({
  action: 'reject',
  problems,
})

/** A definition being validated. Deliberately untyped -- the schema lands in step 3. */
export interface DefinitionUnderValidation {
  readonly kind: string
  readonly name: string
  readonly definition: unknown
  readonly file?: string
}

/** A definition on its way to disk. Last chance to adjust or refuse. */
export interface DefinitionWrite {
  readonly kind: string
  readonly name: string
  readonly definition: unknown
  readonly scope: string
  readonly file: string
}

/**
 * Every hook, keyed by name.
 *
 * These two, and deliberately not a third. This said `beforeStepRun` arrives
 * with the runner "once there is a Step type to pass"; there has been one for
 * several increments, and the entry never arrived — a promise in a comment is
 * the same defect as a field that validates and lies, only cheaper to make.
 *
 * It is not here because nothing would call it. What a step may reach is
 * decided by its execution profile, which the plan carries and the runner
 * enforces before a process exists — a seam that already runs, rather than one
 * waiting for its first consumer. A hook that could veto a command about to be
 * spawned is the natural home for a future sandbox capability, and the right
 * time to add it is when that capability exists to use it.
 */
export interface HookSignatures {
  validateDefinition: CollectHook<DefinitionUnderValidation, Problem>
  beforeDefinitionWrite: TransformHook<DefinitionWrite>
}

export type HookName = keyof HookSignatures

/**
 * Every hook name, at runtime.
 *
 * `HookSignatures` is a type, so anything that needs to iterate the hooks —
 * the conformance report, `factory doctor` — wrote its own copy, and a third
 * hook added above and not added to that copy would be invisible in every
 * plugin's report.
 *
 * `satisfies Record<HookName, true>` is the point: a hook added to the
 * signatures and not here does not compile, and one left here after being
 * removed does not compile either. An array would have checked neither.
 */
const DECLARED = {
  validateDefinition: true,
  beforeDefinitionWrite: true,
} satisfies Record<HookName, true>

export const HOOK_NAMES = Object.keys(DECLARED) as readonly HookName[]

/** The function shape a hook of a given name expects. */
export type HookHandler<N extends HookName> =
  HookSignatures[N] extends CollectHook<infer I, infer Item>
    ? (input: I) => Item[] | Promise<Item[]>
    : HookSignatures[N] extends TransformHook<infer V>
      ? (value: V) => TransformOutcome<V> | Promise<TransformOutcome<V>>
      : never

interface Entry {
  plugin: string
  handler: (arg: never) => unknown
}

export class HookRegistry {
  readonly #handlers = new Map<HookName, Entry[]>()

  /** Registration order is run order, and it is stable across a process. */
  add<N extends HookName>(name: N, plugin: string, handler: HookHandler<N>): void {
    const list = this.#handlers.get(name) ?? []
    list.push({ plugin, handler: handler as (arg: never) => unknown })
    this.#handlers.set(name, list)
  }

  count(name: HookName): number {
    return this.#handlers.get(name)?.length ?? 0
  }

  /** Which plugins registered for a hook -- shown by `factory doctor`. */
  contributors(name: HookName): string[] {
    return (this.#handlers.get(name) ?? []).map((entry) => entry.plugin)
  }

  /**
   * Run a collect hook. Every handler runs even if an earlier one threw: a
   * broken plugin must not hide the real validation errors. A handler that
   * throws contributes a problem of its own instead of taking the run down.
   */
  async collect<N extends HookName>(
    name: N,
    input: HookSignatures[N] extends CollectHook<infer I, unknown> ? I : never,
  ): Promise<HookSignatures[N] extends CollectHook<unknown, infer Item> ? Item[] : never> {
    const collected: unknown[] = []
    for (const entry of this.#handlers.get(name) ?? []) {
      try {
        const items = await (entry.handler as (arg: unknown) => unknown[] | Promise<unknown[]>)(
          input,
        )
        collected.push(...items)
      } catch (error) {
        collected.push({
          severity: 'error',
          message: `hook "${name}" from ${entry.plugin} threw: ${describe(error)}`,
          rule: 'hook.threw',
        } satisfies Problem)
      }
    }
    return collected as never
  }

  /**
   * Run a transform hook. Stops at the first rejection, and treats a throw as a
   * rejection -- unlike collect, carrying on would mean writing a value a hook
   * was in the middle of refusing.
   */
  async transform<N extends HookName>(
    name: N,
    value: HookSignatures[N] extends TransformHook<infer V> ? V : never,
  ): Promise<TransformOutcome<HookSignatures[N] extends TransformHook<infer V> ? V : never>> {
    let current = value
    for (const entry of this.#handlers.get(name) ?? []) {
      let outcome: TransformOutcome<typeof current>
      try {
        outcome = await (
          entry.handler as (arg: unknown) => TransformOutcome<typeof current>
        )(current)
      } catch (error) {
        return reject({
          severity: 'error',
          message: `hook "${name}" from ${entry.plugin} threw: ${describe(error)}`,
          rule: 'hook.threw',
        })
      }
      if (outcome.action === 'reject') return outcome
      current = outcome.value
    }
    return keep(current)
  }
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

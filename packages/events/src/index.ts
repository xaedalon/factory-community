/**
 * The Factory event bus.
 *
 * Every meaningful state change in core is published here, and everything that
 * wants to react — the daemon's live updates, `doctor`, a third-party plugin,
 * factory-pro's desktop capability — subscribes. That is deliberate: it is what
 * lets a commercial edition observe the core without the core importing, or
 * even knowing about, the commercial edition.
 *
 * Events are facts about something that already happened. A subscriber cannot
 * veto or alter one; use a hook for that.
 */

/** Payloads, keyed by event name. Adding an event means adding a line here. */
export interface FactoryEvents {
  'definition.created': { kind: DefinitionKind; name: string; scope: string; path: string }
  'definition.updated': { kind: DefinitionKind; name: string; scope: string; path: string }
  'definition.deleted': {
    kind: DefinitionKind
    name: string
    scope: string
    path: string
    /** Deleting one copy can reveal a shadowed one. Null when the name is now gone. */
    nowResolvesFrom: string | null
  }
  'bundle.exported': { entry: string; workflows: string[]; phases: string[] }
  'bundle.imported': { entry: string; targetScope: string; written: string[]; skipped: string[] }
  'plan.resolved': { workflow: string; phaseCount: number; stepCount: number }
  /** A task changed state. The board and any observer redraw from this. */
  'task.created': { taskId: string; name: string }
  'task.transitioned': { taskId: string; action: string; from: string; to: string }
  'task.assigned': { taskId: string; workflows: string[] }
  /** Renamed. Carries what it was, because that is what a reader is looking for. */
  'task.renamed': { taskId: string; name: string; was: string }
  'task.described': { taskId: string; description: string }
  'task.deleted': { taskId: string }
  'project.added': { projectId: string; name: string; path: string }
  'project.removed': { projectId: string }
  /** A setting changed that decides where — and how much of — its work runs. */
  'project.changed': {
    projectId: string
    name: string
    usesWorktrees: boolean
    usesEnvironments: boolean
  }
  /** A workflow earned or invalidated something a gate depends on. */
  'task.flags.changed': { taskId: string; set: string[]; cleared: string[] }
  'run.started': { runId: string; workflow: string }
  'run.completed': { runId: string; workflow: string; ok: boolean }
  'step.started': { runId: string; phase: string; index: number; uses: string }
  'step.completed': { runId: string; phase: string; index: number; exitCode: number }
  'step.failed': { runId: string; phase: string; index: number; exitCode: number; message: string }
  /**
   * An agent was refused something by its own CLI's confinement.
   *
   * Emitted whether or not the run failed, because a confined agent that is
   * refused something exits 0 and says so in prose — so this is the only
   * notice anybody gets. `path` is present when the refusal named one, which
   * is the case Factory can act on: a directory is what it can grant.
   */
  'permission.requested': {
    runId: string
    taskId?: string
    id: string
    describe: string
    path?: string
  }
  'approval.requested': { runId: string; phase: string }
  'approval.granted': { runId: string; phase: string }

  /**
   * A task's reliability was judged again.
   *
   * `delta` is carried because the movement is the interesting part — a board
   * that only learns the new score has to remember the old one to say anything
   * useful, and a remembered value is one that drifts.
   */
  'reliability.assessed': {
    taskId: string
    assessmentId: string
    score: number
    delta: number
    coverage: number
  }
  /** Something new is holding the score down, or holding it up. */
  'reliability.driver.created': {
    taskId: string
    driverId: string
    severity: string
    owner: string
  }
  /**
   * A driver moved: resolved, accepted, invalidated or superseded.
   *
   * `by` is present only for an acceptance, which is the one transition where
   * who decided is part of the record rather than an audit detail.
   */
  'reliability.driver.changed': {
    taskId: string
    driverId: string
    status: string
    by?: string
  }
}

/**
 * Declared here as well as in `@factory/config`, because this package has no
 * dependency on that one. The two are structurally independent: nothing checks
 * them against each other, so a new kind must be added in both.
 */
export type DefinitionKind = 'workflow' | 'phase' | 'agent' | 'profile'
export type FactoryEventName = keyof FactoryEvents

/** An event as delivered to a subscriber. */
export type FactoryEvent<N extends FactoryEventName = FactoryEventName> = {
  [K in N]: { name: K; at: string; payload: FactoryEvents[K] }
}[N]

export type Subscriber<N extends FactoryEventName> = (event: FactoryEvent<N>) => void
export type Unsubscribe = () => void

/** Called when a subscriber throws. A bad subscriber must not break the publisher. */
export type SubscriberErrorHandler = (error: unknown, event: FactoryEvent) => void

export interface EventBusOptions {
  /** Defaults to reporting on stderr; tests and the daemon override it. */
  onSubscriberError?: SubscriberErrorHandler
  /** Injectable so tests get deterministic timestamps. */
  now?: () => Date
}

export class EventBus {
  readonly #subscribers = new Map<FactoryEventName, Set<Subscriber<never>>>()
  readonly #wildcard = new Set<(event: FactoryEvent) => void>()
  readonly #onSubscriberError: SubscriberErrorHandler
  readonly #now: () => Date

  constructor(options: EventBusOptions = {}) {
    this.#onSubscriberError =
      options.onSubscriberError ??
      ((error, event) => {
        console.error(`[factory] subscriber threw handling "${event.name}":`, error)
      })
    this.#now = options.now ?? (() => new Date())
  }

  on<N extends FactoryEventName>(name: N, subscriber: Subscriber<N>): Unsubscribe {
    let set = this.#subscribers.get(name)
    if (!set) {
      set = new Set()
      this.#subscribers.set(name, set)
    }
    const entry = subscriber as Subscriber<never>
    set.add(entry)
    return () => {
      set.delete(entry)
    }
  }

  once<N extends FactoryEventName>(name: N, subscriber: Subscriber<N>): Unsubscribe {
    const off = this.on(name, (event) => {
      off()
      subscriber(event)
    })
    return off
  }

  /** Subscribe to every event. Used by log sinks and the daemon's live stream. */
  onAny(subscriber: (event: FactoryEvent) => void): Unsubscribe {
    this.#wildcard.add(subscriber)
    return () => {
      this.#wildcard.delete(subscriber)
    }
  }

  /**
   * Publish an event.
   *
   * Delivery is synchronous and ordered, and a throwing subscriber is reported
   * but never propagated: publishing is a side effect of core doing its job, so
   * one broken plugin must not fail the operation that emitted the event.
   */
  emit<N extends FactoryEventName>(name: N, payload: FactoryEvents[N]): void {
    const event = { name, at: this.#now().toISOString(), payload } as FactoryEvent<N>

    // Widened once, here. TypeScript cannot prove FactoryEvent<N> is assignable
    // to the full FactoryEvent union while N is still an unresolved type
    // parameter, even though it is sound -- every member of the union is
    // FactoryEvent<K> for some K. The wildcard subscribers and the error
    // handler take the union, so they get this value; typed subscribers get the
    // precise one.
    const widened = event as FactoryEvent

    // Snapshot both sets: a subscriber may unsubscribe (or subscribe) during delivery.
    for (const subscriber of [...(this.#subscribers.get(name) ?? [])]) {
      try {
        ;(subscriber as Subscriber<N>)(event)
      } catch (error) {
        this.#onSubscriberError(error, widened)
      }
    }
    for (const subscriber of [...this.#wildcard]) {
      try {
        subscriber(widened)
      } catch (error) {
        this.#onSubscriberError(error, widened)
      }
    }
  }

  /** Live subscriber count, for tests and `factory doctor`. */
  listenerCount(name?: FactoryEventName): number {
    if (name === undefined) {
      let total = this.#wildcard.size
      for (const set of this.#subscribers.values()) total += set.size
      return total
    }
    return (this.#subscribers.get(name)?.size ?? 0) + this.#wildcard.size
  }
}

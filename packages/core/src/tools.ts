import { spawn } from 'node:child_process'
import type { Capability } from './capabilities.js'
import type { CapabilityLookup } from './host.js'
import type { Task } from './task/state.js'
import type { TaskWorkspace } from './task/project.js'
import { toShellString } from './providers/capability.js'
import {
  TERMINAL_KIND,
  terminalCommand,
  type TerminalOutcome,
  type TerminalRequest,
} from './terminal.js'

/**
 * Something you can do to a task, contributed by a plugin.
 *
 * "Open terminal" and "Open session" were two buttons written into the board
 * with their commands resolved by name inside a route. Adding a third — a diff
 * viewer — would have made three, and the fourth would have been somebody
 * else's and impossible. So the buttons on a task are a registry, and the three
 * Factory ships are ordinary entries in it.
 *
 * A tool returns **data**: a directory and, optionally, argv. It never spawns
 * anything and never learns what is installed to perform it, which is what
 * makes one testable and what lets the same tool work under a desktop shell
 * that can open terminals and under a bare daemon that cannot.
 *
 * Deliberately not called a "task action". `TASK_ACTIONS` and
 * `POST /api/tasks/:id/actions/:action` already mean *state transitions* —
 * queue, cancel, retry — and one word for two things in adjacent files is a
 * trap this codebase has paid for before.
 */
export const TASK_TOOL_KIND = 'task-tool'

/** How the host performs what a tool asked for. */
export type TaskToolRun = 'terminal' | 'detached'

/**
 * What a tool is told about the task. Whatever else it needs, it closes over
 * when it registers — the same bargain `SetupContext` strikes.
 */
export interface TaskToolContext {
  readonly task: Task
  /**
   * Absent when the task's project could not be resolved — which means the row
   * is not in the database, since a task cannot exist without one.
   */
  readonly workspace?: TaskWorkspace
  readonly host: CapabilityLookup
  /** Handed over, so a plugin never reads `process.env` itself. */
  readonly env: Readonly<Record<string, string | undefined>>
  /**
   * Where else to look for a binary, beyond PATH.
   *
   * Built once per request and shared, because assembling it lists every
   * version manager's directory — work that should not be repeated per tool.
   */
  readonly extraDirectories?: readonly string[]
}

/** What a tool offers for one task. */
export interface TaskToolOffer {
  /**
   * What to run in the workspace, as argv.
   *
   * Omitted means a shell and nothing more, which is what "open a terminal
   * here" is.
   */
  readonly command?: { readonly command: string; readonly args: readonly string[] }
  /**
   * Why it cannot be used right now.
   *
   * A *field*, not a second kind of answer, for the reason
   * `DefinitionListing.unavailable`, `SetupState` and `Availability` all give:
   * the label is wanted either way, and a caller that has to narrow a union
   * before it can read one is a caller that will get it wrong.
   *
   * Present means the control is drawn and **disabled with this reason** —
   * never hidden. A control that only appears once a task has run is one
   * nobody knew to look for.
   */
  readonly unavailable?: string
}

export interface TaskToolCapability extends Capability {
  /** Lower lists first. Defaults to 100 — the same rule a setup step follows. */
  readonly order?: number
  /**
   * How the host performs what this tool asks for. Defaults to `terminal`.
   *
   * On the tool rather than on each offer, because it does not vary by task:
   * Diffity is a detached tool whether or not it happens to be installed. It
   * was on the offer first, and an unavailable Diffity then reported itself as
   * a terminal tool — every branch would have had to remember to repeat it.
   */
  readonly run?: TaskToolRun
  /**
   * What this tool offers for this task, or nothing at all.
   *
   * `undefined` means the tool does not apply here — a git tool on a task with
   * no repository — and it is not drawn. A *reason* means it applies and
   * cannot be used yet, which is drawn and disabled. The difference is worth
   * the two answers: one is "this is not for you", the other is "not yet".
   *
   * May be async, like the two runners beside it, because the obvious second
   * consumer is a tool that has to ask a ticket system something.
   */
  offer(
    context: TaskToolContext,
  ): TaskToolOffer | undefined | Promise<TaskToolOffer | undefined>
}

/** One tool's answer, as a client is told it. */
export interface TaskToolView {
  readonly id: string
  readonly label: string
  readonly summary?: string
  /** Which plugin provided it, so a board can say where a button came from. */
  readonly plugin: string
  readonly run: TaskToolRun
  /**
   * Whether anything installed here can perform `run`.
   *
   * Served rather than derived: a client cannot know whether a terminal
   * capability is registered, and asking it to guess is how the board ends up
   * with a button that fails on click.
   */
  readonly runnable: boolean
  readonly unavailable?: string
  /** The line to run there. What a client copies is what the host would run. */
  readonly command: string
}

/** How long a tool gets to answer before it is reported as unavailable. */
export const TOOL_DEADLINE_MS = 2_000

/**
 * Every registered tool's answer for one task, in order.
 *
 * Shaped after `runSetup`: gather from the registry, sort, and turn a tool that
 * misbehaves into data rather than an exception — a page that loses all its
 * buttons because one plugin threw is the opposite of the point.
 *
 * `offer` being async newly allows a tool to *hang*, which a throwing one never
 * could, so it also gets a deadline. Same rule, extended to the new failure.
 */
export async function taskToolOffers(options: {
  readonly context: TaskToolContext
  /**
   * Plugin **names** the installation has switched off.
   *
   * Names, as the host knows them — not the ids `settings.json` holds. A
   * built-in's id *is* its name, but a declared plugin is identified in
   * settings by the specifier the user typed, because that is the only handle
   * that exists before the module is imported. Translating one to the other is
   * the catalogue's job, and it is the only thing that knows both.
   *
   * Filtered here and nowhere else. A plugin disabled while the daemon runs is
   * still registered — the host has no unload — so this is what makes a switch
   * take effect on the board before a restart takes effect on the process.
   */
  readonly disabledPlugins?: ReadonlySet<string>
  readonly deadlineMs?: number
}): Promise<readonly TaskToolView[]> {
  const { context } = options
  const registered = context.host
    .list<TaskToolCapability>(TASK_TOOL_KIND)
    .filter((entry) => options.disabledPlugins?.has(entry.plugin) !== true)
    .sort((a, b) => (a.capability.order ?? 100) - (b.capability.order ?? 100))

  const views: TaskToolView[] = []
  for (const entry of registered) {
    const tool = entry.capability
    const offer = await answer(tool, context, options.deadlineMs ?? TOOL_DEADLINE_MS)
    if (offer === undefined) continue

    const run = tool.run ?? 'terminal'
    views.push({
      id: tool.id,
      // `displayName` is the label. A second field for the same string is how
      // the two come to disagree.
      label: tool.displayName ?? tool.id,
      ...(tool.summary === undefined ? {} : { summary: tool.summary }),
      plugin: entry.plugin,
      run,
      // A detached run needs nothing installed; the daemon does it itself.
      runnable: run === 'detached' || context.host.has(TERMINAL_KIND),
      ...(offer.unavailable === undefined ? {} : { unavailable: offer.unavailable }),
      command: lineFor(offer, context.workspace?.path),
    })
  }
  return views
}

/** The request a tool asked for, in the one shape both performers take. */
export function requestFor(offer: TaskToolOffer, cwd: string): TerminalRequest {
  return { cwd, ...(offer.command === undefined ? {} : { command: offer.command }) }
}

/**
 * The line to show for an offer.
 *
 * `cd` only when there is somewhere to go: a tool asked about a task whose
 * project cannot be resolved has no directory, and `cd ''` is a worse answer
 * than none. Built through the same two functions that build what the host
 * runs, so what you copy and what happens cannot differ.
 */
function lineFor(offer: TaskToolOffer, cwd: string | undefined): string {
  if (cwd !== undefined) return terminalCommand(requestFor(offer, cwd))
  return offer.command === undefined ? '' : toShellString(offer.command)
}

/** A tool's answer, or a reason it did not give one. */
async function answer(
  tool: TaskToolCapability,
  context: TaskToolContext,
  deadlineMs: number,
): Promise<TaskToolOffer | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve(tool.offer(context)),
      new Promise<TaskToolOffer>((resolve) => {
        timer = setTimeout(
          () => resolve({ unavailable: `This tool did not answer within ${deadlineMs}ms.` }),
          deadlineMs,
        )
      }),
    ])
  } catch (error) {
    return {
      unavailable: `This tool failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  } finally {
    clearTimeout(timer)
  }
}

/** Starts something and does not wait for it. */
export type DetachedLauncher = (request: TerminalRequest) => Promise<TerminalOutcome>

/**
 * Start something that outlives this process.
 *
 * Three flags, each load-bearing. `detached` puts it in its own process group,
 * so the daemon's own shutdown does not take it down with it. `stdio: 'ignore'`
 * because a piped handle can hold `app.close()` open — the same trap the event
 * stream fell into and had to be fixed in three layers. `unref()` so the
 * daemon can exit while it runs.
 *
 * Reported on the `spawn` and `error` events rather than on exit. A detached
 * child's exit code is unobservable by design, so "it started" is the most a
 * button can honestly claim — and claiming more is how a green tick comes to
 * mean nothing.
 *
 * No platform detection, which is why this can live in the open core at all:
 * opening a *terminal* is thoroughly platform-specific and belongs to a
 * capability, but starting a process is not.
 */
export const systemDetachedLauncher: DetachedLauncher = async (request) => {
  const command = terminalCommand(request)
  const wanted = request.command
  if (wanted === undefined) {
    return {
      opened: false,
      reason: 'Nothing to run: a detached tool has to say what to start.',
      command,
    }
  }

  return new Promise<TerminalOutcome>((resolve) => {
    const child = spawn(wanted.command, [...wanted.args], {
      cwd: request.cwd,
      detached: true,
      stdio: 'ignore',
    })
    child.on('spawn', () => {
      child.unref()
      resolve({ opened: true, command })
    })
    child.on('error', (error) => resolve({ opened: false, reason: error.message, command }))
  })
}

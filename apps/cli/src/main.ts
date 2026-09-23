import { createRuntime } from '@factory/runtime'
import { styleFor } from './render.js'
import type { CliContext, CommandResult } from './context.js'
import * as scopes from './commands/scopes.js'
import * as security from './commands/security.js'
import * as definitions from './commands/definitions.js'
import * as inspect from './commands/inspect.js'
import * as bundles from './commands/bundles.js'
import { run as runWorkflow } from './commands/run.js'
import * as tasks from './commands/tasks.js'
import { setup as setupCommand } from './commands/setup.js'
import { createDaemonClient, type DaemonClient } from './daemon.js'
import { mcp } from './commands/mcp.js'
import type { McpStreams } from '@factory/mcp'
import { isDefinitionKind } from '@factory/config'
import type { ConflictPolicy, DefinitionKind, ScopeKind } from '@factory/config'

const USAGE = `factory — orchestrate the coding agents you already have

Usage
  factory init [--scope project|user]     create a scope here
  factory config path                     which scopes are in effect

  factory workflow list                   workflows available here
  factory workflow show <name>            one workflow, and where it came from
  factory phase list
  factory phase show <name>
  factory why <workflow|phase> <name>     every path that was tried, in order

  factory workflow export <name>          one file with everything it needs
  factory bundle import <file>            bring one in

  factory run <workflow>                  run it here, now, in the foreground
  factory stop --all                      stop every agent, and cancel its task

  factory accept [--show]                 what an agent run can reach, and agree
  factory profile [default|full-access]   how much authority a new project gets

  factory task list                       what the daemon is working on
  factory task show <id>                  one task, its runs and what it can do
  factory task new <name>                 create one   (--workflow, repeatable)
  factory task logs <id>                  the newest run, step by step
  factory task <action> <id>              queue, approve, reject, retry, cancel, done
  factory task depends <id> <on>          make one wait for another  (--remove)
  factory task move <id> <project>        put it in another project

  factory project add <name> <path>       a repository to work in   (--in-place)
  factory project queue <name>            queue the lot, in dependency order
  factory project stop <name>             cancel whatever is in flight there

  factory mcp                             serve Factory to an MCP-capable agent

  factory setup                           what is still missing, and how to fix it
  factory doctor                          check the installation
  factory capabilities                    everything that is installed
  factory plugins [list]                  plugins, and which are switched on
  factory plugins enable|disable <id>     switch one on or off
  factory provider list                   agents, and whether they are present
  factory step-kind list                  what a phase step may use
  factory rule list                       the checks doctor runs

Options
  --json                 machine-readable output
  --no-color             plain text (also honours NO_COLOR)
  -h, --help

Export
  -o, --out <file>       write to a file instead of stdout
  --allow-missing        export even if something it references is missing

Import
  --scope <project|user> where to write   (default: the writable scope in effect)
  --on-conflict <fail|skip|overwrite>     what to do about a name already there
  --prefix <text>        rename everything, rewriting internal references
  --dry-run              show the plan and write nothing

Task
  --state <state>        list only tasks in that state
  --archived             include archived tasks in the listing
  --workflow <name>      assign a workflow    (repeatable, order matters)
  --project <name>       which repository it happens in
  --branch <name>        the branch its work belongs on
  --ticket <id>          an id from wherever the work was asked for
  --description <text>   what the work is for; steps read it as {{ task.description }}

  The daemon is at $FACTORY_URL, or 127.0.0.1:$FACTORY_PORT, default port 7317.

Run
  --dry-run              print the commands and run nothing
  --yes                  approve every gate without asking
  --timeout <seconds>    how long one step may take   (default 1800)
  --workspace <dir>      where steps run              (default: here)
  --provider <id>        agent for steps that do not name one
  --ticket <id>          fills {{ task.ticketId }}
  --branch <name>        fills {{ task.branch }}
  --task <text>          fills {{ task.name }}
  --description <text>   fills {{ task.description }}
`

/** Actions a person may ask for. The daemon has the final say; this is the spelling. */
const TASK_ACTIONS = [
  'queue',
  'approve',
  'reject',
  'retry',
  'cancel',
  'archive',
  'restore',
  // Spelled `done` here and `mark_done` on the wire. The wire name says which
  // of two ways of reaching `done` this is; a person typing it has only one.
  'done',
] as const satisfies readonly string[]

/** Where a CLI verb and the action it performs are spelled differently. */
const ACTION_NAMES: Record<string, string> = { done: 'mark_done' }

export interface RunOptions {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly isTty?: boolean
  /** Where streamed output goes. Collected instead of printed under test. */
  readonly write?: (line: string) => void
  /** Injected so the task commands can be specified without a daemon running. */
  readonly daemon?: DaemonClient
  /**
   * Where `factory mcp` speaks, when it is what was asked for.
   *
   * The one command that owns its streams rather than returning lines, so the
   * streams are handed over the way everything else here is — which is what
   * lets the whole protocol be specified without spawning a process.
   */
  readonly streams?: McpStreams
}

/**
 * Parse and dispatch. Returns rather than exits, so the whole CLI is testable
 * without spawning anything; `bin.ts` is the only place that touches process.
 */
export async function run(options: RunOptions): Promise<CommandResult> {
  const args = [...options.argv]
  const json = take(args, '--json')
  const noColor = take(args, '--no-color')
  const help = take(args, '--help') || take(args, '-h')

  const style = styleFor({
    env: noColor ? { ...options.env, NO_COLOR: '1' } : options.env,
    isTty: options.isTty ?? false,
  })

  if (help || args.length === 0) return { lines: [USAGE], exitCode: args.length === 0 && !help ? 2 : 0 }

  const context = await createRuntime({ cwd: options.cwd, env: options.env })
  const [command, ...rest] = args

  const result = await dispatch(
    command as string,
    rest,
    context,
    style,
    {
      isTty: options.isTty ?? false,
      // Streamed straight out, so a long build is watchable rather than arriving
      // in one lump when it finishes.
      write: options.write ?? (() => {}),
      ...(options.streams === undefined ? {} : { streams: options.streams }),
    },
    false,
    options.daemon,
  )
  return json && result.json !== undefined
    ? { ...result, lines: [JSON.stringify(result.json, null, 2)] }
    : result
}

async function dispatch(
  command: string,
  rest: string[],
  context: CliContext,
  style: ReturnType<typeof styleFor>,
  io: { isTty: boolean; write: (line: string) => void; streams?: McpStreams },
  dryRun: boolean,
  daemon?: DaemonClient,
): Promise<CommandResult> {
  const usage = (message: string): CommandResult => ({
    lines: [message, '', USAGE],
    exitCode: 2,
  })

  switch (command) {
    case 'accept': {
      const show = rest.includes('--show')
      return security.accept(context, show ? { show } : {}, style)
    }

    case 'profile': {
      const [wanted] = rest
      return security.profile(context, wanted, style)
    }

    case 'stop': {
      // `--all` required rather than assumed: "stop" alone reads as though it
      // might mean one thing, and the one thing it means is everything.
      if (!rest.includes('--all')) {
        return usage('Try "factory stop --all" — it stops every agent Factory started.')
      }
      return security.stop(daemon ?? createDaemonClient(context.env), style)
    }

    case 'mcp':
      return mcp(context, daemon ?? createDaemonClient(context.env), io.streams)

    case 'init': {
      const index = rest.indexOf('--scope')
      const scope = index === -1 ? undefined : (rest[index + 1] as ScopeKind | undefined)
      if (index !== -1 && scope === undefined) return usage('--scope needs a value.')
      return scopes.init(context, scope === undefined ? {} : { scope }, style)
    }

    case 'config':
      if (rest[0] !== 'path') return usage('Unknown config command. Try "factory config path".')
      return scopes.configPath(context, style)

    case 'workflow':
    case 'phase':
    case 'agent': {
      const kind = command as DefinitionKind
      const [action, name] = rest
      if (action === 'list') return definitions.list(kind, context, style)
      if (action === 'show') {
        return name === undefined
          ? usage(`Which ${kind}? Try "factory ${kind} show <name>".`)
          : definitions.show(kind, name, context, style)
      }
      if (action === 'export') {
        if (kind !== 'workflow') return usage('Only workflows can be exported.')
        if (name === undefined) return usage('Which workflow? Try "factory workflow export <name>".')
        const out = value(rest, '--out') ?? value(rest, '-o')
        return bundles.exportBundle(
          name,
          { ...(out === undefined ? {} : { out }), allowMissing: has(rest, '--allow-missing') },
          context,
          style,
        )
      }
      return usage(`Unknown ${kind} command. Try "list", "show" or "export".`)
    }

    case 'why': {
      const [kind, name] = rest
      if (kind === undefined || !isDefinitionKind(kind)) {
        return usage('Say what to explain: "factory why workflow <name>".')
      }
      if (name === undefined) return usage(`Which ${kind}?`)
      return definitions.why(kind, name, context, style)
    }

    case 'bundle': {
      const [action, file] = rest
      if (action !== 'import') return usage('Try "factory bundle import <file>".')
      if (file === undefined) return usage('Which file? Try "factory bundle import <file>".')

      const scope = value(rest, '--scope') as ScopeKind | undefined
      const policy = value(rest, '--on-conflict') as ConflictPolicy | undefined
      if (policy !== undefined && !['fail', 'skip', 'overwrite'].includes(policy)) {
        return usage(`Unknown conflict policy "${policy}". Use fail, skip or overwrite.`)
      }
      const namePrefix = value(rest, '--prefix')

      return bundles.importFile(
        file,
        {
          ...(scope === undefined ? {} : { scope }),
          ...(policy === undefined ? {} : { policy }),
          ...(namePrefix === undefined ? {} : { prefix: namePrefix }),
          dryRun: has(rest, '--dry-run'),
        },
        context,
        style,
      )
    }

    case 'task': {
      const client = daemon ?? createDaemonClient(context.env)
      const [action, ...args] = rest

      if (action === 'list') {
        const state = value(rest, '--state')
        return tasks.list(
          client,
          { ...(state === undefined ? {} : { state }), archived: has(rest, '--archived') },
          style,
        )
      }
      if (action === 'show' || action === 'logs') {
        const id = args[0]
        if (id === undefined) return usage(`Which task? Try "factory task ${action} <id>".`)
        return action === 'show' ? tasks.show(client, id, style) : tasks.logs(client, id, style)
      }
      if (action === 'new') {
        const name = args.find((arg) => !arg.startsWith('--'))
        if (name === undefined) return usage('What is it called? Try "factory task new <name>".')
        const project = value(rest, '--project')
        const branch = value(rest, '--branch')
        const ticket = value(rest, '--ticket')
        const description = value(rest, '--description')
        return tasks.create(
          client,
          {
            name,
            // Repeatable, and the order is the order they run in.
            workflows: values(rest, '--workflow'),
            ...(project === undefined ? {} : { project }),
            ...(branch === undefined ? {} : { branch }),
            ...(ticket === undefined ? {} : { ticket }),
            ...(description === undefined ? {} : { description }),
          },
          style,
        )
      }
      if (action === 'depends') {
        const [id, blocker] = args.filter((arg) => !arg.startsWith('--'))
        if (id === undefined || blocker === undefined) {
          return usage('Which two? Try "factory task depends <id> <waits-for-id>".')
        }
        return tasks.depends(client, id, blocker, { remove: has(rest, '--remove') }, style)
      }
      if (action === 'move') {
        const [id, project] = args.filter((arg) => !arg.startsWith('--'))
        if (id === undefined || project === undefined) {
          return usage('Which task, and where? Try "factory task move <id> <project>".')
        }
        return tasks.move(client, id, project, style)
      }
      if (action !== undefined && (TASK_ACTIONS as readonly string[]).includes(action)) {
        const id = args[0]
        if (id === undefined) return usage(`Which task? Try "factory task ${action} <id>".`)
        return tasks.act(client, ACTION_NAMES[action] ?? action, id, style)
      }
      return usage(
        'Unknown task command. Try "list", "show", "new", "logs", "depends", "move", ' +
          'or an action like "queue".',
      )
    }

    case 'project': {
      const client = daemon ?? createDaemonClient(context.env)
      const [action, ...args] = rest
      const name = args.find((arg) => !arg.startsWith('--'))
      if (action === 'add') {
        const [projectName, path] = args.filter((arg) => !arg.startsWith('--'))
        if (projectName === undefined || path === undefined) {
          return usage('Which repository? Try "factory project add <name> <path>".')
        }
        return tasks.projectAdd(client, projectName, path, { inPlace: has(rest, '--in-place') }, style)
      }
      if (action === 'queue' || action === 'stop') {
        if (name === undefined) {
          return usage(`Which project? Try "factory project ${action} <name>".`)
        }
        return action === 'queue'
          ? tasks.projectQueue(client, name, style)
          : tasks.projectStop(client, name, style)
      }
      return usage('Unknown project command. Try "add", "queue" or "stop".')
    }

    case 'run': {
      const [name] = rest
      if (name === undefined) return usage('Which workflow? Try "factory run <workflow>".')
      const timeout = value(rest, '--timeout')
      const workspace = value(rest, '--workspace')
      const provider = value(rest, '--provider')
      // Built with assignments rather than conditional spreads: a spread of
      // `string | undefined` keeps the undefined in the type, which
      // exactOptionalPropertyTypes then rejects against an optional field.
      const task: {
        ticketId?: string
        branch?: string
        name?: string
        description?: string
      } = {}
      const ticket = value(rest, '--ticket')
      const branch = value(rest, '--branch')
      const taskName = value(rest, '--task')
      const taskDescription = value(rest, '--description')
      if (ticket !== undefined) task.ticketId = ticket
      if (branch !== undefined) task.branch = branch
      if (taskName !== undefined) task.name = taskName
      if (taskDescription !== undefined) task.description = taskDescription
      return runWorkflow(
        name,
        {
          dryRun: has(rest, '--dry-run') || dryRun,
          yes: has(rest, '--yes'),
          ...(timeout === undefined ? {} : { timeoutSeconds: Number(timeout) }),
          ...(workspace === undefined ? {} : { workspace }),
          ...(provider === undefined ? {} : { provider }),
          ...(Object.keys(task).length === 0 ? {} : { task }),
        },
        context,
        style,
        io,
      )
    }

    case 'setup':
      return setupCommand(daemon ?? createDaemonClient(context.env), context, style)

    case 'doctor':
      return inspect.doctor(daemon ?? createDaemonClient(context.env), context, style)

    case 'capabilities':
      return inspect.capabilities(context, style)

    case 'plugins': {
      const [action, id] = rest
      if (action === undefined || action === 'list') return inspect.plugins(context, style)
      if (action !== 'enable' && action !== 'disable') {
        return usage('Try "factory plugins", "factory plugins enable <id>" or "… disable <id>".')
      }
      if (id === undefined) return usage(`Which plugin? "factory plugins ${action} <id>".`)
      return inspect.switchPlugin(context, id, action === 'enable')
    }

    case 'provider':
      if (rest[0] !== 'list') return usage('Try "factory provider list".')
      return inspect.providers(context, style)

    case 'step-kind':
      if (rest[0] !== 'list') return usage('Try "factory step-kind list".')
      return inspect.stepKinds(context, style)

    case 'rule':
      if (rest[0] !== 'list') return usage('Try "factory rule list".')
      return inspect.doctorRules(context, style)

    default:
      return usage(`Unknown command "${command}".`)
  }
}

function take(args: string[], flag: string): boolean {
  const index = args.indexOf(flag)
  if (index === -1) return false
  args.splice(index, 1)
  return true
}

const has = (args: readonly string[], flag: string): boolean => args.includes(flag)

function value(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

/** Every occurrence, in order: `--workflow a --workflow b` runs a then b. */
function values(args: readonly string[], flag: string): string[] {
  const found: string[] = []
  args.forEach((arg, index) => {
    if (arg !== flag) return
    const next = args[index + 1]
    if (next !== undefined && !next.startsWith('--')) found.push(next)
  })
  return found
}

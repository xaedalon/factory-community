import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline/promises'
import {
  denialMessage,
  hasAccepted,
  NOT_ACCEPTED,
  runPlan,
  toShellString,
  type ResolvedPhase,
  type RunResult,
} from '@factory/core'
import { planWorkflow } from '@factory/config'
import { renderProblem, type Style } from '../render.js'
import { failed, ok, type CliContext, type CommandResult } from '../context.js'

/**
 * `factory run <workflow>` — run a workflow here, now, in the foreground.
 *
 * Deliberately the simplest thing that could be called running: one process,
 * in order, output straight through, stop when something fails. What it proves
 * is that the definition layer is executable — and the demo it makes possible
 * is the whole point of the increment: author a workflow in the browser, export
 * it, import it somewhere else, and run it.
 */
export interface RunFlags {
  readonly dryRun?: boolean
  /** Approve every gate without asking. Required when there is no terminal. */
  readonly yes?: boolean
  readonly timeoutSeconds?: number
  readonly workspace?: string
  readonly provider?: string
  /**
   * What the run is about.
   *
   * Any workflow that mentions `{{ task.* }}` needs this, and until the Task
   * entity exists there is nowhere else for it to come from — without it every
   * such workflow warns about an unresolved token and passes the braces
   * straight to the shell.
   */
  readonly task?: { ticketId?: string; branch?: string; name?: string; description?: string }
}

export async function run(
  name: string,
  flags: RunFlags,
  context: CliContext,
  style: Style,
  io: { isTty: boolean; write: (line: string) => void } = {
    isTty: false,
    write: () => {},
  },
): Promise<CommandResult> {
  // The same gate the daemon puts on queueing, because this is the other way an
  // agent actually starts. Two call sites, one decision function — they are two
  // entry points, not two implementations.
  //
  // Not on `--dry-run`: it executes nothing, and refusing to *show* somebody
  // what would happen until they have agreed to what happens is backwards.
  if (flags.dryRun !== true && !hasAccepted(context.settings.current().security.acceptedVersion)) {
    return failed([NOT_ACCEPTED, '', 'Run "factory accept --show" to read it first.'])
  }

  const workspace = flags.workspace ?? context.cwd

  const planned = planWorkflow({
    chain: context.chain,
    host: context.host,
    workflow: name,
    workspace,
    // One session for this invocation, so a workflow's phases are one
    // conversation the way they are when the daemon runs it. A foreground run
    // has no task to hang it on, so the run itself is the honest scope — and
    // `started: false` because it has plainly never existed before now.
    session: { id: randomUUID(), started: false },
    ...(flags.provider === undefined ? {} : { defaultProvider: flags.provider }),
    ...(flags.task === undefined ? {} : { task: flags.task }),
  })

  if (planned.plan === undefined) {
    return failed([
      `Cannot run "${name}":`,
      ...planned.problems.map((problem) => renderProblem(problem, style)),
    ])
  }

  // Streamed, not returned: returned lines print after the run, and a header
  // that arrives after the output it introduces is worse than none.
  io.write(`${style.bold(flags.dryRun === true ? 'Would run' : 'Running')} ${name}`)
  io.write(style.dim(`  in ${workspace}`))
  for (const problem of planned.problems) io.write(renderProblem(problem, style))
  io.write('')

  // Output is written as it arrives rather than collected: watching a build
  // scroll is most of the value of running one in the foreground.
  const result: RunResult = await runPlan({
    // Handed over, not read: the CLI is an entry point and this is what an
    // entry point is for.
    env: context.env,
    plan: planned.plan,
    ...(flags.dryRun === undefined ? {} : { dryRun: flags.dryRun }),
    ...(flags.timeoutSeconds === undefined ? {} : { timeoutSeconds: flags.timeoutSeconds }),
    events: context.host.events,
    onStep: (step, phase) => {
      const prefix = `${phase.name} · ${step.index}`
      io.write(style.dim(`— ${prefix} — `) + step.planned.describe)
      if (flags.dryRun === true) {
        io.write(style.dim(`  ${toShellString(step.planned)}`))
      }
    },
    onOutput: (chunk) => io.write(chunk.replace(/\n$/, '')),
    onApproval: (phase) => approve(phase, flags, style, io),
  })

  const lines = summarise(result, style)
  // A foreground run has nowhere to park, so the exit code is the whole of what
  // it can say — and a refused *command* means the run did not do what it was
  // asked, whatever its steps exited. The engine takes the same view and pauses
  // the task; this is the same decision at the other entry point.
  const refusedCommand = result.denials.some((denial) => denial.command !== undefined)
  return result.status === 'completed' && !refusedCommand
    ? ok(lines, result)
    : failed(lines, result)
}

async function approve(
  phase: ResolvedPhase,
  flags: RunFlags,
  style: Style,
  io: { isTty: boolean; write: (line: string) => void },
): Promise<boolean> {
  if (flags.yes === true) {
    io.write(style.dim(`— ${phase.name} — approved by --yes`))
    return true
  }

  // No terminal and no --yes: stopping is the honest outcome. Assuming approval
  // in a script would let a gate someone put there on purpose pass unread.
  if (!io.isTty) {
    io.write(
      style.yellow(
        `— ${phase.name} — needs approval, and there is no terminal to ask. Re-run with --yes.`,
      ),
    )
    return false
  }

  // Whatever the phase's steps promised. A phase no longer has one artifact —
  // each agent step that writes something names its own — so the prompt lists
  // them, which is also more useful than the single one ever was.
  //
  // Only for a review gate. An authorisation gate is asked *before* the steps
  // run, so those files do not exist yet and pointing at them would send
  // someone looking for something nothing has written.
  const produced =
    phase.approval === 'after'
      ? phase.steps
          .map((step) => step.artifact?.path)
          .filter((path): path is string => path !== undefined)
      : []
  const artifact = produced.length === 0 ? '' : ` Look at ${produced.join(' and ')} first.`
  // Which side of the phase this is, because "needs your approval" alone is
  // exactly what made the gate a surprise: nothing said whether the work had
  // already happened.
  const when =
    phase.approval === 'before'
      ? `${style.bold(phase.name)} has not run yet and needs your approval.`
      : `${style.bold(phase.name)} has run and needs your approval.`
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await prompt.question(`\n${when}${artifact} Continue? [y/N] `)
    return /^y(es)?$/i.test(answer.trim())
  } finally {
    prompt.close()
  }
}

function summarise(result: RunResult, style: Style): string[] {
  const lines: string[] = ['']
  const ran = result.steps.length
  // A command the agent was refused is not a footnote to "completed". The
  // install did not happen, so everything the agent reported afterwards was
  // reported without it — which is the whole failure this exists to end.
  const refusedCommand = result.denials.some((denial) => denial.command !== undefined)

  lines.push(
    refusedCommand && result.status === 'completed'
      ? style.red(`Ran ${ran} step(s), but the agent was refused a command it needed.`)
      : {
          completed: style.green(`Completed. ${ran} step(s).`),
          failed: style.red(`Failed after ${ran} step(s).`),
          'timed-out': style.red(`Timed out after ${ran} step(s).`),
          declined: style.yellow(`Stopped: approval was not given.`),
          refused: style.red(`Did not run.`),
        }[result.status],
  )

  // Every refusal, whatever the run did. Before this the foreground runner
  // collected them and printed none, so the one surface a person watches said
  // nothing at all about the one thing they would want to know.
  for (const denial of result.denials) lines.push(style.yellow(denialMessage(denial)))
  for (const problem of result.problems) lines.push(renderProblem(problem, style))
  if (result.skipped.length > 0) {
    lines.push(style.dim(`Not reached: ${result.skipped.join(', ')}`))
  }
  return lines
}

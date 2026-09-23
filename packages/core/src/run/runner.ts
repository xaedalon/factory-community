import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import type { EventBus } from '@factory/events'
import type { Problem } from '../problems.js'
import type { ResolvedPhase, ResolvedPlan, ResolvedStep } from '../plan/resolve.js'
import { retryPolicy } from '../schema/step.js'
import { agentEnvironment, withheldMessage } from '../security/environment.js'
import { DenialScanner, type Denial } from '../security/denials.js'
import {
  processGroup,
  type ProcessRegistry,
  STOP_GRACE_MS,
  type StopSignal,
} from '../security/processes.js'

/**
 * Running a plan, in the foreground, in one process.
 *
 * Not the eventual engine: there is no queue, no persistence, no worktrees and
 * no lanes. Its job is to prove the definition layer is actually executable —
 * a contract nothing can run is a contract nobody has tested, however cleanly
 * it validates.
 *
 * Two behaviours are here because of specific incidents in the prototype's
 * backlog rather than a wish list. Every stuck-workflow report there was a
 * process that never exited — `dredd` waiting on a confirmation, a dev server
 * running forever, a spawn into a directory that did not exist — so a step has
 * a deadline and the deadline is enforced. And a failed step stops the run
 * rather than carrying on into steps that assume it worked.
 */

export type RunStatus = 'completed' | 'failed' | 'declined' | 'timed-out' | 'refused'

export interface StepOutcome {
  readonly phase: string
  readonly index: number
  readonly describe: string
  readonly exitCode: number | null
  readonly timedOut: boolean
  /** Set when the step could not be started at all. */
  readonly error?: string
  /** How many times it ran. More than one means it was retried. */
  readonly attempts: number
  /**
   * Refusals found in this step's output.
   *
   * Independent of `exitCode`, deliberately. A confined agent that is refused
   * something exits 0 and says so in prose — measured against Claude Code —
   * so tying this to failure would find nothing at all in the ordinary case.
   */
  readonly denials?: readonly Denial[]
}

export interface RunResult {
  readonly status: RunStatus
  readonly steps: readonly StepOutcome[]
  readonly problems: readonly Problem[]
  /** Phases that never ran because something before them stopped the run. */
  readonly skipped: readonly string[]
  /**
   * Every refusal any step reported, de-duplicated by kind.
   *
   * Collected here so the engine has one place to look, rather than walking
   * the steps and deciding for itself what counts.
   */
  readonly denials: readonly Denial[]
}

export interface RunOptions {
  readonly plan: ResolvedPlan
  /**
   * The environment to build each step's from.
   *
   * Required, and handed over rather than read. This module used to spawn with
   * `{ ...process.env }`, which made it the one thing below an entry point
   * reaching for the ambient environment — in a codebase where
   * `PluginContext.env` exists precisely so that nothing does. The practical
   * cost was that every coding agent Factory started inherited every credential
   * the daemon had.
   *
   * Not optional with a `process.env` fallback, because a fallback is the bug
   * with a nicer signature: the caller that forgets is the caller that gets the
   * old behaviour.
   */
  readonly env: Readonly<Record<string, string | undefined>>
  /**
   * Output as it arrives. The CLI writes it straight through; the engine files
   * it against the step, which is why the step is an argument — a callback that
   * only gets the text forces its caller to track "which step is running now"
   * in a variable, and that variable is wrong the moment anything runs in
   * parallel.
   */
  readonly onOutput?: (
    chunk: string,
    stream: 'stdout' | 'stderr',
    step: ResolvedStep,
    phase: ResolvedPhase,
  ) => void
  /** Progress, for a caller that wants to narrate. */
  readonly onStep?: (step: ResolvedStep, phase: ResolvedPhase) => void
  /** How a step ended, for a caller that is writing the run down. */
  readonly onStepDone?: (outcome: StepOutcome, step: ResolvedStep, phase: ResolvedPhase) => void
  /**
   * Skip everything before this phase.
   *
   * How a run that paused at an approval gate continues: the phases before the
   * gate already ran, and running them again would repeat their side effects.
   */
  readonly startPhase?: number
  /**
   * True when this run is picking up from an approval that was already given.
   *
   * Only a `before` gate needs to know. It sits at the top of its phase and the
   * run resumes *into* that phase — so without this it would ask again the
   * moment it was let through, and go on asking for ever. An `after` gate
   * resumes past itself and never sees this.
   */
  readonly approved?: boolean
  /** Asked at a phase's approval gate, before or after its steps. */
  readonly onApproval?: (phase: ResolvedPhase) => Promise<boolean>
  /** Print what would run and execute nothing. */
  readonly dryRun?: boolean
  /** Seconds a single step may take before it is killed. */
  readonly timeoutSeconds?: number
  readonly events?: EventBus
  readonly runId?: string
  /**
   * Where to register each step's process so something outside can stop it.
   *
   * Without this the handle lives and dies inside one promise closure, which is
   * why cancelling a run used to flip a row and leave the agent running. Needs
   * `runId` to key on; a caller that supplies neither gets the old behaviour and
   * no kill switch, which is what a `--dry-run` and an in-memory run want.
   */
  readonly processes?: ProcessRegistry
  /** Injected so a retry delay is testable without waiting for it. */
  readonly wait?: (seconds: number) => Promise<void>
}

/** A step gets this long before it is killed, unless the caller says otherwise. */
export const DEFAULT_STEP_TIMEOUT_SECONDS = 1800

export async function runPlan(options: RunOptions): Promise<RunResult> {
  const { plan } = options
  const runId = options.runId ?? `run-${Date.now()}`
  const steps: StepOutcome[] = []
  const problems: Problem[] = []

  // One pass, and a warning. A loop is a *scheduling* property — what repeats
  // the workflow, and how long it waits, belongs to the scheduler — so the
  // runner's job is the same either way. Saying so matters: a foreground run
  // that quietly stopped after one pass is what made this confusing before.
  if (plan.mode === 'loop') {
    problems.push({
      severity: 'warning',
      message:
        `"${plan.workflow}" is a loop workflow. This runs one pass; the scheduler is what ` +
        `repeats it` +
        (plan.interval === undefined ? '.' : ` every ${plan.interval}s.`),
      rule: 'run.loopSinglePass',
    })
  }

  if (plan.requires.length > 0) {
    problems.push({
      severity: 'warning',
      message:
        `"${plan.workflow}" requires ${plan.requires.join(', ')}. A foreground run has no task to ` +
        `carry flags, so the requirement is not being checked — the scheduler enforces it.`,
      rule: 'run.conditionsIgnored',
    })
  }

  options.events?.emit('run.started', { runId, workflow: plan.workflow })

  for (const [phaseIndex, phase] of plan.phases.entries()) {
    if (phaseIndex < (options.startPhase ?? 0)) continue

    // An authorisation gate: nothing of this phase has run, and nothing will
    // until somebody says so. Resume *into* this phase, so approving runs the
    // steps that were being asked about rather than skipping them.
    //
    // Skipped when the run is resuming into the very phase that parked it:
    // that is this gate, and it has already been answered.
    const alreadyAnswered = options.approved === true && phaseIndex === (options.startPhase ?? 0)
    if (phase.approval === 'before' && !alreadyAnswered) {
      const verdict = await gate(phase, 'before', phaseIndex)
      if (verdict !== undefined) return verdict
    }

    for (const step of phase.steps) {
      options.onStep?.(step, phase)
      options.events?.emit('step.started', {
        runId,
        phase: phase.name,
        index: step.index,
        uses: step.uses,
      })

      if (options.dryRun === true) {
        const planned = {
          phase: phase.name,
          index: step.index,
          describe: step.planned.describe,
          exitCode: 0,
          timedOut: false,
          attempts: 0,
        }
        steps.push(planned)
        options.onStepDone?.(planned, step, phase)
        continue
      }

      const outcome = await attemptStep(step, phase, options)
      steps.push(outcome)
      options.onStepDone?.(outcome, step, phase)

      if (outcome.exitCode !== 0 || outcome.timedOut) {
        options.events?.emit('step.failed', {
          runId,
          phase: phase.name,
          index: step.index,
          exitCode: outcome.exitCode ?? -1,
          message: outcome.error ?? (outcome.timedOut ? 'timed out' : 'failed'),
        })
        problems.push({
          severity: 'error',
          message: outcome.timedOut
            ? `Step ${step.index} of "${phase.name}" was killed after ` +
              `${options.timeoutSeconds ?? DEFAULT_STEP_TIMEOUT_SECONDS}s: ${step.planned.describe}`
            : `Step ${step.index} of "${phase.name}" exited ${outcome.exitCode}: ` +
              `${step.planned.describe}`,
          field: `${phase.name}.steps.${step.index}`,
          rule: outcome.timedOut ? 'run.stepTimedOut' : 'run.stepFailed',
        })

        const status: RunStatus = outcome.timedOut ? 'timed-out' : 'failed'
        return finish(status, phaseIndex + 1)
      }

      options.events?.emit('step.completed', {
        runId,
        phase: phase.name,
        index: step.index,
        exitCode: outcome.exitCode ?? 0,
      })
    }

    // A review gate: the steps have run, so the point is to look at what they
    // produced before anything downstream acts on it. Resume past this phase.
    if (phase.approval === 'after') {
      const verdict = await gate(phase, 'after', phaseIndex + 1)
      if (verdict !== undefined) return verdict
    }
  }

  return finish('completed', plan.phases.length)

  /**
   * Ask, and say what to do about the answer.
   *
   * Returns a finished run when the answer was no (or nobody was there to give
   * one), and `undefined` to carry on. `resumeFrom` is the whole difference
   * between the two kinds of gate: a review gate has already done its work and
   * continues after itself, while an authorisation gate has not started and
   * must come back to the same phase.
   */
  async function gate(
    phase: ResolvedPhase,
    when: 'before' | 'after',
    resumeFrom: number,
  ): Promise<RunResult | undefined> {
    options.events?.emit('approval.requested', { runId, phase: phase.name })

    // A dry run is a preview: stopping at the first gate would hide the rest of
    // the plan, which is the one thing the preview is for.
    if (options.dryRun === true) {
      problems.push({
        severity: 'warning',
        message: `"${phase.name}" would pause ${when} its steps for approval.`,
        rule: 'run.wouldPause',
      })
      return undefined
    }

    if ((await options.onApproval?.(phase)) ?? false) {
      options.events?.emit('approval.granted', { runId, phase: phase.name })
      return undefined
    }

    problems.push({
      severity: 'warning',
      message:
        when === 'before'
          ? `Stopped before "${phase.name}" — approval was not given.`
          : `Stopped after "${phase.name}" — approval was not given.`,
      rule: 'run.declined',
    })
    return finish('declined', resumeFrom)
  }

  function finish(status: RunStatus, phasesReached: number): RunResult {
    options.events?.emit('run.completed', {
      runId,
      workflow: plan.workflow,
      ok: status === 'completed',
    })
    // One entry per kind of refusal across the whole run, not per step. An
    // agent refused the same thing in three phases has one problem.
    const denials = new Map<string, Denial>()
    for (const step of steps) {
      for (const denial of step.denials ?? []) {
        if (!denials.has(denial.id)) denials.set(denial.id, denial)
      }
    }

    return {
      status,
      steps,
      problems,
      skipped: plan.phases.slice(phasesReached).map((phase) => phase.name),
      denials: [...denials.values()],
    }
  }
}

/**
 * Run a step, and run it again if it failed and is allowed to.
 *
 * Agent CLIs fail transiently — a rate limit, a dropped connection, a model
 * that returns nothing — and the prototype's answer was for a person to notice
 * a blocked task and press retry, which re-ran the entire workflow. A step that
 * says `retries: 2` retries itself, and the run carries on as if nothing
 * happened.
 *
 * A timeout is not retried: the step was killed for taking too long, and doing
 * that three times costs three times as long to reach the same conclusion.
 */
async function attemptStep(
  step: ResolvedStep,
  phase: ResolvedPhase,
  options: RunOptions,
): Promise<StepOutcome> {
  const policy = retryPolicy(step.raw)
  const wait = options.wait ?? ((seconds) => new Promise((done) => setTimeout(done, seconds * 1000)))

  let outcome = await runStep(step, phase, options)
  let attempts = 1

  while (attempts < policy.attempts && outcome.exitCode !== 0 && !outcome.timedOut) {
    options.onOutput?.(
      `factory: step failed (${outcome.exitCode}); retrying ${attempts} of ${policy.attempts - 1}\n`,
      'stderr',
      step,
      phase,
    )
    if (policy.delaySeconds > 0) await wait(policy.delaySeconds)
    // `retryArgs` where the plan supplied them: a first attempt that *started*
    // an agent session cannot be repeated, because the CLI refuses an id it
    // has already seen. Without this a step with `retries:` would fail every
    // attempt after the first with "Session ID … is already in use" — and the
    // failure would look like the step's own.
    outcome = await runStep(step, phase, options, { retry: true })
    attempts += 1
  }

  return { ...outcome, attempts }
}

function runStep(
  step: ResolvedStep,
  phase: ResolvedPhase,
  options: RunOptions,
  attempt: { retry: boolean } = { retry: false },
): Promise<StepOutcome> {
  const seconds = options.timeoutSeconds ?? DEFAULT_STEP_TIMEOUT_SECONDS
  const base = {
    phase: phase.name,
    index: step.index,
    describe: step.planned.describe,
    attempts: 1,
  }

  return new Promise((resolve) => {
    const args =
      attempt.retry && step.planned.retryArgs !== undefined
        ? step.planned.retryArgs
        : step.planned.args
    // The profile decides what the step may see. `step.planned.env` is merged
    // *after* the filter, so a descriptor's own variables always survive — they
    // are Factory's, not the machine's.
    const filtered = agentEnvironment(options.env, {
      profile: options.plan.profile,
      ...(step.planned.passEnv === undefined ? {} : { keep: step.planned.passEnv }),
    })
    if (filtered.withheld.length > 0) {
      // Against the step, because that is where somebody debugging "it cannot
      // reach the registry" will be looking. Names, never values.
      options.onOutput?.(`${withheldMessage(filtered.withheld)}\n`, 'stderr', step, phase)
    }

    // `stdin:` on a planned step is a file to redirect in, which several agent
    // CLIs need to run headless. It was carried this far and then dropped:
    // `--dry-run` printed `< prompt.txt` and the process got nothing. Opened
    // here rather than in the plan, because a plan is pure and a file
    // descriptor is not.
    let input: number | undefined
    if (step.planned.stdin !== undefined) {
      try {
        input = openSync(step.planned.stdin, 'r')
      } catch (error) {
        // The step's failure, not the runner's. Reported the way a command
        // that will not start is reported, because that is what it is.
        const because = error instanceof Error ? error.message : String(error)
        options.onOutput?.(`cannot open ${step.planned.stdin}: ${because}\n`, 'stderr', step, phase)
        resolve({ ...base, exitCode: null, timedOut: false, error: because })
        return
      }
    }

    const child = spawn(step.planned.command, [...args], {
      cwd: phase.cwd,
      env: { ...filtered.env, ...step.planned.env },
      // A step that expects input and asked for none has nobody to provide it.
      // Closing stdin makes it fail fast instead of blocking until the
      // deadline.
      stdio: [input ?? 'ignore', 'pipe', 'pipe'],
      // Its own process group, which is what makes stopping it possible at all.
      // A step is almost always `bash -c '…'`, and the work is a grandchild:
      // signalling the one pid killed the shell and left `npm test` running.
      //
      // Not `unref()`ed, unlike the detached tool launcher — this process is
      // exactly what the run is waiting for.
      detached: true,
    })

    // The child has its own duplicate of the descriptor by now, so this one is
    // ours to close — and leaving it open would leak one per step.
    if (input !== undefined) closeSync(input)

    // Registered before anything can be awaited, so there is no window in which
    // a running process is unknown to the thing that stops processes.
    const target = processGroup(child)
    const forget =
      target === undefined || options.runId === undefined
        ? undefined
        : options.processes?.add(options.runId, target)

    let timedOut = false
    let settled = false

    // SIGTERM first so the process can clean up, then SIGKILL if it will not
    // go. A step that ignores both would otherwise hold the run open forever.
    //
    // The group, not the pid: a deadline that killed only `bash` left the work
    // it started running for as long as it liked, and the run reported a
    // timeout while the machine stayed busy.
    const deadline = setTimeout(() => {
      timedOut = true
      const stop = target ?? { kill: (signal: StopSignal) => child.kill(signal) }
      stop.kill('SIGTERM')
      setTimeout(() => stop.kill('SIGKILL'), STOP_GRACE_MS)
    }, seconds * 1000)

    // Watched for refusals as it goes, because a confined agent reports being
    // refused and then exits 0 — there is no failure to inspect afterwards.
    const scanner = new DenialScanner(step.planned.denialPatterns ?? [])
    const observe = (text: string, stream: 'stdout' | 'stderr'): void => {
      scanner.push(text)
      options.onOutput?.(text, stream, step, phase)
    }

    child.stdout?.on('data', (data: Buffer) => observe(data.toString(), 'stdout'))
    child.stderr?.on('data', (data: Buffer) => observe(data.toString(), 'stderr'))

    const done = (partial: StepOutcome) => {
      if (settled) return
      settled = true
      const found = scanner.denials()
      const outcome: StepOutcome = {
        ...partial,
        ...(found.length === 0 ? {} : { denials: found }),
      }
      clearTimeout(deadline)
      // Forgotten here rather than where it was stopped: this is the only moment
      // the process is actually gone, and a pid remembered after that is a pid
      // the operating system may have given to something else.
      forget?.()
      resolve(outcome)
    }

    child.on('error', (error) =>
      done({ ...base, exitCode: null, timedOut, error: error.message }),
    )
    child.on('close', (code) => done({ ...base, exitCode: code, timedOut }))
  })
}

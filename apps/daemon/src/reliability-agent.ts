import { spawn } from 'node:child_process'
import { openSync, closeSync } from 'node:fs'
import {
  PROVIDER_KIND,
  agentEnvironment,
  type EvaluatorAgent,
  type ExecutionProfile,
  type Project,
  type ProviderCapability,
} from '@factory/core'
import type { Runtime } from '@factory/runtime'

/**
 * How the daemon lets an evaluator ask an agent something.
 *
 * The evaluator is a plugin and knows nothing about processes: it hands over a
 * prompt and gets text back. Everything between — choosing a provider, deciding
 * it is actually installed, rendering the argv, filtering the environment,
 * enforcing a deadline — happens here, where the registry, the settings and the
 * project's profile already are.
 *
 * `undefined` is the answer to every reason it cannot happen: judging switched
 * off, no model chosen, no provider installed, the provider's binary missing.
 * None of them is an error. The deterministic evaluator still runs, the task is
 * still judged, and the only difference is that nobody read the work.
 */

/** Long enough to read a task's evidence, short enough not to hold a verdict. */
export const ASK_TIMEOUT_MS = 180_000

/** What comes back is a judgement, not a transcript. Anything longer is a bug. */
export const MAX_ANSWER_BYTES = 256_000

export interface AgentForOptions {
  readonly runtime: Runtime
  readonly project: Project | undefined
  readonly profile: ExecutionProfile
  /** Where to run it. The project's own directory: it is reading, not writing. */
  readonly cwd: string | undefined
}

export function agentFor(options: AgentForOptions): EvaluatorAgent | undefined {
  const { runtime, project, profile, cwd } = options
  if (project === undefined) return undefined
  if (!project.reliabilityEnabled) return undefined

  // No model chosen is not "use a default". Falling back to a model named in
  // Factory's own source would spend somebody's tokens on a decision they never
  // made, and the whole point of the setting is that the choice is theirs.
  const model = project.reliabilityModel
  if (model === undefined) return undefined

  const provider = chooseProvider(runtime)
  if (provider === undefined) return undefined
  if (cwd === undefined) return undefined

  return {
    model,
    ask: (prompt) => ask({ runtime, provider, model, prompt, profile, cwd }),
  }
}

/**
 * Which agent reads the work.
 *
 * The first provider whose CLI is actually on this machine, in registration
 * order. Registered, not merely present in the catalogue: Factory ships three
 * provider plugins and almost nobody has three CLIs installed, so "how many are
 * registered" is not the question — "how many can be run" is.
 *
 * Deliberately not the ambiguity failure a step's planner raises. An evaluator
 * is not a step somebody wrote, so a machine with two CLIs gets a judgement from
 * the first rather than a planning error on a run that succeeded. It matters
 * only in that the model a project names has to be one that provider
 * understands, which is why `docs/reliability/evaluators.md` says which one is
 * chosen and the board's field says so too.
 */
function chooseProvider(runtime: Runtime): ProviderCapability | undefined {
  return runtime.host
    .list<ProviderCapability>(PROVIDER_KIND)
    .map((entry) => entry.capability)
    .find((candidate) => candidate.availability(runtime.env).available)
}

function ask(options: {
  runtime: Runtime
  provider: ProviderCapability
  model: string
  prompt: string
  profile: ExecutionProfile
  cwd: string
}): Promise<string> {
  const { runtime, provider, model, prompt, profile, cwd } = options
  // `session: none` throughout: a judgement is a question asked once, and a
  // session id would make the second assessment of a task continue the first
  // one's conversation — which is how an evaluator learns to agree with itself.
  const rendered = provider.render({ prompt, model, profile, session: 'none' })
  const filtered = agentEnvironment(runtime.env, {
    profile,
    ...(rendered.passEnv === undefined ? {} : { keep: rendered.passEnv }),
  })

  return new Promise<string>((resolve, reject) => {
    let input: number | undefined
    if (rendered.stdin !== undefined) {
      try {
        input = openSync(rendered.stdin, 'r')
      } catch (error) {
        reject(new Error(error instanceof Error ? error.message : String(error)))
        return
      }
    }

    const child = spawn(rendered.command, [...rendered.args], {
      cwd,
      env: { ...filtered.env, ...rendered.env },
      stdio: [input ?? 'ignore', 'pipe', 'pipe'],
      // Its own group, for the same reason the runner does it: the deadline
      // below has to be able to stop whatever the CLI started, not only the CLI.
      detached: true,
    })
    if (input !== undefined) closeSync(input)

    let out = ''
    let err = ''
    let settled = false
    const finish = (outcome: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      outcome()
    }

    const deadline = setTimeout(() => {
      try {
        process.kill(-child.pid!, 'SIGTERM')
      } catch {
        child.kill('SIGTERM')
      }
      finish(() =>
        reject(
          new Error(
            `${provider.id} did not answer within ${String(ASK_TIMEOUT_MS / 1000)} seconds.`,
          ),
        ),
      )
    }, ASK_TIMEOUT_MS)

    // Capped rather than streamed to a file: this is one answer, and a CLI that
    // decides to narrate its whole session should not be able to take the
    // daemon's memory with it.
    child.stdout?.on('data', (chunk: Buffer) => {
      if (out.length < MAX_ANSWER_BYTES) out += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (err.length < 4_000) err += chunk.toString('utf8')
    })

    child.on('error', (error) => {
      finish(() => reject(error))
    })
    child.on('close', (code) => {
      finish(() => {
        // A non-zero exit with usable output is still an answer — several CLIs
        // exit non-zero on a refusal they nonetheless explained. An empty one
        // is not, and saying so beats handing the parser an empty string and
        // letting it report "not JSON".
        if (out.trim() === '') {
          reject(
            new Error(
              `${provider.id} exited ${String(code)} with nothing to read${
                err.trim() === '' ? '' : `: ${err.trim().slice(0, 200)}`
              }`,
            ),
          )
          return
        }
        resolve(out)
      })
    })
  })
}

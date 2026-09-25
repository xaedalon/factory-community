import { spawn } from 'node:child_process'
import { openSync, closeSync } from 'node:fs'
import {
  PROVIDER_KIND,
  agentEnvironment,
  checkProviderSettings,
  resolveJudge,
  type EvaluatorAgent,
  type ExecutionProfile,
  type Problem,
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

/**
 * The judge, and anything worth saying about why there is not one.
 *
 * `agent` absent is still not an error — the deterministic evaluator runs, the
 * task is judged, and the only difference is that nobody read the work. But
 * absent *because somebody named a CLI that is not installed* is worth a
 * sentence: an absence that is not reported is a flag that reads correctly and
 * does nothing.
 */
export interface JudgeFor {
  readonly agent?: EvaluatorAgent
  readonly problems: readonly Problem[]
}

export function agentFor(options: AgentForOptions): JudgeFor {
  const { runtime, project, profile, cwd } = options
  if (project === undefined) return { problems: [] }
  if (!project.reliabilityEnabled) return { problems: [] }

  // The project's choice, then the installation's, then nothing — decided in
  // `resolveJudge` rather than here, because the board has to show the same
  // answer and two implementations of a precedence rule is one that is wrong.
  const installation = runtime.settings.current().reliability
  const chosen = resolveJudge({
    project: {
      ...(project.reliabilityProvider === undefined ? {} : { provider: project.reliabilityProvider }),
      ...(project.reliabilityModel === undefined ? {} : { model: project.reliabilityModel }),
      ...(project.reliabilityEffort === undefined ? {} : { effort: project.reliabilityEffort }),
    },
    installation,
  })

  // No model chosen is not "use a default". Falling back to a model named in
  // Factory's own source would spend somebody's tokens on a decision they never
  // made, and the whole point of the setting is that the choice is theirs.
  const model = chosen.model
  if (model === undefined) return { problems: [] }

  const named = chosen.provider
  const provider = named === undefined ? chooseProvider(runtime) : providerNamed(runtime, named)
  if (provider === undefined) {
    // Named and missing is reported; nothing named and nothing installed is not.
    // Nobody stated anything in the second case, so nothing was disappointed.
    if (named === undefined) return { problems: [] }
    return {
      problems: [
        {
          severity: 'warning',
          message:
            `"${named}" is this project's judge, and ${reasonFor(runtime, named)} — so nothing ` +
            `read the work. The deterministic evaluator still ran.`,
          rule: 'reliability.judgeUnavailable',
        },
      ],
    }
  }
  if (cwd === undefined) return { problems: [] }

  // An effort the CLI has no flag for is ignored rather than refused, which is
  // exactly what an agent step's own effort does — same function, same words.
  const problems = checkProviderSettings(provider, {
    model,
    ...(chosen.effort === undefined ? {} : { effort: chosen.effort }),
  })

  return {
    agent: {
      model,
      ask: (prompt) =>
        ask({
          runtime,
          provider,
          model,
          prompt,
          profile,
          cwd,
          ...(chosen.effort === undefined ? {} : { effort: chosen.effort }),
        }),
    },
    problems,
  }
}

/** The provider somebody named, whether or not its command can be run. */
function providerNamed(runtime: Runtime, id: string): ProviderCapability | undefined {
  const found = runtime.host
    .list<ProviderCapability>(PROVIDER_KIND)
    .map((entry) => entry.capability)
    .find((candidate) => candidate.id === id)
  if (found === undefined) return undefined
  return found.availability(runtime.env).available ? found : undefined
}

/**
 * Why a named provider is not the judge, in words that distinguish the two
 * causes: nobody registered it, or it is registered and its command is missing.
 */
function reasonFor(runtime: Runtime, id: string): string {
  const registered = runtime.host
    .list<ProviderCapability>(PROVIDER_KIND)
    .some((entry) => entry.capability.id === id)
  return registered
    ? 'its command was not found on this machine'
    : 'no such provider is registered'
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
  effort?: string
}): Promise<string> {
  const { runtime, provider, model, prompt, profile, cwd, effort } = options
  // `session: none` throughout: a judgement is a question asked once, and a
  // session id would make the second assessment of a task continue the first
  // one's conversation — which is how an evaluator learns to agree with itself.
  const rendered = provider.render({
    prompt,
    model,
    profile,
    session: 'none',
    ...(effort === undefined ? {} : { effort }),
  })
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

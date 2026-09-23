import type { Problem } from '../problems.js'
import type { Agent } from '../schema/agent.js'
import type { Phase } from '../schema/phase.js'
import type { Step } from '../schema/step.js'
import type { Workflow } from '../schema/workflow.js'
import { BUNDLE_KIND, type Bundle } from './schema.js'

/**
 * Collect a workflow and everything it needs into one file.
 *
 * The recipient imports a single document and it works, which is the whole
 * point: a workflow that arrives without its phases is not shareable, it is a
 * puzzle.
 */

export interface ExportLookups {
  readonly workflow: (name: string) => Workflow | undefined
  readonly phase: (name: string) => Phase | undefined
  readonly agent: (name: string) => Agent | undefined
}

export interface ExportOptions {
  readonly entry: string
  readonly lookups: ExportLookups
  readonly exportedBy?: string
  readonly exportedAt?: string
  readonly sourceScope?: string
  /**
   * Emit a bundle even when something it references is missing, recording the
   * gaps in metadata. Off by default: a bundle that silently omits a phase is
   * the prototype's silent-drop bug wearing a different hat.
   */
  readonly allowMissing?: boolean
}

export interface ExportResult {
  readonly bundle?: Bundle
  readonly problems: readonly Problem[]
}

/**
 * The agents a phase's steps name.
 *
 * Read off the step's own `agent` field rather than by asking the step kind,
 * because export has no capability host — and a bundle should be buildable
 * from definitions alone, without the plugin that runs them being installed.
 */
const agentsNamedBy = (phase: Phase): string[] =>
  phase.steps
    .map((step: Step) => (step as { agent?: unknown }).agent)
    .filter((name): name is string => typeof name === 'string' && name !== '')

/** A runaway guard, not a cycle detector — cycles are handled by the visited set. */
const MAX_DEFINITIONS = 100

export function buildBundle(options: ExportOptions): ExportResult {
  const { entry, lookups } = options
  const problems: Problem[] = []
  const workflows = new Map<string, Workflow>()
  const phases = new Map<string, Phase>()
  const agents = new Map<string, Agent>()
  const unresolved: string[] = []

  // Iterative worklist with a visited set. `a.on_fail: b` and `b.on_fail: a` is
  // a perfectly reasonable retry pair, so a cycle terminates here rather than
  // being reported as an error — the visited set is what makes that free.
  const queue = [entry]
  const seen = new Set<string>()

  while (queue.length > 0) {
    const name = queue.shift() as string
    if (seen.has(name)) continue
    seen.add(name)

    if (workflows.size + phases.size + agents.size > MAX_DEFINITIONS) {
      problems.push({
        severity: 'error',
        message:
          `Export stopped after ${MAX_DEFINITIONS} definitions. That is far more than a ` +
          `workflow should need — something is probably referencing itself in a loop.`,
        rule: 'bundle.tooLarge',
      })
      break
    }

    const workflow = lookups.workflow(name)
    if (workflow === undefined) {
      unresolved.push(name)
      problems.push({
        severity: options.allowMissing === true ? 'warning' : 'error',
        message: `Workflow "${name}" does not exist, so the bundle would be incomplete.`,
        rule: 'bundle.missingWorkflow',
      })
      continue
    }
    workflows.set(name, workflow)

    for (const phaseName of workflow.phases) {
      if (phases.has(phaseName)) continue
      const phase = lookups.phase(phaseName)
      if (phase === undefined) {
        unresolved.push(phaseName)
        problems.push({
          severity: options.allowMissing === true ? 'warning' : 'error',
          message:
            `Workflow "${name}" needs a phase "${phaseName}" that does not exist, ` +
            `so the bundle would be incomplete.`,
          rule: 'bundle.missingPhase',
        })
        continue
      }
      phases.set(phaseName, phase)

      // The third edge of the graph: a step may name an agent, and that agent
      // is as much a part of the workflow as the phase holding the step.
      for (const agentName of agentsNamedBy(phase)) {
        if (agents.has(agentName)) continue
        const agent = lookups.agent(agentName)
        if (agent === undefined) {
          unresolved.push(agentName)
          problems.push({
            severity: options.allowMissing === true ? 'warning' : 'error',
            message:
              `Phase "${phaseName}" uses an agent "${agentName}" that does not exist, ` +
              `so the bundle would be incomplete.`,
            rule: 'bundle.missingAgent',
          })
          continue
        }
        agents.set(agentName, agent)
      }
    }

    // The two edges a workflow has to another workflow. `on_fail` was followed
    // from the start; `needs` was not, so exporting a pipeline of five was five
    // exports and a merge by hand — and the merge is where a mistake lands
    // unnoticed. The visited set above makes a cycle in either free.
    if (workflow.onFail !== undefined) queue.push(workflow.onFail)
    for (const needed of workflow.needs) queue.push(needed)
  }

  if (problems.some((problem) => problem.severity === 'error')) return { problems }

  return {
    bundle: {
      kind: BUNDLE_KIND,
      metadata: {
        name: entry,
        description: lookups.workflow(entry)?.description ?? '',
        exportedAt: options.exportedAt ?? new Date().toISOString(),
        exportedBy: options.exportedBy ?? 'factory',
        sourceScope: options.sourceScope ?? '',
        unresolved: [...new Set(unresolved)],
      },
      entry: { workflow: entry },
      workflows: [...workflows.values()],
      phases: [...phases.values()],
      agents: [...agents.values()],
    },
    problems,
  }
}

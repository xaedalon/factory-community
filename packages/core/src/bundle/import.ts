import type { Problem } from '../problems.js'
import type { Agent } from '../schema/agent.js'
import type { Profile } from '../schema/profile.js'
import type { Phase } from '../schema/phase.js'
import type { Workflow } from '../schema/workflow.js'
import type { Bundle } from './schema.js'

/**
 * Planning an import.
 *
 * Every import is planned first and applied second, through the same code —
 * `--dry-run` is the plan with the apply step skipped, not a separate path that
 * can drift from the real one. The UI import screen renders exactly this object.
 */

export type ConflictPolicy = 'fail' | 'skip' | 'overwrite'

/**
 * The kinds a bundle can carry.
 *
 * Declared here rather than imported from `@factory/config`: core does not
 * depend on config, and this union was previously written out inline at six
 * separate sites, so a third kind meant finding all six.
 */
export type BundledKind = 'workflow' | 'phase' | 'agent' | 'profile'

export interface ImportTargetLookup {
  /** Does a definition of this name already exist in the *target* scope? */
  readonly existsInTarget: (kind: BundledKind, name: string) => boolean
  /** Where would it land? */
  readonly targetPath: (kind: BundledKind, name: string) => string
  /**
   * Does a definition of this name exist in a scope the target would hide?
   * Not a conflict — a shadow, which is silent and surprising unless it is said.
   */
  readonly wouldShadow: (kind: BundledKind, name: string) => string | undefined
}

export interface ImportOptions {
  readonly bundle: Bundle
  readonly lookup: ImportTargetLookup
  readonly policy?: ConflictPolicy
  /** Rename everything, rewriting references inside the bundle to match. */
  readonly prefix?: string
}

/**
 * `conflict` is distinct from `overwrite` on purpose: under the default policy
 * a clashing name is not going to be written at all, and a row that says
 * "overwrite" next to a file nothing will touch is a small lie the reader has
 * to catch.
 */
export type ImportAction = 'create' | 'overwrite' | 'skip' | 'conflict'

export interface ImportItem {
  readonly kind: BundledKind
  readonly name: string
  /** The name after any prefix. */
  readonly targetName: string
  readonly action: ImportAction
  readonly targetPath: string
  readonly conflicts: boolean
  /** Scope whose copy this would hide once written. */
  readonly shadows?: string
}

export interface ImportPlan {
  /** The renamed entry workflow, when the bundle named one. */
  readonly entry?: string
  readonly items: readonly ImportItem[]
  readonly problems: readonly Problem[]
  /** Definitions rewritten to the target names, ready to serialize. */
  readonly workflows: readonly Workflow[]
  readonly phases: readonly Phase[]
  readonly agents: readonly Agent[]
  readonly profiles: readonly Profile[]
}

export function planImport(options: ImportOptions): ImportPlan {
  const policy = options.policy ?? 'fail'
  const prefix = options.prefix ?? ''
  const { bundle, lookup } = options

  // Only names carried by the bundle are renamed. A reference to something
  // outside it points at the recipient's own definitions and must stay put.
  const owned = new Set([
    ...bundle.workflows.map((workflow) => workflow.name),
    ...bundle.phases.map((phase) => phase.name),
    ...bundle.agents.map((agent) => agent.name),
    ...bundle.profiles.map((profile) => profile.name),
  ])
  const rename = (name: string): string => (owned.has(name) ? `${prefix}${name}` : name)

  const workflows = bundle.workflows.map((workflow) => ({
    ...workflow,
    name: rename(workflow.name),
    phases: workflow.phases.map(rename),
    ...(workflow.onFail === undefined ? {} : { onFail: rename(workflow.onFail) }),
  }))
  // A step naming an agent is a reference like any other, so a prefix has to
  // rewrite it. Missing this would import a renamed agent and leave every step
  // pointing at the name it used to have.
  const phases = bundle.phases.map((phase) => ({
    ...phase,
    name: rename(phase.name),
    steps: phase.steps.map((step) => {
      const named = (step as { agent?: unknown }).agent
      return typeof named === 'string' ? { ...step, agent: rename(named) } : step
    }),
  }))
  const agents = bundle.agents.map((agent) => ({ ...agent, name: rename(agent.name) }))
  // Only the name: a profile refers to providers and commands, and neither is a
  // definition the bundle carries, so there is nothing else a prefix could
  // rewrite. A project naming the profile is the recipient's own row and is
  // deliberately left alone — an import must not repoint a project at something
  // it did not choose.
  const profiles = bundle.profiles.map((profile) => ({ ...profile, name: rename(profile.name) }))

  const items: ImportItem[] = []
  const problems: Problem[] = []

  const consider = (kind: BundledKind, original: string, targetName: string) => {
    const conflicts = lookup.existsInTarget(kind, targetName)
    const shadows = lookup.wouldShadow(kind, targetName)
    const action: ImportAction = !conflicts
      ? 'create'
      : policy === 'skip'
        ? 'skip'
        : policy === 'fail'
          ? 'conflict'
          : 'overwrite'

    if (conflicts && policy === 'fail') {
      problems.push({
        severity: 'error',
        message:
          `A ${kind} named "${targetName}" already exists here. Import with --on-conflict=skip, ` +
          `--on-conflict=overwrite, or --prefix to bring it in under another name.`,
        rule: 'bundle.conflict',
      })
    }

    items.push({
      kind,
      name: original,
      targetName,
      action,
      targetPath: lookup.targetPath(kind, targetName),
      conflicts,
      ...(shadows === undefined ? {} : { shadows }),
    })
  }

  bundle.workflows.forEach((workflow, index) =>
    consider('workflow', workflow.name, workflows[index]?.name ?? workflow.name),
  )
  bundle.phases.forEach((phase, index) =>
    consider('phase', phase.name, phases[index]?.name ?? phase.name),
  )
  bundle.agents.forEach((agent, index) =>
    consider('agent', agent.name, agents[index]?.name ?? agent.name),
  )
  bundle.profiles.forEach((profile, index) =>
    consider('profile', profile.name, profiles[index]?.name ?? profile.name),
  )

  return {
    ...(bundle.entry === undefined ? {} : { entry: rename(bundle.entry.workflow) }),
    items,
    problems,
    profiles,
    workflows,
    phases,
    agents,
  }
}

/**
 * Whether the plan can be applied.
 *
 * `fail` is atomic on purpose: a half-applied import leaves a workflow whose
 * phases are a mixture of two sources, which is worse than not importing at all
 * and much harder to unpick.
 */
export const canApply = (plan: ImportPlan): boolean =>
  !plan.problems.some((problem) => problem.severity === 'error')

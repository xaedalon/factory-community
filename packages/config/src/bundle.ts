import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { Agent, CapabilityLookup, Phase, Problem, Profile, Workflow } from '@factory/core'
import {
  BUNDLE_KIND,
  buildBundle,
  canApply,
  parseAgentFile,
  parseBundleEnvelope,
  parsePhaseFile,
  parseProfileFile,
  parseWorkflowFile,
  planImport,
  writeNewAgent,
  writeNewPhase,
  writeNewProfile,
  writeNewWorkflow,
  type Bundle,
  type ConflictPolicy,
  type ImportPlan,
} from '@factory/core'
import type { ScopeChain, ScopeKind } from './scopes.js'

// Re-exported so a caller configuring an import needs one import, not two.
export type { Bundle, ConflictPolicy, ImportItem, ImportPlan } from '@factory/core'
import { definitionPath, resolveAgent, resolvePhase, resolveWorkflow, writeTarget } from './store.js'

/**
 * Bundles on disk: read one, write one, apply one.
 *
 * The model lives in core with injected lookups so that planning an import is
 * testable without a filesystem. This binds it to real scopes.
 */

export interface ExportOutcome {
  readonly text?: string
  readonly bundle?: Bundle
  readonly problems: readonly Problem[]
}

export function exportWorkflow(options: {
  chain: ScopeChain
  host: CapabilityLookup
  name: string
  allowMissing?: boolean
  exportedAt?: string
  exportedBy?: string
}): ExportOutcome {
  const source = resolveWorkflow(options.chain, options.name)

  const result = buildBundle({
    entry: options.name,
    lookups: {
      workflow: (name) => resolveWorkflow(options.chain, name)?.value,
      phase: (name) => resolvePhase(options.chain, options.host, name)?.value,
      agent: (name) => resolveAgent(options.chain, name)?.value,
    },
    ...(options.allowMissing === undefined ? {} : { allowMissing: options.allowMissing }),
    ...(options.exportedAt === undefined ? {} : { exportedAt: options.exportedAt }),
    ...(options.exportedBy === undefined ? {} : { exportedBy: options.exportedBy }),
    ...(source === undefined ? {} : { sourceScope: source.ref.scope }),
  })

  if (result.bundle === undefined) return { problems: result.problems }

  return {
    bundle: result.bundle,
    text: serializeBundle(result.bundle, options.host),
    problems: result.problems,
  }
}

/**
 * Bundles are written whole, so canonical output is right — there is nothing of
 * the author's to preserve.
 *
 * The definitions inside go through the *same* writers that produce definition
 * files, then straight back through the YAML parser to get a plain object to
 * embed. That is not a detour: writing them from the in-memory shape would emit
 * domain field names (`onFail`) instead of the ones the schema accepts
 * (`on_fail`), and the bundle would not import — a defect that only shows up on
 * the recipient's machine. Round-tripping through the real writer makes the
 * inner form identical to the on-disk form by construction.
 */
export function serializeBundle(bundle: Bundle, host: CapabilityLookup): string {
  return stringifyYaml(
    {
      kind: bundle.kind,
      metadata: bundle.metadata,
      entry: bundle.entry,
      workflows: bundle.workflows.map((workflow) => parseYaml(writeNewWorkflow(workflow))),
      phases: bundle.phases.map((phase) => parseYaml(writeNewPhase(phase, host))),
      agents: bundle.agents.map((agent) => parseYaml(writeNewAgent(agent))),
    },
    { lineWidth: 0 },
  )
}

export interface ReadBundleResult {
  readonly bundle?: Bundle
  readonly problems: readonly Problem[]
}

export function readBundle(text: string, host: CapabilityLookup, file?: string): ReadBundleResult {
  const { envelope, problems } = parseBundleEnvelope(parseYaml(text))
  if (envelope === undefined) return { problems }

  const collected: Problem[] = []
  const workflows: Workflow[] = []
  const phases: Phase[] = []
  const agents: Agent[] = []
  const profiles: Profile[] = []

  // Definitions inside a bundle go through the same schemas as definitions on
  // disk. A bundle is an untrusted document from somewhere else; it does not
  // get a shortcut past validation.
  envelope.workflows.forEach((entry, index) => {
    const parsed = parseWorkflowFile(stringifyYaml(entry), file)
    collected.push(...prefix(parsed.problems, `workflows.${index}`))
    if (parsed.value !== undefined) workflows.push(parsed.value)
  })
  envelope.phases.forEach((entry, index) => {
    const parsed = parsePhaseFile(stringifyYaml(entry), host, file)
    collected.push(...prefix(parsed.problems, `phases.${index}`))
    if (parsed.value !== undefined) phases.push(parsed.value)
  })
  envelope.agents.forEach((entry, index) => {
    const parsed = parseAgentFile(stringifyYaml(entry), file)
    collected.push(...prefix(parsed.problems, `agents.${index}`))
    if (parsed.value !== undefined) agents.push(parsed.value)
  })
  envelope.profiles.forEach((entry, index) => {
    const parsed = parseProfileFile(stringifyYaml(entry), file)
    collected.push(...prefix(parsed.problems, `profiles.${index}`))
    if (parsed.value !== undefined) profiles.push(parsed.value)
  })

  if (collected.some((problem) => problem.severity === 'error')) return { problems: collected }

  return {
    bundle: {
      kind: BUNDLE_KIND,
      metadata: {
        name: envelope.metadata?.name ?? '',
        description: envelope.metadata?.description ?? '',
        exportedAt: envelope.metadata?.exportedAt ?? '',
        exportedBy: envelope.metadata?.exportedBy ?? '',
        sourceScope: envelope.metadata?.sourceScope ?? '',
        unresolved: envelope.metadata?.unresolved ?? [],
      },
      ...(envelope.entry === undefined ? {} : { entry: envelope.entry }),
      workflows,
      phases,
      agents,
      profiles,
    },
    problems: collected,
  }
}

const prefix = (problems: readonly Problem[], path: string): Problem[] =>
  problems.map((problem) => ({
    ...problem,
    field: problem.field === undefined ? path : `${path}.${problem.field}`,
  }))

export interface ApplyOptions {
  readonly chain: ScopeChain
  readonly host: CapabilityLookup
  readonly bundle: Bundle
  readonly scope?: ScopeKind
  readonly policy?: ConflictPolicy
  readonly prefix?: string
  /** Plan only. The plan is identical either way. */
  readonly dryRun?: boolean
}

export interface ApplyResult {
  readonly plan: ImportPlan
  readonly written: readonly string[]
  readonly problems: readonly Problem[]
}

export function importBundle(options: ApplyOptions): ApplyResult {
  const target = writeTarget(options.chain, options.scope)

  const plan = planImport({
    bundle: options.bundle,
    ...(options.policy === undefined ? {} : { policy: options.policy }),
    ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    lookup: {
      existsInTarget: (kind, name) => existsSync(definitionPath(target, kind, name)),
      targetPath: (kind, name) => definitionPath(target, kind, name),
      wouldShadow: (kind, name) => {
        // Only scopes *below* the target can be shadowed by writing here.
        const below = options.chain.scopes.slice(
          options.chain.scopes.findIndex((scope) => scope.kind === target.kind) + 1,
        )
        return below.find((scope) => existsSync(definitionPath(scope, kind, name)))?.kind
      },
    },
  })

  if (options.dryRun === true || !canApply(plan)) {
    return { plan, written: [], problems: plan.problems }
  }

  const written: string[] = []
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')

  for (const item of plan.items) {
    if (item.action === 'skip') continue

    if (item.action === 'overwrite' && existsSync(item.targetPath)) {
      // Keep the previous version. Cheap insurance against "I just lost the
      // workflow I had spent an afternoon tuning".
      const trashed = join(target.root, '.trash', stamp, `${item.kind}s`, `${item.targetName}.yaml`)
      mkdirSync(dirname(trashed), { recursive: true })
      renameSync(item.targetPath, trashed)
    }

    // One writer per kind, keyed rather than nested ternaries — the else branch
    // of a ternary silently absorbs any kind added later.
    const writers: Record<typeof item.kind, () => string> = {
      workflow: () =>
        writeNewWorkflow(plan.workflows.find((w) => w.name === item.targetName) as Workflow),
      phase: () =>
        writeNewPhase(plan.phases.find((p) => p.name === item.targetName) as Phase, options.host),
      agent: () => writeNewAgent(plan.agents.find((a) => a.name === item.targetName) as Agent),
      profile: () =>
        writeNewProfile(plan.profiles.find((p) => p.name === item.targetName) as Profile),
    }
    const text = writers[item.kind]()

    mkdirSync(dirname(item.targetPath), { recursive: true })
    writeFileSync(item.targetPath, text)
    written.push(item.targetPath)
  }

  return { plan, written, problems: plan.problems }
}

export function readBundleFile(path: string, host: CapabilityLookup): ReadBundleResult {
  return readBundle(readFileSync(path, 'utf8'), host, path)
}

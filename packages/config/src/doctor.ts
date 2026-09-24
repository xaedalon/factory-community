import type {
  Capability,
  CapabilityLookup,
  FactoryPlugin,
  Problem,
  ProviderCapability,
} from '@factory/core'
import {
  distinguishesProfiles,
  knownToolDirectories,
  permissionArgsFor,
  PROVIDER_KIND,
  STEP_KIND,
  parseAgentFile,
  parsePhaseFile,
  parseWorkflowFile,
  resolveNeeds,
  type StepKindCapability,
} from '@factory/core'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { declaredPlugins } from './plugins.js'
import { SCOPE_CONFIG_FILE, type ScopeChain } from './scopes.js'
import { readSettings } from './settings.js'
import { listDefinitions, resolveWorkflow, type DefinitionListing } from './store.js'

/**
 * `factory doctor` — check an installation and say what is wrong, precisely.
 *
 * The prototype's backlog asked for exactly this and never got it, and the
 * incidents it records are the reason: a mis-quoted line in a YAML file that
 * failed with no file, no line and no field; a workflow referencing a phase
 * that had been renamed; a provider model id retired by its vendor. Every one
 * of those is cheap to detect and expensive to debug.
 *
 * Rules are a capability, so a project can add its own the same way it adds a
 * step kind — and the built-in rules go through that registry too, which is how
 * we find out whether the registry is good enough.
 */

export const DOCTOR_RULE_KIND = 'doctor-rule'

export interface DoctorContext {
  readonly chain: ScopeChain
  readonly host: CapabilityLookup
  readonly env: Readonly<Record<string, string | undefined>>
  readonly workflows: readonly DefinitionListing[]
  readonly phases: readonly DefinitionListing[]
  readonly agents: readonly DefinitionListing[]
}

export interface DoctorRuleCapability extends Capability {
  readonly summary: string
  check(context: DoctorContext): Problem[] | Promise<Problem[]>
}

export interface DoctorReport {
  readonly problems: readonly Problem[]
  readonly checked: { workflows: number; phases: number; agents: number; rules: number }
}

export async function runDoctor(context: DoctorContext): Promise<DoctorReport> {
  const rules = context.host
    .list<DoctorRuleCapability>(DOCTOR_RULE_KIND)
    .map((entry) => entry.capability)

  const problems: Problem[] = []
  for (const rule of rules) {
    try {
      problems.push(...(await rule.check(context)))
    } catch (error) {
      // A broken rule reports itself and the others still run. Losing every
      // check because one plugin threw is the opposite of what doctor is for.
      problems.push({
        severity: 'error',
        message: `Doctor rule "${rule.id}" threw: ${describe(error)}`,
        rule: 'doctor.ruleThrew',
      })
    }
  }

  return {
    problems,
    checked: {
      workflows: context.workflows.length,
      phases: context.phases.length,
      agents: context.agents.length,
      rules: rules.length,
    },
  }
}

/** Gather everything the rules need, once. */
export function doctorContext(options: {
  chain: ScopeChain
  host: CapabilityLookup
  env: Readonly<Record<string, string | undefined>>
}): DoctorContext {
  const { chain, host } = options
  return {
    chain,
    host,
    env: options.env,
    workflows: listDefinitions(chain, 'workflow', (text, file) => {
      const r = parseWorkflowFile(text, file)
      return { value: r.value, problems: r.problems }
    }),
    phases: listDefinitions(chain, 'phase', (text, file) => {
      const r = parsePhaseFile(text, host, file)
      return { value: r.value, problems: r.problems }
    }),
    agents: listDefinitions(chain, 'agent', (text, file) => {
      const r = parseAgentFile(text, file)
      return { value: r.value, problems: r.problems }
    }),
  }
}

// ---------------------------------------------------------------- built-ins

const definitionsParse: DoctorRuleCapability = {
  id: 'definitions-parse',
  summary: 'Every workflow and phase validates.',
  check: ({ workflows, phases, agents }) => [...workflows, ...phases, ...agents].flatMap((entry) => entry.problems),
}

const phaseReferences: DoctorRuleCapability = {
  id: 'phase-references',
  summary: 'Every phase a workflow names exists.',
  check({ chain, workflows, phases }) {
    const known = new Set(phases.map((entry) => entry.name))
    const problems: Problem[] = []
    for (const entry of workflows) {
      if (!entry.valid) continue
      const workflow = resolveWorkflow(chain, entry.name)?.value
      for (const phase of workflow?.phases ?? []) {
        if (known.has(phase)) continue
        problems.push({
          severity: 'error',
          message: `Workflow "${entry.name}" names a phase "${phase}" that does not exist in any scope.`,
          file: entry.winner.file,
          field: 'phases',
          rule: 'doctor.missingPhase',
        })
      }
    }
    return problems
  },
}

/**
 * A workflow that would run nothing.
 *
 * `phase-references` iterates `workflow?.phases ?? []`, so a workflow with none
 * passes it without a word — and every other rule too. The parser warns, but a
 * warning lives in the file's own problems and nobody opens a file they think
 * is fine.
 *
 * Planning refuses to run one. This is how somebody finds out before a task
 * blocks: a supervised run had a workflow like this on ten tasks, and the first
 * notice anybody got was a run that finished in three milliseconds.
 */
const emptyWorkflows: DoctorRuleCapability = {
  id: 'empty-workflows',
  summary: 'Every workflow lists at least one phase.',
  check({ chain, workflows }) {
    const problems: Problem[] = []
    for (const entry of workflows) {
      if (!entry.valid) continue
      const workflow = resolveWorkflow(chain, entry.name)?.value
      if (workflow === undefined || workflow.phases.length > 0) continue
      problems.push({
        severity: 'warning',
        message:
          `Workflow "${entry.name}" lists no phases, so it will do nothing. ` +
          `A task that runs it is refused rather than finishing instantly — add a phase, or ` +
          `take the workflow off the tasks that name it.`,
        file: entry.winner.file,
        field: 'phases',
        rule: 'doctor.emptyWorkflow',
      })
    }
    return problems
  },
}

const onFailReferences: DoctorRuleCapability = {
  id: 'on-fail-references',
  summary: 'Every on_fail workflow exists.',
  check({ chain, workflows }) {
    const known = new Set(workflows.map((entry) => entry.name))
    const problems: Problem[] = []
    for (const entry of workflows) {
      if (!entry.valid) continue
      const onFail = resolveWorkflow(chain, entry.name)?.value?.onFail
      if (onFail === undefined || known.has(onFail)) continue
      problems.push({
        severity: 'error',
        message: `Workflow "${entry.name}" has on_fail "${onFail}", which does not exist in any scope.`,
        file: entry.winner.file,
        field: 'on_fail',
        rule: 'doctor.missingOnFail',
      })
    }
    return problems
  },
}

const needsReferences: DoctorRuleCapability = {
  id: 'needs-references',
  summary: 'Every workflow a `needs` names exists, and no chain loops.',
  check({ chain, workflows }) {
    const known = new Set(workflows.map((entry) => entry.name))
    const problems: Problem[] = []
    const needsOf = (name: string): readonly string[] | undefined =>
      known.has(name) ? (resolveWorkflow(chain, name)?.value?.needs ?? []) : undefined

    for (const entry of workflows) {
      if (!entry.valid) continue
      for (const predecessor of resolveWorkflow(chain, entry.name)?.value?.needs ?? []) {
        if (known.has(predecessor)) continue
        problems.push({
          severity: 'error',
          message: `Workflow "${entry.name}" needs "${predecessor}", which does not exist in any scope.`,
          file: entry.winner.file,
          field: 'needs',
          rule: 'doctor.missingNeeds',
        })
      }
    }

    // Resolution is the only place a ring can be seen — each file knows one
    // hop. Reported once per ring rather than once per member, which is why
    // the whole set is resolved in one call instead of one call each.
    const cycles = resolveNeeds(
      workflows.filter((entry) => entry.valid).map((entry) => entry.name),
      needsOf,
    ).problems.filter((problem) => problem.rule === 'needs.cycle')
    problems.push(...cycles.map((problem) => ({ ...problem, rule: 'doctor.needsCycle' })))

    return problems
  },
}

const stepKindsRunnable: DoctorRuleCapability = {
  id: 'step-kinds-runnable',
  summary: 'Every installed step kind can actually run.',
  check({ host }) {
    return host
      .list<StepKindCapability>(STEP_KIND)
      .filter((entry) => entry.capability.plan === undefined)
      .map((entry) => ({
        severity: 'warning' as const,
        message:
          `Step kind "${entry.capability.id}" (from ${entry.plugin}) can be written but not run — ` +
          `the plugin does not implement a planner.`,
        rule: 'doctor.stepKindNotRunnable',
      }))
  },
}

const providerAvailability: DoctorRuleCapability = {
  id: 'provider-availability',
  summary: 'Installed agent providers are actually on PATH.',
  check({ chain, host, env }) {
    // The same directories discovery searches, so "looked in" in the message is
    // the truth rather than a shorter version of it.
    const extraDirectories = knownToolDirectories(env)
    // And the file they would actually edit, resolved rather than assumed --
    // the scope directory moved once already, and a message naming the old one
    // sends someone to a path that is not there.
    const writable = chain.scopes.find((scope) => scope.writable)
    const configFile =
      writable === undefined ? undefined : join(writable.root, SCOPE_CONFIG_FILE)
    return host
      .list<ProviderCapability>(PROVIDER_KIND)
      .flatMap((entry) => {
        const provider = entry.capability
        const availability = provider.availability(env, {
          extraDirectories,
          ...(configFile === undefined ? {} : { configFile }),
        })
        const problems: Problem[] = []
        if (!availability.available) {
          problems.push({
            severity: 'warning',
            message:
              `Provider "${provider.id}" is registered but ${availability.reason ?? 'unavailable'}`,
            rule: 'doctor.providerUnavailable',
          })
        }
        if (provider.descriptor.provisional) {
          problems.push({
            severity: 'warning',
            message:
              `Provider "${provider.id}" has an unverified descriptor. ` +
              (provider.descriptor.provisionalNote ?? 'Check its flags before relying on it.'),
            rule: 'doctor.providerProvisional',
          })
        }
        // Degrade by absence, with the absence said out loud. A descriptor
        // written before profiles existed still renders — its one list of
        // arguments is used whichever profile is active — so nothing breaks.
        // But its Default profile is then only as confined as Factory's own
        // boundary and environment filtering make it, with nothing from the CLI
        // itself, and that is worth being told rather than assumed.
        if (!distinguishesProfiles(provider.descriptor)) {
          problems.push({
            severity: 'warning',
            message:
              `Provider "${provider.id}" uses the same permission arguments for every ` +
              `execution profile, so the Default profile does not confine it any further ` +
              `than Factory does. Give its permissionArgs a "default" and a "full-access" ` +
              `list to change that.`,
            rule: 'doctor.providerProfileUnaware',
          })
        }
        // An empty Default list is a provider that claims nothing at all —
        // different from the case above, where it claims the same thing twice.
        else if (permissionArgsFor(provider.descriptor, 'default').length === 0) {
          problems.push({
            severity: 'warning',
            message:
              `Provider "${provider.id}" passes no arguments under the Default profile, so ` +
              `the CLI adds no confinement of its own. Factory's workspace boundary and ` +
              `environment filtering still apply.`,
            rule: 'doctor.providerUnconfined',
          })
        }
        return problems
      })
  },
}

const shadowing: DoctorRuleCapability = {
  id: 'shadowing',
  summary: 'Reports definitions that hide a copy in a lower-precedence scope.',
  check: ({ workflows, phases, agents }) =>
    [...workflows, ...phases, ...agents]
      .filter((entry) => entry.shadowed.length > 0)
      .map((entry) => ({
        severity: 'warning' as const,
        message:
          `"${entry.name}" resolves from the ${entry.winner.scope} scope and hides ` +
          entry.shadowed.map((ref) => `${ref.scope} (${ref.file})`).join(', ') +
          `. This is usually intended; it is reported so it is never a surprise.`,
        file: entry.winner.file,
        rule: 'doctor.shadowed',
      })),
}

/**
 * A scope still at the old `.factory` path.
 *
 * Reported rather than moved. It is somebody's repository, the database may be
 * inside it, and a tool that quietly relocates either is a tool nobody should
 * trust with the other. Naming the exact command is the useful half.
 */
const legacyScopes: DoctorRuleCapability = {
  id: 'scopes-at-the-old-path',
  summary: 'Scopes still living at `.factory` rather than under `.xaedalon`.',
  check: ({ chain }) =>
    chain.scopes
      .filter((scope) => scope.legacy && scope.exists)
      .map((scope) => ({
        severity: 'warning' as const,
        message:
          `The ${scope.kind} scope is still at ${scope.root}. Factory now keeps its files under ` +
          `.xaedalon/, beside whatever else Xaedalon writes: ` +
          `${scope.kind === 'project' ? 'git mv' : 'mv'} ${scope.root} ` +
          `${scope.root.replace(/\.factory$/, join('.xaedalon', '.factory'))}. ` +
          `It is read from the old place until then, database and all.`,
        file: scope.root,
        rule: 'doctor.legacyScope',
      })),
}

/**
 * A scope config that does not parse, which until now failed in silence.
 *
 * `declaredPlugins` and `providerSettings` both swallow a YAML error and carry
 * on — the right behaviour, since a broken config must not stop the tool from
 * starting. Both said so in a comment claiming doctor would report it. **No
 * such rule existed.** So a syntax error in `config.yaml` silently disabled
 * that scope's plugins *and* its provider settings with no diagnostic
 * anywhere, and the first sign was a plugin that had stopped loading.
 *
 * Worth fixing on its own, and more so now that a UI writes plugin state into
 * a file beside it.
 */
const scopeConfigParses: DoctorRuleCapability = {
  id: 'scope-configs-parse',
  summary: 'Every scope config is readable.',
  check: ({ chain }) => {
    const problems: Problem[] = []
    for (const scope of chain.scopes) {
      const file = join(scope.root, SCOPE_CONFIG_FILE)
      if (!existsSync(file)) continue
      try {
        const parsed = parseYaml(readFileSync(file, 'utf8')) as unknown
        // A file of nothing is fine — `factory init` writes comments only.
        if (parsed !== null && (typeof parsed !== 'object' || Array.isArray(parsed))) {
          problems.push({
            severity: 'error',
            message:
              `${file} is not a mapping, so nothing in it is read — this scope's plugins and ` +
              `provider settings are being ignored.`,
            file,
            rule: 'doctor.scopeConfigShape',
          })
        }
      } catch (error) {
        problems.push({
          severity: 'error',
          message:
            `${file} could not be read: ${describe(error)}. This scope's plugins and provider ` +
            `settings are being ignored until it parses.`,
          file,
          rule: 'doctor.scopeConfigUnreadable',
        })
      }
    }
    return problems
  },
}

/**
 * Plugins switched off, said out loud.
 *
 * A warning rather than an error: switching one off is a choice. But it is a
 * choice made on a page and remembered in a file, and "why has that button
 * gone" is a question doctor should be able to answer.
 */
const pluginsSwitchedOff: DoctorRuleCapability = {
  id: 'plugins-switched-off',
  summary: 'Plugins the installation has switched off.',
  check: ({ chain, host }) => {
    const { settings, file } = readSettings(chain)
    const loaded = new Set(host.plugins().map((plugin) => plugin.name))
    return settings.plugins.disabled.map((id) => ({
      severity: 'warning' as const,
      message:
        `The plugin "${id}" is switched off${file === undefined ? '' : ` in ${file}`}. ` +
        (loaded.has(id)
          ? 'It is still loaded in this process; restarting Factory will unload it.'
          : 'It contributes nothing.'),
      ...(file === undefined ? {} : { file }),
      rule: 'doctor.pluginSwitchedOff',
    }))
  },
}

/**
 * An id switched off that nothing claims any more.
 *
 * It is kept rather than pruned — never edit somebody's file behind their
 * back — so the way it stops being confusing is being told about it. A warning,
 * not an error: two machines may share a settings file, and a plugin absent
 * here may be present there.
 */
const unknownDisabledPlugin: DoctorRuleCapability = {
  id: 'unknown-disabled-plugin',
  summary: 'Plugins switched off that no longer exist.',
  check: ({ chain }) => {
    const { settings, file } = readSettings(chain)
    const declared = new Set(declaredPlugins(chain).map((entry) => entry.specifier))
    return settings.plugins.disabled
      .filter((id) => !declared.has(id) && !id.startsWith('@factory/'))
      .map((id) => ({
        severity: 'warning' as const,
        message:
          `"${id}" is switched off, but nothing declares it any more. It is kept in case it ` +
          `comes back; switch it on to forget it.`,
        ...(file === undefined ? {} : { file }),
        rule: 'doctor.unknownDisabledPlugin',
      }))
  },
}

export const BUILTIN_DOCTOR_RULES: readonly DoctorRuleCapability[] = [
  scopeConfigParses,
  pluginsSwitchedOff,
  unknownDisabledPlugin,
  legacyScopes,
  definitionsParse,
  phaseReferences,
  emptyWorkflows,
  onFailReferences,
  needsReferences,
  stepKindsRunnable,
  providerAvailability,
  shadowing,
]

/** The built-in rules, registered like anything else. */
export const builtinDoctorPlugin: FactoryPlugin = {
  name: '@factory/config/builtin-doctor',
  version: '0.1.0',
  register(context) {
    for (const rule of BUILTIN_DOCTOR_RULES) context.provide(DOCTOR_RULE_KIND, rule)
  },
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

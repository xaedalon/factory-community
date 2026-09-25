import type {
  Canonicalise,
  CapabilityLookup,
  ExecutionProfile,
  PlanResult,
  Profile,
  TaskContext,
} from '@factory/core'
import { DEFAULT_PROFILE, isBuiltInProfile, resolvePlan } from '@factory/core'
import type { ScopeChain } from './scopes.js'
import {
  resolveAgent,
  resolvePhase,
  resolveProfileDefinition,
  resolveWorkflow,
} from './store.js'

/**
 * Plan a workflow by name, resolving it and its phases through the scope chain.
 *
 * The core planner takes lookups rather than a chain, so that `@factory/core`
 * never has to depend on `@factory/config` — dependencies point one way, and a
 * plugin planning a workflow in memory does not have to invent a filesystem.
 * This binds the two together for the ordinary case.
 */
export function planWorkflow(options: {
  chain: ScopeChain
  host: CapabilityLookup
  workflow: string
  workspace: string
  task?: TaskContext
  /** Where this task's artifacts go. Defaults beside the workspace. */
  artifacts?: string
  project?: Readonly<Record<string, string>>
  defaultProvider?: string
  /** The agent session this plan's steps share. See `PlanRequest.session`. */
  session?: { readonly id: string; readonly started: boolean }
  /** How much authority this run gets. See `PlanRequest.profile`. */
  profile?: ExecutionProfile
  /** How to resolve a path before comparing it to the workspace. */
  canonical?: Canonicalise
  /** Directories outside the workspace this task's agents may reach. */
  allowedDirectories?: readonly string[]
}): PlanResult {
  const resolved = resolveWorkflow(options.chain, options.workflow)

  if (resolved === undefined) {
    return {
      problems: [
        {
          severity: 'error',
          message: `No workflow named "${options.workflow}" in any scope.`,
          rule: 'plan.missingWorkflow',
        },
      ],
    }
  }
  if (resolved.value === undefined) {
    // The winning file exists but does not validate. Report why, rather than
    // falling through to a shadowed copy and running something the author
    // never edited.
    return { problems: resolved.problems }
  }

  // The profile the run will use, found in the chain. A built-in needs no file;
  // anything else is a definition, and a name no scope defines is a **refusal**
  // rather than a fall back to Default. Falling back would be the failure the
  // stored-profile guard already exists to stop: a project that asked to be
  // confined in a particular way, quietly running under something else.
  const profile = options.profile ?? DEFAULT_PROFILE
  let grants: Profile | undefined
  if (!isBuiltInProfile(profile)) {
    const found = resolveProfileDefinition(options.chain, profile)
    if (found === undefined) {
      return {
        problems: [
          {
            severity: 'error',
            message:
              `This project runs under the profile "${profile}", and no scope defines one by ` +
              `that name. Write it, or choose a profile that exists — Factory will not fall ` +
              `back to Default, because that would quietly change what this run may do.`,
            rule: 'plan.missingProfile',
          },
        ],
      }
    }
    if (found.value === undefined) return { problems: found.problems }
    grants = found.value
  }

  return resolvePlan({
    workflow: resolved.value,
    ...(grants === undefined ? {} : { profileDefinition: grants }),
    lookupPhase: (name) => resolvePhase(options.chain, options.host, name)?.value,
    // The same chain the phases come from, so a project's own agents work in
    // that project without anything else being told about them.
    lookupAgent: (name) => resolveAgent(options.chain, name)?.value,
    host: options.host,
    workspace: options.workspace,
    ...(options.task === undefined ? {} : { task: options.task }),
    ...(options.artifacts === undefined ? {} : { artifacts: options.artifacts }),
    ...(options.project === undefined ? {} : { project: options.project }),
    ...(options.defaultProvider === undefined ? {} : { defaultProvider: options.defaultProvider }),
    ...(options.session === undefined ? {} : { session: options.session }),
    ...(options.profile === undefined ? {} : { profile: options.profile }),
    ...(options.canonical === undefined ? {} : { canonical: options.canonical }),
    ...(options.allowedDirectories === undefined
      ? {}
      : { allowedDirectories: options.allowedDirectories }),
  })
}

import {
  PROJECT_SETTING_DEFINITIONS,
  type CapabilityLookup,
  type HookRegistry,
  type ProjectSetting,
} from '@factory/core'
import { resolvePhase, resolveWorkflow } from './store.js'
import { writeDefinition } from './write.js'
import type { ScopeChain } from './scopes.js'

/**
 * Give a project its own copies of the definitions a setting brings with it.
 *
 * The built-in `worktree-create` cannot know where this repository wants its
 * worktrees, and the built-in `environment-create` cannot know what an
 * environment even is here. Both say so — `override: required` — and this is
 * the other half of that conversation: turning the setting on puts an editable
 * copy in the project — ignored by git like the rest of that directory until
 * somebody shares it — instead of leaving
 * someone to find out from a doctor warning what they were supposed to create.
 *
 * Anything already present is left alone. Re-running is therefore safe, which
 * matters because a setting can be toggled more than once and the second time
 * must not overwrite the work done after the first.
 */
export interface ScaffoldOptions {
  readonly chain: ScopeChain
  readonly host: CapabilityLookup
  /** Passed through, so a plugin sees the copies a project is given too. */
  readonly hooks?: HookRegistry
  readonly setting: ProjectSetting
}

export interface ScaffoldResult {
  /** Files created, in the order they were written. */
  readonly written: readonly string[]
  /** Definitions the project already had, left untouched. */
  readonly kept: readonly string[]
  /** Names that resolved nowhere, so nothing could be copied. */
  readonly missing: readonly string[]
}

export async function scaffoldProjectDefinitions(
  options: ScaffoldOptions,
): Promise<ScaffoldResult> {
  const { chain, host } = options
  const written: string[] = []
  const kept: string[] = []
  const missing: string[] = []

  // Phases come with their workflows: a project copy of `worktree-create` that
  // still points at the built-in `worktree-add` is only half overridden, and
  // the half left behind is the half that knows where the directory goes.
  const copyPhase = async (name: string): Promise<void> => {
    const resolved = resolvePhase(chain, host, name)
    if (resolved?.value === undefined) {
      missing.push(name)
      return
    }
    if (resolved.ref.scope === 'project') {
      kept.push(name)
      return
    }
    const outcome = await writeDefinition({
      chain,
      host,
      ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
      kind: 'phase',
      definition: resolved.value,
      scope: 'project',
    })
    if (outcome.status === 'created') written.push(outcome.file)
  }

  for (const name of PROJECT_SETTING_DEFINITIONS[options.setting]) {
    const resolved = resolveWorkflow(chain, name)
    if (resolved?.value === undefined) {
      // The built-in was removed or replaced by something unparseable. Not this
      // function's problem to fix, but not something to swallow either.
      missing.push(name)
      continue
    }

    if (resolved.ref.scope === 'project') {
      kept.push(name)
    } else {
      const outcome = await writeDefinition({
        chain,
        host,
        ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
        kind: 'workflow',
        definition: resolved.value,
        scope: 'project',
      })
      if (outcome.status === 'created') written.push(outcome.file)
    }

    for (const phase of resolved.value.phases) await copyPhase(phase)
    if (resolved.value.onFail !== undefined) {
      const fallback = resolveWorkflow(chain, resolved.value.onFail)
      for (const phase of fallback?.value?.phases ?? []) await copyPhase(phase)
    }
  }

  return { written, kept, missing }
}

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  Agent,
  CapabilityLookup,
  HookRegistry,
  Phase,
  Problem,
  Profile,
  ProviderCapability,
  Workflow,
} from '@factory/core'
import {
  PROVIDER_KIND,
  parseAgentFile,
  parsePhaseFile,
  parseProfileFile,
  parseWorkflowFile,
  profileProblems,
  updateExistingAgent,
  updateExistingPhase,
  updateExistingProfile,
  updateExistingWorkflow,
  writeNewAgent,
  writeNewPhase,
  writeNewProfile,
  writeNewWorkflow,
} from '@factory/core'
import type { ScopeChain, ScopeKind } from './scopes.js'
import { definitionPath, explain, writeTarget, type DefinitionKind, type DefinitionRef } from './store.js'

/**
 * Writing definitions.
 *
 * A new file is generated canonically; an existing one is *patched*, so the
 * author's comments, key order and formatting survive. That distinction is the
 * whole reason there are two writers, and this is the only place that chooses
 * between them.
 */

/** A content hash, so a save can tell whether the file moved underneath it. */
export function etagOf(raw: string): string {
  return createHash('sha256').update(raw).digest('hex').slice(0, 16)
}

export interface WriteRequest {
  readonly chain: ScopeChain
  readonly host: CapabilityLookup
  /**
   * The hooks a plugin may have registered, if this caller has any.
   *
   * Optional, and absence means no hooks run — the same degrade-by-absence as
   * everything else here, and what lets a bundle be written without a host
   * that loaded plugins. `CapabilityLookup` deliberately does not carry them:
   * a capability is a thing to call, a hook is a thing that gets called, and
   * only a caller that owns the host has the second.
   */
  readonly hooks?: HookRegistry
  readonly kind: DefinitionKind
  readonly definition: Workflow | Phase | Agent | Profile
  readonly scope?: ScopeKind
  /**
   * The etag the caller last read. When it no longer matches, the file changed
   * on disk since they opened it and the write is refused.
   *
   * Omit it only when creating: an editor that never read the file has nothing
   * to be stale about.
   */
  readonly expectEtag?: string
}

export type WriteOutcome =
  | { readonly status: 'created'; readonly file: string; readonly etag: string }
  | { readonly status: 'updated'; readonly file: string; readonly etag: string; readonly unchanged: boolean }
  | { readonly status: 'exists'; readonly file: string; readonly etag: string }
  | { readonly status: 'stale'; readonly file: string; readonly etag: string; readonly raw: string }
  | { readonly status: 'refused'; readonly problems: readonly Problem[] }

/** Writing one kind, reading it back, and patching an existing file of it. */
interface DefinitionHandler {
  write(): string
  patch(raw: string): string
  read(text: string): { problems: readonly Problem[] }
}

export async function writeDefinition(request: WriteRequest): Promise<WriteOutcome> {
  const { chain, kind } = request
  const target = writeTarget(chain, request.scope)
  const file = definitionPath(target, kind, request.definition.name)
  const exists = existsSync(file)

  // The two hooks the plugin SDK has always declared, run where every write
  // passes through — the API, the CLI, a bundle import and scaffolding a
  // project all get the same answer. They were declared, documented, counted
  // in conformance reports and never called once.
  //
  // Validation first, because a definition somebody's plugin considers invalid
  // should be refused before anything is asked to adjust it. Then the write
  // hook, which may replace the definition or refuse outright. What it returns
  // is still read back below: a hook that adjusts a definition into something
  // Factory cannot load is refused by the same check that catches a bad client.
  let definition = request.definition

  // A profile is the one kind whose validity depends on what is *installed*:
  // whether its arguments would reach Full Access is a question about each
  // provider's own flags. `parseProfile` has no host on purpose — a profile
  // names providers and none of them has to be present for it to be written
  // down — so the check happens here, where the host is, and before a plugin
  // is asked to adjust something that is going to be refused anyway.
  if (kind === 'profile') {
    const providers = request.host
      .list<ProviderCapability>(PROVIDER_KIND)
      .map((entry) => entry.capability.descriptor)
    const problems = profileProblems(definition as Profile, providers, { file })
    const refusals = problems.filter((problem) => problem.severity === 'error')
    if (refusals.length > 0) return { status: 'refused', problems: refusals }
  }

  if (request.hooks !== undefined) {
    const problems = (
      await request.hooks.collect('validateDefinition', {
        kind,
        name: definition.name,
        definition,
        file,
      })
    ).filter((problem) => problem.severity === 'error')
    if (problems.length > 0) return { status: 'refused', problems }

    const outcome = await request.hooks.transform('beforeDefinitionWrite', {
      kind,
      name: definition.name,
      definition,
      scope: target.kind,
      file,
    })
    if (outcome.action === 'reject') return { status: 'refused', problems: outcome.problems }
    definition = outcome.value.definition as typeof definition
  }

  /**
   * How each kind is written and read back.
   *
   * A `Record<DefinitionKind, …>` rather than a chain of ternaries, because
   * the ternaries needed an `as Phase` cast on the else branch and a cast is
   * exactly what stops the compiler telling you a third kind is unhandled. A
   * missing row here does not compile.
   */
  const handlers: Record<DefinitionKind, DefinitionHandler> = {
    workflow: {
      write: () => writeNewWorkflow(definition as Workflow),
      patch: (raw) => updateExistingWorkflow(raw, definition as Workflow),
      read: (text) => parseWorkflowFile(text, file),
    },
    phase: {
      write: () => writeNewPhase(definition as Phase, request.host),
      patch: (raw) => updateExistingPhase(raw, definition as Phase, request.host),
      read: (text) => parsePhaseFile(text, request.host, file),
    },
    agent: {
      write: () => writeNewAgent(definition as Agent),
      patch: (raw) => updateExistingAgent(raw, definition as Agent),
      read: (text) => parseAgentFile(text, file),
    },
    profile: {
      write: () => writeNewProfile(definition as Profile),
      patch: (raw) => updateExistingProfile(raw, definition as Profile),
      read: (text) => parseProfileFile(text, file),
    },
  }
  const handler = handlers[kind]
  const serialize = { new: () => handler.write(), patch: handler.patch }

  // Validate what would be written, by reading it back.
  //
  // The caller passes a domain object, and nothing stops that object from being
  // wrong -- a client that skipped validation, an older client, a script. The
  // guarantee has to be "a file Factory wrote is a file Factory can load", and
  // the only way to know that is to load it. Doing it here rather than in each
  // caller means every write path gets it, including bundle import.
  const verify = (text: string): Problem[] =>
    handler.read(text).problems.filter((problem) => problem.severity === 'error')

  if (!exists) {
    // Creating over a name the caller believed existed means someone deleted it
    // underneath them; a fresh file is the right answer, but say it is a create.
    const text = serialize.new()
    const problems = verify(text)
    if (problems.length > 0) return { status: 'refused', problems }

    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
    return { status: 'created', file, etag: etagOf(text) }
  }

  const raw = readFileSync(file, 'utf8')
  const current = etagOf(raw)

  if (request.expectEtag === undefined) {
    return { status: 'exists', file, etag: current }
  }
  if (request.expectEtag !== current) {
    // Hand back what is actually there, so the caller can show a diff rather
    // than just refusing.
    return { status: 'stale', file, etag: current, raw }
  }

  const text = serialize.patch(raw)
  const problems = verify(text)
  if (problems.length > 0) return { status: 'refused', problems }

  if (text !== raw) writeFileSync(file, text)
  return { status: 'updated', file, etag: etagOf(text), unchanged: text === raw }
}

export interface DeleteOutcome {
  readonly deleted: boolean
  readonly file: string
  /**
   * Where the name resolves from now.
   *
   * Deleting a project copy can *reveal* one that was shadowed, so the name
   * still works but means something else. Saying nothing here would be quietly
   * baffling.
   */
  readonly nowResolvesFrom?: DefinitionRef
}

export function deleteDefinition(options: {
  chain: ScopeChain
  kind: DefinitionKind
  name: string
  scope?: ScopeKind
}): DeleteOutcome {
  const target = writeTarget(options.chain, options.scope)
  const file = definitionPath(target, options.kind, options.name)

  if (!existsSync(file)) return { deleted: false, file }
  rmSync(file)

  const revealed = explain(options.chain, options.kind, options.name).find(
    (candidate) => candidate.exists,
  )

  return {
    deleted: true,
    file,
    ...(revealed === undefined
      ? {}
      : {
          nowResolvesFrom: {
            kind: options.kind,
            name: options.name,
            scope: revealed.scope,
            file: revealed.file,
          },
        }),
  }
}

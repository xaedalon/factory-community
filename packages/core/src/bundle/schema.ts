import { z } from 'zod'
import { closedWithExtensions, problemsFromZod, slug } from '../schema/common.js'
import type { Problem } from '../problems.js'
import type { Phase } from '../schema/phase.js'
import type { Agent } from '../schema/agent.js'
import type { Profile } from '../schema/profile.js'
import type { Workflow } from '../schema/workflow.js'

/**
 * A bundle: one file carrying a workflow and everything it needs.
 *
 * Versioned as a `kind`, k8s-style, because this is the file that gets pasted
 * into a gist or a pull request and will outlive the schema that produced it.
 * `kind` also identifies *what* the document is, so one loader can dispatch
 * across scope configs, bundles and whatever comes later, and reject an unknown
 * document cleanly instead of half-importing it.
 *
 * Workflows and phases are sibling arrays rather than phases nested inside
 * workflows. Phases are shared — nesting would duplicate one used by two
 * workflows and destroy exactly the reuse the phase abstraction exists for.
 */

export const BUNDLE_KIND = 'factory.bundle/v1'

const bundleShape = {
  kind: z.literal(BUNDLE_KIND),
  // Optional rather than defaulted: zod wants a complete object for a default,
  // and metadata is descriptive -- a bundle without it is still importable.
  metadata: z
    .object({
      name: z.string().default(''),
      description: z.string().default(''),
      exportedAt: z.string().default(''),
      exportedBy: z.string().default(''),
      sourceScope: z.string().default(''),
      /** Names the export could not resolve, when --allow-missing was used. */
      unresolved: z.array(z.string()).default([]),
    })
    .optional(),
  /**
   * The workflow this bundle is *for*, when it is for one.
   *
   * Optional since profiles could travel: a bundle carrying only a profile has
   * no entry workflow, and requiring one would mean naming a workflow that is
   * not in the file. Absent is a real answer; an empty string would not be.
   */
  entry: z.object({ workflow: slug('entry workflow') }).optional(),
  workflows: z.array(z.unknown()).default([]),
  phases: z.array(z.unknown()).default([]),
  /**
   * Defaulted, so a bundle written before agents existed still reads.
   *
   * A step naming an agent needs that agent to travel with it, or the recipient
   * imports a workflow that refuses to plan — which is the "arrives without its
   * phases" failure this format exists to prevent, one level down.
   */
  agents: z.array(z.unknown()).default([]),
  /**
   * Defaulted, for the same reason `agents` is: a bundle written before
   * profiles existed still reads.
   *
   * Nothing *references* a profile the way a step references an agent — a
   * project chooses one — so a profile never arrives by being pulled in. It
   * travels because somebody put it in the bundle on purpose, which is how the
   * shipped example ships.
   */
  profiles: z.array(z.unknown()).default([]),
}

const bundleSchema = closedWithExtensions(bundleShape)

export interface Bundle {
  readonly kind: typeof BUNDLE_KIND
  readonly metadata: {
    readonly name: string
    readonly description: string
    readonly exportedAt: string
    readonly exportedBy: string
    readonly sourceScope: string
    readonly unresolved: readonly string[]
  }
  readonly entry?: { readonly workflow: string }
  readonly workflows: readonly Workflow[]
  readonly phases: readonly Phase[]
  readonly agents: readonly Agent[]
  readonly profiles: readonly Profile[]
}

/** Validate the envelope. The definitions inside are validated by their own schemas. */
export function parseBundleEnvelope(input: unknown): {
  envelope?: z.infer<typeof bundleSchema>
  problems: Problem[]
} {
  const parsed = bundleSchema.safeParse(input)
  if (!parsed.success) {
    const unknownKind =
      input !== null &&
      typeof input === 'object' &&
      'kind' in input &&
      (input as { kind?: unknown }).kind !== BUNDLE_KIND

    return {
      problems: unknownKind
        ? [
            {
              severity: 'error',
              message:
                `This is not a Factory bundle — its kind is ` +
                `${JSON.stringify((input as { kind?: unknown }).kind)}, expected "${BUNDLE_KIND}".`,
              field: 'kind',
              rule: 'bundle.wrongKind',
            },
          ]
        : problemsFromZod(parsed.error),
    }
  }
  return { envelope: parsed.data, problems: [] }
}

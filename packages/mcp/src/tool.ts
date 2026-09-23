import { z } from 'zod'
import type { FactoryApi } from './api.js'

/**
 * One thing an agent can ask Factory to do.
 *
 * The schema is written in zod and published as JSON Schema with
 * `z.toJSONSchema()` — the same mechanism the daemon already uses to publish
 * each step kind's fields to the builder. One way to describe a schema to a
 * client, rather than a second one for a second audience.
 *
 * Note the word. Factory already calls two other things a tool: a **task tool**
 * is a button on a task, and a provider's `supports: mcp` means that agent CLI
 * can *consume* MCP servers. This is the third — what Factory *serves* — and it
 * is the only one this package is about.
 */

export interface ToolContext {
  readonly api: FactoryApi
  /** Where `factory mcp` was started, handed over rather than read. */
  readonly cwd: string
  readonly env: Readonly<Record<string, string | undefined>>
}

export interface McpTool {
  readonly name: string
  readonly title: string
  readonly description: string
  /** JSON Schema, computed once at construction rather than per `tools/list`. */
  readonly inputSchema: unknown
  /** Validation is the tool's own, so a bad call is refused before anything is reached. */
  parse(input: unknown): { readonly value: unknown } | { readonly problems: readonly string[] }
  run(value: unknown, context: ToolContext): Promise<unknown>
}

export function defineTool<S extends z.ZodType>(definition: {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly schema: S
  run(input: z.infer<S>, context: ToolContext): Promise<unknown>
}): McpTool {
  return {
    name: definition.name,
    title: definition.title,
    description: definition.description,
    inputSchema: z.toJSONSchema(definition.schema),
    parse: (input) => {
      // `?? {}` because a client is allowed to omit `arguments` entirely for a
      // tool that needs none, and refusing that would make the commonest call
      // in this surface — "where am I" — the one that fails.
      const parsed = definition.schema.safeParse(input ?? {})
      if (parsed.success) return { value: parsed.data }
      return {
        problems: parsed.error.issues.map((issue) =>
          issue.path.length === 0 ? issue.message : `${issue.path.join('.')}: ${issue.message}`,
        ),
      }
    },
    run: (value, context) => definition.run(value as z.infer<S>, context),
  }
}

import { readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import {
  PROVIDER_KIND,
  parseProviderDescriptor,
  providerFromDescriptor,
  resolveCommand,
  type FactoryPlugin,
  type PluginContext,
  type ProviderDescriptor,
  type StreamReaderFactory,
} from '@factory/core'

/**
 * Turn a provider descriptor into a plugin.
 *
 * All three built-in providers are exactly this and nothing more: a YAML file
 * plus one call. Adding a fourth agent needs no code at all, which is what
 * provider independence has to mean if it means anything.
 */
export function defineProviderPlugin(options: {
  name: string
  version: string
  /** Absolute path to the descriptor YAML. */
  descriptorFile: string
  /**
   * How to read this CLI's structured output, when it has some.
   *
   * The one thing about a provider that cannot be data: a transcript format is
   * a parser. Optional, so the three-line descriptor plugin stays three lines —
   * and so a provider that has not been measured says nothing rather than
   * guessing, which is the rule the descriptors already follow.
   */
  stream?: StreamReaderFactory
}): FactoryPlugin {
  return {
    name: options.name,
    version: options.version,
    register(context) {
      const raw = readFileSync(options.descriptorFile, 'utf8')
      const { descriptor: parsed, error } = parseProviderDescriptor(parseYaml(raw))
      const descriptor =
        parsed === undefined ? undefined : resolveFor(parsed, context)
      if (descriptor === undefined) {
        const first = error?.issues[0]
        throw new Error(
          `${options.descriptorFile} is not a valid provider descriptor: ` +
            `${first?.path.join('.') ?? ''} ${first?.message ?? 'unknown error'}`.trim(),
        )
      }
      const provider = providerFromDescriptor(descriptor)
      context.provide(
        PROVIDER_KIND,
        options.stream === undefined ? provider : { ...provider, stream: options.stream },
      )
    },
  }
}

/**
 * Where this machine keeps the agent.
 *
 * A descriptor ships inside the package and is the same on every machine; where
 * the binary is, is not. Three answers in order: what the installation
 * configured, what PATH says, and where things are usually installed.
 *
 * Resolved here, once, so that everything downstream — the availability check,
 * the rendered command line, the planner — works from one answer. An agent
 * installed while Factory is running is picked up on the next start, which is
 * what `factory doctor` and the setup checklist are there to tell you.
 */
function resolveFor(descriptor: ProviderDescriptor, context: PluginContext): ProviderDescriptor {
  const configured = context.settings(PROVIDER_KIND, descriptor.id)?.command
  if (typeof configured === 'string' && configured.trim() !== '') {
    return { ...descriptor, command: configured.trim() }
  }
  return { ...descriptor, command: resolveCommand(descriptor.command, context.env) }
}

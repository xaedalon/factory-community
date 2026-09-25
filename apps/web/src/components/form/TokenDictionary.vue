<script setup lang="ts">
import { computed } from 'vue'
import type { TokenNamespace } from '../../api/client.js'
import { useClipboard } from '../../composables/useClipboard.js'

/**
 * What `{{ namespace.key }}` may say, where a step is being written.
 *
 * The vocabulary is not listed here. It comes from `/api/registries/tokens`,
 * which serves core's own dictionary — a hand-kept copy in this file would be
 * the fourth implementation of one idea, and the one furthest from anything
 * that would notice it going stale.
 *
 * What this component *does* own is the half core cannot know: a workflow's and
 * a phase's `variables:` are whatever the definition being edited declares, so
 * those namespaces arrive empty and are filled from what the editor is holding.
 */
const props = defineProps<{
  namespaces: TokenNamespace[]
  /** The definition's own `variables:`, by namespace, as currently edited. */
  declared?: Record<string, Readonly<Record<string, string>>> | undefined
}>()

/** A Vue interpolation cannot contain `}}`, so tokens are built in script. */
const token = (namespace: string, key: string): string => `{{ ${namespace}.${key} }}`

/**
 * The dictionary as it applies to this definition.
 *
 * A `definition` namespace shows the keys declared here and nothing else — an
 * empty one is the truth, not a gap, and saying so beats an explanation of
 * where the keys would have come from.
 */
const sections = computed(() =>
  props.namespaces.map((entry) => {
    if (entry.source !== 'definition') return entry
    const declared = props.declared?.[entry.namespace] ?? {}
    return {
      ...entry,
      tokens: Object.keys(declared).map((key) => ({
        key,
        summary: `Declared here as “${declared[key] ?? ''}”.`,
      })),
    }
  }),
)

/**
 * Copy on click, rather than insert at the cursor.
 *
 * Inserting would have to guess which of a step's fields was last focused, and
 * guessing wrong writes into the wrong one. The job here is knowing what exists.
 *
 * Through the shared composable, which also means the "Copied" title clears
 * itself — this used to keep claiming it for as long as the editor was open.
 */
const { copied, copy } = useClipboard()
</script>

<template>
  <details class="rounded-lg border border-[var(--color-line)]" data-testid="token-dictionary">
    <summary
      class="cursor-pointer select-none px-3 py-2 text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
      data-testid="token-dictionary-toggle"
    >
      Tokens you can use in any field above
    </summary>

    <div class="border-t border-[var(--color-line)] px-3 py-2">
      <div v-for="section in sections" :key="section.namespace" class="mb-3 last:mb-0">
        <p class="font-mono text-meta text-[var(--color-ink)]">
          {{ section.namespace }}.*
          <span class="font-sans text-[var(--color-ink-faint)]">— {{ section.summary }}</span>
        </p>

        <p
          v-if="section.tokens.length === 0"
          class="mt-1 text-[11px] text-[var(--color-ink-faint)]"
          :data-testid="`token-empty-${section.namespace}`"
        >
          This {{ section.namespace === 'variables' ? 'definition' : section.namespace }} declares
          none yet. Anything added to its <code>variables</code> appears here.
        </p>

        <ul v-else class="mt-1">
          <li
            v-for="entry in section.tokens"
            :key="entry.key"
            class="flex items-baseline gap-2 py-0.5"
          >
            <button
              type="button"
              class="shrink-0 rounded px-1 font-mono text-meta text-[var(--color-accent-text)] hover:bg-[var(--color-veil-strong)]"
              :data-testid="`token-${section.namespace}-${entry.key}`"
              :title="copied === token(section.namespace, entry.key) ? 'Copied' : 'Copy'"
              @click="copy(token(section.namespace, entry.key))"
            >
              {{ token(section.namespace, entry.key) }}
            </button>
            <span class="text-[11px] text-[var(--color-ink-faint)]">{{ entry.summary }}</span>
          </li>
        </ul>
      </div>
    </div>
  </details>
</template>

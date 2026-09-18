<script setup lang="ts">
import { computed } from 'vue'
import type { ScopeKind } from '../api/client.js'

/**
 * Which scope a definition came from.
 *
 * Colour-coded consistently everywhere, because "where does this live" is the
 * question layered resolution creates and the answer should be readable at a
 * glance rather than something you go looking for.
 */
const props = defineProps<{ scope: ScopeKind }>()

const tone = computed(
  () =>
    ({
      project: 'text-[var(--color-accent)] border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10',
      user: 'text-[var(--color-info)] border-[var(--color-info)]/40 bg-[var(--color-info)]/10',
      builtin: 'text-[var(--color-ink-faint)] border-[var(--color-line-strong)] bg-[var(--color-veil-weak)]',
    })[props.scope],
)
</script>

<template>
  <span
    class="inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px] tracking-widest uppercase"
    :class="tone"
    :data-testid="`scope-${scope}`"
  >
    {{ scope }}
  </span>
</template>

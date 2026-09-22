<script setup lang="ts">
import type { DefinitionRef } from '../api/client.js'

/**
 * "This hides another copy."
 *
 * Shadowing is almost always what the author intended — a project overriding a
 * shipped workflow is the feature. It is surfaced anyway because it is
 * otherwise invisible: two files, one name, and no indication which one ran.
 */
defineProps<{ shadowed: DefinitionRef[] }>()
</script>

<template>
  <span
    v-if="shadowed.length > 0"
    class="inline-flex items-center gap-1 font-mono text-label text-[var(--color-warn)]"
    :title="shadowed.map((ref) => ref.file).join('\n')"
    data-testid="shadow-notice"
  >
    hides {{ shadowed.map((ref) => ref.scope).join(', ') }}
  </span>
</template>
